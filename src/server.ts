import express from "express";
import type { AppConfig } from "./config.js";
import type { SessionPool } from "./session-pool.js";
import { buildProviders } from "./providers/factory.js";
import { LoginRequiredError, type Message } from "./providers/base.js";

export function createServer(config: AppConfig, pool: SessionPool) {
  const providers = buildProviders(config, pool);
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // ── original endpoint ────────────────────────────────────────────────────

  app.get("/health", (_req, res) => {
    res.json({ ok: true, providers: [...providers.keys()] });
  });

  app.post("/chat", async (req, res) => {
    const { provider, messages, model, newChat } = req.body ?? {};
    const target = provider ?? model;
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
      const content = await llm.chat(messages as Message[], { newChat });
      res.json({ provider: target, message: { role: "assistant", content } });
    } catch (err) {
      if (err instanceof LoginRequiredError) {
        res.status(401).json({ error: err.message, provider: target });
        return;
      }
      console.error(`[${target}]`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── OpenAI-compatible endpoints ──────────────────────────────────────────

  app.get("/v1/models", (_req, res) => {
    const created = Math.floor(Date.now() / 1000);
    res.json({
      object: "list",
      data: [...providers.keys()].map((id) => ({
        id,
        object: "model",
        created,
        owned_by: "llm-whisper",
      })),
    });
  });

  app.post("/v1/chat/completions", async (req, res) => {
    const { model, messages, stream = false, newChat } = req.body ?? {};
    const llm = providers.get(model);

    if (!llm) {
      res.status(400).json({
        error: {
          message: `Unknown model "${model}". Available: ${[...providers.keys()].join(", ")}`,
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

    try {
      if (stream) {
        // Streaming handled after commit 2 — for now fall through to buffered.
        // Clients that set stream:true will still get a valid (buffered) response.
        res.setHeader("X-LLM-Whisper-Stream", "buffered-fallback");
      }

      const content = await llm.chat(messages as Message[], { newChat });
      res.json({
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (err) {
      if (err instanceof LoginRequiredError) {
        res.status(401).json({ error: { message: err.message, type: "authentication_error" } });
        return;
      }
      console.error(`[${model}]`, err);
      res.status(500).json({ error: { message: (err as Error).message, type: "server_error" } });
    }
  });

  return app;
}
