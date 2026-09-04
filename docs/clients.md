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

`--out` writes to a file (each target has a default filename); without it the
config is printed. `--base-url` overrides the server root (defaults to
`http://localhost:PORT`). Profile defaults to the server's default browser
profile.

Every emitted base URL is **profile-scoped**: `/p/<profile>/v1` for OpenAI
dialects, `/p/<profile>` for Anthropic (the SDK appends `/v1/messages`).

---

## opencode

opencode is a coding agent built on AI SDK. It does **not** auto-discover models
from `/v1/models` — it requires an explicit model map — so the emitter lists
every model the profile exposes.

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

The generated `opencode.json` (provider keyed by profile, base URL under
`/p/<profile>/v1`, models keyed by their `id`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "email1": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Personal (email1)",
      "options": { "baseURL": "http://localhost:9777/p/email1/v1", "apiKey": "not-needed" },
      "models": {
        "qwen": { "name": "qwen" },
        "qwen/qwen3-235b": { "name": "qwen3-235b" },
        "groq": { "name": "groq" },
        "groq/llama-3.3-70b-versatile": { "name": "llama-3.3-70b-versatile" }
      }
    }
  }
}
```

Merge it into your `opencode.json` (or point `--out` at it), restart opencode,
and the model picker lists exactly that profile's models. A request sends the
integer-form `/p/email1/v1/chat/completions` with the model id — and because
wspr now forwards `tools` natively to API-key providers, the agent can edit a
file.

> If you set `WSPR_API_KEY`, change `apiKey` in the emitted block to that key.

---

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
