import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Credential, openVault } from "../src/credentials/vault.js";
import { loadConfig } from "../src/config.js";

const providers = ["qwen", "claude"];
const vaultFile = () => join(mkdtempSync(join(tmpdir(), "wspr-vault-")), "credentials.enc");

describe("credential vault", () => {
  it("round-trips an encrypted credential", async () => {
    const path = vaultFile();
    const vault = await openVault("hunter2", { filePath: path, providers });
    await vault.set("default", "qwen", new Credential("a@b.com", "password", new Date().toISOString(), "s3cret"));
    const reopened = await openVault("hunter2", { filePath: path, providers });
    const cred = reopened.get("default", "qwen");
    assert.ok(cred);
    assert.equal(cred!.email, "a@b.com");
    assert.equal(cred!.password, "s3cret");
    assert.equal(cred!.method, "password");
  });

  it("fails cleanly on a wrong passphrase", async () => {
    const path = vaultFile();
    const vault = await openVault("hunter2", { filePath: path, providers });
    await vault.set("default", "qwen", new Credential("a@b.com", "password", new Date().toISOString(), "s3cret"));
    await assert.rejects(openVault("wrong", { filePath: path, providers }));
  });

  it("listRedacted never emits a password", async () => {
    const path = vaultFile();
    const vault = await openVault("hunter2", { filePath: path, providers });
    await vault.set("default", "qwen", new Credential("a@b.com", "password", new Date().toISOString(), "s3cret"));
    const rows = vault.listRedacted();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].provider, "qwen");
    assert.equal(rows[0].email, "a@b.com");
    assert.equal(rows[0].hasPassword, true);
    assert.ok(!("password" in rows[0]));
  });

  it("a manual credential has no password and reports hasPassword false", async () => {
    const path = vaultFile();
    const vault = await openVault("hunter2", { filePath: path, providers });
    await vault.set("default", "claude", new Credential("a@b.com", "manual", new Date().toISOString()));
    const cred = vault.get("default", "claude");
    assert.equal(cred!.password, undefined);
    assert.equal(cred!.hasPassword, false);
    assert.equal(vault.listRedacted()[0].hasPassword, false);
  });

  it("JSON.stringify(credential) omits the password", () => {
    const cred = new Credential("a@b.com", "password", new Date().toISOString(), "s3cret");
    const s = JSON.stringify(cred);
    assert.ok(!s.includes("s3cret"));
    assert.ok(s.includes("hasPassword"));
  });

  it("rejects set for an unknown provider", async () => {
    const path = vaultFile();
    const vault = await openVault("hunter2", { filePath: path, providers });
    await assert.rejects(vault.set("default", "nope", new Credential("a@b.com", "password", new Date().toISOString(), "s3cret")));
  });
});

describe("config login validation", () => {
  const yaml = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), "wspr-cfg-"));
    const file = join(dir, "providers.yaml");
    writeFileSync(file, body);
    return file;
  };

  it("rejects a password login block missing passwordSelector", () => {
    const file = yaml(`
providers:
  qwen:
    url: "https://qwen.example/"
    requiresLogin: true
    inputSelector: "textarea"
    responseSelector: ".resp"
    timeoutMs: 60000
    stabilizeMs: 2000
    login:
      method: password
      emailSelector: "input[type=email]"
`);
    assert.throws(() => loadConfig(file), /requires passwordSelector/);
  });

  it("accepts a valid password login block", () => {
    const file = yaml(`
providers:
  qwen:
    url: "https://qwen.example/"
    requiresLogin: true
    inputSelector: "textarea"
    responseSelector: ".resp"
    timeoutMs: 60000
    stabilizeMs: 2000
    login:
      method: password
      emailSelector: "input[type=email]"
      passwordSelector: "input[type=password]"
      submitSelector: "button[type=submit]"
`);
    const cfg = loadConfig(file);
    assert.equal(cfg.providers.qwen.login?.method, "password");
  });

  it("accepts a manual login block without a password selector", () => {
    const file = yaml(`
providers:
  claude:
    url: "https://claude.example/"
    requiresLogin: true
    inputSelector: "[contenteditable]"
    responseSelector: ".resp"
    timeoutMs: 60000
    stabilizeMs: 2000
    login:
      method: manual
      emailSelector: "input[type=email]"
`);
    const cfg = loadConfig(file);
    assert.equal(cfg.providers.claude.login?.method, "manual");
  });
});

describe("vault durability and errors", () => {
  it("reports a wrong passphrase as a readable error, not a raw crypto fault", async () => {
    const path = vaultFile();
    const vault = await openVault("right", { filePath: path, providers });
    await vault.set("default", "qwen", new Credential("a@b.com", "password", new Date().toISOString(), "s3cret"));

    await assert.rejects(
      openVault("wrong", { filePath: path, providers }),
      (e: Error) => {
        assert.equal(e.name, "WrongPassphraseError");
        assert.match(e.message, /wrong passphrase/i);
        // The raw node:crypto message must not reach the user.
        assert.doesNotMatch(e.message, /unable to authenticate data/i);
        return true;
      },
    );
  });

  it("leaves the existing vault readable after a failed open", async () => {
    const path = vaultFile();
    const vault = await openVault("right", { filePath: path, providers });
    await vault.set("default", "qwen", new Credential("a@b.com", "password", new Date().toISOString(), "s3cret"));
    await assert.rejects(openVault("wrong", { filePath: path, providers }));

    // A failed open must never truncate or rewrite the file.
    const reopened = await openVault("right", { filePath: path, providers });
    assert.equal(reopened.get("default", "qwen")!.password, "s3cret");
  });

  it("writes atomically and leaves no temp file behind", async () => {
    const path = vaultFile();
    const vault = await openVault("right", { filePath: path, providers });
    await vault.set("default", "qwen", new Credential("a@b.com", "password", new Date().toISOString(), "one"));
    await vault.set("default", "claude", new Credential("c@d.com", "manual", new Date().toISOString()));

    const leftovers = readdirSync(dirname(path)).filter((f) => f.includes(".tmp"));
    assert.deepEqual(leftovers, [], `stray temp files: ${leftovers.join(", ")}`);

    const reopened = await openVault("right", { filePath: path, providers });
    assert.equal(reopened.listRedacted().length, 2);
  });

  it("keeps the vault file at mode 0600 across rewrites", async () => {
    const path = vaultFile();
    const vault = await openVault("right", { filePath: path, providers });
    await vault.set("default", "qwen", new Credential("a@b.com", "password", new Date().toISOString(), "one"));
    await vault.set("default", "qwen", new Credential("a@b.com", "password", new Date().toISOString(), "two"));
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});
