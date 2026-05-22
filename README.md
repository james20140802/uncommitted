# Uncommitted

Uncommitted is a local-first TypeScript/Node.js CLI for generating AI coworker diary drafts from Git activity and manual notes.

## Status

This project is in its initial CLI bootstrap phase. Commands are routed, but feature implementations are intentionally not included yet.

## Setup

```sh
pnpm install
```

## Development

```sh
pnpm test
pnpm build
pnpm dev -- --help
```

## MVP Install (Dogfooding)

> **Not published to public npm.** This is a manual local install path for macOS dogfooding only.

### Prerequisites

- macOS (Apple Silicon or Intel)
- Node.js **>=22.13.0** (`node --version` to verify)
- pnpm **10.10.0** (`pnpm --version` to verify; install via `npm i -g pnpm@10.10.0`)

### Option A — tarball install (recommended)

```sh
# 1. Clone and enter the repo
git clone https://github.com/james20140802/uncommitted.git
cd uncommitted

# 2. Install dependencies and build
pnpm install
pnpm build

# 3. Pack and install from the tarball into a temp dir (smoke-tested flow)
pnpm release:smoke

# Or install the tarball into your own project / global location:
npm pack
# → produces uncommitted-0.1.0.tgz
pnpm add -g file:./uncommitted-0.1.0.tgz
uncommitted --help
```

### Option B — pnpm link (dev convenience)

```sh
# From the repo root (after pnpm install && pnpm build):
pnpm link --global
uncommitted --help
```

### Verify the install

```sh
uncommitted --help
uncommitted init
```

See [`docs/release/MVP-CHECKLIST.md`](docs/release/MVP-CHECKLIST.md) for the full pre-tag release checklist.

## MVP Direction

The MVP is macOS-first and outputs local drafts, metadata, captions, safety reports, and 4:5 Instagram carousel PNGs. It does not auto-publish.
