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
  const dir = mkdtempSync(join(tmpdir(), "wspr-lim-"));
  const file = join(dir, "providers.yaml");
  writeFileSync(file, YAML);
  return loadConfig(file);
}

async function serve(config: AppConfig) {
  const server = createServer(config, {} as SessionPool);
  const listener = server.listen(0);
  await new Promise((r) => listener.once("listening", r));
  return { port: (listener.address() as AddressInfo).port, close: () => listener.close() };
}

describe("request body limit", () => {
  it("defaults large enough for an agent's tool results", () => {
    assert.equal(load().maxBody, "32mb");
  });

  it("rejects an over-limit body as JSON, not Express's HTML page", async () => {
    // An HTML 413 reaches an OpenAI SDK as an opaque JSON parse failure, which
    // reads like a wspr bug rather than "your request was too big".
    process.env.WSPR_MAX_BODY = "1kb";
    try {
      const { port, close } = await serve(load());
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "groq",
            messages: [{ role: "user", content: "x".repeat(5000) }],
          }),
        });
        assert.equal(res.status, 413);
        assert.match(res.headers.get("content-type") ?? "", /application\/json/);
        const json = await res.json();
        assert.match(json.error.message, /WSPR_MAX_BODY/);
      } finally {
        close();
      }
    } finally {
      delete process.env.WSPR_MAX_BODY;
    }
  });
});

describe("streaming errors terminate the stream", () => {
  it("closes with a finish chunk and [DONE] so a client stops waiting", async () => {
    process.env.WSPR_TEST_KEY = "fake";
    const config = load();
    const { port, close } = await serve(config);

    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("api.groq.com")) throw new Error("upstream exploded");
      return original(input, init);
    }) as typeof fetch;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "groq",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      const body = await res.text();
      assert.match(body, /upstream exploded/, "the error reaches the client");
      assert.match(body, /"finish_reason":"stop"/, "the choice is closed out");
      assert.match(body, /data: \[DONE\]/, "and the stream is terminated");
    } finally {
      globalThis.fetch = original;
      delete process.env.WSPR_TEST_KEY;
      close();
    }
  });
});

describe("tool results arriving as content-part arrays", () => {
  it("flattens to text rather than typing a JSON blob into the chat box", async () => {
    // The AI SDK emits this shape when cache breakpoints are on. Stringifying
    // it sends the model a literal [{"type":"text",…}] instead of the result.
    const { openaiToMessages } = await import("../src/server.js");
    const [msg] = openaiToMessages([
      {
        role: "tool",
        tool_call_id: "call_1",
        name: "read",
        content: [{ type: "text", text: "file contents" }],
      },
    ]);
    assert.equal(msg.content, "file contents");
  });

  it("still falls back to JSON when there is no text part to extract", async () => {
    const { openaiToMessages } = await import("../src/server.js");
    const [msg] = openaiToMessages([{ role: "tool", tool_call_id: "c", content: { odd: 1 } }]);
    assert.equal(msg.content, '{"odd":1}');
  });
});
