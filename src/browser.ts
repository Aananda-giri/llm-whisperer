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

export const DEFAULT_BROWSER_PROFILE = "default";

/** Keep profile names safe to use as a directory name. */
export function validateBrowserProfile(profile: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) {
    throw new Error(
      `Invalid browser profile "${profile}". Use 1-64 letters, numbers, dots, underscores, or hyphens.`,
    );
  }
  return profile;
}

/**
 * One persistent browser context per named profile. Providers sharing a profile
 * get tabs in the same browser; separate profiles have isolated cookies and
 * local storage. The legacy `browser/` directory remains the `default` profile.
 *
 * Two modes (controlled by CDP_URL env var):
 *
 *  Profile mode (default) — Launches a browser (bundled Chromium by default, or
 *              the channel set via WSPR_BROWSER_CHANNEL, e.g. "chrome") with one
 *              shared persistent profile. Run `wspr login <provider>` (with serve
 *              stopped) once per provider to authenticate.
 *
 *  CDP mode — Attaches to an already-running Chrome via `CDP_URL`
 *              (e.g. http://localhost:9222). Reuses the browser's existing
 *              default context; no persistent profile needed.
 */
export class BrowserManager {
  private contexts = new Map<string, Promise<BrowserContext>>();

  constructor(
    private profilesDir: string,
    private headless: boolean,
    /** Playwright channel (e.g. "chrome"); undefined ⇒ bundled Chromium. */
    private channel?: string,
    private cdpUrl: string | null = process.env.CDP_URL ?? null,
  ) {}

  context(profile: string = DEFAULT_BROWSER_PROFILE, opts?: { headless?: boolean }): Promise<BrowserContext> {
    validateBrowserProfile(profile);
    if (this.cdpUrl) {
      if (profile !== DEFAULT_BROWSER_PROFILE) {
        throw new Error("Named browser profiles are unavailable when CDP_URL is set. Start a separate wspr server for each CDP browser.");
      }
      const context = this.contexts.get(profile) ?? this.cdpContext();
      this.contexts.set(profile, context);
      return context;
    }
    const context = this.contexts.get(profile) ?? this.profileContext(profile, opts?.headless ?? this.headless);
    this.contexts.set(profile, context);
    return context;
  }

  private async cdpContext(): Promise<BrowserContext> {
    console.log(`[browser] Connecting to Chrome via CDP at ${this.cdpUrl}`);
    const browser = await playwrightChromium.connectOverCDP(this.cdpUrl!);
    return browser.contexts()[0] ?? browser.newContext({ viewport: { width: 1280, height: 900 } });
  }

  private profileContext(profile: string, headless: boolean): Promise<BrowserContext> {
    // Preserve existing installations: their shared browser directory is the default profile.
    const userDataDir = resolve(join(
      this.profilesDir,
      profile === DEFAULT_BROWSER_PROFILE ? "browser" : "browser-profiles",
      ...(profile === DEFAULT_BROWSER_PROFILE ? [] : [profile]),
    ));
    mkdirSync(userDataDir, { recursive: true });
    console.log(`[browser] Launching ${this.channel ?? "Chromium"} with profile "${profile}" at ${userDataDir}`);
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
    const contexts = [...this.contexts.values()];
    this.contexts.clear();
    await Promise.all(contexts.map(async (context) => (await context).close().catch(() => {})));
  }
}
