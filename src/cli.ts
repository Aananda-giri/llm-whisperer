import "dotenv/config";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { BrowserManager } from "./browser.js";
import { SessionPool } from "./session-pool.js";
import { createServer } from "./server.js";

async function main() {
  const [command, arg] = process.argv.slice(2);
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
      console.log(
        `LLM-Whisper

Usage:
  whisper serve            Start the local API on PORT (default 3000)
  whisper login <name>     Open a visible browser to log in; session is saved
  whisper list             List configured providers

Providers: ${Object.keys(config.providers).join(", ")}`,
      );
      process.exit(command ? 1 : 0);
  }
}

async function serve(config: ReturnType<typeof loadConfig>) {
  const browser = new BrowserManager(config.profilesDir, config.headless);
  const pool = new SessionPool(browser);
  const app = createServer(config, pool);

  const server = app.listen(config.port, () => {
    console.log(`LLM-Whisper listening on http://localhost:${config.port}`);
    console.log(`Providers: ${Object.keys(config.providers).join(", ")}`);
  });

  const shutdown = async () => {
    console.log("\nShutting down...");
    server.close();
    await browser.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Open a browser for every provider immediately so the window is visible
  // on startup and the first request doesn't wait for browser launch.
  await warmProviders(config, pool);
}

async function warmProviders(
  config: ReturnType<typeof loadConfig>,
  pool: SessionPool,
) {
  // Only warm providers that have a saved profile (i.e. user has logged in).
  // Skip providers without a profile to avoid launching dead browsers.
  // Warm sequentially to avoid hammering system memory with 5 browsers at once.
  const names = Object.keys(config.providers).filter((name) => {
    if (!config.providers[name].requiresLogin) return true;
    // Only warm if the user has completed login (sentinel written by `login` command).
    return existsSync(resolve(config.profilesDir, name, ".logged-in"));
  });

  if (names.length === 0) {
    console.log("No saved sessions found. Run `pnpm run login <provider>` to log in.");
    return;
  }

  console.log(`Warming browsers: ${names.join(", ")}...`);
  for (const name of names) {
    const cfg = config.providers[name];
    try {
      const page = await pool.acquire(name);
      await page
        .goto(cfg.url, { waitUntil: "domcontentloaded", timeout: 30000 })
        .catch(() => {});
      pool.release(name, page);
      console.log(`  ✓ ${name} ready`);
    } catch (e) {
      console.warn(`  ✗ ${name} failed to warm: ${(e as Error).message}`);
    }
  }
}

/**
 * Opens the provider's site in a visible browser using its persistent profile.
 * Log in by hand, then press Enter here — cookies are saved for headless runs.
 */
async function login(config: ReturnType<typeof loadConfig>, name?: string) {
  if (!name || !config.providers[name]) {
    console.error(
      `Specify a provider to log in to: ${Object.keys(config.providers).join(", ")}`,
    );
    process.exit(1);
  }
  const provider = config.providers[name];
  const browser = new BrowserManager(config.profilesDir, false);
  const ctx = await browser.context(name, { headless: false });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(provider.url, { waitUntil: "domcontentloaded" });

  console.log(`\nA browser opened at ${provider.url}`);
  console.log("Log in there, get to the chat screen, then press Enter here to save the session.");

  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => resolve());
  });

  await browser.close();
  // Sentinel so warmProviders knows this provider has a real saved session.
  writeFileSync(resolve(config.profilesDir, name, ".logged-in"), new Date().toISOString());
  console.log(`Saved session for "${name}". It will be reused on headless runs.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
