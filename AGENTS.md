# AGENTS.md

## Project Overview

Uncommitted is a local-first TypeScript/Node.js CLI that generates AI coworker diary drafts from Git activity and manual notes. MVP is macOS-first and outputs local drafts with `caption.txt`, `story.json`, `activity-summary.json`, `safety-report.json`, `metadata.json`, and 4:5 Instagram carousel PNGs.

Long-form context lives in Notion: `Uncommitted`, `기획서`, `MVP 기능 명세 v0.1`. Do not duplicate those docs here.

## Product Rules

- Do not invent work, commits, bugs, features, or user activity.
- Quiet days are valid content; generate honest quiet-day drafts.
- Default behavior is local draft generation, never automatic posting.
- AI voice may lightly roast situations, tools, TODOs, bugs, and recurring work patterns.
- Never attack the user's identity, ability, appearance, mental health, personal value, or real life.
- Public outputs must not expose secrets, private paths, tokens, emails, private URLs, raw code, credentials, or exploit details.

## Development Workflow

- GitHub Issues are the source of truth.
- Codex CLI is the main implementation tool.
- For each task, read the issue first with `gh issue view <number>`.
- Summarize the issue before implementation.
- If the user asked for planning first, propose a plan and wait for acceptance before editing.
- One issue normally maps to one branch and one PR.
- Keep changes scoped to the issue. Avoid opportunistic refactors.

## TDD Rule

- This project is test-driven.
- Before implementation, define intended behavior and create focused tests first.
- Start with core behavior and representative failure behavior; avoid speculative edge-case coverage.
- Implement after the test target is clear.
- Validate with relevant checks before reporting completion.

Expected validation commands, when available: `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`. If a script does not exist, say so explicitly.

## GitHub And Git Rules

Allowed read-only GitHub commands: `gh issue view <number>`, `gh issue list`, `gh pr view <number>`, `gh pr diff <number>`.

These require explicit user approval: `gh issue create`, `gh issue edit`, `gh issue close`, `gh pr create`, `gh pr merge`, `git push`.

Branch and commit rules:
- The user normally creates branches, commits, pushes, and PRs.
- Codex may do those actions only when explicitly asked.
- Do not run destructive Git commands unless explicitly requested.
- Before committing, inspect the diff and stage only intended files.
- Keep one logical change per commit.
- Use gitmoji in commit messages.

Useful read-only Git commands: `git status --short`, `git diff`, `git diff --staged`, `git log --oneline -n 10`.

## Project Board Fields

- `Status`: `Todo`, `In Progress`, `Done`
- `Area`
- `Priority`: `High`, `Medium`, `Low`

Do not change project fields unless explicitly asked.

## Implementation Order

Build MVP in this order unless an issue says otherwise: CLI initialization/config, project registration, manual notes, Git activity collection, activity summary, AI provider abstraction, story/caption generation, card rendering, draft storage/latest pointer, export, macOS launchd scheduler, safety checks/format history.

## Architecture Rules

- Use TypeScript and Node.js.
- Prefer `pnpm`.
- Keep MVP CLI-first; do not add a web dashboard.
- Use provider abstraction for AI calls.
- Do not send full diffs, raw code, raw transcripts, or secrets to AI providers by default.
- Use local structured JSON files for MVP storage.
- Prefer `HTML -> Playwright screenshot -> PNG` for card rendering unless an issue changes that.

## MVP Commands

`uncommitted init`, `uncommitted project add .`, `uncommitted project list`, `uncommitted project remove <project-id>`, `uncommitted note "..."`, `uncommitted note list`, `uncommitted collect git`, `uncommitted generate today`, `uncommitted generate --date YYYY-MM-DD`, `uncommitted render latest`, `uncommitted preview latest`, `uncommitted export instagram`, `uncommitted schedule install --time 23:30`, `uncommitted schedule status`, `uncommitted schedule remove`, `uncommitted schedule run-now`.

## Storage Rules

Global storage: `~/.uncommitted/config.json`, `~/.uncommitted/projects.json`, `~/.uncommitted/history/formats.json`, `~/.uncommitted/drafts/`, `~/.uncommitted/logs/`.

Project storage: `project-root/.uncommitted/project.json`, `project-root/.uncommitted/events/manual/`, `project-root/.uncommitted/events/claude/`, `project-root/.uncommitted/events/codex/`.

Draft storage: `~/Uncommitted/drafts/YYYY-MM-DD/rev-001/{caption.txt,story.json,activity-summary.json,safety-report.json,metadata.json,carousel/01.png}`.

Manual notes are JSONL at `project-root/.uncommitted/events/manual/YYYY-MM-DD.jsonl`.

## Safety And Privacy

- Redact or exclude API keys, access tokens, secret keys, private URLs, local absolute paths, emails, phone numbers, database credentials, environment variable values, and private repository remote URLs.
- Export policy: `safe` allows export, `warning` allows export with warning, `blocked` blocks export.
- MVP must not auto-publish to Instagram.
- `--force` export for blocked content is not part of MVP unless a later issue explicitly adds it.

## Error Handling

- Error messages must be short and actionable.
- Preserve partial output when possible.
- Scheduled failures must not prevent future scheduled runs.
- Exit codes: `0` success, `1` general failure, `2` config error, `3` collection error, `4` AI generation error, `5` rendering error, `6` safety blocked.

## Do Not Touch Without Explicit Request

- Notion planning docs: `Uncommitted`, `기획서`, `MVP 기능 명세 v0.1`
- Generated local user data under `~/.uncommitted/`
- Generated local drafts under `~/Uncommitted/`
- Project event logs under `.uncommitted/events/`
- User secrets, environment files, credentials, tokens, and private config
- GitHub Issues, PRs, Project fields, and remote branches

## MVP Out Of Scope

- Claude Code automatic log integration
- Codex automatic log integration
- GitHub PR/Issue collection
- Instagram automatic publishing
- Web dashboard
- Mobile app
- Full local LLM mode
- Windows/Linux scheduler support
- `per_project` and `hybrid` entry modes

## Completion Rules

- Report what changed, what tests/checks ran, and remaining risk.
- If tests could not be run, state why.
- Do not create commits, push branches, open PRs, merge PRs, or close issues unless explicitly asked.
