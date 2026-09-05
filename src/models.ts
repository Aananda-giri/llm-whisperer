import type { AppConfig, ProviderConfig } from "./config.js";

/**
 * One entry in a profile-scoped model catalog. `id` is what a client sends as
 * the `model` field: either the bare provider alias (`"qwen"` — use the
 * provider's default) or a `provider/model` pair (`"qwen/qwen3-235b"`).
 */
export interface ModelEntry {
  /** Full id: `"qwen"` or `"qwen/qwen3-235b"`. */
  id: string;
  provider: string;
  /** Undefined ⇒ provider default (the bare alias). */
  model?: string;
  /** Display name for client-config emitters. */
  label: string;
  kind: "browser" | "api";
  /** Browser providers only: how long one turn may take, from providers.yaml. */
  timeoutMs?: number;
  /** Advertised context window, when the provider declares one. */
  contextLimit?: number;
  /** Advertised max output tokens, when the provider declares one. */
  outputLimit?: number;
  /**
   * API providers: is the provider's key env var actually set? Client-config
   * emitters use it to avoid nominating a provider that cannot answer (see the
   * `small_model` choice in clients.ts). Undefined for browser providers —
   * whether a session is live can only be learned by driving the browser.
   */
  keyPresent?: boolean;
}

/** The subset of a profile's providers map that applies to a provider. */
type AllowedList = string[] | "*";

/** The model-id part after the first `/` (everything after the provider). */
function splitModelId(model: string): { provider: string; name?: string } {
  const i = model.indexOf("/");
  if (i === -1) return { provider: model };
  return { provider: model.slice(0, i), name: model.slice(i + 1) };
}

/** Declared profile names, in declaration order. */
export function listProfiles(config: AppConfig): string[] {
  return Object.keys(config.profiles ?? {});
}

/**
 * The provider → allowed-models map for a profile. An undeclared profile (or
 * `undefined`, or a profile with no `profiles:` block) exposes every provider
 * with `"*"` — historical behaviour, untouched.
 */
function profileProviders(config: AppConfig, profile?: string): Map<string, AllowedList> {
  if (!profile) return allWildcard(config);
  const declared = config.profiles?.[profile];
  if (!declared) return allWildcard(config);
  return new Map(Object.entries(declared.providers));
}

function allWildcard(config: AppConfig): Map<string, AllowedList> {
  const m = new Map<string, AllowedList>();
  for (const name of Object.keys(config.providers)) m.set(name, "*");
  return m;
}

/** Does a provider satisfy a profile's allowed list for a given model name? */
function allowed(providerKey: string, list: AllowedList, name?: string): boolean {
  if (name === undefined) return true; // bare alias always resolves to the provider default
  if (list === "*") return true;
  return list.includes(name);
}

function toEntry(
  providerKey: string,
  cfg: ProviderConfig,
  name: string | undefined,
): ModelEntry {
  const kind: "browser" | "api" = cfg.api ? "api" : "browser";
  return {
    id: name === undefined ? providerKey : `${providerKey}/${name}`,
    provider: providerKey,
    model: name,
    label: name ?? providerKey,
    kind,
    // Carried so client-config emitters can size timeouts and context windows
    // from the provider's own config rather than guessing.
    ...(kind === "browser" ? { timeoutMs: cfg.timeoutMs } : {}),
    ...(cfg.contextLimit !== undefined ? { contextLimit: cfg.contextLimit } : {}),
    ...(cfg.outputLimit !== undefined ? { outputLimit: cfg.outputLimit } : {}),
    ...(cfg.api ? { keyPresent: !!process.env[cfg.api.keyEnv]?.trim() } : {}),
  };
}

/**
 * The catalog a profile exposes. Emits, per provider in the profile's set: the
 * bare `<provider>` alias first, then `<provider>/<m>` for each model from the
 * browser `models:` map (filtered by the profile list), or the API default plus
 * any extra model ids the profile listed explicitly.
 */
export function listModels(config: AppConfig, profile?: string): ModelEntry[] {
  const set = profileProviders(config, profile);
  const out: ModelEntry[] = [];

  for (const [providerKey, allowedList] of set) {
    const cfg = config.providers[providerKey];
    if (!cfg) continue; // defensively skip a provider dropped at load time
    out.push(toEntry(providerKey, cfg, undefined));

    if (cfg.api) {
      // Always surface the configured default so a bare alias has an obvious
      // choice, then any extra ids the profile listed explicitly.
      out.push(toEntry(providerKey, cfg, cfg.api.model));
      const extras = allowedList === "*" ? [] : allowedList;
      for (const m of extras) {
        if (m !== cfg.api.model) out.push(toEntry(providerKey, cfg, m));
      }
    } else {
      const known = Object.keys(cfg.models ?? {});
      const names = allowedList === "*" ? known : known.filter((m) => allowedList.includes(m));
      for (const m of names) out.push(toEntry(providerKey, cfg, m));
    }
  }
  return out;
}

/**
 * Resolve a client's `model` string to a concrete provider + upstream model id,
 * honouring the profile's declared set. Splits on the *first* `/` only, so
 * slashed ids (OpenRouter `openrouter/openai/gpt-oss-120b:free`, Cloudflare
 * `cloudflare/@cf/meta/...`) survive intact — the historical `split("/")`
 * defect.
 *
 * Returns `{ provider, model }` on success (model is undefined for a bare
 * provider alias), or `{ error }` for an unknown provider, a model a browser
 * provider does not know, or a model the active profile hides.
 */
export function resolveModel(
  config: AppConfig,
  profile: string | undefined,
  model: string,
): { provider: string; model?: string } | { error: string } {
  const { provider, name } = splitModelId(model ?? "");
  const cfg = config.providers[provider];
  if (!cfg) {
    return {
      error: `Unknown provider "${provider}". Available: ${Object.keys(config.providers).join(", ")}`,
    };
  }

  if (profile && config.profiles?.[profile]) {
    const list = config.profiles[profile].providers[provider];
    if (list === undefined) {
      return { error: `Provider "${provider}" is not exposed by profile "${profile}".` };
    }
    if (!allowed(provider, list, name)) {
      return {
        error: `Model "${name}" is not exposed by profile "${profile}" for provider "${provider}".`,
      };
    }
  }

  if (name !== undefined && !cfg.api) {
    // Browser provider: the model must be a key of its `models:` map.
    const known = Object.keys(cfg.models ?? {});
    if (!known.includes(name)) {
      return {
        error: `Unknown model "${name}" for browser provider "${provider}". Available: ${known.join(", ") || "(none)"}`,
      };
    }
  }

  return { provider, model: name };
}
