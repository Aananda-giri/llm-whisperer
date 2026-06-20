import type { Page } from "playwright";
import type { BrowserManager } from "./browser.js";

/**
 * Pools and reuses pages per provider so N requests don't open N browsers.
 * Each provider is capped at `maxPerProvider` concurrent pages; extra
 * acquirers wait in a FIFO queue until one is released.
 */
export class SessionPool {
  private idle = new Map<string, Page[]>();
  private active = new Map<string, number>();
  private waiters = new Map<string, ((page: Page) => void)[]>();

  constructor(
    private browser: BrowserManager,
    private maxPerProvider = 2,
  ) {}

  async acquire(provider: string): Promise<Page> {
    const idle = this.idle.get(provider) ?? [];
    const page = idle.pop();
    if (page && !page.isClosed()) {
      this.idle.set(provider, idle);
      return page;
    }

    const active = this.active.get(provider) ?? 0;
    if (active < this.maxPerProvider) {
      this.active.set(provider, active + 1);
      const ctx = await this.browser.context(provider);
      return ctx.newPage();
    }

    // At capacity — wait for a release.
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

  // When a released page was already closed, a waiter still needs a fresh page.
  private async drainOnClosed(provider: string): Promise<void> {
    const queue = this.waiters.get(provider);
    const next = queue?.shift();
    if (!next) return;
    const active = this.active.get(provider) ?? 0;
    this.active.set(provider, active + 1);
    const ctx = await this.browser.context(provider);
    next(await ctx.newPage());
  }
}
