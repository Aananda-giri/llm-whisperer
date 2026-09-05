# 7. Status of everything

> **Status:** Reference — the register. One row per item: state, one line of
> evidence, and a link to the chapter that owns it.

This page owns no argument. Every row points at the chapter where the reasoning
lives, and a row that grows a second paragraph has started drifting from the
page it points at — move the prose back.

**Snapshot:** 2026-08-01, git `7dfec34` (`Bump to 0.1.5`) plus the working tree.

## The working tree is ahead of the tag

Published 0.1.5 is **not** what this book mostly describes. Six tracked files
have uncommitted changes:

```console
$ git status --short
 M README.md
 M docs/api.md
 M docs/configuration.md
 M src/cli.ts
 M src/config.ts
 M src/server.ts
?? blog/
?? do-claude.sh
```
<sub>Plus `wiki/`, added by this book.</sub>

Two features live only there — `/v1/messages` and `WSPR_WARM` — and are marked
**working tree** in the rows below. Anyone installing from npm today does not
have them.

## API surface

| Item | State | Evidence | Owner |
|---|---|---|---|
| `POST /chat` | Implemented | Original endpoint; shipped since the first release | [§3.1](./3-api/3.1-three-dialects.md) |
| `POST /v1/chat/completions`, buffered | Implemented | `ad787f0` | [§3.1](./3-api/3.1-three-dialects.md) |
| `POST /v1/chat/completions`, SSE | Implemented | `05530e6` | [§3.3](./3-api/3.3-streaming.md) |
| `POST /v1/embeddings` | Implemented | `d5e39c3` | [§3.4](./3-api/3.4-embeddings-and-auth.md) |
| `POST /v1/messages` + Anthropic SSE | Implemented — **working tree** | In `src/server.ts`, not committed | [§3.1](./3-api/3.1-three-dialects.md) |
| `GET /v1/models`, `GET /health` | Implemented | Both scoped to the active profile; `/health` lists its providers | [§3.2](./3-api/3.2-choosing-a-model.md) |
| Profile-scoped routing (`/p/<profile>/v1/*`) | Implemented | One shared router mounted bare and under `/p/:profile`; `resolveModel` gates models | [§3.2](./3-api/3.2-choosing-a-model.md) |
| `GET /v1/models` lists models, not just providers | Implemented | Provider+model ids (`qwen/qwen3-235b`) plus a bare alias and a `wspr:` metadata field | [§3.2](./3-api/3.2-choosing-a-model.md) |
| `WSPR_API_KEY` auth gate | Implemented | `0d847ed`; accepts Bearer and `x-api-key` | [§3.4](./3-api/3.4-embeddings-and-auth.md) |
| Sampling params (`temperature`, `max_tokens`, …) | Implemented | Forwarded to API-key providers via `ChatOptions.params`; browser providers ignore them | [§4.1](./4-api-key-providers/4.1-one-class-many-services.md) |
| Tool calling | Implemented — both doors | Browser providers simulate it by prompting (`tool-protocol.ts`); API-key providers forward `tools` natively (`openai-tools.ts`) | [§3.1](./3-api/3.1-three-dialects.md) |
| Client-config emitter (`wspr config <client>`) | Implemented | `src/clients.ts` registry: opencode, openai, anthropic, continue. The opencode target emits `tool_call`, `limit`, per-kind `temperature`/`attachment`, timeouts sized from `timeoutMs`, and `small_model` pointed at a keyed API provider | [§3.2](./3-api/3.2-choosing-a-model.md) |
| Real token counts in `usage` | Partial — API-key providers | Upstream `usage` parsed from the stream and carried on the `finish` event; browser providers still report `0` | [§3.1](./3-api/3.1-three-dialects.md) |
| Accurate `finish_reason` / `stop_reason` | Partial | API-key providers report upstream's own value (`"length"` ⇒ `"max_tokens"`) via the `finish` stream event; browser providers still always say `"stop"` / `"end_turn"` | [§5.2](./5-browser-providers/5.2-knowing-when-it-stopped.md) |
| Model ids containing `/` | Implemented | `resolveModel` splits on the first `/`; slashed OpenRouter and `@cf/…` ids reach upstream | [§3.2](./3-api/3.2-choosing-a-model.md) |
| Streaming errors return 200 | Partial | Status is unrecoverable once headers flush, but the stream now closes properly: an error chunk, a `finish_reason` chunk, then `[DONE]` (Anthropic gets `message_stop`), so a client surfaces it instead of hanging | [§3.3](./3-api/3.3-streaming.md) |
| Bind to `127.0.0.1` by default | Implemented | `app.listen(port, config.host)`; `WSPR_HOST` overrides | [§3.4](./3-api/3.4-embeddings-and-auth.md) |
| Vision passthrough | Partial | Works on OpenAI endpoint + API providers; Anthropic blocks are dropped, browser providers stringify | [§3.1](./3-api/3.1-three-dialects.md) |

## API-key providers (Door A)

| Item | State | Evidence | Owner |
|---|---|---|---|
| Eight OpenAI-compatible providers | Implemented | Generated census: 8 of 18 entries carry an `api:` block | [§4.2](./4-api-key-providers/4.2-the-shipped-roster.md) |
| One class for all of them | Implemented | `ApiLLMProvider`, 151 lines, no per-provider branch | [§4.1](./4-api-key-providers/4.1-one-class-many-services.md) |
| `${VAR}` interpolation in `baseUrl` | Implemented | Built for `cloudflare`; one user | [§4.1](./4-api-key-providers/4.1-one-class-many-services.md) |
| Upstream error bodies surfaced | Implemented | Truncated to 500 chars and included in the thrown message | [§4.1](./4-api-key-providers/4.1-one-class-many-services.md) |
| `embedModel` set per provider | Partial | 2 of 8 (`openai`, `digitalocean`); the other 6 need an explicit model on `/v1/embeddings` | [§3.4](./3-api/3.4-embeddings-and-auth.md) |
| Startup key check covers `${VAR}` names | Planned | Only `keyEnv` is checked, so a missing `CLOUDFLARE_ACCOUNT_ID` passes startup | [§4.2](./4-api-key-providers/4.2-the-shipped-roster.md) |
| Request timeout / retry | Planned | Node `fetch` has no default timeout; nothing retries | [§4.1](./4-api-key-providers/4.1-one-class-many-services.md) |
| Google AI Studio (native) provider | Planned | Open item in `todo`; `gemini` currently goes through the OpenAI compat layer | [§4.1](./4-api-key-providers/4.1-one-class-many-services.md) |
| Ollama / local models | Planned | Open item in `todo`; Ollama is OpenAI-compatible, so it is a YAML entry | [§4.1](./4-api-key-providers/4.1-one-class-many-services.md) |

## Browser providers (Door B)

| Item | State | Evidence | Owner |
|---|---|---|---|
| Config-driven generic driver | Implemented | `WebLLMProvider` drives all 10; `OVERRIDES` still empty | [§5.1](./5-browser-providers/5.1-the-generic-driver.md) |
| Ten providers declared | Implemented | Generated census: 10 of 18 entries have no `api:` block | [§5.5](./5-browser-providers/5.5-what-is-verified.md) |
| Providers **live-verified** | Partial | **2 of 10** — `pi` (`5e917fd`) and `qwen` (`6e57651`, `e86a86a`) | [§5.5](./5-browser-providers/5.5-what-is-verified.md) |
| Providers recon'd but never run | Partial | 4 — `kimi`, `minimax`, `grok`, `ernie`; all four name `responseSelector` as unverified | [§5.5](./5-browser-providers/5.5-what-is-verified.md) |
| Providers from template only | Partial | 4 — `chatgpt`, `claude`, `deepseek`, `glm`; no verification note in the YAML | [§5.5](./5-browser-providers/5.5-what-is-verified.md) |
| Saved login sessions on this machine | Partial | **1** — `qwen`, `2026-06-21T20:59:59.654Z`; 4 abandoned profile dirs, 4 providers never attempted | [§5.5](./5-browser-providers/5.5-what-is-verified.md) |
| `qwen` selectors current | Fixed — 2026-09-05 | A site redesign had moved every selector (`responseSelector`, `stopSelector`, Enter no longer submits); re-verified live and updated to `.custom-qwen-markdown` / `button[aria-label='Stop']` / `sendSelector` | [§5.5](./5-browser-providers/5.5-what-is-verified.md) |
| Simulated `<tool_call>` marker collides with native tool-syntax models | Planned — defect, verified on `qwen` | Some models (Qwen among them) were trained with `<tool_call>` as their own function-calling tag; the chat website renders it as a widget instead of visible text, so the call never reaches the DOM as scrapeable text and the turn silently degrades to prose | [§5.1](./5-browser-providers/5.1-driving-a-chat-ui.md) |
| Streaming by DOM polling | Implemented | 300 ms interval, yields the new suffix of `innerText()` | [§3.3](./3-api/3.3-streaming.md) |
| Completion detection | Implemented | `stopSelector` visibility plus `stabilizeMs` of unchanged text | [§5.2](./5-browser-providers/5.2-knowing-when-it-stopped.md) |
| Truncation at `timeoutMs` is silent | Planned — defect | Generator returns without throwing; response reports `finish_reason: "stop"` | [§5.2](./5-browser-providers/5.2-knowing-when-it-stopped.md) |
| Non-incremental re-render drops the tail | Partial | Still true of `streamAnswer`, but a turn that declares tools now bypasses it: `bufferToolTurns` reads the settled answer once, so a JSON tool call cannot be truncated by a re-render | [§3.3](./3-api/3.3-streaming.md) |
| Model-switch mechanism | Implemented | `77afb79`; `switchModel` opens the picker and clicks the option | [§5.6](./5-browser-providers/5.6-model-switching.md) |
| Model-switch selectors configured | Partial | **2 of 26** declared model names have one, both on the unverified `minimax` | [§5.6](./5-browser-providers/5.6-model-switching.md) |
| Fail loudly on an unconfigured model | Planned | Today it returns silently and the response echoes a model that was never selected | [§5.6](./5-browser-providers/5.6-model-switching.md) |
| One shared default profile + named profiles | Implemented | `profilesDir/browser/` and `browser-profiles/<profile>/`; Chrome partitions cookies by origin | [§5.3](./5-browser-providers/5.3-sessions-and-login.md) |
| `wspr login` flow | Implemented | Non-headless, blocks on Enter, writes a `.logged-in` sentinel | [§5.3](./5-browser-providers/5.3-sessions-and-login.md) |
| Per-request and per-provider profile selection | Implemented | `profile` request field → `providers.yaml` `profile:` → `WSPR_BROWSER_PROFILE` → `default` | [§5.3](./5-browser-providers/5.3-sessions-and-login.md) |
| Login is verified before the sentinel is written | Implemented | `login` checks `isLoggedIn` before writing the sentinel; exits non-zero otherwise | [§5.3](./5-browser-providers/5.3-sessions-and-login.md) |
| Encrypted credential vault (per profile × provider) | Implemented | `$PROFILES_DIR/credentials.enc`, AES-256-GCM + scrypt, mode 0600; redacted view only for the server/UI | [§5.3](./5-browser-providers/5.3-sessions-and-login.md) |
| Declarative `login:` rules in `providers.yaml` | Implemented | `method: password\|manual`, selectors, no per-platform code; configured for `qwen` + `claude` | [§2.2](./2-architecture/2.2-configuration-is-the-product.md) |
| Autonomous re-login on a lapsed session | Implemented | `attemptLogin` runs once per process (`WSPR_AUTO_LOGIN`); a failed credential is never retried | [§5.3](./5-browser-providers/5.3-sessions-and-login.md) |
| Session-health checks | Implemented | `wspr status` (server stopped) and the `/ui` route, cached to `$PROFILES_DIR/health.json` | [§5.3](./5-browser-providers/5.3-sessions-and-login.md) |
| Health reports in/out/**unknown** | Implemented | `confirmSession` requires the chat input, not just a missing logged-out marker, so unverified selectors do not read as green | [§5.5](./5-browser-providers/5.5-what-is-verified.md) |
| Credentials CRUD dashboard (`/ui`) | Implemented | Loopback bind + `WSPR_UI_TOKEN` + DNS-rebinding origin check; passwords write-only over HTTP | [§5.3](./5-browser-providers/5.3-sessions-and-login.md) |
| CDP mode | Implemented | `CDP_URL` attaches to a running Chrome and reuses `contexts()[0]` | [§5.3](./5-browser-providers/5.3-sessions-and-login.md) |
| `WSPR_BROWSER_CHANNEL` channel selector (legacy `BROWSER` fallback) | Implemented | `chrome` is required for Google OAuth logins; non-channel `BROWSER` values are ignored | [§5.3](./5-browser-providers/5.3-sessions-and-login.md) |
| Session pool, ≤2 pages per provider | Implemented | Default 2 (`WSPR_MAX_PAGES`), FIFO waiter queue, one relaunch retry | [§5.4](./5-browser-providers/5.4-the-session-pool.md) |
| Conversation affinity (per-tab isolation) | Implemented | A conversation key over the client-authored messages pins a conversation to a tab; a mismatch replays the transcript into a fresh chat. Makes a stateless agent client safe against a stateful tab | [§5.4](./5-browser-providers/5.4-the-session-pool.md) |
| Request abort propagation | Implemented | `req.on("close")` aborts the turn, clicks the chat UI's stop button, and marks the tab dirty so the next turn replays | [§5.4](./5-browser-providers/5.4-the-session-pool.md) |
| Prompt budget for browser providers | Implemented | `maxPromptChars` / `toolResultMaxChars`; over budget is a 413 naming the provider, not a silently truncated chat message | [§5.1](./5-browser-providers/5.1-driving-a-chat-ui.md) |
| `maxPerProvider` configurable | Implemented | `WSPR_MAX_PAGES` (default 2); with affinity it also sets how many conversations stay hot | [§5.4](./5-browser-providers/5.4-the-session-pool.md) |
| Idle page reaping | Planned | Pages sit in the idle map indefinitely; nothing closes them | [§5.4](./5-browser-providers/5.4-the-session-pool.md) |
| Waiter queue timeout / cancellation | Partial | A disconnected client now aborts its in-flight turn (`req.on("close")` → `ChatOptions.signal`), releasing the page; a caller already *parked* in the queue is still not cancellable | [§5.4](./5-browser-providers/5.4-the-session-pool.md) |
| Subclass escape hatch | Implemented — unused | `OVERRIDES` is an empty map with a commented example | [§2.3](./2-architecture/2.3-the-provider-contract.md) |
| Thinking / reasoning tokens | Planned | Open item in `todo`; no provider surfaces them today | [§3.3](./3-api/3.3-streaming.md) |
| Resume a conversation across providers | Planned | Open item in `todo`; tab state is per provider and unreadable | [§3.2](./3-api/3.2-choosing-a-model.md) |

## Configuration and operations

| Item | State | Evidence | Owner |
|---|---|---|---|
| `providers.yaml` drives everything | Implemented | 18 providers, 0 provider-specific code paths | [§2.2](./2-architecture/2.2-configuration-is-the-product.md) |
| `profiles:` API scope block | Implemented | Declared provider/model set, validated at load; undeclared profiles expose everything | [§2.2](./2-architecture/2.2-configuration-is-the-product.md) |
| Per-shape validation at load | Implemented | `api:` requires `baseUrl`/`model`/`keyEnv`; browser requires `url`/`inputSelector`/`responseSelector` | [§2.2](./2-architecture/2.2-configuration-is-the-product.md) |
| `PROVIDERS_FILE` and CWD override | Implemented | Four candidates, first match wins | [§2.2](./2-architecture/2.2-configuration-is-the-product.md) |
| A custom `providers.yaml` merges with the bundled one | Planned | It replaces it whole, which silently drops the other 17 providers | [§2.2](./2-architecture/2.2-configuration-is-the-product.md) |
| Lazy browser launch (`WSPR_WARM`) | Implemented — **working tree** | Default flipped to no browser at startup; `todo` item now true | [§6.2](./6-operating/6.2-startup-and-environment.md) |
| Hot reload of `providers.yaml` | Planned | The provider map is built once at startup; edits need a restart | [§2.1](./2-architecture/2.1-path-of-a-request.md) |
| Timeout screenshots to `/tmp` | Implemented | Path and URL named in the thrown error message | [§6.3](./6-operating/6.3-when-a-provider-breaks.md) |

## Project

| Item | State | Evidence | Owner |
|---|---|---|---|
| Published to npm | Implemented | `llm-whisperer@0.1.5`, `npm view` agrees with `package.json` | [§6.4](./6-operating/6.4-pnpm-and-publishing.md) |
| TypeScript strict, compiles clean | Implemented | `npx tsc --noEmit` exits 0, 2026-08-01 | [§1.1](./1-idea/1.1-what-it-is.md) |
| Automated tests | Implemented — `node:test` | `"test": "tsx --test test/**/*.test.ts"`; 33 tests across `tool-protocol` and message-normalization | [§1.1](./1-idea/1.1-what-it-is.md) |
| Wiki link checker | Implemented | `node wiki/check.mjs`, 0 dependencies | [§8.1](./8-about/8.1-how-this-book-is-written.md) |
| Terms-of-service disclosure | Implemented | README, `docs/overview.md` and [§1.3](./1-idea/1.3-terms-of-service.md) all state it | [§1.3](./1-idea/1.3-terms-of-service.md) |

---

[← Previous: pnpm and publishing](./6-operating/6.4-pnpm-and-publishing.md) · [Contents](./README.md) · [Next: How this book is written →](./8-about/8.1-how-this-book-is-written.md)
