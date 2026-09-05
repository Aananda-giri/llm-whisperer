import type { ModelEntry } from "./models.js";

/**
 * A generic client-config emitter. One entry per client that wants to talk to
 * wspr over a profile-scoped base URL. Nothing here imports Express or
 * Playwright, so emitters stay unit-testable.
 */
export interface EmitContext {
  /** The profile the config is scoped to (e.g. "email1"). */
  profile: string;
  /** The server's root base URL (scheme + host + port, e.g. http://localhost:9777). */
  baseUrl: string;
  /** The catalog {@link listModels} returned for this profile. */
  models: ModelEntry[];
  /** Display label for the provider block (defaults to the profile). */
  label: string;
}

export interface ClientTarget {
  id: string;
  label: string;
  /**
   * Conventional filename for this client's config, suggested in the CLI hint.
   * Never written to implicitly — a client's real config (opencode.json holds
   * agents, MCP servers, keybinds) must not be clobbered by a bare `wspr
   * config`. Writing always requires an explicit `--out`.
   */
  file?: string;
  /** Render a config document for this client. */
  emit(ctx: EmitContext): string;
}

/** The profile-scoped OpenAI-compatible base (everything after `/v1`). */
function openaiBase(ctx: EmitContext): string {
  return `${ctx.baseUrl}/p/${ctx.profile}/v1`;
}

/** The profile-scoped Anthropic base (the SDK appends `/v1/messages`). */
function anthropicBase(ctx: EmitContext): string {
  return `${ctx.baseUrl}/p/${ctx.profile}`;
}

/** Fallbacks when a provider declares no limits of its own. */
const DEFAULT_LIMITS = {
  browser: { context: 32768, output: 8192 },
  api: { context: 128000, output: 8192 },
} as const;

/**
 * opencode: an OpenAI-compatible provider block keyed by profile, with every
 * model in the catalog listed explicitly. opencode does NOT auto-discover from
 * `/v1/models` — it requires a model map — which is exactly why this exists.
 *
 * The per-model flags matter as much as the list. `tool_call` is what makes
 * opencode send `tools` at all (wspr forwards them natively to API providers
 * and simulates them for browser ones). `temperature: false` stops it sending
 * a sampling parameter a browser provider can only ignore. And `small_model`
 * points title generation at an API-key provider, so those side requests never
 * take a browser tab away from the agent loop.
 */
const opencode: ClientTarget = {
  id: "opencode",
  label: "opencode (coding agent)",
  file: "opencode.json",
  emit(ctx) {
    const models: Record<string, unknown> = {};
    for (const m of ctx.models) {
      const browser = m.kind === "browser";
      const fallback = DEFAULT_LIMITS[m.kind];
      models[m.id] = {
        // A browser model that has never actually been driven end-to-end is
        // flagged right in the picker — its selectors are a best-effort guess
        // (see providers.yaml `verified:`), and the difference between "this
        // works" and "this is untested" belongs in front of whoever is about
        // to pick a model, not buried in a doc.
        name: browser && !m.verified ? `${m.label} (untested)` : m.label,
        tool_call: true,
        // Browser providers are text-only and ignore every sampling param
        // (see ChatOptions.params), so advertise neither.
        attachment: !browser,
        temperature: !browser,
        reasoning: false,
        limit: {
          context: m.contextLimit ?? fallback.context,
          output: m.outputLimit ?? fallback.output,
        },
      };
    }

    // A browser turn is one page-load plus a human-speed answer, and a
    // tool turn sends nothing at all until the answer settles — so the
    // chunk timeout, not the total, is the one that would fire.
    const slowest = ctx.models.reduce((ms, m) => Math.max(ms, m.timeoutMs ?? 0), 0);
    const perChunk = slowest ? slowest + 60_000 : 300_000;

    const doc: Record<string, unknown> = {
      $schema: "https://opencode.ai/config.json",
      provider: {
        [ctx.profile]: {
          npm: "@ai-sdk/openai-compatible",
          name: ctx.label || ctx.profile,
          options: {
            baseURL: openaiBase(ctx),
            // Our proxy is keyless unless WSPR_API_KEY is set; a placeholder
            // keeps the OpenAI-compatible adapter happy either way.
            apiKey: "not-needed",
            headerTimeout: perChunk,
            chunkTimeout: perChunk,
            timeout: perChunk * 4,
          },
          models,
        },
      },
    };

    // Title generation and summarisation run on `small_model`. Left unset,
    // opencode uses the main model — which for a browser provider means a
    // second request racing the agent loop for the same tab. Point it at an
    // API-key model when the profile exposes one, preferring a provider whose
    // key is actually set: nominating one that 401s makes every session
    // untitled, which looks like a wspr bug rather than a missing key.
    const api = ctx.models.filter((m) => m.kind === "api" && m.model === undefined);
    const small = api.find((m) => m.keyPresent) ?? api[0];
    if (small) doc.small_model = `${ctx.profile}/${small.id}`;

    return JSON.stringify(doc, null, 2);
  },
};

/** The `openai` SDK / Cursor / Open WebUI / LangChain: env vars only. */
const openai: ClientTarget = {
  id: "openai",
  label: "OpenAI SDK / Cursor / Open WebUI (OPENAI_BASE_URL)",
  emit(ctx) {
    return [
      `# ${ctx.label || ctx.profile} — point any OpenAI-compatible client here.`,
      `# Set these in your shell or .env, then use base_url/OPENAI_BASE_URL as-is.`,
      `# (Cursor: Settings → Models → OpenAI-compatible base URL.)`,
      "",
      `OPENAI_BASE_URL=${openaiBase(ctx)}`,
      "OPENAI_API_KEY=not-needed",
      "",
    ].join("\n");
  },
};

/** The `anthropic` SDK: env vars only (SDK appends /v1/messages). */
const anthropic: ClientTarget = {
  id: "anthropic",
  label: "Anthropic SDK (ANTHROPIC_BASE_URL)",
  emit(ctx) {
    return [
      `# ${ctx.label || ctx.profile} — point the anthropic SDK here.`,
      "# The SDK appends /v1/messages to this base URL.",
      "",
      `ANTHROPIC_BASE_URL=${anthropicBase(ctx)}`,
      "ANTHROPIC_API_KEY=not-needed",
      "",
    ].join("\n");
  },
};

/** Continue.dev config.yaml `models:` section. */
const continueDev: ClientTarget = {
  id: "continue",
  label: "Continue.dev (config.yaml models)",
  emit(ctx) {
    const base = openaiBase(ctx);
    const lines = ctx.models.map((m) => {
      return [
        `  - name: ${m.id}`,
        `    title: "${m.label}"`,
        `    provider: openai`,
        `    apiBase: ${base}`,
        `    apiKey: not-needed`,
      ].join("\n");
    });
    return ["# Continue.dev — merge this `models:` block into config.yaml", "models:", ...lines, ""].join("\n");
  },
};

/** Registered client targets, keyed by id. */
export const CLIENT_TARGETS: Record<string, ClientTarget> = {
  opencode,
  openai,
  anthropic,
  continue: continueDev,
};

/** All targets in declaration order (for `wspr config` help). */
export function clientTargets(): ClientTarget[] {
  return Object.values(CLIENT_TARGETS);
}
