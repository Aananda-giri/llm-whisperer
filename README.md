# LLM-Whisper

Whisper to the **free web chat UIs** of Qwen, ChatGPT, Claude, DeepSeek and GLM,
and talk to all of them through **one local HTTP API** — no paid API keys.

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
| Alibaba / Qwen | Prohibits bots and automated access |
| DeepSeek | Prohibits automated access |
| Zhipu / GLM | Prohibits automated access |

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
- **Stealth** — `puppeteer-extra-plugin-stealth` to reduce bot-detection.

## Available providers & models

| Provider key | Site | Model | Notes |
|---|---|---|---|
| `qwen` | chat.qwen.ai | Qwen3.7-Plus | Verified working ✓ |
| `deepseek` | chat.deepseek.com | DeepSeek V3 / R1 | Login required |
| `chatgpt` | chatgpt.com | GPT-4o (free tier) | Cloudflare + login |
| `claude` | claude.ai | Claude Sonnet (free tier) | Login required |
| `glm` | chat.z.ai | GLM-4 | Login required |

> The model served is whatever the site defaults to for a free account. Change
> it in the web UI after logging in — the setting sticks in your saved session.

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

```bash
# 1. Log in to a provider (stop serve first if it's running)
whisper login qwen

# 2. Start the API
whisper serve

# 3. Chat
curl -s -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"provider":"qwen","messages":[{"role":"user","content":"Hello!"}]}' \
  | jq .message.content
```

See **[docs/quickstart.md](./docs/quickstart.md)** for a full walkthrough.

## Documentation

| Doc | Description |
|---|---|
| [docs/quickstart.md](./docs/quickstart.md) | Step-by-step first run |
| [docs/api.md](./docs/api.md) | HTTP API reference (`POST /chat`, `GET /health`) |
| [docs/providers.md](./docs/providers.md) | Provider status, login, selector reference, adding new providers |
| [docs/configuration.md](./docs/configuration.md) | Env vars, CDP mode, concurrency |

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
