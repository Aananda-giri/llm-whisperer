# Client configs (`wspr config`)

One API endpoint, many tools. `wspr config <client> [profile]` emits the config
a client needs to talk to wspr over a **profile-scoped** base URL — no
client-specific code. The emitter is a registry
(`src/clients.ts`), so "generic" is structural: add a target, and it appears in
`wspr config`.

```bash
wspr config               # list the registered clients
wspr config opencode email1 --out opencode.json --base-url http://localhost:9777
```

The config is **printed to stdout** — a client's config file is usually
hand-maintained (`opencode.json` also holds your agents, MCP servers and
keybinds), so nothing is written unless you ask. Pass `--out <file>` to write
one, which overwrites that path. `--base-url` overrides the server root
(defaults to `http://localhost:PORT`). Profile defaults to the server's default
browser profile.

Every emitted base URL is **profile-scoped**: `/p/<profile>/v1` for OpenAI
dialects, `/p/<profile>` for Anthropic (the SDK appends `/v1/messages`).

---

## opencode

opencode is a coding agent built on the AI SDK. It does **not** auto-discover
models from `/v1/models` — it requires an explicit model map — so the emitter
lists every model the profile exposes, along with the per-model flags opencode
needs (`tool_call`, `limit`, and, for browser providers, `temperature: false`).

```yaml
# providers.yaml
profiles:
  email1:
    label: "Personal (email1)"
    providers:
      qwen: [qwen3-235b, qwen2.5-max]
      groq: "*"
```

```bash
wspr serve &                                    # WSPR_BROWSER_PROFILE etc. as usual
wspr config opencode email1 --out opencode.json
```

The generated `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "email1": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Personal (email1)",
      "options": {
        "baseURL": "http://localhost:9777/p/email1/v1",
        "apiKey": "not-needed",
        "headerTimeout": 150000,
        "chunkTimeout": 150000,
        "timeout": 600000
      },
      "models": {
        "qwen": {
          "name": "qwen",
          "tool_call": true,
          "attachment": false,
          "temperature": false,
          "reasoning": false,
          "limit": { "context": 131072, "output": 8192 }
        },
        "groq": {
          "name": "groq",
          "tool_call": true,
          "attachment": true,
          "temperature": true,
          "reasoning": false,
          "limit": { "context": 128000, "output": 8192 }
        }
      }
    }
  },
  "small_model": "email1/groq"
}
```

Merge it into your `opencode.json` (or point `--out` at it), restart opencode,
and the model picker lists exactly that profile's models.

Three of those fields are doing real work:

- **`tool_call: true`** is what makes opencode send `tools` at all. wspr
  forwards them natively to API-key providers and simulates them for browser
  ones, so either way the agent can act.
- **`temperature: false`** on browser models stops opencode sending a sampling
  parameter a chat website has no way to honour.
- **`small_model`** points title generation and summarisation at an API-key
  provider. Left unset, opencode uses the main model — which for a browser
  provider means a second request racing your agent loop for the same tab. The
  emitter picks an API provider whose key is actually set, and omits the field
  entirely for a browser-only profile.

`chunkTimeout` is sized from the provider's own `timeoutMs`, because a browser
tool turn deliberately sends nothing until the answer settles (see below).

**A browser model's `name` gets " (untested)" appended unless its
`providers.yaml` entry sets `verified: true`.** Only `qwen` and `pi` have
actually been driven end-to-end and confirmed working today (see
`wiki/5-browser-providers/5.5-what-is-verified.md`); every other browser
provider's selectors are a best-effort starting point nobody has live-tested.
API providers need no such flag — they call a real HTTP API, not a scraped
DOM — so they're never annotated. Pick `qwen` for anything that matters until
you've verified another provider yourself and set `verified: true` for it.

> If you set `WSPR_API_KEY`, change `apiKey` in the emitted block to that key.

### Browser providers: how the conversation is kept straight

opencode, like every OpenAI-style client, is **stateless** — it re-sends the
whole message array every request. A browser provider is the opposite: its
history lives in a Chromium tab.

wspr reconciles the two by treating the tab as a *cache of conversation
history*. Each turn derives a key from the messages the client authored, and:

- the key matches the tab ⇒ **continue** — type only the new tool results in,
  and let the thread supply the rest;
- it does not ⇒ **replay** — open a fresh chat and re-send the transcript.

So a conversation stays in one tab across a whole agent loop, two interleaved
sessions get their own tabs, and a resumed or compacted session rebuilds itself
instead of appending to a stranger's thread. `WSPR_MAX_PAGES` sets how many
conversations a provider keeps hot (3+ suits an agent); `WSPR_CONTINUITY=replay`
forces a rebuild every turn, which is the quickest way to tell a provider
problem apart from an affinity problem.

A cancelled request always marks its tab dirty, so hitting Esc mid-turn can
never corrupt the next one.

### What actually works, honestly

A browser provider driving opencode is a **read-and-explain agent, not a
code-editing one**. Worth knowing before you wire it up:

- **Good:** `read`, `list`, `glob`, `grep`, `bash` with short output,
  `todoread`/`todowrite`, `webfetch`. Multi-turn loops hold together.
- **Marginal:** `write` of a small new file; `patch`.
- **Provider-dependent, and worth checking before you rely on one: the
  `<tool_call>` marker itself.** wspr's simulated tool protocol asks the model
  to emit a literal `<tool_call>…</tool_call>` block. Several current models
  (Qwen among them) were *trained* with that exact tag as their own native
  function-calling syntax, and the chat website recognizes it and renders a
  widget instead of passing the JSON through as visible text — so the model's
  call never reaches the DOM as text wspr can scrape, and the turn silently
  degrades to prose. Verified live against `chat.qwen.ai`. If tool calls on a
  given provider come back empty or truncated to something like
  `<tool_call_1>`, this is almost certainly why; there is no per-provider
  workaround today short of trying a different provider.
- **Poor: `edit`.** Its `oldString` must match the file byte-for-byte, and the
  argument makes a round trip through a Markdown renderer to get back to wspr.
  Whitespace will eventually not survive, opencode rejects the edit, and the
  model retries — at a minute or two per attempt.
- **Speed:** a browser turn is 60–120 s. A ten-tool-call loop is minutes.
- **Token counts are always zero** for browser providers — nothing in a chat
  website's DOM reports them. opencode's cost display is blank and its
  compaction trigger is blind, so long sessions need `/compact` by hand.
- Tool turns do not stream. wspr reads the settled answer in one go, because
  incremental DOM scraping drops the tail whenever the page re-renders — a
  blemish in prose, fatal in a JSON tool call.
- An over-long prompt is refused with a **413** naming the provider, rather
  than silently truncated by the chat box. Tune `maxPromptChars` and
  `toolResultMaxChars` in providers.yaml.

The setup that actually earns its keep: point the **main model** at a big free
browser provider and `small_model` at a free API key, and use it to ask a
strong model about your codebase.

## OpenAI SDK / Cursor / Open WebUI / LangChain

Point any OpenAI-compatible client at `OPENAI_BASE_URL`:

```bash
wspr config openai email1      # prints shell lines, or --out .env
```

```bash
OPENAI_BASE_URL=http://localhost:9777/p/email1/v1
OPENAI_API_KEY=not-needed
```

Cursor: Settings → Models → OpenAI-compatible → paste the base URL. Open WebUI:
set `OPENAI_API_BASE_URL` / `OPENAI_API_KEY`. The `openai` SDK:

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:9777/p/email1/v1", api_key="not-needed")
resp = client.chat.completions.create(model="qwen/qwen3-235b", messages=[...])
```

---

## Anthropic SDK

```bash
wspr config anthropic email1
```

```bash
ANTHROPIC_BASE_URL=http://localhost:9777/p/email1
ANTHROPIC_API_KEY=not-needed
```

The SDK appends `/v1/messages`, so the base URL is `/p/<profile>` (no `/v1`).

---

## Continue.dev

```bash
wspr config continue email1 --out config.yaml
```

Emits a `models:` block naming each profile model with its scoped `apiBase`.
Merge it into Continue.dev's `config.yaml`.

---

## The registry

Targets live in `src/clients.ts` under `CLIENT_TARGETS`. Each implements a
`emit(ctx)` that returns a config document given the profile, base URL, and
catalog. Adding a client is a new object plus an entry in the map — no server or
CLI changes.
