# API Reference

LLM-Whisperer exposes a small HTTP API on `http://localhost:9777` (configurable
via `PORT`).

It offers two interfaces:

- **`POST /chat`** — the native endpoint (simple request/response shape)
- **`POST /v1/chat/completions`** — OpenAI-compatible, including streaming,
  so existing OpenAI clients (Cursor, Open WebUI, Continue.dev, LangChain, the
  `openai` SDK) work by just pointing the base URL here.
- **`POST /v1/embeddings`** — OpenAI-compatible embeddings (API-key providers only).
- **`POST /v1/messages`** — Anthropic-compatible (Messages API), including
  streaming, so the `anthropic` SDK works by pointing its base URL here.

Every data route above also works under a **profile prefix** — `POST /p/email1/v1/chat/completions`
scopes the request (and the model catalog) to the `email1` profile. See
[Profiles](#profiles).

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
| `profile` | string | no | Browser profile to use for this request (e.g. `email1`). Default: the provider's `profile` in `providers.yaml`, else `WSPR_BROWSER_PROFILE`, else `default`. Ignored by API-key providers. |

**Message object**

| Field | Type | Values |
|---|---|---|
| `role` | string | `"user"` · `"assistant"` · `"system"` · `"tool"` |
| `content` | string | The message text (empty on assistant turns that carry `tool_calls`) |
| `tool_calls` | array | Optional — assistant turns that requested tools. Ignored by API-key providers. |
| `tool_call_id` | string | Optional — `role: "tool"` turns: which call this result answers |
| `name` | string | Optional — `role: "tool"` turns: the tool that produced the result |

### Conversation behaviour

By default (`newChat` omitted or `false`), only the **pending turn** is sent to
the browser — every message after the last `assistant` message. The web UI
already holds the conversation history from previous requests, so there is no
need to re-send earlier turns.

In the common case that is just the newest user message. Two cases send more:

- **The first turn of a conversation.** With no assistant message yet, a leading
  `system` message is part of the pending turn and is sent along with the user
  message, labelled `System:`. (Earlier versions dropped it silently.) Send
  `newChat: true` if you want a guaranteed-clean thread to anchor it to.
- **A tool loop.** After an assistant turn that requested tools, the pending turn
  is the `role: "tool"` results, which are sent as `<tool_result>` blocks rather
  than a re-ask of the original question. See [Tool calling](#tool-calling).

When `newChat: true`, LLM-Whisperer clicks "New Chat" (or reloads the page),
then sends all messages flattened into one prompt. Use this to switch topics
or reset context.

#### Continuity: which tab a turn lands in

Sending only the pending turn is safe exactly when the browser tab really does
hold the rest. Since several conversations can share a provider, LLM-Whisperer
verifies that rather than assuming it.

Each turn derives a **conversation key** from the messages the client authored
(`user`, `tool`, and the `tool_call` ids on assistant turns). Assistant prose is
excluded — the client's copy of it is a lossy re-render, and hashing it would
mismatch constantly. So is `system` *content* by default: agent clients rebuild
their system prompt every request with volatile context (working directory,
today's date), which would otherwise score every turn as a miss.

Given that key, a turn either:

- **continues** — the tab provably holds this history, so only the pending turn
  is typed in; or
- **replays** — it does not, so a fresh chat is opened and the whole transcript
  re-sent.

Two conversations therefore keep their own tabs, and a resumed or compacted one
rebuilds itself instead of appending to whatever the tab was holding. A
cancelled request always leaves its tab marked dirty, so it replays next time
rather than continuing a thread nobody read to the end.

`WSPR_CONTINUITY` overrides the policy globally, and a `continuity` field on the
request body overrides it per call:

| Value | Behaviour |
|---|---|
| `auto` (default) | Continue on a verified match, replay otherwise. |
| `tab` | Always continue. The historical behaviour — the tab *is* the conversation. |
| `replay` | Always start fresh and re-send everything. Slow; good for debugging. |

A lone user message with no `tools` still continues whatever the tab holds, so
the two-request example below behaves exactly as it always has. A request that
declares `tools` is treated as coming from a stateless agent client, and opens a
clean thread instead. See [clients.md](./clients.md#opencode).

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
| `profile` | string | no | Browser profile to use for this request (e.g. `email1`). Default: the provider's `profile` in `providers.yaml`, else `WSPR_BROWSER_PROFILE`, else `default`. Ignored by API-key providers. |
| `tools` | array | no | OpenAI-style functions (`{"type":"function","function":{"name","description","parameters"}}`). See [Tool calling](#tool-calling). |
| `tool_choice` | string \| object | no | `"auto"` `"none"` `"required"` or `{"type":"function","function":{"name":...}}`. |

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

> Token counts are **real for API-key providers** (parsed from the upstream
> stream's trailing `usage` chunk) and `0` for browser-driven providers — those
> are browser sessions, not metered APIs, so there is no real token accounting.
> The streamed `finish_reason` reflects the upstream's own value (`"length"` on
> truncation) where the provider reports one; browser providers always say
> `"stop"`.
>
> **Caveat:** real usage relies on the upstream supporting the OpenAI
> `stream_options: { include_usage: true }` request field. Most OpenAI-compatible
> providers do (Groq, OpenRouter, Together, Cerebras, …), but one that rejects
> unknown params could error on it. If you hit that, the provider needs
> `stream_options` dropped or made opt-in per provider; `finish_reason` still
> propagates and `usage` simply reads as zeros.

### Streaming (`stream: true`)

Returns `text/event-stream`. Chunks follow the OpenAI `chat.completion.chunk`
format: an opening chunk with `delta.role`, content chunks with `delta.content`
as the LLM types, a final chunk carrying `finish_reason`, then `data: [DONE]`.

`finish_reason` is the API-key provider's own value, so `"length"` really means
the answer was truncated by `max_tokens` and `"tool_calls"` that tools were
requested. Browser providers have no such signal and always report `"stop"`.
The Anthropic endpoint maps the same value onto `stop_reason` (`"length"` ⇒
`"max_tokens"`).

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

## Profiles

A **profile** is a named API scope. It combines the browser identity (the
protocol you already use — see
[configuration.md](./configuration.md#browser-profiles)) with a *declared* set
of providers and models, so a client pointed at one profile sees exactly that
set and nothing else.

Selection is a URL path prefix — it works with **every** client unmodified,
because clients only expose a base URL and an API key:

```
http://localhost:9777/v1              → the default browser profile ("default")
http://localhost:9777/p/email1/v1     → the "email1" profile
http://localhost:9777/p/work/v1       → the "work" profile
```

The path prefix scopes every data route — `/chat`, `/v1/models`,
`/v1/chat/completions`, `/v1/embeddings`, `/v1/messages`, `/health`. The
Anthropic base follows the same rule: `ANTHROPIC_BASE_URL=http://localhost:9777/p/email1`
(the SDK appends `/v1/messages`).

```yaml
# providers.yaml
profiles:
  email1:
    label: "Personal (email1)"
    providers:
      qwen: [qwen3-235b, qwen2.5-max]
      groq: "*"          # every model wspr knows for this provider
```

A profile that is **not** declared is still valid — it simply exposes every
provider (today's bare `/v1/*` behaviour) while scoping browser sessions to that
name. An explicit `profile` field on a request still wins over the path.

See [profiles in configuration.md](./configuration.md#profiles-api-scope) for the schema,
and [clients.md](./clients.md) for the end-to-end walkthrough (opencode and
friends).

---

## Tool calling

Both compatibility dialects accept `tools` / `tool_choice` (OpenAI) and `tools` /
`tool_choice` (Anthropic). wspr **never executes tools** — it only translates the
protocol. The calling application runs the tool functions and sends the results
back as `role: "tool"` messages (OpenAI) or `tool_result` blocks (Anthropic).

Two things are worth knowing up front:

1. **Browser providers simulate tool calling by prompting.** A browser chat UI can
   only ever give us rendered text, so the tool schemas are written into the
   prompt and the model's `<tool_call>` / `</tool_call>` blocks are parsed back
   into a real `tool_calls` response. Because this is prompt-based, reliability
   depends on the model — a small or non-instruct model may ignore the tools or
   emit malformed JSON. A malformed block degrades to ordinary prose, never a
   `500`. The parser is deliberately lenient: it tolerates a wrapping Markdown
   code fence, smart quotes, zero-width characters and trailing commas, all of
   which chat UIs introduce when they re-render the model's output.
2. **API-key providers forward `tools` natively.** A provider with an `api:`
   block passes `tools` / `tool_choice` straight to the upstream API — real
   native tool calling, not prompting — and folds the streamed
   `delta.tool_calls` fragments back into a `tool_calls` response. Sampling
   parameters (`temperature`, `max_tokens`, `top_p`, `stop`, `seed`,
   `response_format`) are forwarded too.

### Example: OpenAI two-turn tool loop

```bash
# Turn 1 — ask with a tool available
curl -s -X POST http://localhost:9777/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen",
    "messages": [{"role":"user","content":"what is the weather in Kathmandu?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city.",
        "parameters": {"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}
      }
    }]
  }'

# Expect: finish_reason "tool_calls" and a populated tool_calls array.

# Turn 2 — feed the result back; wspr renders it into the browser thread.
curl -s -X POST http://localhost:9777/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen",
    "messages": [
      {"role":"user","content":"what is the weather in Kathmandu?"},
      {"role":"assistant","content":null,"tool_calls":[{"id":"call_x","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"Kathmandu\"}"}}]},
      {"role":"tool","tool_call_id":"call_x","content":"{\"temp_c\": 12}"}
    ],
    "tools": [{ "type":"function", "function": { "name":"get_weather" } }]
  }'
```

> The tool `id` and `tool_call_id` are generated and echoed by wspr; no
> server-side conversation state is kept, so any client can drive the loop.

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

OpenAI-compatible model list, **scoped to the active profile**. Each configured
provider is returned first as a bare alias (use the provider's default model),
then one entry per exposed model as `provider/model`. A client pointed at
`/p/email1/v1` sees only what the `email1` profile declares; a bare `/v1` sees
every provider and every model it knows.

```bash
curl http://localhost:9777/v1/models            # every provider + model
curl http://localhost:9777/p/email1/v1/models   # only what email1 exposes
```

```json
{
  "object": "list",
  "data": [
    {
      "id": "qwen",
      "object": "model",
      "created": 1718900000,
      "owned_by": "llm-whisperer",
      "wspr": { "provider": "qwen", "model": null, "kind": "browser", "label": "qwen", "profile": "email1" }
    },
    {
      "id": "qwen/qwen3-235b",
      "object": "model",
      "created": 1718900000,
      "owned_by": "llm-whisperer",
      "wspr": { "provider": "qwen", "model": "qwen3-235b", "kind": "browser", "label": "qwen3-235b", "profile": "email1" }
    },
    {
      "id": "groq/llama-3.3-70b-versatile",
      "object": "model",
      "created": 1718900000,
      "owned_by": "llm-whisperer",
      "wspr": { "provider": "groq", "model": "llama-3.3-70b-versatile", "kind": "api", "label": "llama-3.3-70b-versatile", "profile": "email1" }
    }
  ]
}
```

The `wspr` field is extra metadata clients may ignore. `model: null` means the
bare provider alias. Slashed model ids survive intact here (OpenRouter
`openrouter/openai/gpt-oss-120b:free`, Cloudflare
`cloudflare/@cf/meta/llama-3.1-8b-instruct`), because the catalog splits on the
*first* `/` only.

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

## POST /v1/messages

Anthropic-compatible [Messages API](https://docs.anthropic.com/en/api/messages).
Point the `anthropic` SDK (or any tool that targets it) at
`http://localhost:9777` and the model selection rules are the same as every
other endpoint: `model` is the **provider key**, or `provider/model-name` to
also switch the model.

When `WSPR_API_KEY` is set, the SDK's `x-api-key` header is checked against it;
otherwise the endpoint is open and the key can be anything.

### Request

```json
{
  "model": "groq",
  "max_tokens": 1024,
  "system": "You are concise.",
  "messages": [{ "role": "user", "content": "Hello!" }],
  "stream": false
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | yes | Provider key, or `provider/model-name` to also switch model |
| `messages` | Message[] | yes | Anthropic messages array (`user` / `assistant`) |
| `system` | string \| block[] | no | System prompt. Sent to the provider as a `system` message. |
| `max_tokens` | number | no | Accepted for SDK compatibility; not enforced by the proxy |
| `stream` | boolean | no | `true` for Anthropic-style SSE streaming. Default: `false`. |
| `newChat` | boolean | no | `true` to start a fresh conversation first (browser providers) |
| `profile` | string | no | Browser profile to use for this request (e.g. `email1`). Default: the provider's `profile` in `providers.yaml`, else `WSPR_BROWSER_PROFILE`, else `default`. Ignored by API-key providers. |
| `tools` | array | no | Anthropic tools (`{"name","description","input_schema"}`). See [Tool calling](#tool-calling). |
| `tool_choice` | string \| object | no | `"auto"` `"any"` `"tool"` or `{"type":"auto"|"any",...}`, `{"type":"tool","name":...}`. |

Message `content` may be a string or an array of content blocks. Text blocks
are concatenated; images and other non-text blocks are ignored — browser
providers are text-only. For vision, use the OpenAI endpoint instead. On the
non-streaming path, `tool_use` / `tool_result` blocks are preserved for browser
providers: a `tool_use` block on an assistant turn becomes `tool_calls`, and a
`tool_result` block on a user turn becomes a `role: "tool"` message.

### Response (non-streaming)

```json
{
  "id": "msg_1718900000000",
  "type": "message",
  "role": "assistant",
  "model": "groq",
  "content": [{ "type": "text", "text": "Hi!" }],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": { "input_tokens": 0, "output_tokens": 0 }
}
```

> Token counts are **real for API-key providers** (upstream `prompt_tokens` /
> `completion_tokens` mapped to `input_tokens` / `output_tokens`) and `0` for
> browser-driven providers, which have no metering. `stop_reason` reflects the
> upstream's own value where reported (`"max_tokens"` on truncation); browser
> providers always say `"end_turn"`.

### Streaming (`stream: true`)

Returns `text/event-stream` using the Anthropic event sequence:
`message_start` → `content_block_start` → one or more `content_block_delta`
(`text_delta`) → `content_block_stop` → `message_delta` → `message_stop`.

```bash
curl -N http://localhost:9777/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"groq","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"Count to 5"}]}'
```

### Using the Anthropic SDK

```python
import anthropic

client = anthropic.Anthropic(base_url="http://localhost:9777", api_key="not-needed")

msg = client.messages.create(
    model="groq",                       # or "groq/llama-3.1-8b-instant"
    max_tokens=256,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(msg.content[0].text)
```

### Error responses

Errors use the Anthropic shape `{"type": "error", "error": {"type": ..., "message": ...}}`.

| HTTP | `error.type` | Meaning |
|---|---|---|
| 400 | `invalid_request_error` | Unknown provider or empty `messages` |
| 401 | `authentication_error` | Not logged in / missing API key for the provider |
| 500 | `api_error` | Browser / timeout / upstream error |

---

## GET /health

Returns the list of providers for the active profile. Always open (never
requires an API key).

```bash
curl http://localhost:9777/health            # every provider
curl http://localhost:9777/p/email1/health   # only what email1 exposes
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
