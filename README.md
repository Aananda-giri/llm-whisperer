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

## Setup

```bash
pnpm install
pnpm exec playwright install chromium
cp .env.example .env
```

## Log in once per provider

Login-gated sites need a one-time manual login (saved for later headless runs):

```bash
pnpm run login qwen      # opens a visible browser; log in, then press Enter
pnpm run login claude
pnpm run login deepseek
# ...etc
```

## Run the API

```bash
pnpm serve           # http://localhost:3000
# or: pnpm dev       # auto-reload during development
```

## Use it

```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "qwen",
    "messages": [{ "role": "user", "content": "What is 2+2?" }]
  }'
```

Response:

```json
{ "provider": "qwen", "message": { "role": "assistant", "content": "4" } }
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
