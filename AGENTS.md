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
- All code agents must follow this workflow; Codex is the baseline workflow for this repository.
- If the user asked for planning first, said not to edit yet, invoked a planning workflow, or the issue scope is unclear, propose a plan and wait for acceptance before editing.
- When the user replies `confirm` after a plan, move directly into implementation without reopening scope discussion.
- One issue normally maps to one branch and one PR.
- Keep changes scoped to the issue. Avoid opportunistic refactors.

Default issue workflow:
1. Read the issue with `gh issue view <number>`.
2. Inspect repository state with `git status --short` and the current branch.
3. Restate goal, scope, out-of-scope, acceptance criteria, and intended behavior.
4. Define the focused test target before editing.
5. Add or update focused tests first when the change is testable.
6. Implement the smallest change that satisfies the issue.
7. Run targeted checks first when useful, then the relevant full validation commands.
8. Report changed files, checks run, and remaining risk.

## TDD Rule

- This project is test-driven.
- Before implementation, define intended behavior and create focused tests first.
- Start with core behavior and representative failure behavior; avoid speculative edge-case coverage.
- Implement after the test target is clear.
- Validate with relevant checks before reporting completion.

Expected validation commands, when available: `pnpm check` (runs lint → typecheck → test → build in order). Individual scripts: `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`. If a script does not exist, say so explicitly.

Also run `git diff --check` before commit or PR publication when possible.

## Reporting Language (행동의 언어)

Human-facing outputs — PR bodies, issue comments, completion reports — must let a reviewer judge the work against the issue's acceptance criteria without reading the diff.

- Lead with the user-observable behavior change ("무엇이 달라지나"), not the implementation.
- Map acceptance criteria by quoting each AC verbatim with a verdict and evidence (test name, commit, or manual check). Never paraphrase AC — paraphrased criteria cannot be judged by their author.
- List every deviation from the issue (new dependencies, output-format or publishability impact, changed existing behavior). Write "없음" explicitly when there is none; an omitted section hides decisions.
- Implementation terms (file names, internal modules) belong only in implementation-summary sections and commit messages.

## GitHub And Git Rules

Allowed read-only GitHub commands: `gh issue view <number>`, `gh issue list`, `gh pr view <number>`, `gh pr diff <number>`.

These require explicit user approval: `gh issue create`, `gh issue edit`, `gh issue close`, `gh pr create`, `gh pr merge`, `git push`.

Template rules:
- When creating GitHub issues, follow `.github/ISSUE_TEMPLATE/feature.yml` or `.github/ISSUE_TEMPLATE/bug.yml` and include goal, scope, out-of-scope, acceptance criteria, and implementation notes.
- When creating PRs with `gh pr create`, preserve `.github/pull_request_template.md`'s structure. Prefer filling the template into a temporary body file and using `--body-file`; `--template` is acceptable only when it reliably preserves the template and required filled fields.
- Do not use ad hoc `--body` text unless the user explicitly asks for a custom PR body; ad hoc bodies bypass the PR template shape.
- Fill the PR template's related issue section with `Closes #<issue-number>` when the PR should close an issue on merge.

Branch and commit rules:
- The user normally creates branches, commits, pushes, and PRs.
- Codex may do those actions only when explicitly asked.
- Do not run destructive Git commands unless explicitly requested.
- If asked to create a branch for an issue while on `main`, use a focused branch name for that issue.
- Before committing, inspect the diff and stage only intended files.
- Keep one logical change per commit.
- Use gitmoji in commit messages.

Useful read-only Git commands: `git status --short`, `git diff`, `git diff --staged`, `git log --oneline -n 10`.

## Parallel Worktree Rules

- Use sibling worktrees only when the user asks for parallel issue work or when issues are clearly independent.
- Prefer issue-numbered sibling paths such as `../uncommitted-issue-<number>` for parallel delivery.
- Keep one issue per worktree, one branch per issue, and one logical PR per branch.
- Install and validate dependencies per worktree; do not assume another worktree's `node_modules` or generated state is usable.
- Before claiming issues can run in parallel, check dependencies and overlapping files. If needed, use concrete Git evidence such as `git diff --name-only`, branch comparisons, or `git merge-tree`.

## PR Review Fix Workflow

- For PR review fixes, inspect thread-aware unresolved review context rather than relying only on flat PR comments.
- If the user asks to fix only the latest review, scope the work to the latest actionable review batch.
- Fix only review feedback that is valid, technically sound, and in scope for the PR.
- Prefer the smallest safe fix; avoid refactors and unrelated cleanup.
- Add or update tests when the review exposes behavior that should be covered.
- Validate before reporting completion.
- Resolve only the review threads that were actually fixed, and only when the user has asked to publish or resolve them.

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

- Before reporting completion, re-read the issue acceptance criteria when an issue is involved.
- Confirm tests were added or explain why not.
- Run the relevant validation commands, or explain why a command could not be run.
- Report what changed, what tests/checks ran, and remaining risk.
- If tests could not be run, state why.
- Do not create commits, push branches, open PRs, merge PRs, or close issues unless explicitly asked.
