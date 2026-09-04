import type { Page } from "playwright";
import type { ProviderConfig } from "../config.js";
import type { SessionPool } from "../session-pool.js";
import { DEFAULT_BROWSER_PROFILE, validateBrowserProfile } from "../browser.js";
import { isLoggedIn } from "../credentials/session.js";
import { attemptLogin, type AttemptResult } from "../credentials/login.js";
import type { Vault } from "../credentials/vault.js";
import {
  renderToolCalls,
  renderToolPreamble,
  renderToolResult,
  ToolCallScanner,
  type ToolCall,
  type ToolChoice,
  type ToolDefinition,
} from "./tool-protocol.js";

export interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** Assistant turns that requested tools (OpenAI `tool_calls`). */
  tool_calls?: ToolCall[];
  /** Tool-result turns: which call this result answers. */
  tool_call_id?: string;
  /** Tool-result turns: the tool that produced the result. */
  name?: string;
}

/** One streamed event from a browser provider — text delta or a completed tool call. */
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; call: ToolCall };

export interface ChatOptions {
  /** Named persistent browser profile to use. */
  profile?: string;
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
  /**
   * Tool definitions to describe to the model via prompting. Browser providers
   * simulate tool calling (prompt-in / parse-out); wspr never executes tools.
   */
  tools?: ToolDefinition[];
  /** Normalized tool selection directive (OpenAI/Anthropic shapes are mapped upstream). */
  toolChoice?: ToolChoice;
  /**
   * Extra sampling parameters (temperature, max_tokens, top_p, stop, seed,
   * response_format, …). Forwarded verbatim to HTTP API providers in the
   * request body; browser providers ignore them (the web UI path has no such
   * controls).
   */
  params?: Record<string, unknown>;
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
 * Optional capability for providers that can simulate tool calling. Only the
 * browser-driven providers implement this — API-key providers get real native
 * tool calling by simply passing `tools` through upstream, so they must NOT be
 * run through this prompt hack. Use {@link supportsTools} to check before
 * calling.
 */
export interface ToolCallingProvider {
  streamWithTools(messages: Message[], options?: ChatOptions): AsyncGenerator<StreamEvent>;
}

/** Type guard: does this provider simulate tool calling? */
export function supportsTools(p: LLMProvider): p is LLMProvider & ToolCallingProvider {
  return typeof (p as Partial<ToolCallingProvider>).streamWithTools === "function";
}

/**
 * Optional capability for providers that can submit a stored credential. Only
 * browser providers implement it; going through this (rather than calling
 * `attemptLogin` directly) is what keeps the never-retry guard in one place.
 */
export interface AutoLoginProvider {
  autoLogin(page: Page, profile: string): Promise<AttemptResult>;
}

/** Type guard: can this provider replay a stored credential? */
export function supportsAutoLogin(p: LLMProvider): p is LLMProvider & AutoLoginProvider {
  return typeof (p as Partial<AutoLoginProvider>).autoLogin === "function";
}

/**
 * The trailing run of messages after the last assistant message. With the
 * default `newChat: false`, this is what actually gets sent to the browser —
 * and the whole reason a tool loop works: feeding back `[user, assistant,
 * tool, tool]` sends the two `<tool_result>` blocks, not a re-ask of the stale
 * user question.
 */
export function pendingTurn(messages: Message[]): Message[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages.slice(i + 1);
  }
  return messages;
}

/** Does this turn include a user question (as opposed to only tool results)? */
export function turnContainsUser(messages: Message[]): boolean {
  return messages.some((m) => m.role === "user");
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
  /**
   * Credentials that have already *failed* for this provider×profile in this
   * process. A failed attempt is never retried (a retry storm can lock the
   * account) until the vault entry is changed.
   *
   * A successful attempt is removed again — otherwise a long-running
   * `wspr serve` would auto-login each provider exactly once and then refuse
   * to recover the next time that session lapsed, which is the whole point.
   */
  private readonly failedKeys = new Set<string>();

  /**
   * Auto-login is on when a vault is unlocked and WSPR_AUTO_LOGIN is not
   * "false". A credential is attempted once, then the request raises
   * LoginRequiredError exactly as it did before auto-login existed.
   */
  private readonly autoLoginEnabled: boolean;

  constructor(
    name: string,
    protected readonly config: ProviderConfig,
    protected readonly pool: SessionPool,
    protected readonly vault?: Vault,
  ) {
    super(name);
    this.autoLoginEnabled = !!vault && (process.env.WSPR_AUTO_LOGIN ?? "true") !== "false";
  }

  /**
   * Text-only streaming adapter: forwards only text deltas, so the existing
   * {@link LLMProvider} contract and every current call site are untouched.
   * Use {@link streamWithTools} when tool calling is needed.
   */
  async *stream(messages: Message[], options: ChatOptions = {}): AsyncGenerator<string> {
    for await (const ev of this.streamWithTools(messages, options)) {
      if (ev.type === "text") yield ev.text;
    }
  }

  /**
   * Core method: yields text deltas as the LLM streams its response, and — when
   * `options.tools` are given — parses `<tool_call>` blocks out of the stream
   * into completed {@link StreamEvent}s. Acquires a page from the pool,
   * submits the prompt, streams back events, then releases the page.
   */
  async *streamWithTools(messages: Message[], options: ChatOptions = {}): AsyncGenerator<StreamEvent> {
    const profile = validateBrowserProfile(
      options.profile ?? this.config.profile ?? DEFAULT_BROWSER_PROFILE,
    );
    const page = await this.pool.acquire(this.name, profile);
    try {
      await this.ensureOnPage(page);
      await this.ensureLoggedIn(page, profile);

      if (options.newChat) {
        await this.newConversation(page);
      }
      if (options.model) {
        await this.switchModel(page, options.model);
      }

      // Only scan for tool calls when the caller actually declared tools —
      // otherwise a model legitimately writing `<tool_call>` in prose would
      // get mangled.
      const tools = options.tools;
      const scanner = tools?.length
        ? new ToolCallScanner(new Set(tools.map((t) => t.name)))
        : null;

      const turn = pendingTurn(messages);
      let prompt = options.newChat ? this.flatten(messages) : this.flatten(turn);
      if (!options.newChat && !prompt) {
        // Degenerate case (messages end on an assistant turn): fall back to
        // the last user message so we never send a blank prompt.
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        prompt = lastUser?.content ?? "";
      }

      // Stateless preamble rule: restate the tool schema whenever we are
      // opening a fresh user question. A turn that is only tool results skips
      // it — the browser thread already holds the instructions from the return.
      if (turnContainsUser(turn) && tools?.length && options.toolChoice !== "none") {
        const preamble = renderToolPreamble(tools, options.toolChoice);
        if (preamble) prompt = `${preamble}\n\n${prompt}`;
      }

      const before = await this.countResponses(page);
      await this.submitPrompt(page, prompt);

      for await (const delta of this.streamAnswer(page, before)) {
        if (scanner) {
          const out = scanner.push(delta);
          if (out.text) yield { type: "text", text: out.text };
          for (const call of out.calls) yield { type: "tool_call", call };
        } else {
          yield { type: "text", text: delta };
        }
      }

      if (scanner) {
        const out = scanner.flush();
        if (out.text) yield { type: "text", text: out.text };
        for (const call of out.calls) yield { type: "tool_call", call };
      }
    } finally {
      this.pool.release(this.name, profile, page);
    }
  }

  // --- overridable hooks -------------------------------------------------

  protected async ensureOnPage(page: Page): Promise<void> {
    if (!page.url().startsWith(new URL(this.config.url).origin)) {
      await page.goto(this.config.url, { waitUntil: "domcontentloaded" });
    }
  }

  protected async ensureLoggedIn(page: Page, profile?: string): Promise<void> {
    if (!this.config.requiresLogin) return;

    if (await isLoggedIn(page, this.config)) return;

    const profileName = validateBrowserProfile(profile ?? this.config.profile ?? DEFAULT_BROWSER_PROFILE);
    if (this.autoLoginEnabled) await this.autoLogin(page, profileName);

    if (!(await isLoggedIn(page, this.config))) {
      throw new LoginRequiredError(this.name);
    }
  }

  /**
   * One guarded auto-login attempt using the stored credential, if there is
   * one. This is the *only* path that may submit a stored password, so the
   * never-retry rule holds everywhere: the request path calls it via
   * {@link ensureLoggedIn}, and the dashboard's "Login" button calls it
   * directly rather than reaching for `attemptLogin`.
   *
   * Returns why nothing was attempted, so a caller can say so.
   */
  async autoLogin(page: Page, profile: string): Promise<AttemptResult> {
    if (!this.vault) return { ok: false, reason: "no vault is unlocked" };

    const profileName = validateBrowserProfile(profile);
    const cred = this.vault.get(profileName, this.name);
    if (!cred) return { ok: false, reason: `no credential for "${this.name}" in profile "${profileName}"` };
    if (!this.config.login) return { ok: false, reason: `"${this.name}" has no login: block in providers.yaml` };
    if (cred.method !== "password" || !cred.password) {
      return { ok: false, reason: "credential is manual — log in by hand in the open tab" };
    }

    // `updatedAt` is part of the key, so editing the credential in the vault
    // (via `wspr creds set` or the dashboard) clears the failure by producing
    // a new key — no cross-object invalidation needed.
    const key = `${profileName}\u0000${this.name}\u0000${cred.updatedAt}`;
    if (this.failedKeys.has(key)) {
      return {
        ok: false,
        reason: "this credential already failed once in this process — update it to try again",
      };
    }

    // Mark before attempting, so a throw or a crash mid-attempt still counts
    // as the one try this credential gets. A wrong password submitted in a
    // loop locks accounts.
    this.failedKeys.add(key);
    const attempt = await attemptLogin(page, this.config, cred);
    // Clear on success: a credential that works is not a failed one, and the
    // session will lapse again later in a long-running `wspr serve`. Only a
    // *failure* is permanent for the process.
    if (attempt.ok) this.failedKeys.delete(key);
    else console.warn(`[${this.name}] auto-login failed: ${attempt.reason ?? "unknown reason"}`);
    return attempt;
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
    if (messages.length === 1) {
      const [m] = messages;
      // A lone tool result still needs its block so the browser thread can
      // associate it with the pending tool call.
      if (m.role === "tool") return renderToolResult(m);
      return m.content;
    }
    return messages.map((m) => this.flattenMessage(m)).join("\n\n");
  }

  protected flattenMessage(m: Message): string {
    if (m.role === "tool") return renderToolResult(m);
    if (m.role === "assistant" && m.tool_calls?.length) {
      // Re-render the tool_calls as <tool_call> blocks so a `newChat: true`
      // replay of a tool loop is faithful.
      const text = m.content ? `Assistant: ${m.content}` : null;
      const blocks = renderToolCalls(m.tool_calls);
      return text ? `${text}\n\n${blocks}` : blocks;
    }
    const label = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "System";
    return `${label}: ${m.content}`;
  }
}

export class LoginRequiredError extends Error {
  constructor(public provider: string) {
    super(
      `Not logged in to "${provider}". Run: wspr login ${provider} [profile]` +
        `  (opens a visible browser; log in, then press Enter to save the session)`,
    );
    this.name = "LoginRequiredError";
  }
}
