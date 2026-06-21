# Configuration

## Environment variables

All variables can be set in a `.env` file in the current directory or exported
in the shell.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `9777` | Port the HTTP API listens on (see note) |
| `HEADLESS` | `false` | `true` to hide the browser window |
| `BROWSER` | `chromium` | Browser channel for profile mode: `chromium`, `chrome`, `msedge`, … |
| `PROFILES_DIR` | `~/.config/llm-whisperer/profiles` | Where sessions and sentinel files are stored |
| `PROVIDERS_FILE` | *(see below)* | Path to a custom `providers.yaml` |
| `CDP_URL` | *(unset)* | Connect to an existing Chrome via CDP instead of launching one |
| `WSPR_API_KEY` | *(unset)* | If set, require this key on all endpoints except `/health` |
| `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `CEREBRAS_API_KEY`, `MISTRAL_API_KEY`, `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`), … | *(unset)* | Keys for [API-key providers](#provider-api-keys). The name is set per provider via `keyEnv` in `providers.yaml`; `baseUrl` may also reference `${VAR}` for things like an account id |

### PORT

The default is `9777`, which spells **WSPR** on a phone keypad (9-7-7-7) — a
nod to the project name (and to the real-world weak-signal radio protocol of the
same name, pronounced "whisper"). It avoids the crowded dev-port range
(3000/5000/8000/8080) so it won't collide with a React app or similar. Override
it with `PORT` if 9777 is taken on your machine.

### HEADLESS

```bash
HEADLESS=true wspr serve    # no visible window, runs in background
HEADLESS=false wspr serve   # see the browser (good for debugging)
```

### BROWSER

Selects which browser **profile mode** launches:

| Value | Browser |
|---|---|
| `chromium` *(default)* | Playwright's bundled Chromium — zero install, works out of the box |
| `chrome` | Your locally-installed Google Chrome |
| `msedge` | Your locally-installed Microsoft Edge |

```bash
BROWSER=chrome wspr serve
```

The default is `chromium` so the npm package runs with no extra setup. Switch to
`BROWSER=chrome` if a provider's login (notably **Google sign-in**) rejects the
bundled Chromium with *"This browser or app may not be secure"* — a real Chrome
build passes that check. The named channel must already be installed on your
machine.

This setting only applies to profile mode. In **CDP mode** (`CDP_URL` set) the
browser is whichever one you started yourself, so `BROWSER` is ignored.

### PROFILES_DIR

Holds two things:

```
$PROFILES_DIR/
  browser/               ← Chromium user data (cookies, storage, etc.)
  <provider>/
    .logged-in           ← sentinel: this provider has a saved session
```

Override it if you want sessions stored elsewhere:

```bash
PROFILES_DIR=/opt/llm-whisperer/sessions wspr serve
```

### PROVIDERS_FILE

Point to a custom `providers.yaml` anywhere on disk:

```bash
PROVIDERS_FILE=~/my-providers.yaml wspr serve
```

Without this, LLM-Whisperer looks for `providers.yaml` in the current directory
first, then falls back to the bundled defaults.

### CDP_URL

Attach to an already-running Chrome instead of launching Playwright's bundled
Chromium. Useful if you want to reuse your existing browser profile or keep
Chrome open permanently.

```bash
# Start Chrome with remote debugging
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=$HOME/.config/llm-whisperer-chrome

# Tell LLM-Whisperer to attach
CDP_URL=http://localhost:9222 wspr serve
```

A helper script is included in the repo: `pnpm run chrome`.

### WSPR_API_KEY

By default the API is open — anyone who can reach the port can use it. That's
fine for `localhost`, but if you bind to a LAN address or expose it, set a key:

```bash
WSPR_API_KEY=my-secret-key wspr serve
```

When set, every endpoint **except `GET /health`** requires the key, supplied via
either header:

```bash
curl http://localhost:9777/v1/chat/completions \
  -H "Authorization: Bearer my-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen","messages":[{"role":"user","content":"Hi"}]}'

# or:
curl http://localhost:9777/chat \
  -H "x-api-key: my-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"provider":"qwen","messages":[{"role":"user","content":"Hi"}]}'
```

A missing or wrong key returns `401`. When the variable is unset or empty,
authentication is disabled (no-op).

### Provider API keys

Providers that declare an `api:` block in `providers.yaml` (e.g. `openai`,
`deepseek-api`) call a real OpenAI-compatible HTTP API instead of driving a
browser. Each reads its key from the environment variable named by its `keyEnv`
field — keys are **never** stored in the YAML:

```bash
OPENAI_API_KEY=sk-...   DEEPSEEK_API_KEY=sk-...   GEMINI_API_KEY=...   wspr serve
```

If the key is unset, requests to that provider return `401` with a message
naming the missing variable. Browser providers are unaffected. See
[providers.md](./providers.md#api-key-providers) for the `api:` block reference.

## providers.yaml

See [providers.md](./providers.md) for the full field reference and tips on
writing selectors.

## Concurrency

By default, at most **2 pages per provider** are open simultaneously
(`maxPerProvider = 2` in `SessionPool`). Requests beyond that wait in a FIFO
queue until a page is free.

To change the limit, edit `src/session-pool.ts` and rebuild, or open an issue
requesting a config option.
