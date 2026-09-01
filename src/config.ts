import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { DEFAULT_BROWSER_PROFILE, validateBrowserProfile } from "./browser.js";

// Directory of the compiled file (dist/) — used to find bundled providers.yaml.
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Real HTTP API config for an OpenAI-compatible endpoint (OpenAI, DeepSeek,
 * Groq, Together, …). When a provider declares this block it calls the API
 * instead of driving a browser. The key is read from the named environment
 * variable at request time — never store keys in YAML.
 */
export interface ApiProviderConfig {
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  /** Default model id sent to the API (overridable per request). */
  model: string;
  /**
   * Default model id used for /v1/embeddings (overridable per request).
   * The chat `model` is usually not an embedding model, so set this when the
   * provider should answer embedding requests without an explicit model.
   */
  embedModel?: string;
  /** Name of the env var holding the API key, e.g. OPENAI_API_KEY. */
  keyEnv: string;
}

export interface ProviderConfig {
  url: string;
  requiresLogin: boolean;
  newChatSelector?: string;
  inputSelector: string;
  sendSelector?: string;
  responseSelector: string;
  stopSelector?: string;
  loggedOutSelector?: string;
  timeoutMs: number;
  stabilizeMs: number;
  /** Click this to open the model picker dropdown. */
  modelPickerTrigger?: string;
  /** Map of model name → selector to click inside the picker. */
  models?: Record<string, string>;
  /**
   * Default browser profile for this provider (e.g. "email1"). Omitted ⇒ the
   * server default (WSPR_BROWSER_PROFILE env var, itself defaulting to
   * "default"). A request-level `profile` field always wins.
   */
  profile?: string;
  /** Present ⇒ this is an API-key provider, not a browser one. */
  api?: ApiProviderConfig;
}

export interface AppConfig {
  port: number;
  profilesDir: string;
  headless: boolean;
  /**
   * Playwright browser channel to launch (e.g. "chrome", "msedge", "chrome-beta").
   * Undefined ⇒ Playwright's bundled Chromium (the zero-config default for the
   * npm package). Set WSPR_BROWSER_CHANNEL=chrome to drive a locally-installed
   * Google Chrome, which avoids Google's "this browser may not be secure"
   * login block.
   */
  browserChannel?: string;
  /** Used when a request does not specify its own `profile`. */
  browserProfile: string;
  /**
   * Pre-open ("warm") a browser tab for every logged-in browser provider at
   * startup. Off by default so `wspr serve` stays headless for API-only use —
   * the browser launches lazily on the first browser-provider request instead.
   * Set WSPR_WARM=true to restore eager warming (slightly faster first hit).
   */
  warmTabs: boolean;
  providers: Record<string, ProviderConfig>;
}

const REQUIRED_FIELDS: (keyof ProviderConfig)[] = [
  "url",
  "inputSelector",
  "responseSelector",
];

/**
 * Channels Playwright's Chromium family knows how to launch. Used to decide
 * whether a legacy `BROWSER` env var is a real channel — desktops often export
 * `BROWSER` as a *command* (e.g. "omarchy-launch-browser", "xdg-open"), which
 * Playwright cannot launch. Those values are ignored.
 */
const KNOWN_BROWSER_CHANNELS = new Set([
  "chromium",
  "chrome",
  "chrome-beta",
  "chrome-dev",
  "chrome-canary",
  "msedge",
  "msedge-beta",
  "msedge-dev",
  "msedge-canary",
]);

/**
 * Resolve the browser channel: WSPR_BROWSER_CHANNEL wins. Legacy `BROWSER` is
 * used only when it names a known Playwright channel, so desktop `BROWSER`
 * commands (xdg-open, …) never break launching.
 */
function resolveBrowserChannel(): string | undefined {
  const fromEnv = (name: string) => process.env[name]?.trim().toLowerCase();
  const explicit = fromEnv("WSPR_BROWSER_CHANNEL");
  if (explicit && explicit !== "chromium") return explicit;
  if (explicit === "chromium") return undefined; // bundled Chromium is the default
  const legacy = fromEnv("BROWSER");
  if (legacy && KNOWN_BROWSER_CHANNELS.has(legacy) && legacy !== "chromium") {
    console.warn(
      `BROWSER="${legacy}" is deprecated — rename it to WSPR_BROWSER_CHANNEL="${legacy}".`,
    );
    return legacy;
  }
  return undefined;
}

function findProvidersFile(explicit?: string): string {
  const candidates = [
    explicit,
    process.env.PROVIDERS_FILE,
    resolve("providers.yaml"),                     // CWD override
    join(PKG_ROOT, "providers.yaml"),              // bundled with the package
  ].filter(Boolean) as string[];

  for (const f of candidates) {
    if (existsSync(f)) return f;
  }
  throw new Error(
    "providers.yaml not found. Place one in the current directory or set PROVIDERS_FILE.",
  );
}

export function loadConfig(file?: string): AppConfig {
  const configFile = findProvidersFile(file);
  const raw = yaml.load(readFileSync(configFile, "utf-8")) as {
    providers?: Record<string, Partial<ProviderConfig>>;
  };

  if (!raw?.providers || typeof raw.providers !== "object") {
    throw new Error(`No "providers" map found in ${configFile}`);
  }

  // Effective default profile for browser providers that don't declare one.
  // Materialized into every browser provider below so the fallback chain
  // (request `profile` → provider `profile` → this → "default") resolves once.
  const defaultBrowserProfile = validateBrowserProfile(
    process.env.WSPR_BROWSER_PROFILE?.trim() || DEFAULT_BROWSER_PROFILE,
  );

  const providers: Record<string, ProviderConfig> = {};
  for (const [name, cfg] of Object.entries(raw.providers)) {
    if (cfg?.api) {
      // API-key provider: validate the api block; browser selectors are unused.
      for (const field of ["baseUrl", "model", "keyEnv"] as const) {
        if (!cfg.api[field]) {
          throw new Error(`Provider "${name}" api block is missing required field "${field}"`);
        }
      }
    } else {
      for (const field of REQUIRED_FIELDS) {
        if (!cfg?.[field]) {
          throw new Error(`Provider "${name}" is missing required field "${field}"`);
        }
      }
      try {
        cfg.profile = validateBrowserProfile(cfg.profile ?? defaultBrowserProfile);
      } catch (e) {
        throw new Error(`Provider "${name}": ${(e as Error).message}`);
      }
    }
    providers[name] = {
      // Defaults so browser-typed fields are always present; API providers
      // leave the selectors empty (never read in API mode).
      url: "",
      inputSelector: "",
      responseSelector: "",
      requiresLogin: false,
      timeoutMs: 90000,
      stabilizeMs: 2000,
      ...cfg,
    } as ProviderConfig;
  }

  const defaultProfilesDir = join(homedir(), ".config", "llm-whisperer", "profiles");

  return {
    // 9777 = "WSPR" on a phone keypad; avoids the crowded 3000/5000/8000 range. See docs/configuration.md.
    port: Number(process.env.PORT ?? 9777),
    profilesDir: process.env.PROFILES_DIR ?? defaultProfilesDir,
    headless: (process.env.HEADLESS ?? "false").toLowerCase() !== "false",
    // Unset ⇒ bundled Chromium. See resolveBrowserChannel() for the legacy
    // BROWSER fallback and its channel allowlist.
    browserChannel: resolveBrowserChannel(),
    browserProfile: defaultBrowserProfile,
    warmTabs: (process.env.WSPR_WARM ?? "false").toLowerCase() === "true",
    providers,
  };
}
