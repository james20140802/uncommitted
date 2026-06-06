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

### Prerequisites

- macOS (Apple Silicon or Intel)
- Node.js **>=22.13.0** (`node --version` to verify)
- pnpm **10.10.0** (`pnpm --version` to verify; install via `npm i -g pnpm@10.10.0`)

### Install via npm (recommended)

```sh
npm install -g @sangchu04/uncommitted
uncommitted --help
```

### Option B — tarball install (from source)

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
# → produces sangchu04-uncommitted-0.1.0.tgz
pnpm add -g file:./sangchu04-uncommitted-0.1.0.tgz
uncommitted --help
```

### Option C — pnpm link (dev convenience)

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

See [`docs/release/MVP-CHECKLIST.md`](docs/release/MVP-CHECKLIST.md) for the full pre-tag release checklist and [`docs/release/CI-WORKFLOW.md`](docs/release/CI-WORKFLOW.md) for the GitHub Actions release artifact workflow.

## MVP Direction

The MVP is macOS-first and outputs local drafts, metadata, captions, safety reports, and 4:5 Instagram carousel PNGs. It does not auto-publish.

## Exports

`uncommitted export instagram` writes Instagram-ready output to:

```
~/Uncommitted/exports/instagram/<date>/<rev>/
```

This sits **sibling to `drafts/`**, not inside it. Prior versions wrote to `~/Uncommitted/drafts/exports/instagram/...`; that legacy location is no longer used.

### Migrating from the legacy export location

If you previously ran `uncommitted export instagram` and have content under `~/Uncommitted/drafts/exports/...`, Uncommitted will **not** auto-migrate it. To clean up:

1. Run `uncommitted doctor` — it will surface a `Legacy export directory` warning when the old path exists, including the source and target paths.
2. Either move the contents to the new path:

   ```sh
   mv ~/Uncommitted/drafts/exports/instagram ~/Uncommitted/exports/instagram
   ```

   or delete the legacy directory:

   ```sh
   rm -rf ~/Uncommitted/drafts/exports
   ```

3. Re-run `uncommitted doctor` to confirm the warning is gone.

Future exports always write to the new sibling location; there is no silent fallback to the legacy path.
