import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium as playwrightChromium } from "playwright";
import { chromium as stealthChromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { BrowserContext } from "playwright";

stealthChromium.use(StealthPlugin());

const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-default-browser-check",
  "--no-first-run",
];

/**
 * Single shared browser window; each provider gets a tab (Page) inside it.
 * All providers' sessions are stored together in `profilesDir/browser/` —
 * Chrome partitions cookies by origin, so qwen.ai, deepseek.com, etc. never
 * bleed into each other.
 *
 * Two modes (controlled by CDP_URL env var):
 *
 *  Profile mode (default) — Launches a browser (bundled Chromium by default, or
 *              the channel set via BROWSER, e.g. "chrome") with one shared
 *              persistent profile. Run `wspr login <provider>` (with serve
 *              stopped) once per provider to authenticate.
 *
 *  CDP mode — Attaches to an already-running Chrome via `CDP_URL`
 *              (e.g. http://localhost:9222). Reuses the browser's existing
 *              default context; no persistent profile needed.
 */
export class BrowserManager {
  private sharedContext: Promise<BrowserContext> | null = null;

  constructor(
    private profilesDir: string,
    private headless: boolean,
    /** Playwright channel (e.g. "chrome"); undefined ⇒ bundled Chromium. */
    private channel?: string,
    private cdpUrl: string | null = process.env.CDP_URL ?? null,
  ) {}

  context(opts?: { headless?: boolean }): Promise<BrowserContext> {
    if (this.cdpUrl) {
      if (!this.sharedContext) this.sharedContext = this.cdpContext();
      return this.sharedContext;
    }
    if (!this.sharedContext) {
      this.sharedContext = this.profileContext(opts?.headless ?? this.headless);
    }
    return this.sharedContext;
  }

  private async cdpContext(): Promise<BrowserContext> {
    console.log(`[browser] Connecting to Chrome via CDP at ${this.cdpUrl}`);
    const browser = await playwrightChromium.connectOverCDP(this.cdpUrl!);
    return browser.contexts()[0] ?? browser.newContext({ viewport: { width: 1280, height: 900 } });
  }

  private profileContext(headless: boolean): Promise<BrowserContext> {
    const userDataDir = resolve(join(this.profilesDir, "browser"));
    mkdirSync(userDataDir, { recursive: true });
    if (this.channel) {
      console.log(`[browser] Launching ${this.channel} with profile ${userDataDir}`);
    }
    return stealthChromium.launchPersistentContext(userDataDir, {
      channel: this.channel,
      headless,
      viewport: { width: 1280, height: 900 },
      args: LAUNCH_ARGS,
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    }) as Promise<BrowserContext>;
  }

  async close(): Promise<void> {
    if (this.sharedContext) {
      await (await this.sharedContext).close().catch(() => {});
      this.sharedContext = null;
    }
  }
}
