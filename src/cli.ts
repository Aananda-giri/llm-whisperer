#!/usr/bin/env node
import "dotenv/config";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { BrowserManager } from "./browser.js";
import { SessionPool } from "./session-pool.js";
import { createServer } from "./server.js";

async function main() {
  const [command, arg] = process.argv.slice(2);

  // Support --help / -h before loading config (which might fail)
  const isHelp = command === "--help" || command === "-h";
  if (!command || isHelp) {
    console.log(`LLM-Whisper — free web LLM bridge

Usage:
  whisper serve            Start the local API on PORT (default 3000)
  whisper login <name>     Open a visible browser to log in; session is saved
  whisper list             List configured providers

Environment:
  PORT           API port (default 3000)
  HEADLESS       true/false — hide the browser (default false)
  PROFILES_DIR   where to store login sessions (default ~/.config/llm-whisper/profiles)
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
      console.error(`Unknown command: ${command}. Run whisper --help.`);
      process.exit(1);
  }
}

async function serve(config: ReturnType<typeof loadConfig>) {
  const browser = new BrowserManager(config.profilesDir, config.headless);
  const pool = new SessionPool(browser);
  const app = createServer(config, pool);

  const server = app.listen(config.port, () => {
    console.log(`LLM-Whisper listening on http://localhost:${config.port}`);
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
    if (!config.providers[name].requiresLogin) return true;
    return existsSync(join(config.profilesDir, name, ".logged-in"));
  });

  if (names.length === 0) {
    console.log("No saved sessions found. Run `whisper login <provider>` to log in.");
    return;
  }

  console.log(`Warming browsers: ${names.join(", ")}...`);
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
  const profileDir = join(config.profilesDir, name);
  mkdirSync(profileDir, { recursive: true });

  const browser = new BrowserManager(config.profilesDir, false);
  const ctx = await browser.context(name, { headless: false });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(provider.url, { waitUntil: "domcontentloaded" });

  console.log(`\nA browser opened at ${provider.url}`);
  console.log("Log in, get to the chat screen, then press Enter to save the session.");

  await new Promise<void>((res) => {
    process.stdin.resume();
    process.stdin.once("data", () => res());
  });

  await browser.close();
  writeFileSync(join(config.profilesDir, name, ".logged-in"), new Date().toISOString());
  console.log(`Session saved. It will be reused on future runs.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
