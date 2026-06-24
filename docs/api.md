# API Reference

LLM-Whisperer exposes a small HTTP API on `http://localhost:9777` (configurable
via `PORT`).

It offers two interfaces:

- **`POST /chat`** — the native endpoint (simple request/response shape)
- **`POST /v1/chat/completions`** — OpenAI-compatible, including streaming,
  so existing OpenAI clients (Cursor, Open WebUI, Continue.dev, LangChain, the
  `openai` SDK) work by just pointing the base URL here.
- **`POST /v1/embeddings`** — OpenAI-compatible embeddings (API-key providers only).

## Authentication

By default the API is **open** (no key required) — convenient for localhost.

If you set the `WSPR_API_KEY` environment variable, all endpoints except
`GET /health` require a matching key, supplied via either header:

```
Authorization: Bearer <key>
x-api-key: <key>
```

A missing/wrong key returns `401`. See [configuration.md](./configuration.md#wspr_api_key).

---

## POST /chat

Send a message to a provider and get the response.

### Request

```json
{
  "provider": "qwen",
  "messages": [
    { "role": "user", "content": "What is the capital of France?" }
  ],
  "newChat": false
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `provider` | string | yes | Provider key from `providers.yaml` (e.g. `qwen`, `deepseek`) |
| `messages` | Message[] | yes | Conversation turns. See below. |
| `newChat` | boolean | no | `true` to start a fresh conversation first. Default: `false`. |
| `model` | string | no | `provider/model-name` to switch the model in the web UI before sending (e.g. `qwen/qwen2.5-max`). See [Model selection](#model-selection). |

**Message object**

| Field | Type | Values |
|---|---|---|
| `role` | string | `"user"` · `"assistant"` · `"system"` |
| `content` | string | The message text |

### Conversation behaviour

By default (`newChat` omitted or `false`), only the **last user message** is
sent to the browser. The web UI already holds the conversation history from
previous requests, so there is no need to re-send earlier turns.

When `newChat: true`, LLM-Whisperer clicks "New Chat" (or reloads the page),
then sends all messages flattened into one prompt. Use this to switch topics
or reset context.

> **API-key providers are different.** Providers with an `api:` block (e.g.
> `openai`, `digitalocean`) call a stateless HTTP API — there is no server-side
> conversation, so send the **full** `messages` history with every request
> (standard OpenAI behaviour). `newChat` has no effect on them. See
> [providers.md](./providers.md#api-key-providers).

### Response

```json
{
  "provider": "qwen",
  "message": {
    "role": "assistant",
    "content": "Paris."
  }
}
```

### Error responses

| HTTP | Body | Meaning |
|---|---|---|
| 400 | `{"error":"..."}` | Missing or invalid request fields |
| 401 | `{"error":"Not logged in to \"qwen\"..."}` | Run `wspr login qwen` |
| 500 | `{"error":"..."}` | Browser / timeout error |

### Example: multi-turn conversation

```bash
# Turn 1
curl -s -X POST http://localhost:9777/chat \
  -H "Content-Type: application/json" \
  -d '{"provider":"qwen","messages":[{"role":"user","content":"My name is Ana."}]}'

# Turn 2 — the browser already knows the context
curl -s -X POST http://localhost:9777/chat \
  -H "Content-Type: application/json" \
  -d '{"provider":"qwen","messages":[{"role":"user","content":"What is my name?"}]}'

# Start over
curl -s -X POST http://localhost:9777/chat \
  -H "Content-Type: application/json" \
  -d '{"provider":"qwen","newChat":true,"messages":[{"role":"user","content":"Fresh start."}]}'
```

---

## POST /v1/chat/completions

OpenAI-compatible chat completions. Point any OpenAI client at
`http://localhost:9777/v1` and set the API key to anything (or to your
`WSPR_API_KEY` if configured).

### Request

```json
{
  "model": "qwen",
  "messages": [{ "role": "user", "content": "Hello!" }],
  "stream": false
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | yes | Provider key, or `provider/model-name` to also switch model |
| `messages` | Message[] | yes | Standard OpenAI messages array |
| `stream` | boolean | no | `true` for Server-Sent Events streaming. Default: `false`. |
| `newChat` | boolean | no | `true` to start a fresh conversation first |

**Images (vision):** for API-key providers, `content` may be an OpenAI-style
array of parts (`{"type":"text",...}` + `{"type":"image_url","image_url":{"url":...}}`).
It is forwarded to the upstream API unchanged, so any vision-capable model works
(e.g. `digitalocean/llama-4-maverick`). The `url` accepts a `data:` URL (inline
base64) or a publicly reachable `https://` URL. Browser providers are text-only.

### Response (non-streaming)

```json
{
  "id": "chatcmpl-1718900000000",
  "object": "chat.completion",
  "created": 1718900000,
  "model": "qwen",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "Hi!" }, "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

> Token counts are always `0` — these are browser sessions, not metered APIs,
> so there is no real token accounting.

### Streaming (`stream: true`)

Returns `text/event-stream`. Chunks follow the OpenAI `chat.completion.chunk`
format: an opening chunk with `delta.role`, content chunks with `delta.content`
as the LLM types, a final chunk with `finish_reason: "stop"`, then `data: [DONE]`.

```bash
curl -N http://localhost:9777/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen","stream":true,"messages":[{"role":"user","content":"Count to 5 slowly"}]}'
```

Streaming reflects the LLM typing in real time — deltas are emitted as new text
appears in the web UI (polled ~3×/second).

### Using the OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:9777/v1", api_key="not-needed")

resp = client.chat.completions.create(
    model="qwen",                       # or "qwen/qwen2.5-max"
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True,
)
for chunk in resp:
    print(chunk.choices[0].delta.content or "", end="")
```

---

## Model selection

A provider corresponds to a **browser session** (one site). Many sites offer
several models behind a picker. Use the `provider/model-name` form to switch
before sending:

```bash
# native endpoint
curl -s -X POST http://localhost:9777/chat \
  -H "Content-Type: application/json" \
  -d '{"provider":"qwen","model":"qwen/qwen2.5-max","messages":[{"role":"user","content":"Hi"}]}'

# OpenAI endpoint
curl -s -X POST http://localhost:9777/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen/qwen2.5-max","messages":[{"role":"user","content":"Hi"}]}'
```

The model name must be a key in that provider's `models:` map in
`providers.yaml`, and the provider must define `modelPickerTrigger` plus a
selector for that model. If those are not configured, the model switch is a
no-op and whichever model is currently selected in the tab is used. See
[providers.md](./providers.md#model-switching).

---

## GET /v1/models

OpenAI-compatible model list. Each configured provider is returned as a model.

```bash
curl http://localhost:9777/v1/models
```

```json
{
  "object": "list",
  "data": [
    { "id": "qwen", "object": "model", "created": 1718900000, "owned_by": "llm-whisperer" }
  ]
}
```

---

## POST /v1/embeddings

OpenAI-compatible embeddings. **Only API-key providers support this** — calling
it on a browser provider returns `400`.

### Request

```json
{
  "model": "digitalocean",
  "input": "hello world"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | yes | Provider key, or `provider/model-name` to pick the embedding model. Bare provider uses its `embedModel` default. |
| `input` | string \| string[] | yes | One text, or a batch of texts |

```bash
# default embedding model (digitalocean -> gte-large-en-v1.5)
curl http://localhost:9777/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model":"digitalocean","input":"hello world"}'

# pick the model + batch several inputs
curl http://localhost:9777/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model":"digitalocean/bge-m3","input":["first text","second text"]}'
```

### Response

The upstream OpenAI-shaped response is passed through (one entry per input):

```json
{
  "object": "list",
  "data": [
    { "object": "embedding", "index": 0, "embedding": [0.0123, -0.0456, "..."] }
  ],
  "model": "digitalocean",
  "usage": { "prompt_tokens": 4, "total_tokens": 4 }
}
```

---

## GET /health

Returns the list of configured providers. Always open (never requires an API key).

```bash
curl http://localhost:9777/health
```

```json
{
  "ok": true,
  "providers": ["qwen", "deepseek", "chatgpt", "claude", "glm", "kimi", "minimax", "grok", "pi", "ernie"]
}
```

---

## Timeouts

The server waits up to `timeoutMs` (per `providers.yaml`, default 90 s) for the
LLM to respond. If it times out, a screenshot is saved to `/tmp/<provider>-timeout.png`
for debugging and a 500 error is returned.

Increase `timeoutMs` in `providers.yaml` for slow providers (reasoning models
can take 2+ minutes).
