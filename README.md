# LLM-Whisper

Whisper to the **free web chat UIs** of Qwen, ChatGPT, Claude, DeepSeek, GLM,
Kimi, MiniMax, Grok, Pi and ERNIE — and talk to all of them through **one local
HTTP API** (native or OpenAI-compatible, with streaming) — no paid API keys.

```
your app ──HTTP──▶ LLM-Whisper ──▶ browser tabs ──▶ chat.qwen.ai / claude.ai / ...
```

## ⚠️ Terms of Service disclaimer

This tool automates web interfaces that are intended for human use. Most
providers explicitly **prohibit automated or programmatic access** to their
free web UI in their Terms of Service:

| Provider | ToS reference |
|---|---|
| OpenAI / ChatGPT | [Terms of Use](https://openai.com/policies/terms-of-use/) — prohibits scraping and automated access |
| Anthropic / Claude | [Usage Policy](https://www.anthropic.com/legal/aup) — prohibits automated web UI access |
| xAI / Grok | [Terms of Service](https://x.ai/legal/terms-of-service) — prohibits automated access |
| Alibaba / Qwen | Prohibits bots and automated access |
| DeepSeek | Prohibits automated access |
| Zhipu / GLM | Prohibits automated access |
| Moonshot / Kimi | Prohibits automated access |
| MiniMax | Prohibits automated access |
| Inflection / Pi | Prohibits automated access |
| Baidu / ERNIE | Prohibits automated access |

**Use this tool for personal experimentation, research, or local prototyping
only — at your own risk.** For production use, pay for the official API.
Publishing this package on npm does not imply endorsement of violating any
provider's terms.

---

## How it works

- **One browser window** — all providers share a single Chromium instance; each
  gets a separate tab. Chrome partitions cookies by origin, so sessions never mix.
- **Config-driven selectors** — every provider is the same generic driver; only
  the CSS selectors in `providers.yaml` differ. Fix a broken provider without
  touching code.
- **Persistent login** — log in once per service by hand; the session is saved
  and reused (including headless).
- **Conversation continuity** — each request continues the open tab's chat by
  default. Pass `newChat: true` to start fresh.
- **OpenAI-compatible** — a `/v1/chat/completions` endpoint with real SSE
  streaming, so OpenAI clients (Cursor, Open WebUI, Continue.dev, the `openai`
  SDK) work by just changing the base URL.
- **Model switching** — request `provider/model-name` to flip the model in the
  web UI before sending.
- **Optional API key** — set `WHISPER_API_KEY` to gate the API for LAN exposure.
- **Stealth** — `puppeteer-extra-plugin-stealth` to reduce bot-detection.

## Available providers & models

| Provider key | Site | Model | Login | Status |
|---|---|---|---|---|
| `qwen` | chat.qwen.ai | Qwen3.7-Plus | yes | Verified ✓ |
| `pi` | pi.ai | Pi (Inflection) | **no** | Verified ✓ |
| `deepseek` | chat.deepseek.com | DeepSeek V3 / R1 | yes | Template |
| `chatgpt` | chatgpt.com | GPT-4o (free tier) | yes | Cloudflare + login |
| `claude` | claude.ai | Claude Sonnet (free tier) | yes | Template |
| `glm` | chat.z.ai | GLM-4 | yes | Template |
| `kimi` | kimi.com | Kimi K2 (Moonshot) | yes | Partial |
| `minimax` | agent.minimax.io | MiniMax-M3 | yes | Partial |
| `grok` | grok.com | Grok 3 (xAI) | yes | Partial |
| `ernie` | yiyan.baidu.com | ERNIE (Baidu) | yes | Partial |

> **Verified** = driven end-to-end. **Partial** = input/login confirmed, response
> selector needs a `HEADLESS=false` check. **Template** = best-effort selectors.
> `pi` needs no login — the quickest way to try the tool. See
> [docs/providers.md](./docs/providers.md) for details and how to fix selectors.

## Install

```bash
npm install -g llm-whisper
npx playwright install chromium   # one-time browser download (~170 MB)
```

Or run without installing:

```bash
npx llm-whisper serve
```

## Quick start

`pi` needs no login, so you can try the tool immediately:

```bash
# 1. Start the API
whisper serve

# 2. Chat (native endpoint)
curl -s -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"provider":"pi","messages":[{"role":"user","content":"Hello!"}]}' \
  | jq .message.content
```

For login-gated providers like Qwen, run `whisper login qwen` first (with
`serve` stopped), then use `"provider":"qwen"`.

### OpenAI-compatible (with streaming)

```bash
curl -N http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"pi","stream":true,"messages":[{"role":"user","content":"Count to 5"}]}'
```

Or with the `openai` SDK — set `base_url="http://localhost:3000/v1"`.

See **[docs/quickstart.md](./docs/quickstart.md)** for a full walkthrough.

## Documentation

| Doc | Description |
|---|---|
| [docs/quickstart.md](./docs/quickstart.md) | Step-by-step first run |
| [docs/api.md](./docs/api.md) | HTTP API: `/chat`, OpenAI `/v1/chat/completions`, streaming, model selection, auth |
| [docs/providers.md](./docs/providers.md) | Provider status, login, selector & model-switching reference |
| [docs/configuration.md](./docs/configuration.md) | Env vars (`WHISPER_API_KEY`, CDP mode, …), concurrency |
| [wiki/pnpm.md](./wiki/pnpm.md) | pnpm usage and publishing notes |

## Caveats

- UI updates break selectors — run with `HEADLESS=false` to debug, fix in `providers.yaml`
- Aggressive use triggers rate limits or Cloudflare challenges
- Sessions expire — run `whisper login <name>` to refresh
- `whisper login` requires `whisper serve` to be stopped first (Chrome profile lock)
- This is for personal, low-volume use; respect each service's terms

## From source

```bash
git clone https://github.com/aananda-giri/llm-whisperer
cd llm-whisperer
pnpm install
pnpm exec playwright install chromium
pnpm run serve
```

## License

MIT — see [LICENSE](./LICENSE).
