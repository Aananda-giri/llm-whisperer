import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionPool } from "../src/session-pool.js";
import type { Page } from "playwright";
import type { BrowserManager } from "../src/browser.js";

/**
 * A page is only ever identity-compared and asked whether it is closed, so a
 * two-field stand-in exercises the whole pool without launching Chromium.
 */
function fakePages() {
  let n = 0;
  const made: { id: number; closed: boolean }[] = [];
  const browser = {
    context: async () => ({
      newPage: async () => {
        const p = { id: n++, closed: false };
        made.push(p);
        return p as unknown as Page;
      },
    }),
    close: async () => {},
  } as unknown as BrowserManager;
  return { browser, made };
}

const isClosed = (p: Page) => (p as unknown as { closed: boolean }).closed;
const close = (p: Page) => ((p as unknown as { closed: boolean }).closed = true);

// The pool calls page.isClosed(); the fake stores a plain boolean.
function wrap(p: Page): Page {
  return Object.assign(p as object, { isClosed: () => isClosed(p) }) as Page;
}

describe("SessionPool — conversation affinity", () => {
  it("hands back the page already holding this conversation", async () => {
    const { browser } = fakePages();
    const pool = new SessionPool(browser, 3);

    const a = wrap(await pool.acquire("qwen", "p"));
    const b = wrap(await pool.acquire("qwen", "p"));
    pool.setStateKey(a, "conv-A");
    pool.setStateKey(b, "conv-B");
    pool.release("qwen", "p", a);
    pool.release("qwen", "p", b);

    // Not merely "an idle page" — the one holding conv-A specifically, even
    // though b was released last and is what a plain LIFO pop would return.
    assert.equal(await pool.acquire("qwen", "p", "conv-A"), a);
  });

  it("still returns a page when nothing matches, so the caller can replay", async () => {
    const { browser } = fakePages();
    const pool = new SessionPool(browser, 2);
    const a = wrap(await pool.acquire("qwen", "p"));
    pool.setStateKey(a, "conv-A");
    pool.release("qwen", "p", a);

    const got = await pool.acquire("qwen", "p", "conv-Z");
    assert.ok(got, "affinity is best-effort, never a hard requirement");
    assert.notEqual(pool.stateKey(got), "conv-Z", "and the caller can see it missed");
  });

  it("clearState makes a page unmatchable", async () => {
    const { browser } = fakePages();
    const pool = new SessionPool(browser, 2);
    const a = wrap(await pool.acquire("qwen", "p"));
    pool.setStateKey(a, "conv-A");
    assert.equal(pool.stateKey(a), "conv-A");
    pool.clearState(a);
    assert.equal(pool.stateKey(a), undefined);
  });

  it("keeps two interleaved conversations on their own pages", async () => {
    const { browser } = fakePages();
    const pool = new SessionPool(browser, 3);

    const a = wrap(await pool.acquire("qwen", "p", "conv-A"));
    const b = wrap(await pool.acquire("qwen", "p", "conv-B"));
    assert.notEqual(a, b, "a second conversation must not take the first's tab");
    pool.setStateKey(a, "A1");
    pool.setStateKey(b, "B1");
    pool.release("qwen", "p", a);
    pool.release("qwen", "p", b);

    assert.equal(await pool.acquire("qwen", "p", "A1"), a);
    assert.equal(await pool.acquire("qwen", "p", "B1"), b);
  });

  it("does not leak state for a page that was closed while idle", async () => {
    const { browser } = fakePages();
    const pool = new SessionPool(browser, 2);
    const a = wrap(await pool.acquire("qwen", "p"));
    pool.setStateKey(a, "conv-A");
    pool.release("qwen", "p", a);

    close(a);
    const fresh = wrap(await pool.acquire("qwen", "p", "conv-A"));
    assert.notEqual(fresh, a, "a closed page must never be handed out");
    assert.equal(pool.stateKey(a), undefined, "and its key must not linger");
  });

  it("still caps concurrency and queues past the cap", async () => {
    const { browser } = fakePages();
    const pool = new SessionPool(browser, 1);
    const a = wrap(await pool.acquire("qwen", "p"));

    let handed: Page | undefined;
    void pool.acquire("qwen", "p", "conv-B").then((p) => (handed = p));
    await new Promise((r) => setImmediate(r));
    assert.equal(handed, undefined, "the second caller waits at maxPerProvider=1");

    pool.release("qwen", "p", a);
    await new Promise((r) => setImmediate(r));
    assert.equal(handed, a, "and is handed the page directly on release");
  });

  it("scopes state by provider and profile", async () => {
    const { browser } = fakePages();
    const pool = new SessionPool(browser, 2);
    const a = wrap(await pool.acquire("qwen", "p1"));
    pool.setStateKey(a, "same-key");
    pool.release("qwen", "p1", a);

    const other = wrap(await pool.acquire("qwen", "p2", "same-key"));
    assert.notEqual(other, a, "a different profile is a different browser identity");
  });
});
