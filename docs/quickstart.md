# Quickstart

This guide gets you from zero to your first API response in under five minutes.

## 1. Install

```bash
npm install -g llm-whisperer
npx playwright install chromium   # only needed for the browser path (Path B), ~170 MB
```

On Linux/WSL, the browser path also needs Chromium system libraries. If
`wspr login <name>` fails with a missing shared library such as `libnspr4.so`,
run:

```bash
sudo npx playwright install-deps chromium
```

For Ubuntu 24.04/WSL, the common manual fix is:

```bash
sudo apt update
sudo apt install -y libnspr4 libnss3 libatk-bridge2.0-0 libgtk-3-0 libxss1 libasound2t64
```

## 2. Get a model — pick a path

LLM-Whisperer connects two ways. **Path A (API key)** is the fastest — no
browser, no login. **Path B (browser)** needs no paid key but you log in once by
hand. You can use both at once.

### Path A — API key (fastest, no browser)

Several supported providers have **free tiers**: `gemini`, `groq`, `openrouter`,
`cerebras`, `mistral` (also `openai`, `deepseek-api` if you pay). Set the key and
go — you can skip the `playwright install` step above entirely.

```bash
echo "GROQ_API_KEY=your-key-here" >> .env   # free key: https://console.groq.com/keys
wspr serve
```

Send a message — use the **provider key as the model**:

```bash
curl -s http://localhost:9777/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"groq","messages":[{"role":"user","content":"Say hello!"}]}' \
  | jq -r '.choices[0].message.content'
```

Pick a specific model with `provider/model`, e.g. `"model":"groq/llama-3.1-8b-instant"`.
See [providers.md](./providers.md#api-key-providers) for every API provider and
[configuration.md](./configuration.md#provider-api-keys) for key setup.

### Path B — browser login (free web UIs, no API key)

Drives a real chat UI like a human. Qwen is the easiest to start with — it works
reliably and allows Google login.

```bash
wspr login qwen
```

A Chromium window opens at `chat.qwen.ai`. Log in (Google OAuth works), get to
the chat screen, then press **Enter** in your terminal. The session is saved.

> **Note:** You must stop `wspr serve` before running `wspr login` — Chrome
> locks the browser profile to one process at a time.

Then start the server and send a message:

```bash
wspr serve
```

```bash
curl -s -X POST http://localhost:9777/chat \
  -H "Content-Type: application/json" \
  -d '{"provider":"qwen","messages":[{"role":"user","content":"Say hello!"}]}' \
  | jq -r '.message.content'
```

## 3. Continue the conversation

With a **browser** provider, subsequent requests continue the same chat — the
browser tab holds the history, so you only send the new message:

```bash
curl -s -X POST http://localhost:9777/chat \
  -H "Content-Type: application/json" \
  -d '{"provider":"qwen","messages":[{"role":"user","content":"What did I just ask you?"}]}' \
  | jq -r '.message.content'
```

To start a fresh chat, pass `"newChat": true`.

> **API-key providers are stateless** — they keep no server-side history, so send
> the full `messages` array each time (standard OpenAI behaviour). `newChat` has
> no effect on them.

See [api.md](./api.md) for the full request reference.

## Next steps

- [api.md](./api.md) — full HTTP API reference
- [providers.md](./providers.md) — all providers: API-key setup, browser login, fixing selectors
- [configuration.md](./configuration.md) — ports, headless mode, custom config paths
