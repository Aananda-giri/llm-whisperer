import type { Page } from "playwright";
import type { ProviderConfig } from "../config.js";
import type { Credential } from "./vault.js";
import { isLoggedIn } from "./session.js";

/** Budget for optional steps (trigger / continue) that may legitimately be absent. */
const OPTIONAL_STEP_MS = 5000;

export interface AttemptResult {
  ok: boolean;
  reason?: string;
}

/**
 * One login attempt, driven entirely by the provider's declarative `login:`
 * block. Never retries — a wrong password is attempted once, because repeated
 * failures lock accounts. On failure it screenshots to /tmp and returns a
 * reason; it never throws, so the caller can fall back to the manual flow.
 *
 * Steps (each guarded — a mid-DOM transition must not crash the caller):
 *   trigger click → fill email → optional continue click → fill password →
 *   submit → wait for successSelector (default inputSelector) → confirm with
 *   isLoggedIn().
 */
export async function attemptLogin(
  page: Page,
  cfg: ProviderConfig,
  cred: Credential,
): Promise<AttemptResult> {
  const login = cfg.login;
  if (!login) return { ok: false, reason: "no login block configured" };

  const fail = (reason: string): AttemptResult => {
    const name = cleanName(cfg.url);
    void page.screenshot({ path: `/tmp/${name}-login-fail.png` }).catch(() => {});
    return { ok: false, reason };
  };

  // Manual method: autofill the email, then hand the tab to the human.
  if (login.method === "manual") {
    try {
      await type(page, login.emailSelector, cred.email, 15000);
    } catch {
      // Email may already be present (magic-link trips forward to chat).
    }
    return { ok: false, reason: "manual login — email autofilled; log in by hand" };
  }

  const password = cred.password;
  if (!password) {
    return { ok: false, reason: "credential has no password" };
  }

  const timeoutMs = login.timeoutMs ?? 60000;
  // Optional steps get a short budget of their own. They are allowed to be
  // absent, so waiting the full login timeout for a selector that will never
  // appear just burns a minute per provider — painful across `login --all`.
  const optionalMs = Math.min(OPTIONAL_STEP_MS, timeoutMs);

  // 1. Optional trigger click to open the form.
  if (login.trigger) {
    await page.locator(login.trigger).first().click({ timeout: optionalMs }).catch(() => {});
  }

  // 2. Email.
  try {
    await type(page, login.emailSelector, cred.email, timeoutMs);
  } catch {
    return fail(`could not fill email selector "${login.emailSelector}"`);
  }

  // 3. Optional two-step (email → Continue → password).
  if (login.continueSelector) {
    await page.locator(login.continueSelector).first().click({ timeout: optionalMs }).catch(() => {});
    await page.waitForTimeout(600);
  }

  // 4. Password.
  try {
    await type(page, login.passwordSelector!, password, timeoutMs);
  } catch {
    return fail(`could not fill password selector "${login.passwordSelector}"`);
  }

  // 5. Submit.
  if (login.submitSelector) {
    try {
      await page.locator(login.submitSelector).first().click({ timeout: timeoutMs });
    } catch {
      return fail(`could not click submit "${login.submitSelector}"`);
    }
  }

  // 6. Wait for the success surface (default: the chat input selector).
  const success = login.successSelector || cfg.inputSelector;
  try {
    await page.locator(success).first().waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return fail(`timed out waiting for the login surface "${success}"`);
  }

  // 7. Confirm with the shared success predicate — never trust a selector alone.
  if (await isLoggedIn(page, cfg)) return { ok: true };
  await page.waitForTimeout(1500);
  return (await isLoggedIn(page, cfg))
    ? { ok: true }
    : { ok: false, reason: "page did not report a logged-in chat surface" };
}

/** Fill a single field, waiting for it to be visible. */
async function type(page: Page, selector: string, value: string, timeoutMs: number): Promise<void> {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: "visible", timeout: timeoutMs });
  await loc.fill(value);
}

/** A filesystem-safe provider name derived from its URL (for screenshots). */
function cleanName(url: string): string {
  const host = url.replace(/^https?:\/\//, "").split("/")[0] || "provider";
  return host.replace(/[^A-Za-z0-9._-]/g, "_");
}
