#!/usr/bin/env node
import "dotenv/config";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { BrowserManager } from "./browser.js";
import { SessionPool } from "./session-pool.js";
import { createServer } from "./server.js";

async function main() {
  const [command, arg] = process.argv.slice(2);

  const isHelp = command === "--help" || command === "-h";
  if (!command || isHelp) {
    console.log(`🤫 llm-whisperer — one quiet API for every LLM

Usage:
  wspr serve            Start the local API on PORT (default 9777)
  wspr login <name>     Open a browser tab to log in; session is saved
  wspr list             List configured providers

Environment:
  PORT           API port (default 9777)
  HEADLESS       true/false — hide the browser (default false)
  BROWSER        browser channel: chromium (default), chrome, msedge, …
  PROFILES_DIR   where to store login sessions (default ~/.config/llm-whisperer/profiles)
  PROVIDERS_FILE path to a custom providers.yaml`);
    process.exit(isHelp ? 0 : 1);
  }

  const config = loadConfig();

  switch (command) {
    case "serve":
      return serve(config);
    case "login":
      return login(config, arg);
    case "list":
      console.log("Providers:", Object.keys(config.providers).join(", "));
      return;
    default:
      console.error(`Unknown command: ${command}. Run wspr --help.`);
      process.exit(1);
  }
}

async function serve(config: ReturnType<typeof loadConfig>) {
  const browser = new BrowserManager(config.profilesDir, config.headless, config.browserChannel);
  const pool = new SessionPool(browser);
  const app = createServer(config, pool);

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

  const server = app.listen(config.port, () => {
    console.log(`listening on http://localhost:${config.port}`);
    console.log(`Providers: ${Object.keys(config.providers).join(", ")}`);
    console.log(`Profiles:  ${config.profilesDir}`);
  });

  const shutdown = async () => {
    console.log("\nShutting down...");
    server.close();
    await browser.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await warmProviders(config, pool);
}

async function warmProviders(
  config: ReturnType<typeof loadConfig>,
  pool: SessionPool,
) {
  const names = Object.keys(config.providers).filter((name) => {
    const cfg = config.providers[name];
    if (cfg.api) return false; // API providers have no browser tab to warm
    if (!cfg.requiresLogin) return true;
    return existsSync(join(config.profilesDir, name, ".logged-in"));
  });

  if (names.length === 0) {
    console.log("No saved sessions found. Run `wspr login <provider>` to log in.");
    return;
  }

  console.log(`Warming tabs: ${names.join(", ")}...`);
  for (const name of names) {
    const cfg = config.providers[name];
    try {
      const page = await pool.acquire(name);
      await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      pool.release(name, page);
      console.log(`  ✓ ${name} ready`);
    } catch (e) {
      console.warn(`  ✗ ${name} failed to warm: ${(e as Error).message}`);
    }
  }
}

async function login(config: ReturnType<typeof loadConfig>, name?: string) {
  if (!name || !config.providers[name]) {
    console.error(`Specify a provider: ${Object.keys(config.providers).join(", ")}`);
    process.exit(1);
  }
  const provider = config.providers[name];

  // All providers share one browser profile. Chrome locks the profile while
  // running, so "wspr serve" must be stopped before running login.
  const browser = new BrowserManager(config.profilesDir, false, config.browserChannel);
  let ctx: Awaited<ReturnType<typeof browser.context>>;
  try {
    ctx = await browser.context({ headless: false });
  } catch (e) {
    console.error(
      `Could not open the browser. If "wspr serve" is running, stop it first —` +
        ` Chrome locks the profile to one process at a time.`,
    );
    console.error((e as Error).message);
    process.exit(1);
  }

  const page = await ctx.newPage();
  await page.goto(provider.url, { waitUntil: "domcontentloaded" });

  console.log(`\nA browser tab opened at ${provider.url}`);
  console.log("Log in, get to the chat screen, then press Enter to save the session.");

  await new Promise<void>((res) => {
    process.stdin.resume();
    process.stdin.once("data", () => res());
  });

  await browser.close();

  const sentinelDir = join(config.profilesDir, name);
  mkdirSync(sentinelDir, { recursive: true });
  writeFileSync(join(sentinelDir, ".logged-in"), new Date().toISOString());
  console.log(`Session saved for "${name}". Start "wspr serve" to use it.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
