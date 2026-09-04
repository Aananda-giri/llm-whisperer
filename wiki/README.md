# 🤫 The LLM-Whisperer Book

> **Status:** Reference — this is the contents page, not a claim about any code.

This is the explanatory book for **llm-whisperer**: what it is, how each piece
works, why it was built the way it was, and — page by page — how much of it is
actually finished.

It is not the task-oriented reference. That lives in
[`docs/`](../docs/overview.md): quickstart, exact request shapes, every
environment variable. This book links there rather than restating it. Read the
book to understand the system; read `docs/` to use it.

**Written against:** llm-whisperer 0.1.5, git `7dfec34` plus the uncommitted
working tree, 2026-08-01. See [§7](./7-status.md) for what that working tree
contains.

---

## Status markers

Every page carries one marker directly under its H1. The vocabulary is closed —
four words, no more — because a marker's job is to be *comparable across pages*,
and a fifth word sorts nowhere against the others.

| Marker | Means |
|---|---|
| **Implemented** | The code described here exists and runs. Every claim on the page is about shipped behaviour. |
| **Partial** | Some of the page ships and some does not. The page must say **which half**. |
| **Planned** | Described, not built. No code on this page's subject exists. |
| **Reference** | Not a claim about the state of any code — contents, vocabulary, conventions. |

A stale banner is the worst defect this book can have, because it is a claim
nobody re-reads. Careful prose about unbuilt design is indistinguishable from
prose about working software; the banner is the only thing keeping them apart.

---

## Contents

### 1. The idea

| | |
|---|---|
| [1.1 What llm-whisperer is](./1-idea/1.1-what-it-is.md) | One local port, many models — and who it is for |
| [1.2 The two doors](./1-idea/1.2-two-doors.md) | API keys and browsers: the fork that shapes everything else |
| [1.3 Terms of service, honestly](./1-idea/1.3-terms-of-service.md) | What the browser door actually is, and what it costs you |

### 2. Architecture

| | |
|---|---|
| [2.1 The path of a request](./2-architecture/2.1-path-of-a-request.md) | From `curl` to a provider and back, file by file |
| [2.2 Configuration is the product](./2-architecture/2.2-configuration-is-the-product.md) | Why `providers.yaml` carries the domain knowledge |
| [2.3 The provider contract](./2-architecture/2.3-the-provider-contract.md) | One interface, one abstract method, two implementations |

### 3. The API surface

| | |
|---|---|
| [3.1 Three dialects, one core](./3-api/3.1-three-dialects.md) | `/chat`, OpenAI, and Anthropic over the same generator |
| [3.2 Choosing a model](./3-api/3.2-choosing-a-model.md) | The `provider/model` string, and where it stops working |
| [3.3 Streaming](./3-api/3.3-streaming.md) | Two SSE dialects out, one polled DOM in |
| [3.4 Embeddings and the auth gate](./3-api/3.4-embeddings-and-auth.md) | An optional capability, and the one shared lock |

### 4. API-key providers

| | |
|---|---|
| [4.1 One class, many services](./4-api-key-providers/4.1-one-class-many-services.md) | Why eight providers needed no code between them |
| [4.2 The shipped roster](./4-api-key-providers/4.2-the-shipped-roster.md) | All eight, generated from `providers.yaml` |

### 5. Browser providers

| | |
|---|---|
| [5.1 The generic driver](./5-browser-providers/5.1-the-generic-driver.md) | Typing into someone else's chat box |
| [5.2 Knowing when it stopped talking](./5-browser-providers/5.2-knowing-when-it-stopped.md) | The hardest problem in the codebase |
| [5.3 Sessions and login](./5-browser-providers/5.3-sessions-and-login.md) | One profile, one lock, one sentinel file |
| [5.4 The session pool](./5-browser-providers/5.4-the-session-pool.md) | Two pages per provider, and the queue behind them |
| [5.5 What is actually verified](./5-browser-providers/5.5-what-is-verified.md) | Two of ten, and the evidence for each |
| [5.6 Model switching](./5-browser-providers/5.6-model-switching.md) | Built, wired, and a no-op on nine of ten providers |

### 6. Operating it

| | |
|---|---|
| [6.1 Install and first run](./6-operating/6.1-install-and-first-run.md) | Both doors, from nothing |
| [6.2 Startup and environment](./6-operating/6.2-startup-and-environment.md) | What `wspr serve` does, and what it deliberately doesn't |
| [6.3 When a provider breaks](./6-operating/6.3-when-a-provider-breaks.md) | The repair loop, and the errors you'll see first |
| [6.4 pnpm and publishing](./6-operating/6.4-pnpm-and-publishing.md) | Why pnpm, what ships in the tarball |

### 7. Status

| | |
|---|---|
| [7. Status of everything](./7-status.md) | One row per item: state, evidence, and the page that owns it |

### 8. About this book

| | |
|---|---|
| [8.1 How this book is written](./8-about/8.1-how-this-book-is-written.md) | The rules, and which ones a check enforces |
| [8.2 Vocabulary](./8-about/8.2-vocabulary.md) | Verified vs recon'd, declared vs works, and other not-quites |

---

## Checking the book

```bash
node wiki/check.mjs      # or: pnpm run check:wiki
```

Asserts that every relative link resolves, every `#anchor` exists, every page is
reachable from this contents page, every page has an H1 and a status banner and
a nav footer, that banners use only the four markers above, and that every row
in [§7](./7-status.md) links to the chapter that owns it.

What no check can verify is whether a **Status** line is still true. That is on
whoever changes the code — which is exactly why the banner is one line, at the
top, in a four-word vocabulary. It is the cheapest possible thing to keep
honest. See [§8.1](./8-about/8.1-how-this-book-is-written.md).

---

[Next: What llm-whisperer is →](./1-idea/1.1-what-it-is.md)
