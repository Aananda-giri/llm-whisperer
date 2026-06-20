# Providers

## Status

| Key | Site | Model | Login | Status |
|---|---|---|---|---|
| `qwen` | chat.qwen.ai | Qwen3.7-Plus | yes | **Verified ✓** |
| `pi` | pi.ai | Pi (Inflection) | **no** | **Verified ✓** |
| `deepseek` | chat.deepseek.com | DeepSeek V3 / R1 | yes | Template |
| `chatgpt` | chatgpt.com | GPT-4o (free tier) | yes | Template — Cloudflare may block |
| `claude` | claude.ai | Claude Sonnet (free tier) | yes | Template |
| `glm` | chat.z.ai | GLM-4 | yes | Template |
| `kimi` | kimi.com | Kimi K2 (Moonshot) | yes | Partial — input/login verified |
| `minimax` | agent.minimax.io | MiniMax-M3 | yes | Partial — input/login verified |
| `grok` | grok.com | Grok 3 (xAI) | yes | Partial — input/send verified |
| `ernie` | yiyan.baidu.com | ERNIE (Baidu) | yes | Partial — input/login verified |

**Verified ✓** — driven end-to-end; a real message returned a correct response.
`pi` requires no login, making it the easiest to try first.

**Partial** — input, send, login, and new-chat selectors were confirmed against
the live DOM, but the `responseSelector` is a best-effort guess (those
containers only render after a real authenticated message). Verify with
`HEADLESS=false` on first run.

**Template** — best-effort selectors based on the site's DOM at time of writing.
Run with `HEADLESS=false` and verify on first use.

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
    modelPickerTrigger: ""                # (optional) click to open model dropdown
    models:                               # (optional) name → selector to click
      "model-a": "li:has-text('Model A')"
      "model-b": "li:has-text('Model B')"
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

## Model switching

Many sites offer several models behind a picker. To let the API switch between
them, define two optional fields:

- `modelPickerTrigger` — selector for the control that opens the model dropdown
- `models` — a map of `model-name → selector` to click inside that dropdown

```yaml
qwen:
  # ...
  modelPickerTrigger: "button[aria-label='Select model']"
  models:
    "qwen2.5-max":  "div[role='option']:has-text('Qwen2.5-Max')"
    "qwen2.5-plus": "div[role='option']:has-text('Qwen2.5-Plus')"
```

Then request a model with the `provider/model-name` form:

```bash
curl -s -X POST http://localhost:3000/v1/chat/completions \
  -d '{"model":"qwen/qwen2.5-max","messages":[{"role":"user","content":"Hi"}]}'
```

Before sending, LLM-Whisper clicks `modelPickerTrigger`, then the selector for
`qwen2.5-max`. If either field is empty/unconfigured, the switch is a **no-op**
and the tab's current model is used — so it's safe to leave the selectors blank
until you've verified them with `HEADLESS=false`.

> The `models:` maps shipped in the default `providers.yaml` list model **names**
> but leave the selectors blank. Fill them in after inspecting each site's picker.

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
