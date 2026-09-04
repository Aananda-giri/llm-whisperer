import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import { WebLLMProvider, supportsAutoLogin } from "../src/providers/base.js";
import { Credential, type Vault, type RedactedCredential } from "../src/credentials/vault.js";
import type { ProviderConfig } from "../src/config.js";
import type { SessionPool } from "../src/session-pool.js";

/**
 * A Page just real enough for `attemptLogin`: every locator resolves, and
 * `loggedOut` decides what `isLoggedIn` sees. Flipping it mid-test is how we
 * simulate a login that works, and one that doesn't.
 */
function fakePage(state: { loggedOut: boolean }) {
  const locator = (sel: string) => ({
    first: () => ({
      click: async () => {
        // Submitting the form is what "logs in" — unless the test says otherwise.
        if (sel.includes("submit") && state.loggedOut === false) return;
      },
      fill: async () => {},
      waitFor: async () => {},
      // loggedOutSelector is visible exactly when we are logged out.
      isVisible: async () => state.loggedOut,
    }),
  });
  return {
    locator,
    url: () => "https://example.test/",
    goto: async () => {},
    waitForTimeout: async () => {},
    screenshot: async () => Buffer.alloc(0),
  } as unknown as Page;
}

const cfg = (): ProviderConfig => ({
  url: "https://example.test/",
  requiresLogin: true,
  inputSelector: "textarea",
  responseSelector: ".resp",
  loggedOutSelector: "button.login",
  timeoutMs: 1000,
  stabilizeMs: 10,
  login: {
    method: "password",
    emailSelector: "input[type=email]",
    passwordSelector: "input[type=password]",
    submitSelector: "button[type=submit]",
    timeoutMs: 500,
  },
});

/** A Vault holding one credential, with a settable updatedAt. */
function stubVault(cred?: Credential): Vault {
  return {
    filePath: "/dev/null",
    get: () => cred,
    listRedacted: (): RedactedCredential[] => [],
    set: async () => {},
    remove: async () => {},
  };
}

const pool = {} as SessionPool;
const pw = (updatedAt = "2026-01-01T00:00:00.000Z") =>
  new Credential("a@b.com", "password", updatedAt, "s3cret");

describe("autoLogin guard", () => {
  it("is exposed as a capability on browser providers", () => {
    const p = new WebLLMProvider("qwen", cfg(), pool, stubVault(pw()));
    assert.ok(supportsAutoLogin(p));
  });

  it("does nothing without a vault", async () => {
    const p = new WebLLMProvider("qwen", cfg(), pool);
    const r = await p.autoLogin(fakePage({ loggedOut: true }), "default");
    assert.equal(r.ok, false);
    assert.match(r.reason!, /no vault/i);
  });

  it("does nothing without a stored credential", async () => {
    const p = new WebLLMProvider("qwen", cfg(), pool, stubVault(undefined));
    const r = await p.autoLogin(fakePage({ loggedOut: true }), "default");
    assert.equal(r.ok, false);
    assert.match(r.reason!, /no credential/i);
  });

  it("does nothing for a manual credential", async () => {
    const cred = new Credential("a@b.com", "manual", new Date().toISOString());
    const p = new WebLLMProvider("qwen", cfg(), pool, stubVault(cred));
    const r = await p.autoLogin(fakePage({ loggedOut: true }), "default");
    assert.equal(r.ok, false);
    assert.match(r.reason!, /manual/i);
  });

  it("does nothing when the provider has no login: block", async () => {
    const c = cfg();
    delete c.login;
    const p = new WebLLMProvider("qwen", c, pool, stubVault(pw()));
    const r = await p.autoLogin(fakePage({ loggedOut: true }), "default");
    assert.equal(r.ok, false);
    assert.match(r.reason!, /no login: block/i);
  });

  it("refuses to retry a credential that already failed", async () => {
    const p = new WebLLMProvider("qwen", cfg(), pool, stubVault(pw()));
    const page = fakePage({ loggedOut: true }); // never becomes logged in

    const first = await p.autoLogin(page, "default");
    assert.equal(first.ok, false);

    // The second call must not submit the password again — a retry storm is
    // what locks accounts.
    const second = await p.autoLogin(page, "default");
    assert.equal(second.ok, false);
    assert.match(second.reason!, /already failed once/i);
  });

  it("retries once the credential is updated in the vault", async () => {
    let cred = pw("2026-01-01T00:00:00.000Z");
    const vault: Vault = { ...stubVault(), get: () => cred };
    const p = new WebLLMProvider("qwen", cfg(), pool, vault);
    const page = fakePage({ loggedOut: true });

    await p.autoLogin(page, "default");
    assert.match((await p.autoLogin(page, "default")).reason!, /already failed once/i);

    // A new updatedAt means a different credential — it gets its own attempt.
    cred = pw("2026-02-02T00:00:00.000Z");
    const retried = await p.autoLogin(page, "default");
    assert.doesNotMatch(retried.reason ?? "", /already failed once/i);
  });

  it("succeeds, and stays retryable so a later lapse can recover", async () => {
    const p = new WebLLMProvider("qwen", cfg(), pool, stubVault(pw()));
    const state = { loggedOut: false }; // already logged in => attempt succeeds
    const page = fakePage(state);

    const first = await p.autoLogin(page, "default");
    assert.equal(first.ok, true, `expected success, got: ${first.reason}`);

    // This is the regression: a *successful* login must not consume the one
    // attempt. When the session lapses later in the same process, auto-login
    // has to be able to run again.
    const second = await p.autoLogin(page, "default");
    assert.equal(second.ok, true, `expected a second attempt to be allowed, got: ${second.reason}`);
    assert.doesNotMatch(second.reason ?? "", /already failed once/i);
  });
});
