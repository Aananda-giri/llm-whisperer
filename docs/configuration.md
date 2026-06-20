# Configuration

## Environment variables

All variables can be set in a `.env` file in the current directory or exported
in the shell.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the HTTP API listens on |
| `HEADLESS` | `false` | `true` to hide the browser window |
| `PROFILES_DIR` | `~/.config/llm-whisper/profiles` | Where sessions and sentinel files are stored |
| `PROVIDERS_FILE` | *(see below)* | Path to a custom `providers.yaml` |
| `CDP_URL` | *(unset)* | Connect to an existing Chrome via CDP instead of launching one |
| `WHISPER_API_KEY` | *(unset)* | If set, require this key on all endpoints except `/health` |

### HEADLESS

```bash
HEADLESS=true whisper serve    # no visible window, runs in background
HEADLESS=false whisper serve   # see the browser (good for debugging)
```

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
PROFILES_DIR=/opt/llm-whisper/sessions whisper serve
```

### PROVIDERS_FILE

Point to a custom `providers.yaml` anywhere on disk:

```bash
PROVIDERS_FILE=~/my-providers.yaml whisper serve
```

Without this, LLM-Whisper looks for `providers.yaml` in the current directory
first, then falls back to the bundled defaults.

### CDP_URL

Attach to an already-running Chrome instead of launching Playwright's bundled
Chromium. Useful if you want to reuse your existing browser profile or keep
Chrome open permanently.

```bash
# Start Chrome with remote debugging
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=$HOME/.config/llm-whisper-chrome

# Tell LLM-Whisper to attach
CDP_URL=http://localhost:9222 whisper serve
```

A helper script is included in the repo: `pnpm run chrome`.

### WHISPER_API_KEY

By default the API is open — anyone who can reach the port can use it. That's
fine for `localhost`, but if you bind to a LAN address or expose it, set a key:

```bash
WHISPER_API_KEY=my-secret-key whisper serve
```

When set, every endpoint **except `GET /health`** requires the key, supplied via
either header:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer my-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen","messages":[{"role":"user","content":"Hi"}]}'

# or:
curl http://localhost:3000/chat \
  -H "x-api-key: my-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"provider":"qwen","messages":[{"role":"user","content":"Hi"}]}'
```

A missing or wrong key returns `401`. When the variable is unset or empty,
authentication is disabled (no-op).

## providers.yaml

See [providers.md](./providers.md) for the full field reference and tips on
writing selectors.

## Concurrency

By default, at most **2 pages per provider** are open simultaneously
(`maxPerProvider = 2` in `SessionPool`). Requests beyond that wait in a FIFO
queue until a page is free.

To change the limit, edit `src/session-pool.ts` and rebuild, or open an issue
requesting a config option.
