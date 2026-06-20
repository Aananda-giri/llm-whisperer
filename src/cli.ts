import "dotenv/config";
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

function serve(config: ReturnType<typeof loadConfig>) {
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
  console.log(`Saved session for "${name}". It will be reused on headless runs.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
