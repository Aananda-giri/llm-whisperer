# Quickstart

This guide gets you from zero to your first API response in under five minutes.

## 1. Install

```bash
npm install -g llm-whisper
npx playwright install chromium   # one-time download, ~170 MB
```

## 2. Log in to a provider

LLM-Whisper drives real browser sessions, so you authenticate once by hand.
Qwen is the recommended provider to start with — it works reliably and allows
Google login.

```bash
whisper login qwen
```

A Chromium window opens at `chat.qwen.ai`. Log in (Google OAuth works), get to
the chat screen, then press **Enter** in your terminal. The session is saved.

> **Note:** You must stop `whisper serve` before running `whisper login` — Chrome
> locks the browser profile to one process at a time.

## 3. Start the server

```bash
whisper serve
```

You should see:

```
LLM-Whisper listening on http://localhost:9777
Providers: qwen, deepseek, chatgpt, claude, glm
Warming tabs: qwen...
  ✓ qwen ready
```

## 4. Send your first message

```bash
curl -s -X POST http://localhost:9777/chat \
  -H "Content-Type: application/json" \
  -d '{"provider":"qwen","messages":[{"role":"user","content":"Say hello!"}]}' \
  | jq .
```

Response:

```json
{
  "provider": "qwen",
  "message": {
    "role": "assistant",
    "content": "Hello! How can I help you today?"
  }
}
```

## 5. Continue the conversation

Subsequent requests continue the same chat — the browser holds the history:

```bash
curl -s -X POST http://localhost:9777/chat \
  -H "Content-Type: application/json" \
  -d '{"provider":"qwen","messages":[{"role":"user","content":"What did I just ask you?"}]}' \
  | jq .message.content
```

To start a fresh chat, pass `"newChat": true`. See [api.md](./api.md) for the
full request reference.

## Next steps

- [api.md](./api.md) — full HTTP API reference
- [providers.md](./providers.md) — log in to more providers, fix broken selectors
- [configuration.md](./configuration.md) — ports, headless mode, custom config paths
