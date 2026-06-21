import type { ApiProviderConfig, ProviderConfig } from "../config.js";
import { BaseProvider, type ChatOptions, type Message } from "./base.js";

/**
 * Calls a real OpenAI-compatible HTTP API (OpenAI, DeepSeek, Groq, Together, …)
 * instead of driving a browser. One class covers every such service — only
 * baseUrl/model/key differ, all of which come from the provider's `api` block.
 *
 * Unlike the browser providers, this is stateless: there is no server-side
 * conversation, so the caller must send the full message history each request
 * (standard OpenAI behaviour). `newChat` is therefore a no-op here.
 */
export class ApiLLMProvider extends BaseProvider {
  private readonly api: ApiProviderConfig;

  constructor(name: string, config: ProviderConfig) {
    super(name);
    if (!config.api) {
      throw new Error(`ApiLLMProvider "${name}" built without an api config block`);
    }
    this.api = config.api;
  }

  async *stream(messages: Message[], options: ChatOptions = {}): AsyncGenerator<string> {
    const key = process.env[this.api.keyEnv];
    if (!key) {
      throw new ApiKeyMissingError(this.name, this.api.keyEnv);
    }

    // baseUrl may contain ${VAR} placeholders (e.g. Cloudflare's account id),
    // resolved from the environment at request time.
    const baseUrl = this.resolveEnv(this.api.baseUrl).replace(/\/+$/, "");
    const endpoint = `${baseUrl}/chat/completions`;
    const model = options.model ?? this.api.model;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model, messages, stream: true }),
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `${this.name}: API request failed (${res.status} ${res.statusText})` +
          (detail ? ` — ${detail.slice(0, 500)}` : ""),
      );
    }

    yield* parseSSE(res.body);
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
 * Parses an OpenAI-style `text/event-stream` body and yields each
 * `choices[0].delta.content` fragment. Handles chunks split across reads by
 * buffering until a full `\n\n`-delimited event is available.
 */
async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
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
        if (data === "[DONE]") return;

        try {
          const json = JSON.parse(data);
          const delta: string | undefined = json?.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // Ignore keep-alive comments / partial JSON; the next event recovers.
        }
      }
    }
  }
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
