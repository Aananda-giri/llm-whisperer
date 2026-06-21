# 🤫 llm-whisperer — full reference

> New here? Start with the [project README](../README.md) for a friendly intro.
> This page is the detailed reference (architecture, every provider, caveats).

Whisper to the **free web chat UIs** of Qwen, ChatGPT, Claude, DeepSeek, GLM,
Kimi, MiniMax, Grok, Pi and ERNIE — and talk to all of them through **one local
HTTP API** (native or OpenAI-compatible, with streaming) — no paid API keys.

```
your app ──HTTP──▶ LLM-Whisperer ──▶ browser tabs ──▶ chat.qwen.ai / claude.ai / ...
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
- **Real API keys too** — already paying for OpenAI, DeepSeek, etc.? Add an
  API-key provider and it calls the official OpenAI-compatible HTTP API instead
  of a browser — same endpoints, no scraping. See [API-key providers](#api-key-providers).
- **Optional API key** — set `WSPR_API_KEY` to gate the API for LAN exposure.
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
> [providers.md](./providers.md) for details and how to fix selectors.

### API-key providers

If you have a real key, you can skip the browser entirely. These call an
OpenAI-compatible HTTP API and ship in `providers.yaml`:

| Provider key | Endpoint | Default model | Key env var |
|---|---|---|---|
| `openai` | api.openai.com | `gpt-4o-mini` | `OPENAI_API_KEY` |
| `deepseek-api` | api.deepseek.com | `deepseek-chat` | `DEEPSEEK_API_KEY` |
| `gemini` | generativelanguage.googleapis.com | `gemini-2.5-flash` | `GEMINI_API_KEY` |
| `groq` | api.groq.com | `llama-3.3-70b-versatile` | `GROQ_API_KEY` |
| `openrouter` | openrouter.ai | `openai/gpt-oss-120b:free` | `OPENROUTER_API_KEY` |
| `cerebras` | api.cerebras.ai | `gpt-oss-120b` | `CEREBRAS_API_KEY` |
| `mistral` | api.mistral.ai | `mistral-small-latest` | `MISTRAL_API_KEY` |
| `cloudflare` | api.cloudflare.com | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` |

> `gemini`, `groq`, `openrouter`, `cerebras`, `mistral`, and `cloudflare` all
> have **free tiers** (OpenRouter's `:free` models need no credits at all);
> `openai` and `deepseek-api` are paid. Free quotas, models, and rate limits
> change often — check each provider's docs for current limits.
>
> **Where to get each key** (and the exact Cloudflare steps) is in
> [providers.md](./providers.md#api-key-providers). `cloudflare` also
> needs your account id in `CLOUDFLARE_ACCOUNT_ID` (it goes into the request URL).

Set the matching env var (e.g. in `.env`), then use the provider like any other —
`{"model":"openai"}` or `{"model":"deepseek-api/deepseek-reasoner"}` to pick a
model. Add any other OpenAI-compatible service (Groq, Together, …) by copying the
`api:` block. Keys are read from the environment, never stored in the YAML. See
[providers.md](./providers.md#api-key-providers).

## Install

```bash
npm install -g llm-whisperer
npx playwright install chromium   # one-time browser download (~170 MB)
```

Or run without installing:

```bash
npx llm-whisperer serve
```

## Quick start

`pi` needs no login, so you can try the tool immediately:

```bash
# 1. Start the API
wspr serve

# 2. Chat (native endpoint)
curl -s -X POST http://localhost:9777/chat \
  -H "Content-Type: application/json" \
  -d '{"provider":"pi","messages":[{"role":"user","content":"Hello!"}]}' \
  | jq .message.content
```

For login-gated providers like Qwen, run `wspr login qwen` first (with
`serve` stopped), then use `"provider":"qwen"`.

### OpenAI-compatible (with streaming)

```bash
curl -N http://localhost:9777/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"pi","stream":true,"messages":[{"role":"user","content":"Count to 5"}]}'
```

Or with the `openai` SDK — set `base_url="http://localhost:9777/v1"`.

See **[quickstart.md](./quickstart.md)** for a full walkthrough.

## Documentation

| Doc | Description |
|---|---|
| [quickstart.md](./quickstart.md) | Step-by-step first run |
| [api.md](./api.md) | HTTP API: `/chat`, OpenAI `/v1/chat/completions`, streaming, model selection, auth |
| [providers.md](./providers.md) | Provider status, login, selector & model-switching reference |
| [configuration.md](./configuration.md) | Env vars (`WSPR_API_KEY`, CDP mode, …), concurrency |
| [pnpm.md](../wiki/pnpm.md) | pnpm usage and publishing notes |

## Caveats

- UI updates break selectors — run with `HEADLESS=false` to debug, fix in `providers.yaml`
- Aggressive use triggers rate limits or Cloudflare challenges
- Sessions expire — run `wspr login <name>` to refresh
- `wspr login` requires `wspr serve` to be stopped first (Chrome profile lock)
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

MIT — see [LICENSE](../LICENSE).
