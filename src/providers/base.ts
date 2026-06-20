import type { Page } from "playwright";
import type { ProviderConfig } from "../config.js";
import type { SessionPool } from "../session-pool.js";

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatOptions {
  /** Start a fresh conversation before sending (default true). */
  newChat?: boolean;
}

/**
 * Config-driven web-UI provider. The whole chat flow is generic; the only
 * things that differ per service are the selectors in providers.yaml. Quirky
 * services can subclass and override the protected hooks.
 */
export class WebLLMProvider {
  constructor(
    public readonly name: string,
    protected readonly config: ProviderConfig,
    protected readonly pool: SessionPool,
  ) {}

  async chat(messages: Message[], options: ChatOptions = {}): Promise<string> {
    const prompt = this.flatten(messages);
    const page = await this.pool.acquire(this.name);
    try {
      await this.ensureOnPage(page);
      await this.ensureLoggedIn(page);

      if (options.newChat !== false) {
        await this.newConversation(page);
      }

      const before = await this.countResponses(page);
      await this.submitPrompt(page, prompt);
      return await this.waitForAnswer(page, before);
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

    // Prefer an explicit "logged out" marker (e.g. a visible Log in button).
    if (this.config.loggedOutSelector) {
      const out = await page
        .locator(this.config.loggedOutSelector)
        .first()
        .isVisible()
        .catch(() => false);
      if (out) throw new LoginRequiredError(this.name);
      return;
    }

    // Fallback: if the input box never appears, assume we're gated.
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
    // No explicit "new chat" control — reload the landing page for a clean slate.
    await page.goto(this.config.url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
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

  // --- response handling -------------------------------------------------

  protected countResponses(page: Page): Promise<number> {
    return page.locator(this.config.responseSelector).count();
  }

  /**
   * Wait for a new assistant message to appear, then poll its text until it
   * stops changing (streaming finished) or the stop control disappears.
   */
  protected async waitForAnswer(page: Page, before: number): Promise<string> {
    const { timeoutMs, stabilizeMs } = this.config;
    const responses = page.locator(this.config.responseSelector);
    const deadline = Date.now() + timeoutMs;

    // 1. Wait for a brand-new response node.
    while ((await responses.count()) <= before) {
      if (Date.now() > deadline) {
        throw new Error(`${this.name}: timed out waiting for a response to start`);
      }
      await page.waitForTimeout(250);
    }

    // 2. Poll the latest response until its text stabilizes.
    let last = "";
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      const text = (await responses.last().innerText().catch(() => "")).trim();

      if (text && text !== last) {
        last = text;
        stableSince = Date.now();
      }

      const stillStreaming = await this.isStreaming(page);
      if (!stillStreaming && last && Date.now() - stableSince >= stabilizeMs) {
        return last;
      }
      await page.waitForTimeout(300);
    }

    if (last) return last; // best-effort partial answer on timeout
    throw new Error(`${this.name}: timed out waiting for the response to finish`);
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
    // Web UIs are single-turn from our side; flatten history into one prompt.
    return messages
      .map((m) => `${m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "System"}: ${m.content}`)
      .join("\n\n");
  }
}

export class LoginRequiredError extends Error {
  constructor(public provider: string) {
    super(
      `Not logged in to "${provider}". Run: pnpm run login ${provider}  (opens a visible browser; log in, then press Enter to save the session)`,
    );
    this.name = "LoginRequiredError";
  }
}
