#!/usr/bin/env node
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { DEFAULT_BROWSER_PROFILE, validateBrowserProfile, BrowserManager } from "./browser.js";
import { listModels, listProfiles } from "./models.js";
import { CLIENT_TARGETS, clientTargets } from "./clients.js";
import { SessionPool } from "./session-pool.js";
import { createServer } from "./server.js";
import {
  Credential,
  openVault,
  VaultHandle,
  WrongPassphraseError,
  type Vault,
  type CredentialVault,
} from "./credentials/vault.js";
import { attemptLogin } from "./credentials/login.js";
import { isLoggedIn } from "./credentials/session.js";
import { checkSessions, readHealthCache } from "./credentials/health.js";
import { prompt } from "./credentials/prompt.js";

/** Sentinel file marking a provider×profile session as saved. */
function sentinelPath(profilesDir: string, provider: string, profile: string): string {
  const dir = join(profilesDir, provider);
  // Legacy layout: the default profile keeps the old `.logged-in` name.
  return join(dir, profile === DEFAULT_BROWSER_PROFILE ? ".logged-in" : `${profile}.logged-in`);
}

function vaultOptions(config: ReturnType<typeof loadConfig>): {
  filePath: string;
  providers: readonly string[];
} {
  return {
    filePath: join(config.profilesDir, "credentials.enc"),
    providers: Object.keys(config.providers),
  };
}

/** Passphrase from WSPR_VAULT_KEY, else a hidden interactive prompt. */
async function resolveVaultPassphrase(): Promise<string> {
  const envKey = process.env.WSPR_VAULT_KEY?.trim();
  if (envKey) return envKey;
  return (await prompt("Vault passphrase: ", true)).trim();
}

/** Open the vault for the CLI when there is something to read. */
async function openVaultFor(config: ReturnType<typeof loadConfig>): Promise<CredentialVault | undefined> {
  const opts = vaultOptions(config);
  if (!existsSync(opts.filePath) && !process.env.WSPR_VAULT_KEY) return undefined;
  const pass = await resolveVaultPassphrase();
  if (!pass) return undefined;
  return openVault(pass, opts);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  const isHelp = command === "--help" || command === "-h";
  if (!command || isHelp) {
    console.log(`🤫 llm-whisperer — one quiet API for every LLM

Usage:
  wspr serve                  Start the local API on PORT (default 9777)
  wspr login <name> [profile] Open a browser tab to log in; session is saved
                              under the given browser profile (default "${DEFAULT_BROWSER_PROFILE}")
  wspr login --all [profile]  Auto-login every provider that has a password
                              credential in the vault
  wspr status [profile]       Live login grid for every browser provider
                              (--cached reads the last run, no browser)
  wspr list                   List configured providers
  wspr creds set <name> [profile]   Store email/password (echo-off) for a provider
  wspr creds list [profile]   List stored credentials (password never shown)
  wspr creds show <name> [profile]  The only way to read a password back
  wspr creds rm <name> [profile]    Remove a stored credential
  wspr profiles             List declared + discovered API profiles
  wspr models [profile]     List the models a profile exposes
  wspr config <client> [profile]   Emit a client config for opencode, openai,
                              anthropic, or continue (--out <file>, --base-url <url>)

Environment:
  PORT                 API port (default 9777)
  WSPR_HOST            bind address (default 127.0.0.1 — loopback only)
  HEADLESS             true/false — hide the browser (default false)
  WSPR_BROWSER_CHANNEL browser channel: chromium (default), chrome, msedge, …
  WSPR_WARM            true/false — pre-open browser tabs at startup (default false;
                       otherwise they launch lazily on the first browser request)
  WSPR_BROWSER_PROFILE default browser profile for logins and requests (default "${DEFAULT_BROWSER_PROFILE}")
  PROFILES_DIR         where to store login sessions (default ~/.config/llm-whisperer/profiles)
  PROVIDERS_FILE       path to a custom providers.yaml
  WSPR_VAULT_KEY       passphrase that unlocks the encrypted credential vault
                       (otherwise wspr prompts for it, hidden)
  WSPR_AUTO_LOGIN      true (default when a vault is unlocked) / false`);
    process.exit(isHelp ? 0 : 1);
  }

  const config = loadConfig();

  switch (command) {
    case "serve":
      return serve(config);
    case "login":
      return login(config, rest);
    case "list":
      console.log("Providers:", Object.keys(config.providers).join(", "));
      return;
    case "creds":
      return creds(config, rest);
    case "status":
      return status(config, rest);
    case "profiles":
      return profilesCmd(config);
    case "models":
      return modelsCmd(config, rest);
    case "config":
      return configCmd(config, rest);
    default:
      console.error(`Unknown command: ${command}. Run wspr --help.`);
      process.exit(1);
  }
}

async function serve(config: ReturnType<typeof loadConfig>) {
  const browser = new BrowserManager(config.profilesDir, config.headless, config.browserChannel);
  const pool = new SessionPool(browser);

  // One vault per process. Unlock at startup only if a passphrase is provided;
  // otherwise it stays locked and the dashboard (or WSPR_VAULT_KEY) unlocks it.
  const vault = new VaultHandle(vaultOptions(config));
  if (process.env.WSPR_VAULT_KEY) {
    try {
      await vault.unlock(process.env.WSPR_VAULT_KEY.trim());
    } catch (e) {
      console.warn(`Could not unlock vault with WSPR_VAULT_KEY: ${(e as Error).message}`);
    }
  }

  const uiToken = process.env.WSPR_UI_TOKEN?.trim() || randomBytes(16).toString("hex");
  const app = createServer(config, pool, vault, uiToken);

  const missingKeys = Object.entries(config.providers)
    .filter(([, c]) => c.api && !process.env[c.api.keyEnv])
    .map(([name, c]) => `  ⚠ ${name}: set ${c.api!.keyEnv}=... in .env or export it`);
  if (missingKeys.length > 0) {
    console.warn("\nMissing API keys — API providers will fail until configured:");
    console.warn(missingKeys.join("\n"));
    console.warn("\n  Copy .env.example to .env and fill in your keys, or set them in your shell.\n");
  }

  console.log(`
       🤫
  l l m - w h i s p e r e r
  one quiet API for every LLM
`);

  const server = app.listen(config.port, config.host, () => {
    console.log(`listening on http://${config.host}:${config.port}`);
    console.log(`Providers: ${Object.keys(config.providers).join(", ")}`);
    console.log(`Profiles:  ${config.profilesDir} (default browser profile "${config.browserProfile}")`);
    if (config.host === "127.0.0.1") {
      console.log("Bound to loopback only — set WSPR_HOST=0.0.0.0 to expose it.");
    }
    console.log(`Dashboard: http://127.0.0.1:${config.port}/ui?token=${uiToken}`);
    if (vault.locked) {
      console.log('Vault locked (set WSPR_VAULT_KEY or unlock from the dashboard).');
    }
  });

  const shutdown = async () => {
    console.log("\nShutting down...");
    server.close();
    await browser.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (config.warmTabs) {
    await warmProviders(config, pool);
  } else {
    console.log(
      "Browser tabs launch on first use (set WSPR_WARM=true to pre-open them at startup).",
    );
  }
}

async function warmProviders(
  config: ReturnType<typeof loadConfig>,
  pool: SessionPool,
) {
  const names = Object.keys(config.providers).filter((name) => {
    const cfg = config.providers[name];
    if (cfg.api) return false; // API providers have no browser tab to warm
    // Only warm the default profile; named profiles launch lazily.
    if (cfg.profile !== DEFAULT_BROWSER_PROFILE) return false;
    if (!cfg.requiresLogin) return true;
    return existsSync(sentinelPath(config.profilesDir, name, DEFAULT_BROWSER_PROFILE));
  });

  if (names.length === 0) {
    console.log("No saved sessions found. Run `wspr login <provider>` to log in.");
    return;
  }

  console.log(`Warming tabs: ${names.join(", ")}...`);
  for (const name of names) {
    const cfg = config.providers[name];
    try {
      const page = await pool.acquire(name, DEFAULT_BROWSER_PROFILE);
      await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      pool.release(name, DEFAULT_BROWSER_PROFILE, page);
      console.log(`  ✓ ${name} ready`);
    } catch (e) {
      console.warn(`  ✗ ${name} failed to warm: ${(e as Error).message}`);
    }
  }
}

/** The single-provider login flow. Shared by `wspr login` and `--all`.
 * Returns true if the session was saved (i.e. the page really logged in).
 * Throws a fatal, per-provider error on browser-open failure. */
async function loginOne(
  config: ReturnType<typeof loadConfig>,
  name: string,
  profile: string,
  vault: Vault | undefined,
  /**
   * May this call block waiting for a human? False under `--all`, where a
   * single unattended provider would otherwise hang the whole batch on stdin
   * forever.
   */
  interactive = true,
): Promise<boolean> {
  const provider = config.providers[name];

  const browser = new BrowserManager(config.profilesDir, false, config.browserChannel);
  let ctx: Awaited<ReturnType<typeof browser.context>>;
  try {
    ctx = await browser.context(profile, { headless: false });
  } catch (e) {
    throw new Error(
      `Could not open the browser. If "wspr serve" is running, stop it first —` +
        ` Chrome locks each profile to one process at a time.\n${(e as Error).message}`,
    );
  }

  const page = await ctx.newPage();
  await page.goto(provider.url, { waitUntil: "domcontentloaded" });

  // Auto-login attempt. On success we skip the manual Enter entirely.
  let autoLoggedIn = false;
  const cred = vault?.get(profile, name);
  if (cred && provider.login) {
    if (cred.method === "manual") {
      const res = await attemptLogin(page, provider, cred);
      console.log(`Sent email for "manual" login (${res.reason ?? "awaiting you"}) — complete it in the tab, then press Enter.`);
    } else {
      const res = await attemptLogin(page, provider, cred);
      autoLoggedIn = res.ok;
      if (!autoLoggedIn) {
        console.log(`Auto-login did not succeed (${res.reason ?? "unknown reason"}).`);
      }
    }
  }

  if (autoLoggedIn) {
    console.log("Logged in automatically.");
  } else if (interactive) {
    console.log(`\nA browser tab opened at ${provider.url} (profile "${profile}")`);
    console.log("Log in, get to the chat screen, then press Enter to save the session.");
    await new Promise<void>((res) => {
      process.stdin.resume();
      process.stdin.once("data", () => {
        process.stdin.pause();
        res();
      });
    });
  } else {
    // Batch mode: don't wait on a human. Skip and report; the operator can
    // run `wspr login <name>` for the ones that need hands.
    console.log("Skipped — needs a manual login. Run: wspr login " + name + " " + profile);
  }

  // The sentinel is honest: only written when the page really shows a chat screen.
  const loggedIn = await isLoggedIn(page, provider).catch(() => false);
  await browser.close();

  const sentinelFile = sentinelPath(config.profilesDir, name, profile);
  if (loggedIn) {
    mkdirSync(dirname(sentinelFile), { recursive: true });
    writeFileSync(sentinelFile, new Date().toISOString());
    console.log(`Session saved for "${name}" in profile "${profile}".`);
    return true;
  }
  console.error(
    `Not saved for "${name}" (profile "${profile}") — the page did not report a ` +
      `logged-in chat surface. Fix the selectors in providers.yaml and retry.`,
  );
  return false;
}

async function login(config: ReturnType<typeof loadConfig>, args: string[]) {
  const isAll = args[0] === "--all" || args[0] === "-a";

  if (isAll) {
    const profile = validateBrowserProfile(args[1] ?? config.browserProfile);
    const vault = await openVaultFor(config);
    if (!vault) {
      console.error("No vault (set WSPR_VAULT_KEY or create credentials with `wspr creds set`).");
      process.exit(1);
    }
    const targets = Object.entries(config.providers).filter(
      ([n, c]) => !c.api && c.requiresLogin && c.login && vault.get(profile, n)?.method === "password",
    );
    if (targets.length === 0) {
      console.log(`No providers with a password credential for profile "${profile}".`);
      process.exit(0);
    }
    console.log(`Logging in: ${targets.map(([n]) => n).join(", ")} (profile "${profile}")…`);
    const done: string[] = [];
    const failed: string[] = [];
    for (const [n] of targets) {
      console.log(`\n── ${n} ──`);
      try {
        (await loginOne(config, n, profile, vault, false)) ? done.push(n) : failed.push(n);
      } catch (e) {
        console.error(`  ✗ ${n}: ${(e as Error).message}`);
        failed.push(n);
      }
    }
    console.log(`\n${done.length}/${targets.length} logged in.`);
    if (done.length) console.log(`  ✓ ${done.join(", ")}`);
    if (failed.length) {
      console.log(`  ✗ ${failed.join(", ")}`);
      console.log(`Run \`wspr login <name> ${profile}\` for those to finish by hand.`);
    }
    process.exit(failed.length === 0 ? 0 : 1);
  }

  const name = args[0];
  const profileArg = args[1];
  if (!name || !config.providers[name]) {
    console.error(`Specify a provider: ${Object.keys(config.providers).join(", ")}`);
    process.exit(1);
  }
  const provider = config.providers[name];
  if (provider.api) {
    console.error(
      `"${name}" is an API-key provider — set ${provider.api.keyEnv}=... in .env instead of logging in.`,
    );
    process.exit(1);
  }

  const profile = validateBrowserProfile(profileArg ?? provider.profile ?? config.browserProfile);
  const vault = await openVaultFor(config);
  try {
    const ok = await loginOne(config, name, profile, vault);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

/**
 * `wspr status [profile]` — a live provider×profile login grid.
 *
 * This launches a browser, so it needs the profile's Chromium lock: it works
 * when `wspr serve` is *stopped*. While the server is running, the same check
 * is available inside it (the /ui dashboard's "Re-check" button), which is the
 * process that already holds the lock. `--cached` skips the browser entirely
 * and prints the last run.
 */
async function status(config: ReturnType<typeof loadConfig>, args: string[]) {
  const cachedOnly = args.includes("--cached") || args.includes("-c");
  const profileArg = args.find((a) => !a.startsWith("-"));
  const profile = validateBrowserProfile(profileArg ?? config.browserProfile);

  // Every browser provider that needs a login, under the chosen profile.
  const targets = Object.entries(config.providers)
    .filter(([, c]) => !c.api && c.requiresLogin)
    .map(([provider]) => ({ provider, profile }));

  if (targets.length === 0) {
    console.log("No browser providers require a login.");
    return;
  }

  const vault = await openVaultFor(config).catch(() => undefined);

  let rows;
  if (cachedOnly) {
    rows = readHealthCache(config).filter((r) => r.profile === profile);
    if (rows.length === 0) {
      console.log("No cached results. Run `wspr status` without --cached to check live.");
      return;
    }
  } else {
    const browser = new BrowserManager(config.profilesDir, true, config.browserChannel);
    const pool = new SessionPool(browser);
    try {
      console.log(`Checking ${targets.length} provider(s) in profile "${profile}"…\n`);
      rows = await checkSessions(pool, config, targets);
    } catch (e) {
      console.error(
        `Could not open the browser. If "wspr serve" is running, stop it first —` +
          ` Chrome locks each profile to one process at a time.` +
          ` (Or use \`wspr status --cached\`, or the /ui dashboard.)\n${(e as Error).message}`,
      );
      process.exit(1);
    } finally {
      await browser.close();
    }
  }

  const pad = (v: string, n: number) => v.padEnd(n);
  console.log(
    `${pad("Provider", 12)}${pad("Profile", 12)}${pad("Session", 14)}${pad("Credential", 12)}Checked`,
  );
  let live = 0;
  for (const r of rows) {
    const cred = vault?.get(r.profile, r.provider);
    const credCol = !cred
      ? "—"
      : cred.method === "password"
        ? "password"
        : "manual";
    const session = r.error
      ? "error"
      : r.state === "in"
        ? "logged in"
        : r.state === "out"
          ? "LOGGED OUT"
          : "unknown";
    if (r.loggedIn) live++;
    console.log(
      `${pad(r.provider, 12)}${pad(r.profile, 12)}${pad(session, 14)}${pad(credCol, 12)}${r.checkedAt}`,
    );
    if (r.error) console.log(`             ${r.error}`);
  }

  console.log(`\n${live}/${rows.length} logged in.`);

  const unknown = rows.filter((r) => r.state === "unknown" && !r.error).map((r) => r.provider);
  if (unknown.length) {
    console.log(
      `\n"unknown" means the page matched neither this provider's loggedOutSelector\n` +
        `nor its inputSelector — the selectors in providers.yaml are probably stale.\n` +
        `  ${unknown.join(", ")}`,
    );
  }

  const out = rows.filter((r) => r.state === "out").map((r) => r.provider);
  if (out.length) {
    console.log(`\nLog in with: wspr login ${out[0]} ${profile}` + (out.length > 1 ? `  (or \`wspr login --all ${profile}\`)` : ""));
  }
  process.exit(out.length === 0 && unknown.length === 0 ? 0 : 1);
}

async function creds(config: ReturnType<typeof loadConfig>, args: string[]) {
  const sub = args[0];
  const provider = args[1];
  const profileArg = args[2];

  if (sub !== "set" && sub !== "list" && sub !== "show" && sub !== "rm") {
    console.error(`Usage: wspr creds <set|list|show|rm> [name] [profile]`);
    process.exit(1);
  }

  const opts = vaultOptions(config);

  // `list` needs the vault even if it does not exist yet (empty table).
  const vault = await openVaultFor(config);
  if (!vault) {
    if (sub === "list") {
      console.log("No credentials stored yet. Use `wspr creds set <provider>` to add one.");
      return;
    }
    console.error("Vault not found. Set WSPR_VAULT_KEY or run `wspr creds set` first.");
    process.exit(1);
  }

  if (sub === "set") {
    if (!provider || !config.providers[provider] || config.providers[provider].api) {
      console.error(`Specify a browser provider: ${Object.keys(config.providers).filter((n) => !config.providers[n].api).join(", ")}`);
      process.exit(1);
    }
    const profile = validateBrowserProfile(profileArg ?? config.browserProfile);
    const email = (await prompt("Email/username: ")).trim();
    const password = await prompt("Password (hidden; press Enter for manual login): ", true);
    const method = password ? "password" : "manual";
    const cred = new Credential(email, method, new Date().toISOString(), password || undefined);
    await vault.set(profile, provider, cred);
    console.log(`Saved ${method} credential for "${provider}" in profile "${profile}".`);
    return;
  }

  if (sub === "list") {
    const rows = vault.listRedacted(profileArg ? validateBrowserProfile(profileArg) : undefined);
    if (rows.length === 0) {
      console.log("No credentials stored.");
      return;
    }
    console.log("Provider      Profile            Email              Method    Password  Updated");
    for (const r of rows) {
      console.log(
        `${r.provider.padEnd(13)} ${r.profile.padEnd(18)} ${r.email.padEnd(17)} ${r.method.padEnd(9)} ${(r.hasPassword ? "••••••" : "none").padEnd(8)}   ${r.updatedAt}`,
      );
    }
    console.log("\n(Passwords are never shown. Use `wspr creds show <provider>` to read one back.)");
    return;
  }

  if (sub === "rm") {
    if (!provider) {
      console.error("Specify a provider to remove.");
      process.exit(1);
    }
    const profile = validateBrowserProfile(profileArg ?? config.browserProfile);
    await vault.remove(profile, provider);
    console.log(`Removed credential for "${provider}" in profile "${profile}".`);
    return;
  }

  // show — the only way to read a password back.
  if (!provider) {
    console.error("Specify a provider to show.");
    process.exit(1);
  }
  const profile = validateBrowserProfile(profileArg ?? config.browserProfile);
  const cred = vault.get(profile, provider);
  if (!cred) {
    console.error(`No credential for "${provider}" in profile "${profile}".`);
    process.exit(1);
  }
  console.log(`provider: ${provider}`);
  console.log(`profile:  ${profile}`);
  console.log(`email:    ${cred.email}`);
  console.log(`method:   ${cred.method}`);
  console.log(`updated:  ${cred.updatedAt}`);
  console.log(`password: ${cred.password ?? "(none — manual login)"}`);
}

/** Split a rest array into positional values and `--flag`/`--flag value` pairs. */
function parseFlags(args: string[]): { values: string[]; flags: Record<string, string | true> } {
  const values: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      values.push(a);
    }
  }
  return { values, flags };
}

/** Profiles declared in config, discovered on disk, plus the default. */
function discoverProfiles(config: ReturnType<typeof loadConfig>): string[] {
  const names = new Set(listProfiles(config));
  const dir = join(config.profilesDir, "browser-profiles");
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      try {
        names.add(validateBrowserProfile(entry));
      } catch {
        // Skip stray files/dirs with invalid profile names.
      }
    }
  }
  names.add(DEFAULT_BROWSER_PROFILE);
  return [...names];
}

async function profilesCmd(config: ReturnType<typeof loadConfig>): Promise<void> {
  const pad = (v: string, n: number) => v.padEnd(n);
  const names = discoverProfiles(config);
  if (names.length === 0) {
    console.log("No profiles found.");
    return;
  }
  console.log(`${pad("Profile", 16)}${pad("Declared", 10)}${pad("Providers", 10)}${pad("Models", 8)}Label`);
  for (const name of names) {
    const declared = !!config.profiles?.[name];
    const entries = listModels(config, name);
    const providers = new Set(entries.filter((e) => e.model === undefined).map((e) => e.provider));
    const modelCount = entries.filter((e) => e.model !== undefined).length;
    console.log(
      `${pad(name, 16)}${pad(declared ? "yes" : "no", 10)}${pad(String(providers.size), 10)}${pad(String(modelCount), 8)}${config.profiles?.[name]?.label ?? ""}`,
    );
  }
}

function modelsCmd(config: ReturnType<typeof loadConfig>, args: string[]): void {
  const profile = args[0] ? validateBrowserProfile(args[0]) : undefined;
  const entries = listModels(config, profile);
  if (entries.length === 0) {
    console.log("No models.");
    return;
  }
  const pad = (v: string, n: number) => v.padEnd(n);
  console.log(`${pad("Model", 34)}${pad("Kind", 10)}Provider`);
  for (const e of entries) {
    const extra = e.model === undefined ? "(provider default)" : `default: ${e.model}`;
    console.log(`${pad(e.id, 34)}${pad(e.kind, 10)}${e.provider}  ${extra}`);
  }
}

function configCmd(config: ReturnType<typeof loadConfig>, args: string[]): void {
  const { values, flags } = parseFlags(args);
  const client = values[0];
  if (!client) {
    console.log("Client targets:\n");
    for (const t of clientTargets()) {
      console.log(`  ${t.id.padEnd(12)} ${t.label}`);
    }
    console.log("\nUsage: wspr config <client> [profile] [--out <file>] [--base-url <url>]");
    return;
  }
  const target = CLIENT_TARGETS[client];
  if (!target) {
    console.error(`Unknown client "${client}". Available: ${clientTargets().map((t) => t.id).join(", ")}`);
    process.exit(1);
  }

  const profile = validateBrowserProfile(values[1] ?? config.browserProfile);
  const host = config.host === "127.0.0.1" ? "localhost" : config.host;
  const baseUrl = typeof flags["base-url"] === "string" ? flags["base-url"] : `http://${host}:${config.port}`;
  const label = config.profiles?.[profile]?.label ?? profile;
  const ctx = { profile, baseUrl, models: listModels(config, profile), label };
  const out = target.emit(ctx);

  const outFile = typeof flags["out"] === "string" ? flags["out"] : target.file;
  if (outFile) {
    const path = resolve(outFile);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, out);
    console.log(`Wrote ${basename(path)} (profile "${profile}", ${ctx.models.length} model(s)).`);
  } else {
    console.log(out);
  }
}

main().catch((err) => {
  // Expected, actionable failures print as a sentence — a stack trace here is
  // noise, and the message already says what to do. Anything else is a bug and
  // keeps its stack.
  if (err instanceof WrongPassphraseError) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exit(1);
});
