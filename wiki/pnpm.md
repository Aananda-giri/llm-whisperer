# pnpm

## What is pnpm?

pnpm ("performant npm") is a drop-in replacement for `npm` and `yarn` that
stores packages in a **content-addressable global store** and links them into
projects via hard links. This means:

- Installing the same package in 10 projects only writes the files to disk once
- `node_modules/` is created in milliseconds for repeat installs
- Disk usage is dramatically lower than npm or yarn

```
npm    →  copies files into every project's node_modules
yarn   →  same as npm (yarn v1), or uses PnP (yarn v3)
pnpm   →  hard-links from a global store (~/.pnpm-store)
```

## Why this project uses pnpm

- Faster installs on repeat runs (Playwright and its deps are large)
- Lock file (`pnpm-lock.yaml`) is more precise than `package-lock.json`
- `pnpm publish` and `pnpm pack` work identically to their npm equivalents

## Installing pnpm

```bash
npm install -g pnpm
# or:
curl -fsSL https://get.pnpm.io/install.sh | sh -
```

## Common commands

| npm equivalent | pnpm command | What it does |
|---|---|---|
| `npm install` | `pnpm install` | Install all dependencies |
| `npm install <pkg>` | `pnpm add <pkg>` | Add a dependency |
| `npm install -D <pkg>` | `pnpm add -D <pkg>` | Add a dev dependency |
| `npm uninstall <pkg>` | `pnpm remove <pkg>` | Remove a dependency |
| `npm run <script>` | `pnpm run <script>` or `pnpm <script>` | Run a package.json script |
| `npx <cmd>` | `pnpm exec <cmd>` | Run a binary from node_modules |
| `npm publish` | `pnpm publish` | Publish to the npm registry |

### Project-specific scripts

```bash
pnpm run serve     # start the API server (production build via tsx)
pnpm run dev       # start with file-watching (auto-reload on save)
pnpm run login     # open browser to log in to a provider
pnpm run build     # compile TypeScript → dist/
pnpm run start     # run the compiled dist/cli.js (after build)
pnpm run chrome    # launch Chrome with remote debugging on port 9222
```

## The pnpm-workspace.yaml in this project

```yaml
# pnpm-workspace.yaml
packages: []
allowBuilds:
  esbuild: true
```

This file exists to **isolate this project from any parent workspace**.

Without it, if `llm-whisperer/` sits inside a larger monorepo that has its own
`pnpm-workspace.yaml`, pnpm would treat this project as part of that workspace.
Installs would then be deduplicated against the parent — which can pull in
incompatible versions or fail entirely.

`packages: []` declares this directory as its own workspace root with no
sub-packages, preventing any parent workspace from capturing it.

`allowBuilds: esbuild: true` permits `esbuild` (a Playwright dependency) to
run its native binary build step, which pnpm restricts by default for security.

## Publishing to npm with pnpm

pnpm publishes to the same registry as npm (`registry.npmjs.org`). There is no
separate "pnpm registry".

```bash
# One-time: log in to npm
npm login
# or: pnpm login  (same thing)

# Publish
pnpm publish --access public
```

`--access public` is required for unscoped packages when your account defaults
to private. The `prepublishOnly` script in `package.json` automatically runs
`tsc` before each publish so you never ship stale compiled output.

### What gets published

The `files` field in `package.json` controls what's included in the tarball:

```json
"files": ["dist/", "docs/", "wiki/", "providers.yaml", "README.md"]
```

`node_modules/`, source TypeScript, and dev config are excluded automatically.

Preview before publishing:

```bash
pnpm pack --dry-run
```

## pnpm vs npm: key differences to know

| Topic | npm | pnpm |
|---|---|---|
| `node_modules` layout | flat (hoisted) | nested + symlinked (strict) |
| Phantom dependencies | allowed | blocked by default |
| Global store | no | yes (`~/.pnpm-store`) |
| Workspace protocol | `*` | `workspace:*` |
| Lock file | `package-lock.json` | `pnpm-lock.yaml` |

**Phantom dependencies** are packages your code imports but didn't explicitly
declare in `package.json`. npm's flat layout makes them accidentally available;
pnpm's strict layout will throw a `Cannot find module` error, which is a
feature — it forces explicit dependencies.

## Further reading

- [pnpm docs](https://pnpm.io/motivation)
- [pnpm vs npm vs yarn comparison](https://pnpm.io/feature-comparison)
- [Workspaces](https://pnpm.io/workspaces)
