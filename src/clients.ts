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
  /** Conventional filename the CLI writes to when no --out is given. */
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

/**
 * opencode: an OpenAI-compatible provider block keyed by profile, with every
 * model in the catalog listed explicitly. opencode does NOT auto-discover from
 * `/v1/models` — it requires a model map — which is exactly why this exists.
 */
const opencode: ClientTarget = {
  id: "opencode",
  label: "opencode (coding agent)",
  file: "opencode.json",
  emit(ctx) {
    const models: Record<string, { name: string }> = {};
    for (const m of ctx.models) models[m.id] = { name: m.label };
    return JSON.stringify(
      {
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
            },
            models,
          },
        },
      },
      null,
      2,
    );
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
