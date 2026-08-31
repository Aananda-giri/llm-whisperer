# Configuration

## Environment variables

All variables can be set in a `.env` file in the current directory or exported
in the shell.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `9777` | Port the HTTP API listens on (see note) |
| `HEADLESS` | `false` | `true` to hide the browser window |
| `BROWSER` | `chromium` | Browser channel for profile mode: `chromium`, `chrome`, `msedge`, … |
| `WSPR_WARM` | `false` | `true` to pre-open browser tabs at startup; otherwise they launch lazily on the first browser-provider request |
| `WSPR_BROWSER_PROFILE` | `default` | Default browser profile for logins and requests that don't name one |
| `PROFILES_DIR` | `~/.config/llm-whisperer/profiles` | Where sessions and sentinel files are stored |
| `PROVIDERS_FILE` | *(see below)* | Path to a custom `providers.yaml` |
| `CDP_URL` | *(unset)* | Connect to an existing Chrome via CDP instead of launching one |
| `WSPR_API_KEY` | *(unset)* | If set, require this key on all endpoints except `/health` |
| `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `CEREBRAS_API_KEY`, `MISTRAL_API_KEY`, `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`), `DIGITALOCEAN_INFERENCE_KEY`, … | *(unset)* | Keys for [API-key providers](#provider-api-keys). The name is set per provider via `keyEnv` in `providers.yaml`; `baseUrl` may also reference `${VAR}` for things like an account id |

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

### WSPR_WARM

By default `wspr serve` does **not** open a browser at startup — it stays a
plain HTTP server until something actually needs a browser. The first request to
a browser provider (`qwen`, `chatgpt`, `claude`, …) launches the browser lazily;
API-key providers (`groq`, `gemini`, `openai`, …) never trigger one at all.

```bash
wspr serve                  # no browser until a browser provider is hit
WSPR_WARM=true wspr serve   # pre-open a tab per logged-in provider at startup
```

Set `WSPR_WARM=true` to restore eager "warming" — a tab is pre-opened for every
logged-in browser provider so the first request to each is slightly faster. This
is mainly useful when you primarily use the browser providers; for API-only use,
leave it off so the server runs headless.

### Browser profiles

A **browser profile** is a separate Chromium user-data directory: its own
cookies, logins, and local storage. The `default` profile is the one used
unless something says otherwise. Named profiles let you keep several accounts
per site — e.g. `email1` logged in to DeepSeek, ChatGPT, and Claude, and
`email2` logged in to a different set.

A profile is chosen by the first of these that applies:

1. The `profile` field on the API request (`/chat`, `/v1/chat/completions`, `/v1/messages`)
2. The provider's `profile:` field in `providers.yaml`
3. `WSPR_BROWSER_PROFILE` (default `default`)

```bash
# Log a provider in under a named profile (stop wspr serve first):
wspr login deepseek email1
wspr login deepseek email2

# Prefer a profile for every provider and login that doesn't name one:
WSPR_BROWSER_PROFILE=email1 wspr serve
```

```yaml
# providers.yaml — pin a provider to a profile:
qwen:
  # ...
  profile: "email1"
```

```bash
# API requests can override per call:
curl http://localhost:9777/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek","profile":"email2","messages":[{"role":"user","content":"Hi"}]}'
```

Profile names must be 1–64 characters of letters, numbers, dots, underscores,
or hyphens. Requests without a `profile` field keep working exactly as before.

`WSPR_WARM=true` warms only the `default` profile; named profiles launch
lazily on their first request. Named profiles are unavailable in **CDP mode** —
start a separate `wspr serve` per CDP browser instead.

### PROFILES_DIR

Holds the browser data and one sentinel per logged-in provider×profile:

```
$PROFILES_DIR/
  browser/                       ← Chromium user data for the "default" profile
  browser-profiles/              ← one Chromium user-data dir per named profile
    email1/
    email2/
  <provider>/
    .logged-in                   ← sentinel: default profile has a saved session
    email1.logged-in             ← sentinel: named profile has a saved session
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

Named browser profiles are not available in CDP mode — the running browser
already has one profile. To switch accounts, start a second Chrome with a
different `--user-data-dir` and point a second `wspr serve` at it.

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
`digitalocean`) call a real OpenAI-compatible HTTP API instead of driving a
browser. Each reads its key from the environment variable named by its `keyEnv`
field — keys are **never** stored in the YAML:

```bash
OPENAI_API_KEY=sk-...   GROQ_API_KEY=...   GEMINI_API_KEY=...   wspr serve
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
