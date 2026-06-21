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
(`~/.config/llm-whisperer/profiles/browser/`). Chrome partitions cookies by
origin, so sites never see each other's sessions.

```bash
# Stop serve first, then:
wspr login qwen
wspr login deepseek
# etc.
```

A Chromium window opens. Log in by hand (Google OAuth, email, or whatever the
site requires), get to the chat screen, press **Enter**.

Sessions survive restarts. If a session expires, just run `wspr login <name>`
again.

## providers.yaml reference

All provider behaviour is driven by `providers.yaml`. LLM-Whisperer looks for
it in this order:

1. Path given by `PROVIDERS_FILE` env var
2. `providers.yaml` in the current working directory
3. Bundled file inside the npm package (the defaults)

### Fields

```yaml
providers:
  example:
    url: "https://chat.example.com/"     # page to open on warm-up
    requiresLogin: true                   # if true, must run `wspr login example`
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
  last one). LLM-Whisperer counts how many exist before sending, then watches for
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
curl -s -X POST http://localhost:9777/v1/chat/completions \
  -d '{"model":"qwen/qwen2.5-max","messages":[{"role":"user","content":"Hi"}]}'
```

Before sending, LLM-Whisperer clicks `modelPickerTrigger`, then the selector for
`qwen2.5-max`. If either field is empty/unconfigured, the switch is a **no-op**
and the tab's current model is used — so it's safe to leave the selectors blank
until you've verified them with `HEADLESS=false`.

> The `models:` maps shipped in the default `providers.yaml` list model **names**
> but leave the selectors blank. Fill them in after inspecting each site's picker.

## Fixing broken selectors

Web UIs change. When a provider stops working:

1. Run with `HEADLESS=false`:
   ```bash
   HEADLESS=false wspr serve
   ```
2. Open DevTools in the Chromium window, send a message, and inspect the DOM.
3. Find the new class / attribute for the answer container.
4. Update `providers.yaml` in your working directory (it takes precedence over
   the bundled one).

The timeout screenshot at `/tmp/<provider>-timeout.png` is useful when running
headless — it shows exactly what the page looked like when things went wrong.

## API-key providers

Not every provider has to drive a browser. If you have a real key for an
OpenAI-compatible service (OpenAI, DeepSeek, Groq, Together, …), give the
provider an `api:` block instead of selectors and it will call the official HTTP
API directly — same `/chat` and `/v1/chat/completions` endpoints, no scraping,
no login.

```yaml
providers:
  openai:
    api:
      baseUrl: "https://api.openai.com/v1"   # OpenAI-compatible base URL
      model: "gpt-4o-mini"                    # default model id
      keyEnv: "OPENAI_API_KEY"                # env var holding the key
```

| Field | Required | Description |
|---|---|---|
| `baseUrl` | yes | OpenAI-compatible base; `/chat/completions` is appended. May contain `${VAR}` placeholders resolved from the environment (see below) |
| `model` | yes | Default model id sent to the API |
| `keyEnv` | yes | Name of the env var the key is read from (never put the key in YAML) |

`baseUrl` supports `${VAR}` substitution from the environment — handy when the
endpoint embeds an account id. For example Cloudflare Workers AI:

```yaml
cloudflare:
  api:
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1"
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
    keyEnv: "CLOUDFLARE_API_TOKEN"
```

If a referenced variable is unset, requests to that provider return `401`
naming it.

#### Getting Cloudflare credentials (`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`)

1. Go to <https://dash.cloudflare.com/> → **AI** → **AI Gateway**.
2. Click **Create Authentication Token** — that value is your `CLOUDFLARE_API_TOKEN`.
3. The sample `curl -X POST https://.../accounts/<ACCOUNT_ID>/...` command shown
   on that page contains your account id — copy the `<ACCOUNT_ID>` segment into
   `CLOUDFLARE_ACCOUNT_ID`.

```bash
CLOUDFLARE_API_TOKEN=your-token
CLOUDFLARE_ACCOUNT_ID=your-32-char-account-id
```

(Alternatively — Cloudflare's documented path — go to the **Workers AI** page →
**Use REST API** → **Create a Workers AI API Token**. That same panel also shows
your account id. A custom token needs both `Workers AI - Read` and
`Workers AI - Edit` permissions.)

Notes:

- A provider is **either** browser-driven **or** API-keyed. When an `api:` block
  is present the browser selectors are ignored, so you can omit them.
- Set the key via the environment (e.g. a `.env` file). If it's missing, calls to
  that provider return `401` naming the variable.
- Switch models per request with the `provider/model` form, e.g.
  `{"model":"openai/gpt-4o"}` or `{"model":"deepseek-api/deepseek-reasoner"}`.
- API providers are **stateless** — unlike the browser ones, there is no
  server-side conversation. Send the full message history with each request
  (standard OpenAI behaviour); `newChat` is a no-op.
- Add any other OpenAI-compatible service by copying the block and pointing
  `baseUrl`/`keyEnv` at it.

The bundled `providers.yaml` ships these API-key providers as examples. Create a
key on the provider's console, then put it in your `.env` under the listed env
var. Most consoles show the key **only once** — copy it immediately.

| Provider key | Where to get a key | Free tier? |
|---|---|---|
| `gemini` | <https://aistudio.google.com/apikey> | ✅ free tier |
| `groq` | <https://console.groq.com/keys> | ✅ free, no card |
| `openrouter` | <https://openrouter.ai/keys> | ✅ `:free` models, no credits |
| `cerebras` | <https://cloud.cerebras.ai> → **API Keys** | ✅ free tier |
| `mistral` | <https://admin.mistral.ai/organization/api-keys> | ✅ free, no card |
| `cloudflare` | see [Getting Cloudflare credentials](#getting-cloudflare-credentials-cloudflare_api_token--cloudflare_account_id) above | ✅ free allowance (needs token **+** account id) |
| `openai` | <https://platform.openai.com/api-keys> | paid |
| `deepseek-api` | <https://platform.deepseek.com/api_keys> | paid (low cost) |

Free quotas, model names, and rate limits change often — check each provider's
docs for current limits.

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
2. Run `HEADLESS=false wspr serve` and test with a curl request.
3. Iterate on selectors until responses come back correctly.
4. If the site needs custom logic (unusual submit flow, multi-step login, etc.),
   subclass `WebLLMProvider` in `src/providers/` and register it in
   `src/providers/factory.ts`.

Pull requests for new verified providers are welcome.
