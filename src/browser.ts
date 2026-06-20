import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium as playwrightChromium } from "playwright";
import { chromium as stealthChromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, BrowserContext } from "playwright";

stealthChromium.use(StealthPlugin());

const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-default-browser-check",
  "--no-first-run",
];

/**
 * Manages one browser context per provider.
 *
 * Two modes (controlled by CDP_URL env var):
 *
 *  CDP mode  — Attaches to an already-running Chrome via `CDP_URL`
 *              (e.g. http://localhost:9222). All providers share the
 *              same browser; every provider gets its own incognito context
 *              so sessions don't bleed into each other.
 *              Use `pnpm run chrome` to start Chrome in this mode.
 *
 *  Profile mode (default) — Launches Playwright's bundled Chromium with a
 *              per-provider persistent profile under `PROFILES_DIR`.
 *              Run `pnpm run login <provider>` once to authenticate.
 */
export class BrowserManager {
  private contexts = new Map<string, Promise<BrowserContext>>();
  private cdpBrowser: Promise<Browser> | null = null;

  constructor(
    private profilesDir: string,
    private headless: boolean,
    private cdpUrl: string | null = process.env.CDP_URL ?? null,
  ) {
    if (!cdpUrl) {
      mkdirSync(resolve(profilesDir), { recursive: true });
    }
  }

  context(provider: string, opts?: { headless?: boolean }): Promise<BrowserContext> {
    const existing = this.contexts.get(provider);
    if (existing) return existing;

    const ctx = this.cdpUrl
      ? this.cdpContext(provider)
      : this.profileContext(provider, opts?.headless ?? this.headless);

    this.contexts.set(provider, ctx);
    return ctx;
  }

  private async cdpContext(provider: string): Promise<BrowserContext> {
    if (!this.cdpBrowser) {
      console.log(`[browser] Connecting to Chrome via CDP at ${this.cdpUrl}`);
      this.cdpBrowser = playwrightChromium.connectOverCDP(this.cdpUrl!);
    }
    const browser = await this.cdpBrowser;
    // Each provider gets its own incognito context so cookies don't mix.
    // Exception: providers that need the user's real logged-in session should
    // reuse the default context — but incognito + manual login-per-context is
    // fine for our use case.
    return browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
  }

  private profileContext(provider: string, headless: boolean): Promise<BrowserContext> {
    const userDataDir = resolve(this.profilesDir, provider);
    return stealthChromium.launchPersistentContext(userDataDir, {
      headless,
      viewport: { width: 1280, height: 900 },
      args: LAUNCH_ARGS,
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    }) as Promise<BrowserContext>;
  }

  async close(provider?: string): Promise<void> {
    if (provider) {
      const ctx = this.contexts.get(provider);
      if (ctx) {
        await (await ctx).close().catch(() => {});
        this.contexts.delete(provider);
      }
      return;
    }
    await Promise.all(
      [...this.contexts.values()].map(async (c) => (await c).close().catch(() => {})),
    );
    this.contexts.clear();
    if (this.cdpBrowser) {
      await (await this.cdpBrowser).close().catch(() => {});
    }
  }
}
