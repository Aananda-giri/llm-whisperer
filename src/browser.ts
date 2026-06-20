import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { BrowserContext } from "playwright";

// Stealth plugin masks the obvious "I'm an automated browser" tells that
// Cloudflare and friends look for. It's authored for puppeteer but
// playwright-extra adapts it.
chromium.use(StealthPlugin());

const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-default-browser-check",
  "--no-first-run",
];

/**
 * Manages one persistent browser context per provider. Persistent contexts
 * keep cookies/localStorage on disk, so a manual login survives restarts and
 * every later request reuses that authenticated session.
 */
export class BrowserManager {
  private contexts = new Map<string, Promise<BrowserContext>>();

  constructor(
    private profilesDir: string,
    private headless: boolean,
  ) {
    mkdirSync(resolve(profilesDir), { recursive: true });
  }

  /** Get (launching if needed) the persistent context for a provider. */
  context(provider: string, opts?: { headless?: boolean }): Promise<BrowserContext> {
    const existing = this.contexts.get(provider);
    if (existing) return existing;

    const headless = opts?.headless ?? this.headless;
    const userDataDir = resolve(this.profilesDir, provider);
    const launched = chromium.launchPersistentContext(userDataDir, {
      headless,
      viewport: { width: 1280, height: 900 },
      args: LAUNCH_ARGS,
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    this.contexts.set(provider, launched);
    return launched;
  }

  async close(provider?: string): Promise<void> {
    if (provider) {
      const ctx = this.contexts.get(provider);
      if (ctx) {
        await (await ctx).close();
        this.contexts.delete(provider);
      }
      return;
    }
    await Promise.all(
      [...this.contexts.values()].map(async (c) => (await c).close()),
    );
    this.contexts.clear();
  }
}
