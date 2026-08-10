# MVP Implementation Plan

This plan translates the MVP direction into implementation work for the
TypeScript/Node.js CLI. Product strategy and copy decisions stay in Notion; this
document focuses on build order, module boundaries, and implementation tasks.

## MVP Scope

Uncommitted MVP is a macOS-first, local-first CLI that turns local Git activity
and manual notes into an honest AI coworker diary draft. It generates local
draft artifacts only:

- `caption.txt`
- `story.json`
- `activity-summary.json`
- `safety-report.json`
- `metadata.json`
- 4:5 Instagram carousel PNGs
- `caption-failure.json` (캡션 생성이 재시도 후에도 실패한 경우에만 생성)

The MVP must support quiet days without inventing work. It must preserve privacy
by default, redact sensitive data before public output, and never post to
Instagram automatically.

## MVP Modules

### CLI Shell

Owns command routing, option parsing, help text, exit codes, and user-facing
errors. The CLI should stay thin and delegate behavior to feature modules.

### Configuration

Owns global initialization and config loading for `~/.uncommitted/config.json`.
It should validate required settings and return actionable config errors.

### Project Registry

Owns registered project metadata in `~/.uncommitted/projects.json` and per
project metadata in `project-root/.uncommitted/project.json`.

### Manual Notes

Owns manual note capture and listing. Notes are stored as JSONL files under
`project-root/.uncommitted/events/manual/YYYY-MM-DD.jsonl`.

### Git Activity Collection

Owns local Git inspection for registered projects. It should collect structured
activity summaries without storing raw diffs, secrets, or private remote URLs.

### Activity Summary

Owns normalization of collected events into a daily activity summary. Quiet days
are represented explicitly rather than treated as errors.

### AI Provider Abstraction

Owns provider interfaces, request construction, response parsing, and provider
errors. It must avoid sending raw diffs, raw code, raw transcripts, secrets, and
private paths by default.

### Story And Caption Generation

Owns generation of `story.json` and `caption.txt` from the activity summary.
Voice can lightly roast work situations, tools, TODOs, bugs, and recurring work
patterns, but must not attack identity, ability, appearance, mental health,
personal value, or real life.

### Safety And Privacy Checks

Owns redaction, export policy, and `safety-report.json`. Export policies are:
`safe`, `warning`, and `blocked`.

### Draft Storage

Owns draft revision folders and latest draft pointers under
`~/Uncommitted/drafts/YYYY-MM-DD/rev-001/`.

### Card Rendering

Owns HTML-based card templates and Playwright screenshot rendering to 4:5 PNG
carousel assets.

### Preview And Export

Owns local preview and export packaging for Instagram-ready assets. Export must
respect safety policy and must not auto-publish.

### macOS Scheduler

Owns launchd plist generation, install/status/remove commands, and scheduled
`run-now` execution. Scheduled failures must not prevent future scheduled runs.

### Format History

Owns local format history in `~/.uncommitted/history/formats.json` so generated
drafts can vary over time without inventing activity.

## Initial CLI Command List

| Command | Purpose |
| --- | --- |
| `uncommitted init` | Initialize global config and storage directories. |
| `uncommitted project add .` | Register the current project. |
| `uncommitted project list` | List registered projects. |
| `uncommitted project remove <project-id>` | Remove a project registration. |
| `uncommitted note "..."` | Add a manual note for the current day. |
| `uncommitted note list` | List recent manual notes. |
| `uncommitted collect git` | Collect local Git activity for registered projects. |
| `uncommitted generate today` | Generate today's draft. |
| `uncommitted generate --date YYYY-MM-DD` | Generate a draft for a specific date. |
| `uncommitted render latest` | Render carousel PNGs for the latest draft. |
| `uncommitted preview latest` | Preview the latest local draft. |
| `uncommitted export instagram` | Export Instagram-ready assets. |
| `uncommitted schedule install --time 23:30` | Install the macOS launchd schedule. |
| `uncommitted schedule status` | Show scheduler status. |
| `uncommitted schedule remove` | Remove the scheduler. |
| `uncommitted schedule run-now` | Run the scheduled workflow immediately. |

## Implementation Phases

### Phase 1: CLI And Local Storage Foundation

Implementation tasks:

- Implement command parsing for the initial command list.
- Add storage path helpers for global, project, and draft locations.
- Implement `init` with config file creation and idempotent directory setup.
- Add focused tests for successful init, repeated init, and config error paths.

Product/design decisions:

- Confirm any user-facing naming changes before changing the command names.
- Keep detailed onboarding copy out of the CLI until product copy is finalized.

### Phase 2: Project Registration

Implementation tasks:

- Implement `project add .`, `project list`, and `project remove <project-id>`.
- Write global project registry data to structured JSON.
- Write per-project metadata to `project-root/.uncommitted/project.json`.
- Add tests for duplicate registration, missing project metadata, and removal.

Product/design decisions:

- Decide later whether project IDs should be slugs, generated IDs, or both.

### Phase 3: Manual Notes

Implementation tasks:

- Implement `note "..."` and `note list`.
- Store manual notes as dated JSONL events.
- Keep note output short and actionable.
- Add tests for note persistence, note listing, and invalid note input.

Product/design decisions:

- Final note prompts and suggested examples are product copy, not core
  implementation.

### Phase 4: Git Activity Collection

Implementation tasks:

- Implement `collect git` for registered local repositories.
- Collect commit metadata and safe summaries without raw diffs or secrets.
- Redact local absolute paths, emails, private URLs, and remote repository URLs.
- Add tests using fixture repositories or isolated temporary Git repositories.

Product/design decisions:

- Decide later how much commit detail should appear in public-facing drafts.

### Phase 5: Activity Summary

Implementation tasks:

- Normalize Git events and manual notes into `activity-summary.json`.
- Represent quiet days as valid summaries.
- Preserve partial output where possible.
- Add tests for active days, quiet days, and mixed Git/manual activity.

Product/design decisions:

- Tune summary tone and detail density after end-to-end draft examples exist.

### Phase 6: AI Generation

Implementation tasks:

- Add provider abstraction and provider configuration.
- Generate `story.json` and `caption.txt` from safe summary inputs.
- Handle AI generation failures with exit code `4`.
- Add tests with fake providers for success, invalid response, and provider
  failure.

Product/design decisions:

- Choose default provider/model and final tone guidelines outside this module.

### Phase 7: Safety Checks

Implementation tasks:

- Implement redaction and safety classification.
- Write `safety-report.json` for each draft.
- Block export when policy is `blocked`.
- Add tests for secrets, emails, private URLs, local paths, warnings, and blocked
  content.

Product/design decisions:

- Review policy thresholds after seeing real draft examples.

### Phase 8: Draft Storage And Latest Pointer

Implementation tasks:

- Write draft revisions under `~/Uncommitted/drafts/YYYY-MM-DD/rev-001/`.
- Maintain a latest pointer for preview, render, and export commands.
- Preserve existing draft revisions instead of overwriting them.
- Add tests for revision creation and latest draft resolution.

Product/design decisions:

- Decide later whether revision labels should be user-visible.

### Phase 9: Card Rendering

Implementation tasks:

- Render carousel cards via HTML and Playwright screenshots.
- Produce 4:5 PNGs under the draft `carousel/` directory.
- Handle rendering failures with exit code `5`.
- Add tests around render input validation and file output; use targeted visual
  checks where practical.

Product/design decisions:

- Final card layouts, typography, and visual style are design decisions.

### Phase 10: Preview, Export, And Scheduler

Implementation tasks:

- Implement `preview latest` and `export instagram`.
- Enforce safety policy during export.
- Implement macOS launchd schedule install/status/remove/run-now.
- Ensure scheduled failures are logged and do not block future scheduled runs.
- Add tests for export policy behavior and scheduler plist generation.

Product/design decisions:

- Decide later whether preview opens files automatically or only prints paths.
- Instagram publishing remains out of scope for MVP.

## Out Of Scope For MVP

- Claude Code automatic log integration
- Codex automatic log integration
- GitHub PR or Issue collection
- Instagram automatic publishing
- Web dashboard
- Mobile app
- Full local LLM mode
- Windows/Linux scheduler support
- `per_project` and `hybrid` entry modes
