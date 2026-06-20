# LLM-Whisper

Whisper to the **free web chat UIs** of Qwen, ChatGPT, Claude, DeepSeek and GLM,
and talk to all of them through **one local HTTP API** — no paid API keys.

It drives each site's web interface with a stealthed, persistent-login browser
and exposes a single `POST /chat` endpoint that any app on the same machine can
call.

## How it works

```
your app ──HTTP──▶ LLM-Whisper API ──▶ session pool ──▶ persistent browser ──▶ chat.qwen.ai / claude.ai / ...
```

- **Adapter pattern** — every provider is the same generic `WebLLMProvider`; the
  only per-service difference is selectors in `providers.yaml`.
- **Config-driven selectors** — when a site's UI changes, fix `providers.yaml`,
  not code.
- **Persistent login** — you log in by hand once per service; the session is
  saved to `profiles/<name>/` and reused (including headless).
- **Session pool** — pages are reused, so N requests don't spawn N browsers.
- **Stealth** — `puppeteer-extra-plugin-stealth` to get past basic bot checks.
- **Robust response detection** — polls the answer until it stops changing,
  instead of relying on a single brittle "done" selector.

## Available providers & models

These are the free web UIs you get access to — no API key, just a browser session.

| Provider key | Site | Model served | Notes |
|---|---|---|---|
| `qwen` | chat.qwen.ai | Qwen3.7-Plus | Verified working ✓ |
| `deepseek` | chat.deepseek.com | DeepSeek V3 / R1 | Login required |
| `chatgpt` | chatgpt.com | GPT-4o (free tier) | Cloudflare + login |
| `claude` | claude.ai | Claude Sonnet (free tier) | Login required |
| `glm` | chat.z.ai | GLM-4 | Login required |

> The model served is whatever the site defaults to for a free account.
> To use a different model (e.g. switch Qwen to a different variant), log in
> manually, change the model in the web UI, and that setting persists in your
> saved session.

## Setup

```bash
pnpm install
pnpm exec playwright install chromium
cp .env.example .env
```

## Log in once per provider

The browser that opens is **Playwright's Chromium** (separate from your Brave/Chrome).
It starts with a fresh profile. To authenticate:

1. Run the login command — a visible Chromium browser opens at the provider's site
2. Click "Continue with Google" (or log in however that site requires)
3. Sign into your Google account — Google's account chooser works even in a fresh browser
4. Once on the chat screen, press **Enter** in the terminal to save the session

```bash
pnpm run login qwen      # opens visible browser; log in, press Enter when done
pnpm run login deepseek
pnpm run login chatgpt
# ...etc
```

Sessions are saved to `profiles/<provider>/` and reused on all future runs (including headless).
You only need to do this once per provider.

## Run the API

```bash
pnpm serve           # http://localhost:3000
# or: pnpm dev       # auto-reload during development
```

## Use it

By default each request **continues the same conversation** — the web UI holds the history, so you only need to send the latest message:

```bash
# Turn 1
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"provider":"qwen","messages":[{"role":"user","content":"My name is Ana."}]}'

# Turn 2 — Qwen already knows your name from the browser session
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"provider":"qwen","messages":[{"role":"user","content":"What is my name?"}]}'
```

**Start a fresh conversation** by passing `"newChat": true`:

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"provider":"qwen","newChat":true,"messages":[{"role":"user","content":"New topic!"}]}'
```

Response shape:

```json
{ "provider": "qwen", "message": { "role": "assistant", "content": "..." } }
```

`GET /health` lists the configured providers.

## Adding / fixing a provider

1. Add (or edit) an entry in `providers.yaml`.
2. Find selectors by running with `HEADLESS=false` and using devtools.
3. If a service needs special handling, subclass `WebLLMProvider` and register
   it in `src/providers/factory.ts`.

## Caveats

These are free web UIs, so expect breakage: UI updates change selectors,
aggressive use triggers rate limits / Cloudflare, and sessions eventually
expire (just `pnpm run login <name>` again). Selectors in `providers.yaml` are
best-effort starting points — verify them on first run with `HEADLESS=false`.
This is for personal, low-volume use; respect each service's terms.
