import express from "express";
import type { AppConfig } from "./config.js";
import type { SessionPool } from "./session-pool.js";
import { buildProviders } from "./providers/factory.js";
import { LoginRequiredError, supportsEmbeddings, type Message } from "./providers/base.js";
import { ApiKeyMissingError } from "./providers/api.js";

/**
 * Flatten an Anthropic content value (a string, or an array of content blocks)
 * down to plain text. Text blocks are concatenated; non-text blocks (e.g.
 * images) are ignored — the internal providers consume plain strings.
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
 */
function anthropicToMessages(system: unknown, messages: any[]): Message[] {
  const out: Message[] = [];
  const sys = blocksToText(system).trim();
  if (sys) out.push({ role: "system", content: sys });
  for (const m of messages) {
    out.push({ role: m.role, content: blocksToText(m.content) });
  }
  return out;
}

export function createServer(config: AppConfig, pool: SessionPool) {
  const providers = buildProviders(config, pool);
  const app = express();
  app.use(express.json({ limit: "1mb" }));

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

  // ── original endpoint ────────────────────────────────────────────────────

  app.get("/health", (_req, res) => {
    res.json({ ok: true, providers: [...providers.keys()] });
  });

  app.post("/chat", requireApiKeySimple, async (req, res) => {
    const { provider, messages, model, newChat, profile } = req.body ?? {};
    // `provider` selects the browser session; `model` switches within it.
    const target = provider ?? model?.split("/")[0];
    const modelName = model?.includes("/") ? model.split("/")[1] : undefined;
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
      const content = await llm.chat(messages as Message[], { newChat, model: modelName, profile });
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

  app.get("/v1/models", requireApiKey, (_req, res) => {
    const created = Math.floor(Date.now() / 1000);
    res.json({
      object: "list",
      data: [...providers.keys()].map((id) => ({
        id,
        object: "model",
        created,
        owned_by: "llm-whisperer",
      })),
    });
  });

  app.post("/v1/chat/completions", requireApiKey, async (req, res) => {
    const { model, messages, stream = false, newChat, profile } = req.body ?? {};
    // model field: "qwen" selects the provider; "qwen/qwen2.5-max" also switches model.
    const [providerKey, modelName] = (model as string ?? "").split("/");
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

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      const send = (delta: Partial<{ role: string; content: string }>, finishReason: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`,
        );

      try {
        send({ role: "assistant" });            // opening chunk — role only
        for await (const delta of llm.stream(messages as Message[], { newChat, model: modelName, profile })) {
          send({ content: delta });
        }
        send({}, "stop");                       // closing chunk — finish_reason
        res.write("data: [DONE]\n\n");
        res.end();
      } catch (err) {
        res.write(`data: ${JSON.stringify({ error: { message: (err as Error).message } })}\n\n`);
        res.end();
      }
      return;
    }

    try {
      const content = await llm.chat(messages as Message[], { newChat, model: modelName, profile });
      res.json({
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (err) {
      if (err instanceof LoginRequiredError || err instanceof ApiKeyMissingError) {
        res.status(401).json({ error: { message: err.message, type: "authentication_error" } });
        return;
      }
      console.error(`[${model}]`, err);
      res.status(500).json({ error: { message: (err as Error).message, type: "server_error" } });
    }
  });

  app.post("/v1/embeddings", requireApiKey, async (req, res) => {
    const { model, input } = req.body ?? {};
    // model field: "digitalocean" uses the provider's default embedModel;
    // "digitalocean/bge-m3" also picks the embedding model.
    const [providerKey, modelName] = (model as string ?? "").split("/");
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

  app.post("/v1/messages", requireApiKey, async (req, res) => {
    const { model, messages, system, stream = false, newChat, profile } = req.body ?? {};
    const [providerKey, modelName] = (model as string ?? "").split("/");
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

    const internal = anthropicToMessages(system, messages);
    const id = `msg_${Date.now()}`;

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      // Anthropic SSE: each event is a named `event:` line plus a `data:` line.
      const event = (type: string, data: object) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

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
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        for await (const delta of llm.stream(internal, { newChat, model: modelName, profile })) {
          event("content_block_delta", { index: 0, delta: { type: "text_delta", text: delta } });
        }
        event("content_block_stop", { index: 0 });
        event("message_delta", {
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 0 },
        });
        event("message_stop", {});
        res.end();
      } catch (err) {
        event("error", { error: { type: "api_error", message: (err as Error).message } });
        res.end();
      }
      return;
    }

    try {
      const content = await llm.chat(internal, { newChat, model: modelName, profile });
      res.json({
        id,
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: content }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      });
    } catch (err) {
      if (err instanceof LoginRequiredError || err instanceof ApiKeyMissingError) {
        res.status(401).json({ type: "error", error: { type: "authentication_error", message: err.message } });
        return;
      }
      console.error(`[${model}]`, err);
      res.status(500).json({ type: "error", error: { type: "api_error", message: (err as Error).message } });
    }
  });

  return app;
}
