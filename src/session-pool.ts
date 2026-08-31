import type { Page } from "playwright";
import type { BrowserManager } from "./browser.js";

export class SessionPool {
  private idle = new Map<string, Page[]>();
  private active = new Map<string, number>();
  private waiters = new Map<string, ((page: Page) => void)[]>();

  constructor(
    private browser: BrowserManager,
    private maxPerProvider = 2,
  ) {}

  async acquire(provider: string, profile: string): Promise<Page> {
    const key = this.key(provider, profile);
    // Drain stale idle pages first.
    const idle = this.idle.get(key) ?? [];
    while (idle.length > 0) {
      const page = idle.pop()!;
      if (!page.isClosed()) {
        this.idle.set(key, idle);
        return page;
      }
      this.active.set(key, Math.max(0, (this.active.get(key) ?? 1) - 1));
    }
    this.idle.set(key, idle);

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
