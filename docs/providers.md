# Providers

## Status

| Key | Site | Model | Status |
|---|---|---|---|
| `qwen` | chat.qwen.ai | Qwen3.7-Plus | Verified ✓ |
| `deepseek` | chat.deepseek.com | DeepSeek V3 / R1 | Template — verify selectors |
| `chatgpt` | chatgpt.com | GPT-4o (free tier) | Template — Cloudflare may block |
| `claude` | claude.ai | Claude Sonnet (free tier) | Template — verify selectors |
| `glm` | chat.z.ai | GLM-4 | Template — verify selectors |

"Template" means the selectors are best-effort starting points based on the
site's DOM at time of writing. Run with `HEADLESS=false` and verify on first use.

## Logging in

Each provider stores its session in a shared browser profile
(`~/.config/llm-whisper/profiles/browser/`). Chrome partitions cookies by
origin, so sites never see each other's sessions.

```bash
# Stop serve first, then:
whisper login qwen
whisper login deepseek
# etc.
```

A Chromium window opens. Log in by hand (Google OAuth, email, or whatever the
site requires), get to the chat screen, press **Enter**.

Sessions survive restarts. If a session expires, just run `whisper login <name>`
again.

## providers.yaml reference

All provider behaviour is driven by `providers.yaml`. LLM-Whisper looks for
it in this order:

1. Path given by `PROVIDERS_FILE` env var
2. `providers.yaml` in the current working directory
3. Bundled file inside the npm package (the defaults)

### Fields

```yaml
providers:
  example:
    url: "https://chat.example.com/"     # page to open on warm-up
    requiresLogin: true                   # if true, must run `whisper login example`
    loggedOutSelector: "button:has-text('Log in')"  # visible when not authenticated
    newChatSelector: "a:has-text('New Chat')"       # clicked when newChat:true
    inputSelector: "textarea"             # prompt input box
    sendSelector: ""                      # send button; empty = press Enter
    responseSelector: "[class*='answer']" # matches every assistant message block
    stopSelector: ":text('Stop')"         # visible while streaming; gone when done
    timeoutMs: 90000                      # max wait for a response (ms)
    stabilizeMs: 2000                     # text must be unchanged for this long
```

All selectors are [Playwright locators](https://playwright.dev/docs/locators) —
CSS selectors, `:text()`, `:has-text()`, `[attr*=value]`, etc.

### Selector tips

- `responseSelector` must match **every** assistant message block (not just the
  last one). LLM-Whisper counts how many exist before sending, then watches for
  a new one to appear.
- `stopSelector` is the streaming indicator ("Stop generating", "Skip", etc.).
  When it disappears AND the text stops changing, the answer is considered done.
- If `sendSelector` is empty, Enter is pressed in the input box instead.

## Fixing broken selectors

Web UIs change. When a provider stops working:

1. Run with `HEADLESS=false`:
   ```bash
   HEADLESS=false whisper serve
   ```
2. Open DevTools in the Chromium window, send a message, and inspect the DOM.
3. Find the new class / attribute for the answer container.
4. Update `providers.yaml` in your working directory (it takes precedence over
   the bundled one).

The timeout screenshot at `/tmp/<provider>-timeout.png` is useful when running
headless — it shows exactly what the page looked like when things went wrong.

## Adding a new provider

1. Add an entry to a local `providers.yaml`:
   ```yaml
   providers:
     myllm:
       url: "https://chat.myllm.ai/"
       requiresLogin: true
       inputSelector: "textarea"
       responseSelector: ".message.assistant"
       timeoutMs: 90000
       stabilizeMs: 2000
   ```
2. Run `HEADLESS=false whisper serve` and test with a curl request.
3. Iterate on selectors until responses come back correctly.
4. If the site needs custom logic (unusual submit flow, multi-step login, etc.),
   subclass `WebLLMProvider` in `src/providers/` and register it in
   `src/providers/factory.ts`.

Pull requests for new verified providers are welcome.
