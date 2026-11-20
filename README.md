# Uncommitted

[![npm version](https://img.shields.io/npm/v/@sangchu04/uncommitted)](https://www.npmjs.com/package/@sangchu04/uncommitted)
[![Node.js](https://img.shields.io/node/v/@sangchu04/uncommitted)](package.json)

Uncommitted is a local-first TypeScript/Node.js CLI that turns your Git activity and manual notes into AI coworker diary drafts — captions, story cards, and 4:5 Instagram carousel images. Drafts, config, and history are stored locally on your machine; the AI text generation runs through a provider you configure, which may call a remote API (OpenAI, OpenRouter, or Anthropic).

## Status

Uncommitted is published on npm as [`@sangchu04/uncommitted`](https://www.npmjs.com/package/@sangchu04/uncommitted). The MVP is macOS-first: it collects local activity, generates diary drafts, and renders Instagram-ready carousels. By default every draft stays local; publishing to Instagram is opt-in and needs your own Meta app and image hosting (see [Publishing to Instagram](#publishing-to-instagram)).

## Features

- **Local-first by design.** Activity collection and card rendering run on your machine, and drafts, config, and history live under your home directory — nothing is posted unless you set up publishing. AI text generation uses a provider you configure, which may call a remote API.
- **Git-aware diary drafts.** Point Uncommitted at your projects and it summarizes the day's Git activity (commits, changed files, dirty state) into an honest draft — quiet days included.
- **Manual notes.** Capture context the commits don't show, and fold it into the same daily draft.
- **AI coworker voice.** Drafts read like a coworker's diary. The tone can lightly roast tools, TODOs, and recurring patterns — never you.
- **Safety-checked output.** Every draft is scanned for secrets, tokens, private paths, and other sensitive data before it can be exported.
- **Instagram carousels.** Generates 4:5 carousel PNGs plus a ready-to-paste caption, exported to a dedicated folder.
- **Instagram publishing (opt-in).** Publish a draft as a carousel through the official Graph API, by hand or after each scheduled run. Only safety-`safe` drafts are auto-published, and secrets stay in the macOS keychain.

## Prerequisites

- macOS (Apple Silicon or Intel)
- Node.js **>=22.13.0** (`node --version` to verify)
- pnpm **10.10.0** (`pnpm --version` to verify; install via `npm i -g pnpm@10.10.0`) — only needed for source/dev installs

## MVP Install (Dogfooding)

### Install via npm (recommended)

```sh
npm install -g @sangchu04/uncommitted
npx playwright@1.60.0 install chromium   # browser for story-card rendering
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
# → produces sangchu04-uncommitted-0.6.1.tgz
pnpm add -g file:./sangchu04-uncommitted-0.6.1.tgz
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

`generate` needs an AI provider. `uncommitted init` defaults the provider to `none`, which makes `generate` fail — choose `openai`, `openrouter`, or `anthropic` during `init` (or edit your config) and export the matching API key before running `generate`.

```sh
uncommitted init                 # create local config (pick an AI provider, not "none")
export OPENAI_API_KEY=...         # or OPENROUTER_API_KEY / ANTHROPIC_API_KEY, matching your provider
uncommitted project add .        # register the current repo
uncommitted collect git          # gather today's Git activity
uncommitted generate today       # draft today's diary (requires a provider + API key)
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
| `uncommitted instagram connect --ig-user-id <ID>` | Connect an Instagram professional account (token read from the keychain). |
| `uncommitted instagram status` | Show the connected account, token state, and publish permission. |
| `uncommitted instagram disconnect` | Remove the connection from config. |
| `uncommitted instagram host set --endpoint <url> --bucket <name>` | Configure S3-compatible temporary image hosting (e.g. Cloudflare R2). |
| `uncommitted instagram host status` | Show the hosting settings and where its keys come from. |
| `uncommitted instagram host test` | Upload, fetch, and delete a test image. |
| `uncommitted publish instagram` | Publish the latest draft as a carousel (`--dry-run`, `--yes`, `--retry`, `--date`, `--revision`). |
| `uncommitted publish skip [--date YYYY-MM-DD]` | Keep the scheduled run from auto-publishing that day. |
| `uncommitted feedback latest` | Record feedback on the latest draft. |
| `uncommitted feedback report` | Show a feedback report. |
| `uncommitted schedule install --time 23:30` | Install the macOS scheduled run at a given time. Add `--publish instagram [--publish-delay 30m]` to auto-publish. |
| `uncommitted schedule status` | Show the macOS schedule status. |
| `uncommitted schedule remove` | Remove the macOS schedule. |
| `uncommitted schedule run-now` | Run the scheduled job immediately. |
| `uncommitted completion zsh` | Print a zsh shell completion script. |
| `uncommitted completion bash` | Print a bash shell completion script. |

### GitHub token

If you use GitHub-sourced collection, prefer setting the `GITHUB_TOKEN` environment variable over storing a token in `config.json`; `init` does not manage `githubToken`, and storing it as plaintext in config is discouraged. `uncommitted doctor` reports only a masked status (env / config-plaintext / not-set) and never prints the token value.

### Uncommitted file excludes

`collect git` does not count agent tool config as uncommitted work: `.claude/`, `.agents/`, `.codex/`, and `skills-lock.json` are always excluded. Add your own repo-relative paths with `sources.git.dirtyExcludes` in `~/.uncommitted/config.json` (for example `["notes.tmp", ".idea/"]`). An entry ending in `/` matches everything under that directory; any other entry matches that exact path or the directory of that name. Glob patterns are not supported. A malformed value is a config error (exit 2).

### Carousel modes

`carouselVisualStyle` in `~/.uncommitted/config.json` picks how carousel slides are drawn.

| Mode | What it does | Image provider |
| --- | --- | --- |
| `story-card` (default for new installs) | Draws typographic cards locally with Playwright. | Never called. |
| `photo-first` | Generates one AI image per slide. | Called once per slide; a failure degrades the whole draft to `story-card`. |

Both modes output 1080x1350 (Instagram's recommended 4:5 frame).

Existing configs are left alone: a config that already says `photo-first`, or that has no `carouselVisualStyle` key at all, keeps running photo-first. Only a fresh `uncommitted init` writes `story-card`.

## Publishing to Instagram

Publishing is opt-in. Without the setup below, Uncommitted only writes local drafts. The full step-by-step guide (in Korean, including where each Meta setting lives) is [`docs/instagram-setup.md`](docs/instagram-setup.md).

### What you need

- An Instagram **professional** account (Business or Creator).
- A Meta **business portfolio** (free) with that account added.
- Your own **Meta app** set up with *API setup with Unified login*, and a **System User token** with `instagram_basic` and `instagram_content_publish`. System User tokens can be issued without expiry.
- An **S3-compatible bucket** (Cloudflare R2 works well). The Graph API only accepts public image URLs, so images are uploaded there for a moment and deleted after each publish.

### Setup

```sh
# 1. Store secrets in the macOS keychain. Copy each value first, then:
security add-generic-password -a uncommitted -s instagram-access-token -w "$(pbpaste)"
security add-generic-password -a uncommitted -s meta-app-secret -w "$(pbpaste)"
security add-generic-password -a uncommitted -s r2-access-key-id -w "$(pbpaste)"
security add-generic-password -a uncommitted -s r2-secret-access-key -w "$(pbpaste)"

# 2. Connect the account and check the token
uncommitted instagram connect --ig-user-id <IG user ID>
uncommitted instagram status

# 3. Configure and test image hosting
uncommitted instagram host set --endpoint https://<account-id>.r2.cloudflarestorage.com --bucket <bucket>
uncommitted instagram host test

# 4. Check everything at once
uncommitted doctor
```

> **Watch out:** always store secrets with `-w "$(pbpaste)"`. Typing the value at the interactive `security` prompt truncates it at 128 characters, and System User tokens are longer than that.

If you don't use the keychain, `instagram connect --token-from-stdin`, `--app-secret-from-stdin`, and `host set --keys-from-stdin` store the values in `~/.uncommitted/config.json` (mode 0600) instead.

### Publishing

```sh
uncommitted publish instagram --dry-run   # validate and preview; no upload, no post
uncommitted publish instagram             # preview → confirm (y) → publish → permalink
```

- Carousels need 2–10 slides. Drafts with safety `blocked` are refused (exit 6); `warning` drafts ask again before posting.
- A published revision gets `publish-record.json` and is never posted twice.
- A failure prints `게시 실패 [stage]: message` and exits 7. The revision folder keeps `publish-attempt.json`, and `uncommitted publish instagram --retry` publishes the already-created container within 24 hours instead of uploading again.
- Short Graph API outages (5xx, dropped connections) are retried twice in each step; 4xx errors fail at once.

### Auto-publish after the scheduled run

```sh
uncommitted schedule install --time 23:30 --publish instagram --publish-delay 30m
uncommitted publish skip      # don't auto-publish today
uncommitted schedule status   # setting, last result, and token warnings
```

The scheduled run publishes only drafts whose safety status is `safe`; `warning`, `blocked`, missing safety reports, and incomplete drafts are skipped. The delay gives you time to look at the draft and run `publish skip`. Results are logged to `~/.uncommitted/logs/schedule-publish.jsonl`. See [`docs/scheduler.md`](docs/scheduler.md) for details.

Tokens, app secrets, storage keys, and presigned URL signatures are never printed, logged, or written into the launchd plist.

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
| `caption-failure.json` | Written only when caption generation fails after retries. Records the violated format conditions, attempt count, timestamp, and the redacted provider response. |

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

The MVP is macOS-first and outputs local drafts, metadata, captions, safety reports, and 4:5 Instagram carousel PNGs. Instagram publishing is opt-in and off by default.

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
