import { timingSafeEqual } from "node:crypto";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "./config.js";
import type { SessionPool } from "./session-pool.js";
import { Credential, VaultHandle, type LoginMethod } from "./credentials/vault.js";
import { confirmSession } from "./credentials/session.js";
import { checkSessions, readHealthCache, type HealthTarget } from "./credentials/health.js";
import { validateBrowserProfile } from "./browser.js";
import { buildProviders } from "./providers/factory.js";
import {
  LoginRequiredError,
  supportsEmbeddings,
  supportsTools,
  supportsAutoLogin,
  type ChatOptions,
  type LLMProvider,
  type Message,
  type ToolCallingProvider,
  type Usage,
} from "./providers/base.js";
import {
  newCallId,
  type ToolCall,
  type ToolChoice,
  type ToolDefinition,
  PromptTooLargeError,
} from "./providers/tool-protocol.js";
import { ApiKeyMissingError } from "./providers/api.js";
import { listModels, resolveModel } from "./models.js";
import { anthropicUsage, openAIUsage, toOpenAIWire } from "./providers/openai-tools.js";

declare global {
  namespace Express {
    interface Request {
      /** The active API profile, stashed by the mount middleware. */
      wsprProfile?: string;
    }
  }
}

/** Build the sampling-params object for a route, dropping unset fields. */
function buildParams(src: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Middleware factory: pin the shared router to the server's default profile. */
function setProfileMiddleware(profile: string): express.RequestHandler {
  return (req, _res, next) => {
    req.wsprProfile = profile;
    next();
  };
}

/**
 * Middleware for the `/p/:profile` mount. Express 4 exposes the mount-path
 * param here, so we stash it on `req` and the shared router needs no mergeParams.
 */
const setProfileFromPath: express.RequestHandler = (req, res, next) => {
  const raw = String(req.params.profile);
  try {
    req.wsprProfile = validateBrowserProfile(raw);
  } catch (err) {
    // validateBrowserProfile throws; letting it escape hands the request to
    // Express's default handler, which answers 500 text/html. Every other
    // error this API returns is JSON, so translate it here.
    res.status(400).json({
      error: { message: (err as Error).message, type: "invalid_request_error" },
    });
    return;
  }
  next();
};

/**
 * Flatten an Anthropic content value (a string, or an array of content blocks)
 * down to plain text. Text blocks are concatenated; non-text blocks (e.g.
 * images) are ignored — the internal providers consume plain strings. This is
 * the text-only helper; tool-aware routing branches above it.
 */
function blocksToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } =>
      !!b && b.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text)
    .join("\n");
}

/**
 * Convert an Anthropic Messages request — which carries the system prompt in a
 * separate `system` field and allows message `content` to be a string or an
 * array of content blocks — into the flat `Message[]` our providers consume.
 *
 * When `keepTools` is set (browser providers), tool blocks survive the
 * conversion: `tool_use` blocks on an assistant turn become `tool_calls`, and
 * `tool_result` blocks on a user turn become `role: "tool"` messages. Otherwise
 * (API-key providers) non-text blocks are flattened away as before.
 */
export function anthropicToMessages(system: unknown, messages: any[], keepTools = false): Message[] {
  const out: Message[] = [];
  const sys = blocksToText(system).trim();
  if (sys) out.push({ role: "system", content: sys });
  for (const m of messages) {
    if (keepTools && m.role === "assistant") {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
      const toolUses = blocks.filter((b: any) => b?.type === "tool_use");
      const msg: Message = { role: "assistant", content: blocksToText(m.content) };
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((b: any) => ({
          id: b.id,
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        }));
      }
      out.push(msg);
      continue;
    }
    if (keepTools && m.role === "user") {
      const blocks = Array.isArray(m.content) ? m.content : null;
      const toolResults = (blocks?.filter((b: any) => b?.type === "tool_result") ?? []) as any[];
      if (toolResults.length) {
        for (const b of toolResults) {
          out.push({
            role: "tool",
            content: blocksToText(b.content),
            tool_call_id: b.tool_use_id,
          } as Message);
        }
        // A tool-result turn may also carry text ("…and answer in Nepali").
        // Keep it as a trailing user message so the instruction is not lost.
        const alsoText = blocksToText(m.content).trim();
        if (alsoText) out.push({ role: "user", content: alsoText });
        continue;
      }
    }
    out.push({ role: m.role, content: blocksToText(m.content) });
  }
  return out;
}

/**
 * Convert an OpenAI chat request into the flat `Message[]` our providers
 * consume. Flattens multimodal `content` arrays to text (browser UIs are
 * text-only — the `[object Object]` bug), and carries assistant `tool_calls`
 * plus `role: "tool"` messages through so a tool loop survives the boundary.
 */
export function openaiToMessages(messages: any[]): Message[] {
  return messages.map((m) => {
    if (m.role === "assistant") {
      const msg: Message = { role: "assistant", content: typeof m.content === "string" ? m.content : "" };
      const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      if (toolCalls.length) {
        msg.tool_calls = toolCalls.map((tc: any) => ({
          id: tc.id ?? newCallId(),
          name: tc.function?.name ?? "",
          arguments:
            typeof tc.function?.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc.function?.arguments ?? {}),
        }));
      }
      return msg;
    }
    if (m.role === "tool") {
      return {
        role: "tool",
        // A tool result can arrive as a content-part array (the AI SDK emits
        // that shape when cache breakpoints are on). Flatten it like any other
        // content — stringifying it types a literal `[{"type":"text",…}]` into
        // the chat box. JSON is the fallback only for a shape with no text
        // parts at all, where showing something beats showing nothing.
        content: toolContentToText(m.content),
        tool_call_id: m.tool_call_id,
        name: m.name,
      } as Message;
    }
    return { role: m.role, content: openaiContentToText(m.content) } as Message;
  });
}

/**
 * Flatten a `role: "tool"` message's content to the text we type into the tab.
 * Falls back to JSON only when the value carries no text parts to extract.
 */
function toolContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  const text = openaiContentToText(content);
  if (text) return text;
  return content == null ? "" : JSON.stringify(content);
}

/** Flatten an OpenAI `content` (string, or array of text/image parts) to plain text. */
function openaiContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } =>
      !!b && b.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text)
    .join("\n");
}

/**
 * An AbortSignal that fires when the client hangs up.
 *
 * A browser provider that keeps polling after the client is gone burns a tab
 * (and the provider's rate limit) on an answer nobody will read, and — worse —
 * leaves a half-read exchange in the tab that would poison the next turn's
 * conversation affinity. See WebLLMProvider.streamWithTools.
 */
function abortOnDisconnect(_req: Request, res: Response): AbortSignal {
  const ac = new AbortController();
  // Listen on the *response*, not the request. `req`'s "close" fires as soon
  // as the request body has been fully read — which for an ordinary POST is
  // immediately, and would abort every call. `res`'s "close" fires when the
  // connection goes away; `writableEnded` then tells a hang-up apart from a
  // response we finished writing ourselves.
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  return ac.signal;
}

/** The `error` payload for a failure, tagged with the type a client can act on. */
function errorBody(err: unknown): { message: string; type: string } {
  if (err instanceof LoginRequiredError || err instanceof ApiKeyMissingError) {
    return { message: err.message, type: "authentication_error" };
  }
  if (err instanceof PromptTooLargeError) {
    return { message: err.message, type: "invalid_request_error" };
  }
  return { message: (err as Error).message, type: "server_error" };
}

/** The Anthropic dialect's name for one of {@link errorBody}'s types. */
function anthropicErrorType(type: string): string {
  return type === "server_error" ? "api_error" : type;
}

/** Map OpenAI `tools` to internal {@link ToolDefinition}s (function shape). */
export function openaiToolsToDefs(tools: any): ToolDefinition[] {
  if (!Array.isArray(tools)) return [];
  const defs: ToolDefinition[] = [];
  for (const t of tools) {
    const fn = t?.function;
    if (!fn?.name) continue;
    defs.push({ name: fn.name, description: fn.description, parameters: fn.parameters });
  }
  return defs;
}

/** Map OpenAI `tool_choice` to the internal normalized directive. */
export function openaiToolChoiceToInternal(toolChoice: any): ToolChoice {
  if (!toolChoice || toolChoice === "auto") return "auto";
  if (toolChoice === "none" || toolChoice === "required") return toolChoice;
  if (toolChoice.name) return { name: toolChoice.name };
  if (toolChoice.function?.name) return { name: toolChoice.function.name };
  return "auto";
}

/** Map Anthropic `tools` (input_schema shape) to internal {@link ToolDefinition}s. */
function anthropicToolsToDefs(tools: any): ToolDefinition[] {
  if (!Array.isArray(tools)) return [];
  const defs: ToolDefinition[] = [];
  for (const t of tools) {
    if (!t?.name) continue;
    defs.push({ name: t.name, description: t.description, parameters: t.input_schema });
  }
  return defs;
}

/** Map Anthropic `tool_choice` (auto/any/tool) to the internal normalized directive. */
function anthropicToolChoiceToInternal(toolChoice: any): ToolChoice {
  if (!toolChoice || toolChoice === "auto") return "auto";
  if (toolChoice === "any" || toolChoice === "tool") return "required";
  if (toolChoice === "none") return "none";
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "tool" && toolChoice.name) return { name: toolChoice.name };
  return "auto";
}

/**
 * Collect the full text (and any tool calls) from a provider for a buffered
 * response. With tools, we iterate the tool-aware stream; without, we simply
 * collect text deltas via `chat()`.
 */
/**
 * Map an OpenAI-style `finish_reason` onto the Anthropic `stop_reason`
 * vocabulary. Returns undefined for anything unrecognized so the caller keeps
 * its own inferred value.
 */
export function finishToStopReason(reason: string | undefined): string | undefined {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return undefined;
  }
}

async function collectText(
  llm: LLMProvider,
  messages: Message[],
  opts: ChatOptions,
  withTools: boolean,
): Promise<{ text: string; toolCalls: ToolCall[]; finish?: string; usage?: Usage }> {
  // Drain the richer stream whenever the provider has one, even with no tools
  // declared — it is the only path that carries the upstream finish reason and
  // token usage, and `chat()` is itself just a text-concatenating adapter over
  // it. Tool calls are only kept when the caller actually asked for tools.
  if (supportsTools(llm)) {
    let text = "";
    let finish: string | undefined;
    let usage: Usage | undefined;
    const toolCalls: ToolCall[] = [];
    for await (const ev of llm.streamWithTools(messages, opts)) {
      if (ev.type === "text") text += ev.text;
      else if (ev.type === "tool_call") {
        if (withTools) toolCalls.push(ev.call);
      } else {
        finish = ev.reason;
        usage = ev.usage;
      }
    }
    return { text, toolCalls, finish, usage };
  }
  return { text: await llm.chat(messages, opts), toolCalls: [] };
}

export function createServer(config: AppConfig, pool: SessionPool, vault?: VaultHandle, uiToken?: string) {
  const providers = buildProviders(config, pool, vault);
  const app = express();
  app.use(express.json({ limit: config.maxBody }));
  // Without this, an over-limit body escapes to Express's default handler and
  // the client gets an HTML 413 — which an OpenAI SDK reports as an opaque
  // JSON parse failure rather than "your request was too big".
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (err?.type === "entity.too.large") {
      res.status(413).json({
        error: {
          message:
            `Request body exceeds the ${config.maxBody} limit. Agent clients send whole ` +
            `files in tool results — raise it with WSPR_MAX_BODY.`,
          type: "invalid_request_error",
        },
      });
      return;
    }
    next(err);
  });

  // ── optional API-key authentication ──────────────────────────────────────
  // When WSPR_API_KEY is set, gated routes require a matching key supplied
  // via either `Authorization: Bearer <key>` or `x-api-key: <key>`. When the
  // env var is unset or empty, authentication is disabled (no-op).
  const apiKey = process.env.WSPR_API_KEY ?? "";

  function extractKey(req: express.Request): string | undefined {
    const auth = req.header("authorization");
    if (auth && auth.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
    const xApiKey = req.header("x-api-key");
    if (xApiKey) return xApiKey.trim();
    return undefined;
  }

  // OpenAI-style error shape for /v1/* routes.
  const requireApiKey: express.RequestHandler = (req, res, next) => {
    if (!apiKey) return next();
    if (extractKey(req) !== apiKey) {
      res.status(401).json({
        error: { message: "Invalid or missing API key.", type: "authentication_error" },
      });
      return;
    }
    next();
  };

  // Simpler error shape for the original /chat route.
  const requireApiKeySimple: express.RequestHandler = (req, res, next) => {
    if (!apiKey) return next();
    if (extractKey(req) !== apiKey) {
      res.status(401).json({ error: "Invalid or missing API key." });
      return;
    }
    next();
  };

  // ── shared router ────────────────────────────────────────────────────────
  // All data routes live on one router so they can be mounted both bare
  // (`/v1/*` → the default profile) and under a profile prefix (`/p/email1/v1/*`).
  // The mount middleware stashes `req.wsprProfile`; the router never reads the
  // URL, so it needs no mergeParams.

  const api = express.Router();

  // ── original endpoint ────────────────────────────────────────────────────

  api.get("/health", (req, res) => {
    // The provider list is scoped to the active profile.
    const scoped = listModels(config, req.wsprProfile).filter((e) => e.model === undefined);
    res.json({ ok: true, providers: [...new Set(scoped.map((e) => e.provider))] });
  });

  api.post("/chat", requireApiKeySimple, async (req, res) => {
    const { provider, messages, model, newChat, profile, continuity } = req.body ?? {};
    // `provider` selects the browser session; `model` switches within it. A
    // bare model ("qwen") or `provider/model` both resolve through resolveModel,
    // so profile scoping and the first-slash split apply here too.
    const effectiveModel = provider && model && !model.includes("/")
      ? `${provider}/${model}`
      : (model || provider);
    const resolved = effectiveModel ? resolveModel(config, req.wsprProfile, effectiveModel) : { error: "A provider or model is required." };
    if ("error" in resolved) {
      res.status(400).json({ error: resolved.error });
      return;
    }
    const target = resolved.provider;
    const llm = providers.get(target);

    if (!llm) {
      res.status(400).json({
        error: `Unknown provider "${target}". Available: ${[...providers.keys()].join(", ")}`,
      });
      return;
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "`messages` must be a non-empty array" });
      return;
    }

    try {
      const content = await llm.chat(messages as Message[], {
        newChat,
        model: resolved.model,
        profile: profile ?? req.wsprProfile,
        signal: abortOnDisconnect(req, res),
        continuity,
      });
      res.json({ provider: target, message: { role: "assistant", content } });
    } catch (err) {
      if (err instanceof LoginRequiredError || err instanceof ApiKeyMissingError) {
        res.status(401).json({ error: err.message, provider: target });
        return;
      }
      console.error(`[${target}]`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── OpenAI-compatible endpoints ──────────────────────────────────────────

  api.get("/v1/models", requireApiKey, (req, res) => {
    const created = Math.floor(Date.now() / 1000);
    const entries = listModels(config, req.wsprProfile);
    res.json({
      object: "list",
      data: entries.map((e) => ({
        id: e.id,
        object: "model",
        created,
        owned_by: "llm-whisperer",
        // Extra, ignorable metadata so clients can show the kind/label.
        wspr: {
          provider: e.provider,
          model: e.model ?? null,
          kind: e.kind,
          label: e.label,
          profile: req.wsprProfile ?? null,
        },
      })),
    });
  });

  api.post("/v1/chat/completions", requireApiKey, async (req, res) => {
    const {
      model,
      messages,
      stream = false,
      newChat,
      profile,
      tools,
      tool_choice,
      continuity,
      temperature,
      max_tokens,
      top_p,
      stop,
      seed,
      response_format,
    } = req.body ?? {};
    // model field: "qwen" selects the provider; "qwen/qwen2.5-max" also switches.
    const resolved = resolveModel(config, req.wsprProfile, model ?? "");
    if ("error" in resolved) {
      res.status(400).json({ error: { message: resolved.error, type: "invalid_request_error" } });
      return;
    }
    const { provider: providerKey, model: modelName } = resolved;
    const llm = providers.get(providerKey);

    if (!llm) {
      res.status(400).json({
        error: {
          message: `Unknown provider "${providerKey}". Available: ${[...providers.keys()].join(", ")}`,
          type: "invalid_request_error",
        },
      });
      return;
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({
        error: { message: "`messages` must be a non-empty array", type: "invalid_request_error" },
      });
      return;
    }

    const id = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    // Tools are honoured by both doors: browser providers simulate them by
    // prompting, API-key providers get real native passthrough upstream.
    const toolDefs = openaiToolsToDefs(tools);
    const useTools = toolDefs.length > 0;
    const isApi = !!config.providers[providerKey]?.api;
    const withTools = useTools && supportsTools(llm);

    // Browser providers get normalized messages (fixes the `[object Object]`
    // content-array bug and carries tool_calls/tool role through). API-key
    // providers keep the original array so vision parts reach upstream intact.
    const internal = isApi ? (messages as Message[]) : openaiToMessages(messages);
    const opts: ChatOptions = {
      newChat,
      model: modelName,
      profile: profile ?? req.wsprProfile,
      tools: toolDefs,
      toolChoice: openaiToolChoiceToInternal(tool_choice),
      params: buildParams({ temperature, max_tokens, top_p, stop, seed, response_format }),
      signal: abortOnDisconnect(req, res),
      // A request that declares tools comes from an agent client, which always
      // re-sends its full history — the signal a browser provider needs to
      // tell a new conversation apart from a continuation.
      stateless: useTools,
      continuity,
    };

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      const send = (
        delta: Partial<{ role: string; content: string; tool_calls: unknown[] }>,
        finishReason: string | null = null,
        usage?: Usage,
      ) =>
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
            ...(usage ? { usage: openAIUsage(usage) } : {}),
          })}\n\n`,
        );

      try {
        send({ role: "assistant" });            // opening chunk — role only
        if (supportsTools(llm)) {
          let toolIndex = 0;
          let toolCalled = false;
          let upstreamFinish: string | undefined;
          let upstreamUsage: Usage | undefined;
          for await (const ev of llm.streamWithTools(internal, opts)) {
            if (ev.type === "text") {
              send({ content: ev.text });
            } else if (ev.type === "finish") {
              upstreamFinish = ev.reason;
              upstreamUsage = ev.usage;
            } else if (withTools) {
              send({
                tool_calls: [
                  {
                    index: toolIndex++,
                    id: ev.call.id,
                    type: "function",
                    function: { name: ev.call.name, arguments: ev.call.arguments },
                  },
                ],
              });
              toolCalled = true;
            }
          }
          // Upstream's reason wins ("length" on truncation); otherwise infer it.
          // Usage rides the closing chunk (OpenAI's include_usage format).
          send({}, upstreamFinish ?? (toolCalled ? "tool_calls" : "stop"), upstreamUsage);
        } else {
          for await (const delta of llm.stream(internal, opts)) {
            send({ content: delta });
          }
          send({}, "stop");                       // closing chunk — finish_reason
        }
        res.write("data: [DONE]\n\n");
        res.end();
      } catch (err) {
        // Headers went out with the first chunk, so a status code is no longer
        // available — but the stream must still *end* like a stream. Without a
        // closing chunk and [DONE], an SDK sits waiting until its chunk
        // timeout instead of surfacing the error.
        res.write(`data: ${JSON.stringify({ error: errorBody(err) })}\n\n`);
        send({}, "stop");
        res.write("data: [DONE]\n\n");
        res.end();
      }
      return;
    }

    try {
      const text = await collectText(llm, internal, opts, withTools);
      if (text.toolCalls?.length) {
        res.json({
          id,
          object: "chat.completion",
          created,
          model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: text.text || null,
                tool_calls: text.toolCalls.map((c) => ({
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: c.arguments },
                })),
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: openAIUsage(text.usage),
        });
        return;
      }
      res.json({
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text.text },
            // Upstream's reason when we have one ("length" on truncation);
            // browser providers report none, so assume a clean stop.
            finish_reason: text.finish ?? "stop",
          },
        ],
        usage: openAIUsage(text.usage),
      });
    } catch (err) {
      if (err instanceof LoginRequiredError || err instanceof ApiKeyMissingError) {
        res.status(401).json({ error: { message: err.message, type: "authentication_error" } });
        return;
      }
      if (err instanceof PromptTooLargeError) {
        res.status(413).json({ error: { message: err.message, type: "invalid_request_error" } });
        return;
      }
      console.error(`[${model}]`, err);
      res.status(500).json({ error: { message: (err as Error).message, type: "server_error" } });
    }
  });

  api.post("/v1/embeddings", requireApiKey, async (req, res) => {
    const { model, input } = req.body ?? {};
    // model field: "digitalocean" uses the provider's default embedModel;
    // "digitalocean/bge-m3" also picks the embedding model.
    const resolved = resolveModel(config, req.wsprProfile, model ?? "");
    if ("error" in resolved) {
      res.status(400).json({ error: { message: resolved.error, type: "invalid_request_error" } });
      return;
    }
    const { provider: providerKey, model: modelName } = resolved;
    const llm = providers.get(providerKey);

    if (!llm) {
      res.status(400).json({
        error: {
          message: `Unknown provider "${providerKey}". Available: ${[...providers.keys()].join(", ")}`,
          type: "invalid_request_error",
        },
      });
      return;
    }
    if (!supportsEmbeddings(llm)) {
      res.status(400).json({
        error: {
          message: `Provider "${providerKey}" does not support embeddings (only API-key providers do).`,
          type: "invalid_request_error",
        },
      });
      return;
    }
    if (input == null || (Array.isArray(input) && input.length === 0)) {
      res.status(400).json({
        error: { message: "`input` is required (a string or array of strings)", type: "invalid_request_error" },
      });
      return;
    }

    try {
      const result = await llm.embed(input as string | string[], modelName);
      // Echo back the requested model string (e.g. "digitalocean/bge-m3").
      res.json({ ...result, model });
    } catch (err) {
      if (err instanceof LoginRequiredError || err instanceof ApiKeyMissingError) {
        res.status(401).json({ error: { message: err.message, type: "authentication_error" } });
        return;
      }
      console.error(`[${model}]`, err);
      res.status(500).json({ error: { message: (err as Error).message, type: "server_error" } });
    }
  });

  // ── Anthropic-compatible endpoint ────────────────────────────────────────
  // Mirrors the OpenAI route above, but speaks the Anthropic Messages API shape
  // so the `anthropic` SDK (and tools that target it) work by pointing their
  // base URL here. `model` selects the provider exactly like the other routes:
  // "qwen" picks the provider, "qwen/qwen2.5-max" also switches the model.

  api.post("/v1/messages", requireApiKey, async (req, res) => {
    const {
      model,
      messages,
      system,
      stream = false,
      newChat,
      profile,
      tools,
      tool_choice,
      continuity,
      max_tokens,
      temperature,
      top_p,
      stop_sequences,
      seed,
    } = req.body ?? {};
    const resolved = resolveModel(config, req.wsprProfile, model ?? "");
    if ("error" in resolved) {
      res.status(400).json({
        type: "error",
        error: { type: "invalid_request_error", message: resolved.error },
      });
      return;
    }
    const { provider: providerKey, model: modelName } = resolved;
    const llm = providers.get(providerKey);

    if (!llm) {
      res.status(400).json({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `Unknown provider "${providerKey}". Available: ${[...providers.keys()].join(", ")}`,
        },
      });
      return;
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({
        type: "error",
        error: { type: "invalid_request_error", message: "`messages` must be a non-empty array" },
      });
      return;
    }

    // Tools are honoured on both doors. Browser providers preserve the tool
    // blocks; API-key providers are re-shaped into OpenAI wire form so their
    // native passthrough receives a complete tool loop.
    const toolDefs = anthropicToolsToDefs(tools);
    const useTools = toolDefs.length > 0;
    const isApi = !!config.providers[providerKey]?.api;
    const withTools = useTools && supportsTools(llm);

    const internal = isApi
      ? toOpenAIWire(anthropicToMessages(system, messages, useTools))
      : anthropicToMessages(system, messages, true);
    const opts: ChatOptions = {
      newChat,
      model: modelName,
      profile: profile ?? req.wsprProfile,
      tools: toolDefs,
      toolChoice: anthropicToolChoiceToInternal(tool_choice),
      params: buildParams({ max_tokens, temperature, top_p, stop: stop_sequences, seed }),
      signal: abortOnDisconnect(req, res),
      stateless: useTools,
      continuity,
    };
    const id = `msg_${Date.now()}`;

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      // Anthropic SSE: each event is a named `event:` line plus a `data:` line.
      const event = (type: string, data: object) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

      const emitTextBlock = (index: number, delta: string) =>
        event("content_block_delta", { index, delta: { type: "text_delta", text: delta } });
      const emitToolUse = (index: number, call: ToolCall) => {
        event("content_block_start", {
          index,
          content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
        });
        event("content_block_delta", {
          index,
          delta: { type: "input_json_delta", partial_json: call.arguments },
        });
        event("content_block_stop", { index });
      };

      try {
        event("message_start", {
          message: {
            id,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });

        if (supportsTools(llm)) {
          let blockIndex = -1;
          let textOpen = false;
          let toolCalled = false;
          let upstreamFinish: string | undefined;
          let upstreamUsage: Usage | undefined;
          const closeTextBlock = () => {
            if (textOpen) {
              event("content_block_stop", { index: blockIndex });
              textOpen = false;
            }
          };
          for await (const ev of llm.streamWithTools(internal, opts)) {
            if (ev.type === "text") {
              if (!textOpen) {
                blockIndex++;
                textOpen = true;
                event("content_block_start", {
                  index: blockIndex,
                  content_block: { type: "text", text: "" },
                });
              }
              emitTextBlock(blockIndex, ev.text);
            } else if (ev.type === "finish") {
              upstreamFinish = ev.reason;
              upstreamUsage = ev.usage;
            } else if (withTools) {
              closeTextBlock();
              blockIndex++;
              emitToolUse(blockIndex, ev.call);
              toolCalled = true;
            }
          }
          closeTextBlock();
          event("message_delta", {
            // Upstream's reason wins ("max_tokens" on truncation). Anthropic's
            // cumulative output_tokens rides here from the upstream usage.
            delta: {
              stop_reason:
                finishToStopReason(upstreamFinish) ?? (toolCalled ? "tool_use" : "end_turn"),
              stop_sequence: null,
            },
            usage: { output_tokens: upstreamUsage?.completion_tokens ?? 0 },
          });
        } else {
          event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
          for await (const delta of llm.stream(internal, opts)) {
            emitTextBlock(0, delta);
          }
          event("content_block_stop", { index: 0 });
          event("message_delta", {
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 0 },
          });
        }
        event("message_stop", {});
        res.end();
      } catch (err) {
        const body = errorBody(err);
        event("error", { error: { type: anthropicErrorType(body.type), message: body.message } });
        // Close the message properly so the SDK stops waiting for more events.
        event("message_stop", {});
        res.end();
      }
      return;
    }

    try {
      const out = await collectText(llm, internal, opts, withTools);
      const content: unknown[] = [];
      if (out.text) content.push({ type: "text", text: out.text });
      for (const c of out.toolCalls) {
        let input: unknown = {};
        try {
          input = JSON.parse(c.arguments);
        } catch {
          input = c.arguments;
        }
        content.push({ type: "tool_use", id: c.id, name: c.name, input });
      }
      if (!content.length) content.push({ type: "text", text: "" });
      res.json({
        id,
        type: "message",
        role: "assistant",
        model,
        content,
        stop_reason:
          finishToStopReason(out.finish) ?? (out.toolCalls.length ? "tool_use" : "end_turn"),
        stop_sequence: null,
        usage: anthropicUsage(out.usage),
      });
    } catch (err) {
      if (err instanceof LoginRequiredError || err instanceof ApiKeyMissingError) {
        res.status(401).json({ type: "error", error: { type: "authentication_error", message: err.message } });
        return;
      }
      if (err instanceof PromptTooLargeError) {
        res.status(413).json({ type: "error", error: { type: "invalid_request_error", message: err.message } });
        return;
      }
      console.error(`[${model}]`, err);
      res.status(500).json({ type: "error", error: { type: "api_error", message: (err as Error).message } });
    }
  });

  // ── mount once bare and once under a profile prefix ──────────────────────
  // Bare `/v1/*` and `/chat` use the server's default browser profile; the
  // `/p/:profile` sister always overrides `req.wsprProfile` from the path.
  app.use(setProfileMiddleware(config.browserProfile), api);
  app.use("/p/:profile", setProfileFromPath, api);

  // ── credentials dashboard / UI ─────────────────────────────────────────────
  // This is the one place the vault's redacted view is exposed. All /ui routes
  // require the UI token (a separate gate from WSPR_API_KEY) and pass an
  // origin check against DNS rebinding. Passwords are write-only here — the
  // server never returns one, and reading one back is `wspr creds show`.

  const uiGate: express.RequestHandler = (req, res, next) => {
    if (!uiToken || !safeEqual(extractUiToken(req), uiToken)) {
      res.status(401).json({ error: "Invalid or missing UI token." });
      return;
    }
    next();
  };

  const allowedHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);
  const originCheck: express.RequestHandler = (req, res, next) => {
    const host = (req.header("host") ?? "").replace(/:\d+$/, "").toLowerCase();
    if (!allowedHosts.has(host) && host !== (config.host ?? "").toLowerCase()) {
      res.status(403).json({ error: "Forbidden host (DNS rebinding guard)." });
      return;
    }
    const origin = req.header("origin");
    if (origin && origin !== "null") {
      let ohost = "";
      try {
        ohost = new URL(origin).hostname.toLowerCase();
      } catch {
        /* ignore malformed origin */
      }
      if (ohost && !allowedHosts.has(ohost) && ohost !== (config.host ?? "").toLowerCase()) {
        res.status(403).json({ error: "Forbidden origin." });
        return;
      }
    }
    next();
  };

  const browserTargets = (): HealthTarget[] => {
    const targets: HealthTarget[] = [];
    for (const [name, cfg] of Object.entries(config.providers)) {
      if (cfg.api || !cfg.requiresLogin) continue;
      targets.push({ provider: name, profile: cfg.profile ?? config.browserProfile });
    }
    return targets;
  };

  const statusPayload = () => {
    const health = readHealthCache(config);
    const byKey = new Map(health.map((r) => [`${r.profile}\u0000${r.provider}`, r]));
    const creds = vault?.listRedacted() ?? [];
    const credByKey = new Map(creds.map((c) => [`${c.profile}\u0000${c.provider}`, c]));
    const rows = browserTargets().map((t) => {
      const key = `${t.profile}\u0000${t.provider}`;
      const h = byKey.get(key);
      const c = credByKey.get(key);
      return {
        provider: t.provider,
        profile: t.profile,
        hasCredential: c !== undefined,
        credentialMethod: c?.method ?? null,
        loggedIn: h?.loggedIn ?? false,
        // "in" | "out" | "unknown"; absent until a check has run.
        state: h?.state ?? null,
        lastChecked: h?.checkedAt ?? null,
      };
    });
    return { providers: rows, vaultLocked: vault?.locked ?? true };
  };

  app.get("/ui", uiGate, originCheck, (_req, res) => {
    res.type("html").send(UI_HTML);
  });

  app.post("/ui/api/unlock", uiGate, originCheck, async (req, res) => {
    const passphrase = String(req.body?.passphrase ?? "").trim();
    if (!passphrase || !vault) {
      res.status(400).json({ error: "A passphrase is required to unlock the vault." });
      return;
    }
    try {
      await vault.unlock(passphrase);
      res.json({ ok: true });
    } catch (e) {
      res.status(401).json({ error: `Could not unlock: ${(e as Error).message}` });
    }
  });

  app.get("/ui/api/status", uiGate, originCheck, (_req, res) => {
    res.json(statusPayload());
  });

  app.get("/ui/api/credentials", uiGate, originCheck, (req, res) => {
    const profile = typeof req.query.profile === "string" ? req.query.profile : undefined;
    res.json(vault?.listRedacted(profile) ?? []);
  });

  app.post("/ui/api/credentials", uiGate, originCheck, async (req, res) => {
    const { profile, provider, email, password, method, note } = req.body ?? {};
    if (!provider || !profile) {
      res.status(400).json({ error: "`provider` and `profile` are required." });
      return;
    }
    const cfg = config.providers[provider];
    if (!cfg || cfg.api) {
      res.status(400).json({ error: `Unknown browser provider "${provider}".` });
      return;
    }
    const value = String(email ?? "").trim();
    if (!value) {
      res.status(400).json({ error: "`email` is required." });
      return;
    }
    const m: LoginMethod = method === "manual" || password === undefined || password === ""
      ? "manual"
      : "password";
    const cred = new Credential(
      value,
      m,
      new Date().toISOString(),
      m === "password" ? String(password) : undefined,
      note ? String(note) : undefined,
    );
    if (!vault) {
      res.status(503).json({ error: "No credential vault is configured." });
      return;
    }
    try {
      await vault.set(validateBrowserProfile(profile), provider, cred);
      res.json({ ok: true });
    } catch (e) {
      res.status(409).json({ error: (e as Error).message });
    }
  });

  app.delete("/ui/api/credentials/:profile/:provider", uiGate, originCheck, async (req, res) => {
    const profile = String(req.params.profile);
    const provider = String(req.params.provider);
    if (!vault) {
      res.status(503).json({ error: "No credential vault is configured." });
      return;
    }
    try {
      await vault.remove(profile, provider);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.post("/ui/api/check", uiGate, originCheck, async (_req, res) => {
    try {
      await checkSessions(pool, config, browserTargets());
      res.json(statusPayload());
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post("/ui/api/login/:provider/:profile", uiGate, originCheck, async (req, res) => {
    const provider = String(req.params.provider);
    const profile = validateBrowserProfile(String(req.params.profile));
    const cfg = config.providers[provider];
    if (!cfg || cfg.api || !cfg.login) {
      res.status(400).json({ error: `Provider "${provider}" has no auto-login block.` });
      return;
    }
    // Go through the provider's guarded autoLogin, never `attemptLogin`
    // directly: that is what keeps the never-retry rule true here too, so
    // clicking "Login" repeatedly cannot replay a wrong password and lock the
    // account.
    const llm = providers.get(provider);
    if (!llm || !supportsAutoLogin(llm)) {
      res.status(400).json({ error: `Provider "${provider}" cannot auto-login.` });
      return;
    }
    const page = await pool.acquire(provider, profile);
    try {
      const attempt = await llm.autoLogin(page, profile);
      // Positive confirmation, not merely "the logged-out marker is missing" —
      // otherwise a provider with stale selectors reports a happy green
      // "logged in" on top of an attempt that plainly failed.
      const state = await confirmSession(page, cfg).catch(() => "unknown" as const);
      res.json({ ok: attempt.ok || state === "in", loggedIn: state === "in", state, reason: attempt.reason });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    } finally {
      // A login flow navigates the tab through forms and redirects, so any
      // conversation it was holding is gone.
      pool.clearState(page);
      pool.release(provider, profile, page);
    }
  });

  return app;
}

/**
 * Constant-time string compare, so the token guarding a password store cannot
 * be recovered a byte at a time. Length is compared first and leaks only the
 * length, which for a fixed-size token is not a secret.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** A UI token is checked against the WSPR_UI_TOKEN (query or x-ui-token header). */
function extractUiToken(req: express.Request): string {
  const fromQuery = typeof req.query.token === "string" ? req.query.token : "";
  const fromHeader = req.header("x-ui-token") ?? "";
  return (fromQuery || fromHeader).trim();
}

const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>llm-whisperer — credentials</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 2rem auto; padding: 0 1rem; max-width: 64rem; }
  h1 { font-size: 1.4rem; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #8882; }
  th { font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; color: #888; }
  input, button { font: inherit; padding: .4rem .6rem; margin: .2rem; }
  button { cursor: pointer; }
  .ok { color: #2e9b57; } .bad { color: #c0392b; } .warn { color: #b26a00; font-weight: 600; }
  .muted { color: #999; }
  form.inline { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
  .card { border: 1px solid #8882; border-radius: .5rem; padding: 1rem; margin: 1rem 0; }
  .row { display: flex; gap: .5rem; flex-wrap: wrap; }
</style>
</head>
<body>
<h1>🤫 llm-whisperer credentials</h1>
<p class="muted">Passwords are write-only here. To read one back, use <code>wspr creds show &lt;provider&gt;</code> on the machine running the server.</p>

<div class="card">
  <strong>Vault: </strong><span id="lockStatus">…</span>
  <button id="check">Check sessions</button>
</div>

<div class="card">
  <h2>Add / update credential</h2>
  <form id="credForm" class="inline">
    <input id="fProvider" placeholder="provider (qwen)" required>
    <input id="fProfile" placeholder="profile (default)" value="default">
    <input id="fEmail" placeholder="email" required>
    <input id="fPassword" type="password" placeholder="password (blank = manual)">
    <button type="submit">Save</button>
  </form>
</div>

<div class="card">
  <h2>Stored credentials</h2>
  <table id="creds"><thead><tr><th>Provider</th><th>Profile</th><th>Email</th><th>Method</th><th>Password</th><th></th></tr></thead><tbody></tbody></table>
</div>

<div class="card">
  <h2>Session health</h2>
  <table id="status"><thead><tr><th>Provider</th><th>Profile</th><th>Credential</th><th>Logged in</th><th>Checked</th><th></th></tr></thead><tbody></tbody></table>
</div>

<script>
(function () {
  var params = new URLSearchParams(window.location.search);
  var TOKEN = params.get("token") || "";
  function el(id) { return document.getElementById(id); }
  function api(path, opts) {
    var headers = { "x-ui-token": TOKEN };
    var o = opts || {};
    if (o.body) headers["Content-Type"] = "application/json";
    var init = { method: o.method || "GET", headers: headers };
    if (o.body) init.body = JSON.stringify(o.body);
    return fetch(path, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.error || "Error " + r.status);
        return data;
      });
    });
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function renderCreds(rows) {
    var tb = el("creds").querySelector("tbody");
    tb.innerHTML = "";
    rows.forEach(function (c) {
      var tr = document.createElement("tr");
      tr.innerHTML = "<td>" + esc(c.provider) + "</td><td>" + esc(c.profile) + "</td><td>" + esc(c.email) +
        "</td><td>" + esc(c.method) + "</td><td>" + (c.hasPassword ? "••••••" : "none") + "</td>" +
        "<td><button data-del='" + esc(c.provider) + "' data-prof='" + esc(c.profile) + "'>Delete</button></td>";
      tb.appendChild(tr);
    });
    tb.querySelectorAll("button[data-del]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        api("/ui/api/credentials/" + encodeURIComponent(btn.dataset.prof) + "/" + encodeURIComponent(btn.dataset.del), { method: "DELETE" })
          .then(refresh).catch(function (e) { alert(e.message); });
      });
    });
  }
  function renderHealth(rows) {
    var tb = el("status").querySelector("tbody");
    tb.innerHTML = "";
    rows.forEach(function (r) {
      var tr = document.createElement("tr");
      var cred = r.hasCredential ? (r.credentialMethod || "manual") : "<span class='bad'>none</span>";
      var login = r.state === "in" ? "<span class='ok'>yes</span>"
        : r.state === "out" ? "<span class='bad'>no</span>"
        : r.state === "unknown" ? "<span class='warn' title='Matched neither loggedOutSelector nor inputSelector — the selectors in providers.yaml are probably stale.'>unknown</span>"
        : "<span class='muted'>—</span>";
      var checked = r.lastChecked ? new Date(r.lastChecked).toLocaleString() : "<span class='muted'>never</span>";
      tr.innerHTML = "<td>" + esc(r.provider) + "</td><td>" + esc(r.profile) + "</td><td>" + cred + "</td><td>" + login +
        "</td><td>" + checked + "</td><td><button data-login='" + esc(r.provider) + "' data-prof='" + esc(r.profile) + "'>Login</button></td>";
      tb.appendChild(tr);
    });
    tb.querySelectorAll("button[data-login]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        btn.disabled = true; btn.textContent = "…";
        api("/ui/api/login/" + encodeURIComponent(btn.dataset.prof) + "/" + encodeURIComponent(btn.dataset.login), { method: "POST" })
          .then(function (r) { alert(r.loggedIn ? "Logged in." : "Login did not complete: " + (r.reason || "unknown")); })
          .catch(function (e) { alert(e.message); })
          .finally(function () { btn.disabled = false; btn.textContent = "Login"; refresh(); });
      });
    });
  }
  function refresh() {
    return Promise.all([api("/ui/api/status"), api("/ui/api/credentials")]).then(function (res) {
      var s = res[0]; var creds = res[1];
      el("lockStatus").textContent = s.vaultLocked ? "Locked" : "Unlocked";
      renderCreds(creds); renderHealth(s.providers);
    }).catch(function (e) { el("lockStatus").textContent = "Token problem: " + e.message; });
  }
  el("check").addEventListener("click", function () {
    el("check").disabled = true; el("check").textContent = "Checking…";
    api("/ui/api/check", { method: "POST" }).then(function (s) {
      renderHealth(s.providers);
    }).catch(function (e) { alert(e.message); }).finally(function () {
      el("check").disabled = false; el("check").textContent = "Check sessions";
    });
  });
  el("credForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var body = {
      provider: el("fProvider").value.trim(),
      profile: el("fProfile").value.trim() || "default",
      email: el("fEmail").value.trim(),
      password: el("fPassword").value,
    };
    api("/ui/api/credentials", { method: "POST", body: body }).then(function () {
      el("fPassword").value = ""; refresh();
    }).catch(function (e) { alert(e.message); });
  });
  refresh();
})();
</script>
</body>
</html>`;
