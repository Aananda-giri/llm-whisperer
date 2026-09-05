import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import type { SessionPool } from "../session-pool.js";
import { confirmSession, type SessionState } from "./session.js";

export interface HealthTarget {
  provider: string;
  profile: string;
}


export interface HealthRow {
  provider: string;
  profile: string;
  /** True only for a positively confirmed session (`state === "in"`). */
  loggedIn: boolean;
  state: SessionState;
  /** ISO timestamp of when this row was measured. */
  checkedAt: string;
  error?: string;
}

/** How long a cached health result is trusted without re-running a browser. */
const CACHE_TTL_MS = 60_000;

/**
 * Run a live login check for each target using the shared SessionPool (so it
 * needs no second browser stack). One page per provider×profile, checked via
 * {@link isLoggedIn} and immediately released. The result is persisted to
 * <profilesDir>/health.json so the dashboard can render it without spawning a
 * browser on every page load.
 */
export async function checkSessions(
  pool: SessionPool,
  config: AppConfig,
  targets: HealthTarget[],
): Promise<HealthRow[]> {
  const rows: HealthRow[] = [];
  for (const t of targets) {
    const cfg = config.providers[t.provider];
    if (!cfg || cfg.api || !cfg.requiresLogin) continue;

    const row: HealthRow = {
      provider: t.provider,
      profile: t.profile,
      loggedIn: false,
      state: "unknown",
      checkedAt: new Date().toISOString(),
    };
    const page = await pool.acquire(t.provider, t.profile);
    try {
      // A pooled page may be blank (freshly created) or already parked on the
      // site. Navigate only when we are not on the right origin — the same
      // rule WebLLMProvider.ensureOnPage uses, so an open conversation is not
      // reloaded out from under a live session. Without this the check runs
      // against about:blank, where no loggedOutSelector is visible and every
      // provider would falsely report a healthy session.
      if (!page.url().startsWith(new URL(cfg.url).origin)) {
        await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        // The navigation discarded whatever conversation this tab held, so the
        // pool must stop believing it still holds it. Only on this branch: the
        // no-navigation case above deliberately leaves a live thread alone.
        pool.clearState(page);
      }
      row.state = await confirmSession(page, cfg);
      row.loggedIn = row.state === "in";
    } catch (e) {
      row.error = (e as Error).message;
    } finally {
      pool.release(t.provider, t.profile, page);
    }
    rows.push(row);
  }
  saveHealthCache(config, rows);
  return rows;
}

/** Read the last cached health run without touching a browser. */
export function readHealthCache(config: AppConfig): HealthRow[] {
  const file = healthFile(config);
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as { checkedAt: string; rows: HealthRow[] };
    return Array.isArray(data.rows) ? data.rows : [];
  } catch {
    return [];
  }
}

function saveHealthCache(config: AppConfig, rows: HealthRow[]): void {
  const file = healthFile(config);
  writeFileSync(file, JSON.stringify({ checkedAt: new Date().toISOString(), rows }, null, 2));
}

function healthFile(config: AppConfig): string {
  return join(config.profilesDir, "health.json");
}

export { CACHE_TTL_MS };
