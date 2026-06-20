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

  async acquire(provider: string): Promise<Page> {
    // Drain stale idle pages first.
    const idle = this.idle.get(provider) ?? [];
    while (idle.length > 0) {
      const page = idle.pop()!;
      if (!page.isClosed()) {
        this.idle.set(provider, idle);
        return page;
      }
      this.active.set(provider, Math.max(0, (this.active.get(provider) ?? 1) - 1));
    }
    this.idle.set(provider, idle);

    const active = this.active.get(provider) ?? 0;
    if (active < this.maxPerProvider) {
      this.active.set(provider, active + 1);
      return this.newPage(provider);
    }

    return new Promise<Page>((res) => {
      const queue = this.waiters.get(provider) ?? [];
      queue.push(res);
      this.waiters.set(provider, queue);
    });
  }

  release(provider: string, page: Page): void {
    if (page.isClosed()) {
      this.active.set(provider, Math.max(0, (this.active.get(provider) ?? 1) - 1));
      this.drainOnClosed(provider);
      return;
    }

    const queue = this.waiters.get(provider);
    const next = queue?.shift();
    if (next) {
      next(page);
      return;
    }

    const idle = this.idle.get(provider) ?? [];
    idle.push(page);
    this.idle.set(provider, idle);
  }

  private async newPage(_provider: string): Promise<Page> {
    try {
      const ctx = await this.browser.context();
      return await ctx.newPage();
    } catch {
      // Shared context crashed; relaunch the whole browser and retry once.
      await this.browser.close();
      return (await this.browser.context()).newPage();
    }
  }

  private async drainOnClosed(provider: string): Promise<void> {
    const queue = this.waiters.get(provider);
    const next = queue?.shift();
    if (!next) return;
    this.active.set(provider, (this.active.get(provider) ?? 0) + 1);
    next(await this.newPage(provider));
  }
}
