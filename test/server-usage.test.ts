import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { loadConfig, type AppConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import type { SessionPool } from "../src/session-pool.js";

const YAML = `
providers:
  groq:
    api:
      baseUrl: "https://api.groq.com/openai/v1"
      model: "llama-3.3-70b-versatile"
      keyEnv: "WSPR_TEST_KEY"
`;

function load(): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), "wspr-srv-"));
  const file = join(dir, "providers.yaml");
  writeFileSync(file, YAML);
  return loadConfig(file);
}

function sse(body: string): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("POST /v1/chat/completions — real usage reaches the HTTP response", () => {
  it("reports upstream token counts and finish_reason", async () => {
    process.env.WSPR_TEST_KEY = "fake";
    const config = load();
    const server = createServer(config, {} as SessionPool);
    const listener = server.listen(0);
    await new Promise((r) => listener.once("listening", r));
    const port = (listener.address() as AddressInfo).port;

    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("api.groq.com")) {
        return sse(
          `data: {"choices":[{"delta":{"content":"hi"}}]}\n\n` +
            `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
            `data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n` +
            `data: [DONE]\n\n`,
        );
      }
      return original(input, init);
    }) as typeof fetch;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "groq", messages: [{ role: "user", content: "hi" }] }),
      });
      const json = await res.json();
      assert.equal(res.status, 200);
      assert.equal(json.choices[0].message.content, "hi");
      assert.equal(json.choices[0].finish_reason, "stop");
      assert.deepEqual(json.usage, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
    } finally {
      globalThis.fetch = original;
      delete process.env.WSPR_TEST_KEY;
      listener.close();
    }
  });

  it("reports truncation via finish_reason when the upstream says length", async () => {
    process.env.WSPR_TEST_KEY = "fake";
    const config = load();
    const server = createServer(config, {} as SessionPool);
    const listener = server.listen(0);
    await new Promise((r) => listener.once("listening", r));
    const port = (listener.address() as AddressInfo).port;

    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("api.groq.com")) {
        return sse(
          `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"length"}]}\n\n` +
            `data: [DONE]\n\n`,
        );
      }
      return original(input, init);
    }) as typeof fetch;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "groq", messages: [{ role: "user", content: "hi" }] }),
      });
      const json = await res.json();
      assert.equal(json.choices[0].finish_reason, "length");
    } finally {
      globalThis.fetch = original;
      delete process.env.WSPR_TEST_KEY;
      listener.close();
    }
  });
});
