import type { Page } from "playwright";
import type { ProviderConfig } from "../config.js";

/**
 * The one success predicate for a browser session: is this page showing a
 * logged-in chat surface? Never throws — every check is guarded so a DOM
 * transition can't crash the caller mid-poll.
 *
 * This is the only thing that decides whether a login attempt worked. It is
 * shared by the request-time guard (`ensureLoggedIn`), the sentinel write in
 * `wspr login`, and the session-health checker — so the three never disagree
 * about what "logged in" means.
 *
 * Two strategies, in order:
 *  1. If the provider configures `loggedOutSelector`, its visibility is the
 *     source of truth: visible ⇒ logged out.
 *  2. Otherwise fall back to "is the prompt input visible?" — a chat surface
 *     has one; a login screen usually does not.
 */
export async function isLoggedIn(page: Page, cfg: ProviderConfig): Promise<boolean> {
  if (cfg.loggedOutSelector) {
    const out = await page
      .locator(cfg.loggedOutSelector)
      .first()
      .isVisible()
      .catch(() => false);
    return !out;
  }

  const input = page.locator(cfg.inputSelector).first();
  const visible = await input.isVisible().catch(() => false);
  return visible;
}

/**
 * Three states, because two would lie. {@link isLoggedIn} answers "is the
 * logged-out marker absent?", and for the providers whose selectors have never
 * been live-verified (wiki §5.5) absent usually means the selector is simply
 * wrong — not that a session exists. Anything reporting a session to a human
 * needs the stronger, positive form.
 *
 * - `in`      — logged-out marker absent *and* the chat input is present.
 * - `out`     — logged-out marker visible.
 * - `unknown` — neither: the page matched none of this provider's selectors.
 */
export type SessionState = "in" | "out" | "unknown";

/** Positive confirmation of a session. Never throws. */
export async function confirmSession(page: Page, cfg: ProviderConfig): Promise<SessionState> {
  if (!(await isLoggedIn(page, cfg))) return "out";
  const hasInput = await page
    .locator(cfg.inputSelector)
    .first()
    .isVisible()
    .catch(() => false);
  return hasInput ? "in" : "unknown";
}
