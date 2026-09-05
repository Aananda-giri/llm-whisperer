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

/**
 * Declarative login rules for a browser provider. Lives beside `loggedOutSelector`
 * in providers.yaml — no per-platform code. `method: "password"` is fully
 * automatic; `method: "manual"` holds the email only and hands the window to
 * the human (Claude's magic link, any Google OAuth).
 */
export interface LoginConfig {
  /** `password` = automatic; `manual` = autofill email, then hand off. */
  method: "password" | "manual";
  /** Optional: click this to open the login form before filling. */
  trigger?: string;
  /** Selector of the email/username input. Required for both methods. */
  emailSelector: string;
  /** Selector of the password input. Required when `method: "password"`. */
  passwordSelector?: string;
  /** Optional: two-step flow — click continue between email and password. */
  continueSelector?: string;
  /** Selector of the submit button. Required when `method: "password"`. */
  submitSelector?: string;
  /**
   * Wait target after submitting. Defaults to the provider's `inputSelector`
   * (the chat surface) — the thing {@link isLoggedIn} already looks for.
   */
  successSelector?: string;
  /** Max time to wait for `successSelector`/login to settle (ms). Default 60 s. */
  timeoutMs?: number;
}

/**
 * How a browser provider chooses between continuing the tab's existing thread
 * and replaying the client's transcript into a fresh one.
 *
 * - `auto`    — continue only when the tab provably holds the client's history
 *               (conversation-key match); otherwise replay. The default, and
 *               the only setting that is correct for a stateless agent client.
 * - `tab`     — always continue, never replay. wspr's historical behaviour:
 *               the browser tab is the conversation and the client is trusted
 *               to send only new turns.
 * - `replay`  — always start a fresh thread and re-send everything. Slowest and
 *               most faithful; useful for debugging a provider.
 */
export type Continuity = "auto" | "tab" | "replay";

/**
 * Whether the conversation key covers system-message *content*.
 *
 * `ignore` (default) is deliberate: coding agents rebuild their system prompt
 * every request with volatile context (working directory, today's date, git
 * status), so hashing it would score every single turn as a miss and replay the
 * whole transcript each time. The tab keeps the system prompt it was opened
 * with — the same trade already made for assistant text. `hash` is available
 * for clients whose system prompt is stable and semantically load-bearing.
 */
export type SystemMode = "ignore" | "hash";

/** How a tool's JSON Schema is rendered into the browser prompt preamble. */
export type SchemaStyle = "compact" | "json" | "pretty";

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
  /**
   * Hard cap on the characters wspr will type into the chat box. A web chat
   * input silently truncates (or converts a long paste into a file
   * attachment), so an over-budget prompt must fail loudly instead. Undefined
   * ⇒ unlimited. Browser providers only.
   */
  maxPromptChars?: number;
  /**
   * Cap on a single `<tool_result>` body before it is middle-out truncated.
   * An agent's `read`/`bash` results are the thing that blows a prompt budget,
   * so they are trimmed first. Undefined ⇒ untrimmed.
   */
  toolResultMaxChars?: number;
  /**
   * Read the answer once, after it stabilizes, instead of streaming deltas —
   * used when the turn declares tools. Incremental `innerText()` polling drops
   * the tail on any non-incremental DOM re-render (see streamAnswer), which is
   * survivable for prose and fatal for a JSON tool call. Default true.
   */
  bufferToolTurns?: boolean;
  /** Advertised context window, for client-config emitters. */
  contextLimit?: number;
  /** Advertised max output tokens, for client-config emitters. */
  outputLimit?: number;
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
  /** Present ⇒ the provider supports declarative auto-login (see {@link LoginConfig}). */
  login?: LoginConfig;
}

/**
 * A named API scope. A profile has two independent halves:
 * - a browser identity (the Chromium user-data dir + vault key, e.g. "email1"),
 *   which reuses the existing {@link validateBrowserProfile} name rules; and
 * - a declared provider/model set, which is what a client scoped to this
 *   profile is allowed to see and use.
 *
 * A profile that is *undeclared* in the `profiles:` block is still valid — it
 * simply exposes every provider (the historical bare `/v1/*` behaviour) while
 * scoping browser sessions to that name. No `profiles:` block ⇒ nothing changes
 * for existing users.
 */
export interface ProfileConfig {
  /** Optional human-readable label, used by client-config emitters. */
  label?: string;
  /** Provider key → exposed model ids, or `"*"` for every model wspr knows. */
  providers: Record<string, string[] | "*">;
}

export interface AppConfig {
  port: number;
  /**
   * Host the HTTP server binds to. Defaults to 127.0.0.1 (loopback only).
   * Set WSPR_HOST to 0.0.0.0 to expose it — the credentials UI then needs a
   * strong WSPR_UI_TOKEN because it is reachable from the network.
   */
  host: string;
  profilesDir: string;
  headless: boolean;
  /**
   * Declared, provider-scoped API profiles (the `profiles:` block in
   * providers.yaml). Absent ⇒ every undeclared profile exposes every provider.
   */
  profiles: Record<string, ProfileConfig>;
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
  /**
   * Max concurrent browser tabs per provider x profile. With conversation
   * affinity each tab holds one conversation, so this is also the number of
   * simultaneous conversations a browser provider can keep hot. Agent clients
   * (which interleave a main loop with title/summary calls) want >= 3.
   */
  maxPagesPerProvider: number;
  /** Request body size limit passed to `express.json`. */
  maxBody: string;
  /**
   * How a browser provider decides between continuing the tab's thread and
   * replaying the transcript into a fresh one. See planTurn().
   */
  continuity: Continuity;
  /** Whether the conversation key hashes system-message content. */
  affinitySystemMode: SystemMode;
  /** How tool JSON Schemas are rendered into the prompt preamble. */
  toolSchemaStyle: SchemaStyle;
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
 * Validate a declarative `login:` block. `method` is required and must be
 * `password` or `manual`. `emailSelector` is always required. A `password`
 * provider must also declare `passwordSelector` and `submitSelector`.
 */
function validateLoginBlock(name: string, login: LoginConfig): void {
  if (login.method !== "password" && login.method !== "manual") {
    throw new Error(
      `Provider "${name}": login.method must be "password" or "manual" (got "${login.method}").`,
    );
  }
  if (!login.emailSelector) {
    throw new Error(`Provider "${name}": login block with method "${login.method}" is missing emailSelector.`);
  }
  if (login.method === "password" && !login.passwordSelector) {
    throw new Error(`Provider "${name}": login method "password" requires passwordSelector.`);
  }
  if (login.method === "password" && !login.submitSelector) {
    throw new Error(`Provider "${name}": login method "password" requires submitSelector.`);
  }
}

/**
 * Validate and normalize the `profiles:` block, after every provider has been
 * materialized so the provider-name and browser-models checks can see it.
 *
 * Rules:
 * - the profile name passes the same charset as its browser directory;
 * - every provider key must exist in `config.providers` (names the typo);
 * - for a browser provider, every listed model must be a key of that provider's
 *   `models:` map — cheap typo protection, since those keys already exist;
 * - for an API provider any model id is allowed (ids are passed upstream
 *   verbatim).
 */
function parseProfiles(
  rawProfiles: Partial<Record<string, Partial<ProfileConfig>>> | undefined,
  providers: Record<string, ProviderConfig>,
): Record<string, ProfileConfig> {
  if (!rawProfiles || typeof rawProfiles !== "object") return {};

  const out: Record<string, ProfileConfig> = {};
  for (const [name, prof] of Object.entries(rawProfiles)) {
    if (!prof || typeof prof.providers !== "object") {
      throw new Error(`Profile "${name}": the "providers" map is required.`);
    }
    validateBrowserProfile(name);
    const result: ProfileConfig = { label: prof.label, providers: {} };
    for (const [providerKey, list] of Object.entries(prof.providers)) {
      const cfg = providers[providerKey];
      if (!cfg) {
        throw new Error(
          `Profile "${name}": unknown provider "${providerKey}". ` +
            `Available: ${Object.keys(providers).join(", ")}`,
        );
      }
      if (list === "*") {
        result.providers[providerKey] = "*";
        continue;
      }
      if (!Array.isArray(list)) {
        throw new Error(
          `Profile "${name}" provider "${providerKey}": expected a list of model ids or "*".`,
        );
      }
      if (cfg.api) {
        // Any id is forwarded upstream verbatim; just accept the list.
        result.providers[providerKey] = [...list];
        continue;
      }
      const known = new Set(Object.keys(cfg.models ?? {}));
      for (const modelId of list) {
        if (!known.has(modelId)) {
          throw new Error(
            `Profile "${name}" provider "${providerKey}": unknown model "${modelId}". ` +
              `Available: ${[...known].join(", ") || "(none)"}`,
          );
        }
      }
      result.providers[providerKey] = [...list];
    }
    out[name] = result;
  }
  return out;
}

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
    profiles?: Record<string, Partial<ProfileConfig>>;
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
      if (cfg.login) {
        validateLoginBlock(name, cfg.login);
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

  // Profiles are validated only after every provider is materialized above, so
  // the provider-name check and the browser-models check can see the real map.
  const profiles = parseProfiles(raw.profiles, providers);

  return {
    // 9777 = "WSPR" on a phone keypad; avoids the crowded 3000/5000/8000 range. See docs/configuration.md.
    port: Number(process.env.PORT ?? 9777),
    // Bind to loopback only by default so the server (and its credentials UI)
    // is not reachable from the LAN. Set WSPR_HOST=0.0.0.0 to expose it.
    host: process.env.WSPR_HOST?.trim() || "127.0.0.1",
    profilesDir: process.env.PROFILES_DIR ?? defaultProfilesDir,
    profiles,
    headless: (process.env.HEADLESS ?? "false").toLowerCase() !== "false",
    // Unset ⇒ bundled Chromium. See resolveBrowserChannel() for the legacy
    // BROWSER fallback and its channel allowlist.
    browserChannel: resolveBrowserChannel(),
    browserProfile: defaultBrowserProfile,
    warmTabs: (process.env.WSPR_WARM ?? "false").toLowerCase() === "true",
    maxPagesPerProvider: positiveInt(process.env.WSPR_MAX_PAGES, 2, "WSPR_MAX_PAGES"),
    // 1mb (Express's default) is far too small for an agent client: a single
    // `read` tool result carrying a source file routinely exceeds it.
    maxBody: process.env.WSPR_MAX_BODY?.trim() || "32mb",
    continuity: oneOf(process.env.WSPR_CONTINUITY, ["auto", "tab", "replay"], "auto", "WSPR_CONTINUITY"),
    affinitySystemMode: oneOf(process.env.WSPR_AFFINITY_SYSTEM, ["ignore", "hash"], "ignore", "WSPR_AFFINITY_SYSTEM"),
    toolSchemaStyle: oneOf(
      process.env.WSPR_TOOL_SCHEMA_STYLE,
      ["compact", "json", "pretty"],
      "compact",
      "WSPR_TOOL_SCHEMA_STYLE",
    ),
    providers,
  };
}

/** Parse a positive-integer env var, falling back to `fallback` when unset. */
function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  const text = raw?.trim();
  if (!text) return fallback;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer (got "${text}").`);
  }
  return n;
}

/** Parse an enum-valued env var, listing the valid values when it is wrong. */
function oneOf<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  name: string,
): T {
  const text = raw?.trim().toLowerCase();
  if (!text) return fallback;
  if (!(allowed as readonly string[]).includes(text)) {
    throw new Error(`${name} must be one of ${allowed.join(", ")} (got "${text}").`);
  }
  return text as T;
}
