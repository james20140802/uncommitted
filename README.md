# Uncommitted

[![npm version](https://img.shields.io/npm/v/@sangchu04/uncommitted)](https://www.npmjs.com/package/@sangchu04/uncommitted)
[![Node.js](https://img.shields.io/node/v/@sangchu04/uncommitted)](package.json)

Uncommitted is a local-first TypeScript/Node.js CLI that turns your Git activity and manual notes into AI coworker diary drafts — captions, story cards, and 4:5 Instagram carousel images — all generated and stored on your machine.

## Status

Uncommitted is published on npm as [`@sangchu04/uncommitted`](https://www.npmjs.com/package/@sangchu04/uncommitted). The MVP is macOS-first: it collects local activity, generates diary drafts, and renders Instagram-ready carousels. It never auto-publishes — every draft stays local until you decide to share it.

## Features

- **Local-first by design.** Activity collection, generation, and rendering all run on your machine. Drafts, config, and history live under your home directory — nothing is posted automatically.
- **Git-aware diary drafts.** Point Uncommitted at your projects and it summarizes the day's Git activity (commits, changed files, dirty state) into an honest draft — quiet days included.
- **Manual notes.** Capture context the commits don't show, and fold it into the same daily draft.
- **AI coworker voice.** Drafts read like a coworker's diary. The tone can lightly roast tools, TODOs, and recurring patterns — never you.
- **Safety-checked output.** Every draft is scanned for secrets, tokens, private paths, and other sensitive data before it can be exported.
- **Instagram carousels.** Generates 4:5 carousel PNGs plus a ready-to-paste caption, exported to a dedicated folder.

## Prerequisites

- macOS (Apple Silicon or Intel)
- Node.js **>=22.13.0** (`node --version` to verify)
- pnpm **10.10.0** (`pnpm --version` to verify; install via `npm i -g pnpm@10.10.0`) — only needed for source/dev installs

## MVP Install (Dogfooding)

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
# → produces sangchu04-uncommitted-0.2.2.tgz
pnpm add -g file:./sangchu04-uncommitted-0.2.2.tgz
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

## Quick start

```sh
uncommitted init                 # create local config
uncommitted project add .        # register the current repo
uncommitted collect git          # gather today's Git activity
uncommitted generate today       # draft today's diary
uncommitted render latest        # render carousel cards
uncommitted preview latest       # inspect the latest draft
uncommitted export instagram     # export Instagram-ready assets
```

## Commands

All commands are run as `uncommitted <command> [subcommand]`. Run `uncommitted --help` for the built-in reference.

| Command | Description |
| --- | --- |
| `uncommitted init` | Initialize Uncommitted config. |
| `uncommitted doctor` | Check local environment setup (and surface migration warnings). |
| `uncommitted project add .` | Register a project (the current directory). |
| `uncommitted project list` | List registered projects. |
| `uncommitted project remove <project-id>` | Remove a registered project. |
| `uncommitted note "..."` | Record a manual note for today. |
| `uncommitted note list` | List recorded manual notes. |
| `uncommitted collect git` | Collect activity from local Git repositories. |
| `uncommitted collect claude` | Collect activity from local Claude sessions. |
| `uncommitted collect codex` | Collect activity from local Codex sessions. |
| `uncommitted collect github` | Collect activity from GitHub. |
| `uncommitted collect all` | Collect activity from all available sources. |
| `uncommitted generate today` | Generate a diary draft for today. |
| `uncommitted generate --date YYYY-MM-DD` | Generate a diary draft for a specific date. |
| `uncommitted render latest` | Render carousel cards for the latest draft. |
| `uncommitted preview latest` | Preview the latest draft. |
| `uncommitted export instagram` | Export the latest draft as Instagram-ready assets. |
| `uncommitted feedback latest` | Record feedback on the latest draft. |
| `uncommitted feedback report` | Show a feedback report. |
| `uncommitted schedule install --time 23:30` | Install the macOS scheduled run at a given time. |
| `uncommitted schedule status` | Show the macOS schedule status. |
| `uncommitted schedule remove` | Remove the macOS schedule. |
| `uncommitted schedule run-now` | Run the scheduled job immediately. |
| `uncommitted completion zsh` | Print a zsh shell completion script. |
| `uncommitted completion bash` | Print a bash shell completion script. |

### GitHub token

If you use GitHub-sourced collection, prefer setting the `GITHUB_TOKEN` environment variable over storing a token in `config.json`; `init` does not manage `githubToken`, and storing it as plaintext in config is discouraged. `uncommitted doctor` reports only a masked status (env / config-plaintext / not-set) and never prints the token value.

## Output

Drafts are written locally to `~/Uncommitted/drafts/<YYYY-MM-DD>/<rev>/` (for example, `rev-001`). Each draft revision contains:

| File | Description |
| --- | --- |
| `caption.txt` | The generated Instagram caption. |
| `story.json` | The structured story used to render the carousel. |
| `activity-summary.json` | The summarized Git/activity signals for the day. |
| `safety-report.json` | The result of the secret/privacy safety scan. |
| `metadata.json` | Draft metadata (date, revision, source info). |
| `carousel/01.png` | The rendered 4:5 carousel card image(s). |

`uncommitted export instagram` writes Instagram-ready output to a sibling location:

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

## MVP direction

The MVP is macOS-first and outputs local drafts, metadata, captions, safety reports, and 4:5 Instagram carousel PNGs. It does not auto-publish.

## Contributing

Development happens with pnpm:

```sh
pnpm install
pnpm test        # run the vitest suite
pnpm lint        # run ESLint
pnpm typecheck   # run the TypeScript type check
pnpm build       # build the CLI
pnpm check       # lint → typecheck → test → build
pnpm dev -- --help
```

See [`AGENTS.md`](AGENTS.md) for the project's development workflow, product rules, and safety/privacy policy.
