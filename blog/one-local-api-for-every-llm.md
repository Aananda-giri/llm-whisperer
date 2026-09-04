---
title: "One Local API for Every LLM"
date: 2026-06-22
tags: [llm, ai, openai-api, browser-automation, developer-tools]
---

# 🤫 One Local API for Every LLM

> 📦 npm: [llm-whisperer](https://www.npmjs.com/package/llm-whisperer) ·
> 🐙 GitHub: [aananda-giri/llm-whisperer](https://github.com/aananda-giri/llm-whisperer)

Every AI provider speaks a slightly different dialect. You wire up Groq, then
your code wants OpenAI's SDK, then a teammate swears by Gemini — and half your
project turns into glue code for talking to chat models.

**[llm-whisperer](https://github.com/aananda-giri/llm-whisperer)** collapses all
of that into one thing: a local, OpenAI-compatible API. Point any app at
`http://localhost:9777`, name a provider as the model, done.

```
your app ──▶ http://localhost:9777 ──▶ llm-whisperer ──▶ any provider you pick
```

---

## Two ways to connect

1. **API key** — fast and reliable. Set an env var, use the provider name as the
   model. Many have a free tier (Groq, Gemini, Mistral, OpenRouter, Cerebras,
   Cloudflare) — answers back, no credit card.
2. **Browser** — for sites that don't hand out free keys, it drives the *real*
   chat website for you. Log in once by hand; the session is saved. Now ChatGPT,
   Claude, Qwen, DeepSeek, Grok and friends share the same endpoint as everything
   else — no key required.

> ⚠️ The browser route automates websites built for humans, which most providers'
> Terms of Service don't allow. Personal experimentation only, at your own risk.

---

## It looks like OpenAI — because it is

Anything that already speaks the OpenAI API just works: curl, the `openai` SDK,
Cursor, Open WebUI. Change the base URL and go.

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:9777/v1", api_key="not-needed")
resp = client.chat.completions.create(
    model="groq",                       # or "qwen", or "openai/gpt-4o"
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)
```

Want a specific model? Use `provider/model`, e.g. `"openai/gpt-4o"` or
`"groq/llama-3.1-8b-instant"`. Streaming works too.

---

## A minute to first reply

**1. Install it**

```bash
npm install -g llm-whisperer
```

**2. Add a free key** (Groq — no card)

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

That's it. 🎉 Swap `groq` for any provider you've configured.

---

## Why port 9777?

A small detail I enjoy: the default port spells **WSPR** on a phone keypad — a
nod to the name (and to the weak-signal radio protocol of the same name,
literally pronounced *"whisper"*). It also dodges the crowded 3000/5000/8000
range, so it won't fight your React dev server. Override it with `PORT`.

---

## The honest caveats

| Caveat | What it means |
|---|---|
| Browser mode is fragile | It's as stable as the sites it scrapes — selectors break, logins expire. |
| Google sign-in is picky | It may reject the bundled Chromium. Set `WSPR_BROWSER_CHANNEL=chrome` to drive your real Chrome. |
| API-key mode is the safe bet | Reach for the browser only when a model has no free key. |

---

**One endpoint, many models, your keys or your browser.**

- 📦 npm: [llm-whisperer](https://www.npmjs.com/package/llm-whisperer)
- 🐙 GitHub: [aananda-giri/llm-whisperer](https://github.com/aananda-giri/llm-whisperer)

MIT licensed.
