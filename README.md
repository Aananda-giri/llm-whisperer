# 🤫 llm-whisperer

**One simple local API for many AI chat models.**

Use your own API keys (several providers are **free**), or talk to the free web
chat sites (ChatGPT, Claude, Qwen, …) through a real browser — no paid key
needed. Any OpenAI-compatible app or SDK works: just point it at
`http://localhost:9777`.

```
your app ──▶ http://localhost:9777 ──▶ LLM-Whisperer ──▶ any provider you pick
```

---

## What can it do?

- **One API for lots of models.** OpenAI-style `/v1/chat/completions` (with live
  streaming) plus a simple `/chat` endpoint.
- **Two ways to connect:**
  1. **API key** — fast and easy. Many providers have a free tier.
  2. **Browser** — drives the free chat websites for you. No API key required.
- **Pick the model in your request** — `"model": "groq"`, or a specific one with
  `"model": "groq/llama-3.1-8b-instant"`.
- **Use it from anything** — curl, the `openai` SDK, Cursor, Open WebUI, etc.

---

## Quick start (about 1 minute, with a free key)

**1. Install it**

```bash
npm install -g llm-whisperer
```

**2. Get a free API key and save it**

Grab a free key from [Groq](https://console.groq.com/keys) (no credit card),
then put it in a file named `.env` in your current folder:

```bash
echo "GROQ_API_KEY=your-key-here" >> .env
```

**3. Start the server**

```bash
wspr serve
```

**4. Send your first message**

```bash
curl http://localhost:9777/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"groq","messages":[{"role":"user","content":"Hello!"}]}'
```

That's it! 🎉 Swap `groq` for any provider in the list below.

> Want a step-by-step walkthrough (including the browser way)? See the
> [Quickstart guide](./docs/quickstart.md).

---

## Supported providers

### A. Connect with an API key (recommended — fast and reliable)

Set the env var, then use the **provider name as the model**.

| Provider | Use as model | Free? | Env var |
|---|---|---|---|
| Google Gemini | `gemini` | ✅ free tier | `GEMINI_API_KEY` |
| Groq | `groq` | ✅ free, no card | `GROQ_API_KEY` |
| OpenRouter | `openrouter` | ✅ free models | `OPENROUTER_API_KEY` |
| Cerebras | `cerebras` | ✅ free tier | `CEREBRAS_API_KEY` |
| Mistral | `mistral` | ✅ free, no card | `MISTRAL_API_KEY` |
| Cloudflare Workers AI | `cloudflare` | ✅ free allowance | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` |
| OpenAI | `openai` | 💲 paid | `OPENAI_API_KEY` |
| DeepSeek | `deepseek-api` | 💲 paid | `DEEPSEEK_API_KEY` |

You can also add any other OpenAI-compatible service yourself — see
[providers.md](./docs/providers.md#api-key-providers).

### B. Connect through a browser (no API key)

These drive the real, free chat websites. You log in once by hand and the
session is saved. First do `npx playwright install chromium`, then
`wspr login <name>`.

On Linux/WSL, Chromium also needs system libraries. If `wspr login <name>` fails
with a missing shared library such as `libnspr4.so`, install Playwright's Linux
dependencies:

```bash
sudo npx playwright install-deps chromium
```

For Ubuntu 24.04/WSL, the common manual fix is:

```bash
sudo apt update
sudo apt install -y libnspr4 libnss3 libatk-bridge2.0-0 libgtk-3-0 libxss1 libasound2t64
```

| Provider | Use as model | Login needed? |
|---|---|---|
| Pi | `pi` | ❌ no login — quickest to try! |
| Qwen | `qwen` | ✅ yes |
| ChatGPT | `chatgpt` | ✅ yes |
| Claude | `claude` | ✅ yes |
| DeepSeek | `deepseek` | ✅ yes |
| GLM | `glm` | ✅ yes |
| Kimi | `kimi` | ✅ yes |
| MiniMax | `minimax` | ✅ yes |
| Grok | `grok` | ✅ yes |
| ERNIE | `ernie` | ✅ yes |

> ⚠️ The browser way automates websites meant for people, which most providers'
> Terms of Service don't allow. Use it for personal experimenting only, at your
> own risk. See the Terms-of-Service notes in the [overview](./docs/overview.md).

---

## How to get API keys

Create a key on the provider's website, then add it to your `.env` file. Most
sites show the key **only once**, so copy it right away.

| Provider | Where to get a key |
|---|---|
| Gemini | <https://aistudio.google.com/apikey> |
| Groq | <https://console.groq.com/keys> |
| OpenRouter | <https://openrouter.ai/keys> |
| Cerebras | <https://cloud.cerebras.ai> → **API Keys** |
| Mistral | <https://admin.mistral.ai/organization/api-keys> |
| Cloudflare | <https://dash.cloudflare.com> → **AI → AI Gateway → Create Authentication Token** (your account id is shown in the sample `curl` on that page) |
| OpenAI | <https://platform.openai.com/api-keys> |
| DeepSeek | <https://platform.deepseek.com/api_keys> |

Your `.env` file can hold as many keys as you like:

```bash
GROQ_API_KEY=...
GEMINI_API_KEY=...
OPENAI_API_KEY=...
```

Full details (and the exact Cloudflare steps) are in
[providers.md](./docs/providers.md#api-key-providers).

---

## Using the API

**OpenAI-compatible endpoint** (recommended). Works with the `openai` SDK and
most AI tools — just change the base URL to `http://localhost:9777/v1`.

```bash
# streaming response
curl -N http://localhost:9777/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"groq","stream":true,"messages":[{"role":"user","content":"Count to 5"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:9777/v1", api_key="not-needed")
resp = client.chat.completions.create(
    model="groq",                       # or "groq/llama-3.1-8b-instant"
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)
```

**Pick a specific model** with `provider/model`, e.g. `"model": "openai/gpt-4o"`.

**Protect the API (optional)** — set `WSPR_API_KEY=your-secret` and callers must
send it as `Authorization: Bearer your-secret`. Handy if you expose it on a
network.

Full request/response reference: [api.md](./docs/api.md).

---

## Documentation

| Guide | What's inside |
|---|---|
| [Quickstart](./docs/quickstart.md) | Step-by-step first run (both ways) |
| [API reference](./docs/api.md) | Endpoints, streaming, model selection, auth |
| [Providers](./docs/providers.md) | All providers, getting keys, browser login |
| [Configuration](./docs/configuration.md) | Env vars, ports, options |
| [Overview / full reference](./docs/overview.md) | How it works, design, caveats, Terms-of-Service notes |

---

## Run from source

```bash
git clone https://github.com/aananda-giri/llm-whisperer
cd llm-whisperer
pnpm install
pnpm run serve
```

## License

MIT — see [LICENSE](./LICENSE).
