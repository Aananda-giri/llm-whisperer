import type { ApiProviderConfig, ProviderConfig } from "../config.js";
import {
  BaseProvider,
  type ChatOptions,
  type EmbeddingProvider,
  type EmbeddingResponse,
  type Message,
  type StreamEvent,
  type ToolCallingProvider,
  type Usage,
} from "./base.js";
import { ToolCallAccumulator, toolChoiceToOpenAI, toolsToOpenAI } from "./openai-tools.js";

/**
 * Calls a real OpenAI-compatible HTTP API (OpenAI, DeepSeek, Groq, Together, …)
 * instead of driving a browser. One class covers every such service — only
 * baseUrl/model/key differ, all of which come from the provider's `api` block.
 *
 * Unlike the browser providers, this is stateless: there is no server-side
 * conversation, so the caller must send the full message history each request
 * (standard OpenAI behaviour). `newChat` is therefore a no-op here.
 *
 * Tool calling is **native**: `tools`/`tool_choice` are forwarded upstream and
 * the streamed `delta.tool_calls` fragments are folded into completed calls.
 * This is the inverse of the browser providers, which simulate tools by
 * prompting.
 */
export class ApiLLMProvider extends BaseProvider implements EmbeddingProvider, ToolCallingProvider {
  private readonly api: ApiProviderConfig;

  constructor(name: string, config: ProviderConfig) {
    super(name);
    if (!config.api) {
      throw new Error(`ApiLLMProvider "${name}" built without an api config block`);
    }
    this.api = config.api;
  }

  /**
   * Text-only streaming adapter: forwards only text deltas, so the existing
   * {@link LLMProvider} contract and every old call site are untouched. Use
   * {@link streamWithTools} when tool calling is needed.
   */
  async *stream(messages: Message[], options: ChatOptions = {}): AsyncGenerator<string> {
    for await (const ev of this.streamWithTools(messages, options)) {
      if (ev.type === "text") yield ev.text;
    }
  }

  /**
   * Streams a completion, folding native `delta.tool_calls` fragments into
   * completed {@link StreamEvent}s. Text deltas yield as they arrive; tool calls
   * are released once the stream signals completion (finish_reason or `[DONE]`),
   * followed by a single `finish` event carrying the upstream stop reason and,
   * when the upstream reports it, the real token `usage`.
   */
  async *streamWithTools(messages: Message[], options: ChatOptions = {}): AsyncGenerator<StreamEvent> {
    const body = await this.request(messages, options);

    const acc = new ToolCallAccumulator();
    let finishReason: string | undefined;
    let usage: Usage | undefined;
    for await (const { done, data } of parseSSE(body)) {
      if (done) break;
      // Usage arrives as a trailing chunk (often on the final `data:` line),
      // so keep the last one seen across the whole stream.
      if (data?.usage) usage = data.usage as Usage;
      const choice = data?.choices?.[0];
      const delta = choice?.delta ?? {};
      if (typeof delta.content === "string") yield { type: "text", text: delta.content };
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) acc.push(tc);
      }
      if (choice?.finish_reason) finishReason = String(choice.finish_reason);
    }
    // A stream that ends without an explicit finish_reason still owes us calls.
    for (const call of acc.flush()) yield { type: "tool_call", call };
    // Report upstream's own stop reason ("length" on truncation) and usage, so
    // the routes don't have to assume "stop" / zero token counts.
    if (finishReason) yield { type: "finish", reason: finishReason, usage };
  }

  /**
   * Produces embeddings via the OpenAI-compatible `/embeddings` endpoint.
   * `model` defaults to the provider's `embedModel`, falling back to its chat
   * `model` (which most APIs reject for embeddings — set `embedModel` instead).
   * The upstream OpenAI-shaped response is returned as-is.
   */
  async embed(input: string | string[], model?: string): Promise<EmbeddingResponse> {
    const key = process.env[this.api.keyEnv];
    if (!key) {
      throw new ApiKeyMissingError(this.name, this.api.keyEnv);
    }

    const baseUrl = this.resolveEnv(this.api.baseUrl).replace(/\/+$/, "");
    const endpoint = `${baseUrl}/embeddings`;
    const embedModel = model ?? this.api.embedModel ?? this.api.model;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model: embedModel, input }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `${this.name}: embeddings request failed (${res.status} ${res.statusText})` +
          (detail ? ` — ${detail.slice(0, 500)}` : ""),
      );
    }

    return (await res.json()) as EmbeddingResponse;
  }

  /** Build and send the /chat/completions request; returns the response body. */
  private async request(messages: Message[], options: ChatOptions): Promise<ReadableStream<Uint8Array>> {
    const key = process.env[this.api.keyEnv];
    if (!key) {
      throw new ApiKeyMissingError(this.name, this.api.keyEnv);
    }

    // baseUrl may contain ${VAR} placeholders (e.g. Cloudflare's account id),
    // resolved from the environment at request time.
    const baseUrl = this.resolveEnv(this.api.baseUrl).replace(/\/+$/, "");
    const endpoint = `${baseUrl}/chat/completions`;
    const model = options.model ?? this.api.model;

    const body: Record<string, unknown> = { model, messages, stream: true };
    // Sampling params forwarded verbatim (temperature, max_tokens, top_p, …).
    if (options.params) Object.assign(body, options.params);
    if (options.tools?.length) {
      body.tools = toolsToOpenAI(options.tools);
      if (options.toolChoice !== undefined) body.tool_choice = toolChoiceToOpenAI(options.toolChoice);
    }
    // Ask the upstream for token usage in the stream's trailing chunk, so the
    // `finish` event can carry real numbers instead of the hardcoded zeros.
    //
    // CAVEAT: `stream_options` is OpenAI-specific. Most OpenAI-compatible
    // providers (Groq, OpenRouter, Together, Cerebras, …) support it, but a
    // provider that rejects unknown params could 400 on it. Real usage stops
    // being available on that provider and `stream_options` must be dropped or
    // made opt-in per provider. The rest of the flow degrades gracefully — the
    // `finish` event is still emitted (reason only), and `usage` reads as zeros.
    body.stream_options = { include_usage: true };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `${this.name}: API request failed (${res.status} ${res.statusText})` +
          (detail ? ` — ${detail.slice(0, 500)}` : ""),
      );
    }

    return res.body;
  }

  /** Substitute `${VAR}` placeholders in a config string from the environment. */
  private resolveEnv(template: string): string {
    return template.replace(/\$\{(\w+)\}/g, (_match, name: string) => {
      const value = process.env[name];
      if (!value) throw new ApiKeyMissingError(this.name, name);
      return value;
    });
  }
}

/**
 * Parses an OpenAI-style `text/event-stream` body and yields the parsed JSON
 * payload of each `data:` event. Handles chunks split across reads by buffering
 * until a full `\n\n`-delimited event is available. `[DONE]` yields a final
 * `{ done: true }` and stops.
 */
async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ done: boolean; data?: any }> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      for (const line of event.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice("data:".length).trim();
        if (data === "[DONE]") {
          yield { done: true };
          return;
        }
        try {
          yield { done: false, data: JSON.parse(data) };
        } catch {
          // Ignore keep-alive comments / partial JSON; the next event recovers.
        }
      }
    }
  }
  yield { done: true };
}

export class ApiKeyMissingError extends Error {
  constructor(public provider: string, public keyEnv: string) {
    super(
      `Missing credentials for "${provider}": set the ${keyEnv} environment ` +
        `variable (e.g. in your .env file) to use this provider.`,
    );
    this.name = "ApiKeyMissingError";
  }
}
