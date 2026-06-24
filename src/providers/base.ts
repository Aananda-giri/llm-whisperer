import type { Page } from "playwright";
import type { ProviderConfig } from "../config.js";
import type { SessionPool } from "../session-pool.js";

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatOptions {
  /**
   * Start a fresh conversation before sending.
   * Default: false — continues the existing conversation so the web UI
   * maintains history naturally (no need to re-send prior turns).
   * Set true to wipe the chat and start clean (e.g. new topic / new session).
   */
  newChat?: boolean;
  /**
   * Model name to switch to before sending (must be a key in providers.yaml
   * `models` map and `modelPickerTrigger` must be set). Omit to use whichever
   * model is currently selected in the browser tab.
   */
  model?: string;
}

/**
 * Common contract for everything the server can talk to — whether it drives a
 * browser tab (WebLLMProvider) or calls a real HTTP API (ApiLLMProvider).
 */
export interface LLMProvider {
  readonly name: string;
  stream(messages: Message[], options?: ChatOptions): AsyncGenerator<string>;
  chat(messages: Message[], options?: ChatOptions): Promise<string>;
}

/** One embedding vector and its position in the input batch. */
export interface Embedding {
  object: "embedding";
  index: number;
  embedding: number[];
}

/** OpenAI-style embeddings response (passed through from the upstream API). */
export interface EmbeddingResponse {
  object: "list";
  data: Embedding[];
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

/**
 * Optional capability for providers that can produce embeddings. Only the
 * HTTP API providers implement this — browser-driven chat UIs cannot. Use
 * {@link supportsEmbeddings} to check before calling.
 */
export interface EmbeddingProvider {
  embed(input: string | string[], model?: string): Promise<EmbeddingResponse>;
}

/** Type guard: does this provider expose an `embed()` method? */
export function supportsEmbeddings(p: LLMProvider): p is LLMProvider & EmbeddingProvider {
  return typeof (p as Partial<EmbeddingProvider>).embed === "function";
}

/**
 * Shared base: implements `chat()` (collect all deltas) in terms of the
 * subclass's `stream()`, so each provider type only writes the streaming logic.
 */
export abstract class BaseProvider implements LLMProvider {
  constructor(public readonly name: string) {}

  abstract stream(messages: Message[], options?: ChatOptions): AsyncGenerator<string>;

  /** Convenience wrapper: collects all deltas and returns the full response. */
  async chat(messages: Message[], options: ChatOptions = {}): Promise<string> {
    let result = "";
    for await (const chunk of this.stream(messages, options)) {
      result += chunk;
    }
    return result;
  }
}

/**
 * Config-driven web-UI provider. The whole chat flow is generic; the only
 * things that differ per service are the selectors in providers.yaml. Quirky
 * services can subclass and override the protected hooks.
 */
export class WebLLMProvider extends BaseProvider {
  constructor(
    name: string,
    protected readonly config: ProviderConfig,
    protected readonly pool: SessionPool,
  ) {
    super(name);
  }

  /**
   * Core method: yields text deltas as the LLM streams its response.
   * Acquires a page from the pool, submits the prompt, streams back deltas,
   * then releases the page.
   */
  async *stream(messages: Message[], options: ChatOptions = {}): AsyncGenerator<string> {
    const page = await this.pool.acquire(this.name);
    try {
      await this.ensureOnPage(page);
      await this.ensureLoggedIn(page);

      if (options.newChat) {
        await this.newConversation(page);
      }
      if (options.model) {
        await this.switchModel(page, options.model);
      }

      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const prompt = options.newChat
        ? this.flatten(messages)
        : (lastUser?.content ?? this.flatten(messages));

      const before = await this.countResponses(page);
      await this.submitPrompt(page, prompt);
      yield* this.streamAnswer(page, before);
    } finally {
      this.pool.release(this.name, page);
    }
  }

  // --- overridable hooks -------------------------------------------------

  protected async ensureOnPage(page: Page): Promise<void> {
    if (!page.url().startsWith(new URL(this.config.url).origin)) {
      await page.goto(this.config.url, { waitUntil: "domcontentloaded" });
    }
  }

  protected async ensureLoggedIn(page: Page): Promise<void> {
    if (!this.config.requiresLogin) return;

    if (this.config.loggedOutSelector) {
      const out = await page
        .locator(this.config.loggedOutSelector)
        .first()
        .isVisible()
        .catch(() => false);
      if (out) throw new LoginRequiredError(this.name);
      return;
    }

    const input = page.locator(this.config.inputSelector).first();
    const visible = await input.isVisible().catch(() => false);
    if (!visible) {
      throw new LoginRequiredError(this.name);
    }
  }

  protected async newConversation(page: Page): Promise<void> {
    if (this.config.newChatSelector) {
      const btn = page.locator(this.config.newChatSelector).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(400);
        return;
      }
    }
    await page.goto(this.config.url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
  }

  protected async switchModel(page: Page, modelName: string): Promise<void> {
    const { modelPickerTrigger, models } = this.config;
    const optionSelector = models?.[modelName];
    if (!modelPickerTrigger || !optionSelector) return;
    await page.locator(modelPickerTrigger).first().click().catch(() => {});
    await page.waitForTimeout(400);
    await page.locator(optionSelector).first().click().catch(() => {});
    await page.waitForTimeout(400);
  }

  protected async submitPrompt(page: Page, prompt: string): Promise<void> {
    const input = page.locator(this.config.inputSelector).first();
    await input.waitFor({ state: "visible", timeout: 15000 });
    await input.click();
    await input.fill(prompt);

    if (this.config.sendSelector) {
      const send = page.locator(this.config.sendSelector).first();
      await send.click();
    } else {
      await input.press("Enter");
    }
  }

  // --- response streaming ------------------------------------------------

  protected countResponses(page: Page): Promise<number> {
    return page.locator(this.config.responseSelector).count();
  }

  /**
   * Polls the latest response element and yields text deltas as the LLM
   * types. Assumes text is append-only (true for all streaming LLMs).
   * Non-incremental DOM changes (rare edits) are skipped silently.
   */
  protected async *streamAnswer(page: Page, before: number): AsyncGenerator<string> {
    const { timeoutMs, stabilizeMs } = this.config;
    const responses = page.locator(this.config.responseSelector);
    const deadline = Date.now() + timeoutMs;

    // 1. Wait for a brand-new response node to appear.
    while ((await responses.count()) <= before) {
      if (Date.now() > deadline) {
        await page.screenshot({ path: `/tmp/${this.name}-timeout.png` }).catch(() => {});
        throw new Error(
          `${this.name}: timed out waiting for a response to start` +
            ` (url=${page.url()}, screenshot=/tmp/${this.name}-timeout.png)`,
        );
      }
      await page.waitForTimeout(500);
    }

    // 2. Poll and yield deltas as text grows.
    let emitted = "";   // text we've already yielded
    let last = "";      // last observed text (for stabilization check)
    let stableSince = Date.now();

    while (Date.now() < deadline) {
      const text = (await responses.last().innerText().catch(() => "")).trim();

      if (text !== last) {
        last = text;
        stableSince = Date.now();

        // Only yield the new suffix; skip if text changed non-incrementally.
        if (text.startsWith(emitted)) {
          const delta = text.slice(emitted.length);
          if (delta) {
            yield delta;
            emitted = text;
          }
        }
      }

      const stillStreaming = await this.isStreaming(page);
      if (!stillStreaming && last && Date.now() - stableSince >= stabilizeMs) {
        return;
      }
      await page.waitForTimeout(300);
    }
    // Generator returns without throwing — caller has already received partial output.
  }

  protected async isStreaming(page: Page): Promise<boolean> {
    if (!this.config.stopSelector) return false;
    return page
      .locator(this.config.stopSelector)
      .first()
      .isVisible()
      .catch(() => false);
  }

  protected flatten(messages: Message[]): string {
    if (messages.length === 1) return messages[0].content;
    return messages
      .map((m) =>
        `${m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "System"}: ${m.content}`,
      )
      .join("\n\n");
  }
}

export class LoginRequiredError extends Error {
  constructor(public provider: string) {
    super(
      `Not logged in to "${provider}". Run: wspr login ${provider}` +
        `  (opens a visible browser; log in, then press Enter to save the session)`,
    );
    this.name = "LoginRequiredError";
  }
}
