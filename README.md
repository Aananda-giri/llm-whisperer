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

## Install

```bash
npm install -g llm-whisper
npx playwright install chromium   # one-time browser download (~170 MB)
```

Or run without installing:

```bash
npx llm-whisper serve
```

### From source

```bash
git clone https://github.com/aananda-giri/llm-whisperer
cd llm-whisperer
pnpm install
pnpm exec playwright install chromium
```

## Log in once per provider

All providers share **one browser window** (one Chromium process). Each provider
is a separate tab — Chrome partitions cookies by origin, so sessions never
bleed between sites.

> **Important:** `whisper login` needs the browser profile to be unlocked.
> Stop `whisper serve` before running login.

1. Run the login command — a Chromium window opens with a new tab at that site:

```bash
whisper login qwen      # opens browser tab at qwen.ai; log in, press Enter
whisper login deepseek  # opens another tab at deepseek.com
whisper login chatgpt
# ...etc
```

2. Log in (Google OAuth or email — the browser remembers the session)
3. Press **Enter** in the terminal — the session is saved to the shared profile
4. Start `whisper serve` — all logged-in providers appear as tabs in one window

Sessions are saved to `~/.config/llm-whisper/profiles/browser/` (shared).
You only need to do this once per provider; sessions persist across restarts.

## Run the API

```bash
whisper serve        # http://localhost:3000
```

From source: `pnpm run serve` (or `pnpm run dev` for auto-reload).

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
expire (just `whisper login <name>` again). Selectors in `providers.yaml` are
best-effort starting points — verify them on first run with `HEADLESS=false`.
This is for personal, low-volume use; respect each service's terms.
