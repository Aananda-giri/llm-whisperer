import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApiLLMProvider } from "../src/providers/api.js";
import type { ProviderConfig } from "../src/config.js";

/** SSE body as a fetch Response body, chunked to exercise partial reads. */
function sseResponses(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(enc.encode(line));
      controller.close();
    },
  });
}

const cfg = (): ProviderConfig => ({
  url: "",
  inputSelector: "",
  responseSelector: "",
  requiresLogin: false,
  timeoutMs: 0,
  stabilizeMs: 0,
  api: { baseUrl: "https://api.groq.com/openai/v1", model: "mm", keyEnv: "WSPR_TEST_FAKE_KEY" },
});

async function streamEvents(body: string[]) {
  process.env.WSPR_TEST_FAKE_KEY = "fake";
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(sseResponses(body), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
  try {
    const p = new ApiLLMProvider("groq", cfg());
    const events: any[] = [];
    for await (const ev of p.streamWithTools([{ role: "user", content: "hi" }])) events.push(ev);
    return events;
  } finally {
    globalThis.fetch = original;
    delete process.env.WSPR_TEST_FAKE_KEY;
  }
}

describe("ApiLLMProvider — finish + usage", () => {
  it("emits text deltas and a finish event carrying the upstream stop reason", async () => {
    const events = await streamEvents([
      `data: {"choices":[{"delta":{"content":"hi"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":" there"}}]}\n\n`,
      `data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n`,
      `data: [DONE]\n\n`,
    ]);
    const text = events.filter((e) => e.type === "text").map((e) => e.text).join("");
    assert.equal(text, "hi there");
    const finish = events.find((e) => e.type === "finish");
    assert.ok(finish, "upstream finish_reason must surface as a finish event");
    assert.equal(finish.reason, "length");
  });

  it("carries the real token usage from the trailing usage chunk", async () => {
    // OpenAI (include_usage) sends usage on a final chunk with empty choices,
    // after the finish_reason chunk and before [DONE].
    const events = await streamEvents([
      `data: {"choices":[{"delta":{"content":"hi"}}]}\n\n`,
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`,
      `data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n`,
      `data: [DONE]\n\n`,
    ]);
    const finish = events.find((e) => e.type === "finish");
    assert.ok(finish);
    assert.deepEqual(finish.usage, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
  });

  it("omits usage when the upstream reports none", async () => {
    const events = await streamEvents([
      `data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n`,
      `data: [DONE]\n\n`,
    ]);
    const finish = events.find((e) => e.type === "finish");
    assert.ok(finish);
    assert.equal(finish.usage, undefined);
  });

  it("emits a single finish event, not one per chunk", async () => {
    const events = await streamEvents([
      `data: {"choices":[{"delta":{"content":"a"},"finish_reason":"length"}]}\n\n`,
      `data: [DONE]\n\n`,
    ]);
    assert.equal(events.filter((e) => e.type === "finish").length, 1);
  });
});
