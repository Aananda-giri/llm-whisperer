import express from "express";
import type { AppConfig } from "./config.js";
import type { SessionPool } from "./session-pool.js";
import { buildProviders } from "./providers/factory.js";
import { LoginRequiredError, type Message } from "./providers/base.js";

export function createServer(config: AppConfig, pool: SessionPool) {
  const providers = buildProviders(config, pool);
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, providers: [...providers.keys()] });
  });

  // OpenAI-ish shape so existing clients can point here with minimal changes.
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
      res.json({
        provider: target,
        message: { role: "assistant", content },
      });
    } catch (err) {
      if (err instanceof LoginRequiredError) {
        res.status(401).json({ error: err.message, provider: target });
        return;
      }
      console.error(`[${target}]`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return app;
}
