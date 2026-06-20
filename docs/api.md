# API Reference

LLM-Whisper exposes a small HTTP API on `http://localhost:3000` (configurable
via `PORT`).

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

**Message object**

| Field | Type | Values |
|---|---|---|
| `role` | string | `"user"` · `"assistant"` · `"system"` |
| `content` | string | The message text |

### Conversation behaviour

By default (`newChat` omitted or `false`), only the **last user message** is
sent to the browser. The web UI already holds the conversation history from
previous requests, so there is no need to re-send earlier turns.

When `newChat: true`, LLM-Whisper clicks "New Chat" (or reloads the page),
then sends all messages flattened into one prompt. Use this to switch topics
or reset context.

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
| 401 | `{"error":"Not logged in to \"qwen\"..."}` | Run `whisper login qwen` |
| 500 | `{"error":"..."}` | Browser / timeout error |

### Example: multi-turn conversation

```bash
# Turn 1
curl -s -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"provider":"qwen","messages":[{"role":"user","content":"My name is Ana."}]}'

# Turn 2 — the browser already knows the context
curl -s -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"provider":"qwen","messages":[{"role":"user","content":"What is my name?"}]}'

# Start over
curl -s -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"provider":"qwen","newChat":true,"messages":[{"role":"user","content":"Fresh start."}]}'
```

---

## GET /health

Returns the list of configured providers and their status.

```bash
curl http://localhost:3000/health
```

```json
{
  "status": "ok",
  "providers": ["qwen", "deepseek", "chatgpt", "claude", "glm"]
}
```

---

## Timeouts

The server waits up to `timeoutMs` (per `providers.yaml`, default 90 s) for the
LLM to respond. If it times out, a screenshot is saved to `/tmp/<provider>-timeout.png`
for debugging and a 500 error is returned.

Increase `timeoutMs` in `providers.yaml` for slow providers (reasoning models
can take 2+ minutes).
