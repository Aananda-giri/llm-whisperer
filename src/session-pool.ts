import type { Page } from "playwright";
import type { BrowserManager } from "./browser.js";

/**
 * A pool of browser tabs, keyed by provider x profile.
 *
 * Beyond pooling, a page carries **conversation state**: the key of the
 * conversation its tab is currently holding (see providers/conversation.ts).
 * `acquire` prefers a page whose state matches what the caller is about to
 * continue, which is what lets a stateless client (any coding agent) drive a
 * stateful chat website without its turns landing in a stranger's thread.
 *
 * Affinity here is strictly **best-effort**: `acquire` may hand back a page
 * with any state at all (an idle page of the wrong conversation, a brand-new
 * one, or one handed over directly by `release`). Callers must re-read
 * {@link stateKey} on the page they actually got and decide from that. Keeping
 * the guarantee out of the pool is what keeps the direct hand-off path in
 * `release` correct without a second affinity check.
 */
export class SessionPool {
  private idle = new Map<string, Page[]>();
  private active = new Map<string, number>();
  private waiters = new Map<string, ((page: Page) => void)[]>();
  /** page → the conversation key its tab holds. Absent ⇒ unknown/dirty. */
  private state = new Map<Page, string>();

  constructor(
    private browser: BrowserManager,
    private maxPerProvider = 2,
  ) {}

  async acquire(provider: string, profile: string, want?: string): Promise<Page> {
    const key = this.key(provider, profile);
    // Drain closed idle pages first. Every closed page must go, not just the
    // ones at the tail: the affinity scan below indexes into this array, and a
    // closed page in the middle would otherwise be a match nobody can use.
    const idle: Page[] = [];
    for (const page of this.idle.get(key) ?? []) {
      if (page.isClosed()) {
        this.state.delete(page);
        this.active.set(key, Math.max(0, (this.active.get(key) ?? 1) - 1));
      } else {
        idle.push(page);
      }
    }
    this.idle.set(key, idle);

    // Affinity: prefer the page already holding this conversation, so a
    // continuation does not have to replay the transcript into a fresh tab.
    if (want !== undefined) {
      const hit = idle.findIndex((p) => this.state.get(p) === want);
      if (hit !== -1) return idle.splice(hit, 1)[0];
    }

    if (idle.length > 0) return idle.pop()!;

    const active = this.active.get(key) ?? 0;
    if (active < this.maxPerProvider) {
      this.active.set(key, active + 1);
      return this.newPage(profile);
    }

    return new Promise<Page>((res) => {
      const queue = this.waiters.get(key) ?? [];
      queue.push(res);
      this.waiters.set(key, queue);
    });
  }

  release(provider: string, profile: string, page: Page): void {
    const key = this.key(provider, profile);
    if (page.isClosed()) {
      this.state.delete(page);
      this.active.set(key, Math.max(0, (this.active.get(key) ?? 1) - 1));
      this.drainOnClosed(key, profile);
      return;
    }

    const queue = this.waiters.get(key);
    const next = queue?.shift();
    if (next) {
      next(page);
      return;
    }

    const idle = this.idle.get(key) ?? [];
    idle.push(page);
    this.idle.set(key, idle);
  }

  /** The conversation this page's tab is holding, or undefined if unknown. */
  stateKey(page: Page): string | undefined {
    return this.state.get(page);
  }

  /** Record the conversation a page's tab now holds, after a clean turn. */
  setStateKey(page: Page, key: string): void {
    this.state.set(page, key);
  }

  /**
   * Forget what this page was holding. Called whenever the tab's thread stops
   * being trustworthy — an aborted or failed turn, a login flow, a health
   * check, or a warm-up navigation. A forgotten page simply replays on its
   * next turn, which is always safe; keeping a stale key is not.
   */
  clearState(page: Page): void {
    this.state.delete(page);
  }

  private key(provider: string, profile: string): string {
    return `${profile}\u0000${provider}`;
  }

  private async newPage(profile: string): Promise<Page> {
    try {
      const ctx = await this.browser.context(profile);
      return await ctx.newPage();
    } catch {
      // Shared context crashed; relaunch the whole browser and retry once.
      await this.browser.close();
      return (await this.browser.context(profile)).newPage();
    }
  }

  private async drainOnClosed(key: string, profile: string): Promise<void> {
    const queue = this.waiters.get(key);
    const next = queue?.shift();
    if (!next) return;
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
    next(await this.newPage(profile));
  }
}
