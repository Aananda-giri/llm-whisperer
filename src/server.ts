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
      const content = await llm.chat(messages as Message[], { newChat, model: modelName });
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
        for await (const delta of llm.stream(messages as Message[], { newChat, model: modelName })) {
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
      const content = await llm.chat(messages as Message[], { newChat, model: modelName });
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
