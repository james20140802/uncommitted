# macOS Scheduler

Uncommitted ships with a macOS LaunchAgent integration that runs the daily
collect → generate → render pipeline automatically at a time you choose.
The scheduler generates **local drafts only** and never posts to Instagram.

> **macOS only.** Linux and Windows scheduler support is out of scope for MVP.

---

## Installation

Install the LaunchAgent and set a daily run time:

```sh
uncommitted schedule install --time 23:30
```

The `--time` argument accepts a 24-hour `HH:mm` value. For example, `23:30`
runs the job at 11:30 PM local time.

When the command succeeds it prints the plist path:

```
Installed macOS schedule for 23:30.
Plist path: /Users/<you>/Library/LaunchAgents/com.uncommitted.schedule.plist
```

### What gets created

| Item | Location |
|------|----------|
| LaunchAgent plist | `~/Library/LaunchAgents/com.uncommitted.schedule.plist` |
| Stdout log | `~/.uncommitted/logs/schedule.stdout.log` |
| Stderr log | `~/.uncommitted/logs/schedule.stderr.log` |

The LaunchAgent label is `com.uncommitted.schedule`. The scheduler is loaded
into your GUI session immediately; you do not need to log out.

### Reinstalling at a different time

Run `uncommitted schedule install --time HH:mm` again. The command boots out
the old job and loads the plist with the new schedule.

---

## Checking scheduler status

```sh
uncommitted schedule status
```

Reports whether the LaunchAgent plist is installed and whether launchd
currently shows the job as loaded.

Example output when the scheduler is running:

```
Scheduler: installed
Plist: /Users/<you>/Library/LaunchAgents/com.uncommitted.schedule.plist
Status: loaded
```

Example output when no scheduler is installed:

```
Scheduler: not installed
```

> `schedule status` is implemented as part of UNC-68. If your build predates
> that issue, the command is not yet available.

---

## Removing the scheduler

```sh
uncommitted schedule remove
```

Unloads the `com.uncommitted.schedule` LaunchAgent and deletes the plist.
The command is idempotent — running it when the scheduler is not installed
exits cleanly.

`schedule remove` does **not** delete logs, drafts, config files, project
registrations, or any other user data. Only the LaunchAgent plist is removed.

> `schedule remove` is the canonical uninstall command. There is no `uninstall`
> alias in the MVP.

> `schedule remove` is implemented as part of UNC-68. If your build predates
> that issue, the command is not yet available.

---

## Running the workflow immediately

Use `run-now` to trigger the full daily pipeline without waiting for the
scheduled time. This is the primary debugging tool for a failed scheduled run:

```sh
uncommitted schedule run-now
```

This runs, in order:

1. `uncommitted collect git` — collects Git activity for all registered projects
2. `uncommitted generate --date <today>` — generates a text draft
3. `uncommitted render latest` — renders carousel PNGs

The draft is written to `~/Uncommitted/drafts/YYYY-MM-DD/rev-NNN/`. It is
**not posted to Instagram** unless the schedule was installed with
`--publish instagram` (see below).

If any step fails its exit code propagates and subsequent steps are skipped.

---

## Auto-publish to Instagram (opt-in)

Requires a connected account and image hosting (`docs/instagram-setup.md`
sections 7 and 8).

```sh
uncommitted schedule install --time 23:30 --publish instagram
uncommitted schedule install --time 23:30 --publish instagram --publish-delay 30m
```

With `--publish instagram`, `run-now` adds a fourth step: it publishes the
latest revision of the day as a carousel without asking (`publish instagram
--yes`). Installing again without `--publish` turns auto-publish off, and
`schedule remove` deletes the setting too.

- **Setting**: stored in `~/.uncommitted/schedule.json`. The plist only runs
  `schedule run-now`; Instagram tokens, the App Secret and storage keys are
  never written to it. They are read from the keychain (or 0600 config) at
  publish time.
- **Delay**: `--publish-delay <Nm|Nh>` (max `12h`) waits after rendering so you
  can check the draft or make a new revision; the latest revision of the day is
  published when the delay ends. The wait checks the wall clock every 30
  seconds, so a laptop that sleeps past the deadline publishes on wake.
- **Skip a day**: `uncommitted publish skip [--date YYYY-MM-DD]` writes
  `publish-skip.json` into the day's draft folder. The run checks it while
  waiting and right before publishing. It only affects auto-publish; manual
  `publish instagram` still works.
- **Skipped, not failed** (exit 0): safety `warning` or `blocked`, a missing
  or unreadable `safety-report.json` (auto-publish needs an explicit `safe`;
  manual `publish instagram` is unchanged), an incomplete draft, a revision that already has `publish-record.json`, a
  skipped day, or no draft. (A `blocked` day still exits 6 from the draft step,
  as before.)
- **Failure** (exit 7): the draft stays as is, and the launchd job is not
  touched, so the next day runs normally.
- **Results**: every attempt is appended to
  `~/.uncommitted/logs/schedule-publish.jsonl`. `schedule status` shows whether
  auto-publish is on and the last result:

```
자동 게시: 켜짐 (instagram, 지연 30분)
마지막 게시 결과: 2026-11-20 게시됨: https://www.instagram.com/p/…/
```

The last result reads `건너뜀: <reason>` for a skip or `실패 [<stage>]: <message>`
for a failure.

When auto-publish is on, `schedule status` also checks the Instagram token and
adds a `경고: Instagram 토큰 — …` line when it is missing, invalid, or expires
within 7 days. After a failed run, `uncommitted publish instagram --retry --yes`
retries that day's draft (see `docs/instagram-setup.md` section 11).

---

## Log files

All scheduled runs write to two plain-text log files under `~/.uncommitted/logs/`:

| Log | Path |
|-----|------|
| Standard output | `~/.uncommitted/logs/schedule.stdout.log` |
| Standard error | `~/.uncommitted/logs/schedule.stderr.log` |

Both files accumulate over time. You can tail them to watch a run in progress:

```sh
tail -f ~/.uncommitted/logs/schedule.stderr.log
```

---

## launchd environment variable caveats

launchd runs jobs in a minimal environment that does **not** inherit your
interactive shell's environment variables. This means environment variables
set in `~/.zshrc`, `~/.bashrc`, `~/.zprofile`, or similar files are not
available to the scheduled job.

**AI provider credentials must be provided to launchd explicitly.**

### Setting environment variables for launchd

Use `launchctl setenv` to export a variable into the launchd session. The
value persists until the next logout or reboot, so you must set it again after
each restart (or automate it via a login item):

```sh
launchctl setenv ANTHROPIC_API_KEY "sk-ant-..."
```

After setting the variable, restart the scheduled job so it picks up the
new value:

```sh
uncommitted schedule remove
uncommitted schedule install --time 23:30
```

### Alternatives

- Add an `EnvironmentVariables` block to the plist file manually. Edit
  `~/Library/LaunchAgents/com.uncommitted.schedule.plist` and add:

  ```xml
  <key>EnvironmentVariables</key>
  <dict>
    <key>ANTHROPIC_API_KEY</key>
    <string>sk-ant-...</string>
  </dict>
  ```

  Then reload:

  ```sh
  launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.uncommitted.schedule.plist
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.uncommitted.schedule.plist
  ```

  Note: the plist will be overwritten if you reinstall the scheduler via
  `uncommitted schedule install`. Re-add the block after reinstalling.

- Store credentials in a file and source them in a wrapper script. This
  approach is more robust to reinstalls but requires more setup.

> **Security note.** Storing plaintext credentials in a plist or environment
> is convenient but has the same risk as any plaintext file. Ensure the plist
> and any wrapper scripts are readable only by your user account
> (`chmod 600 ~/Library/LaunchAgents/com.uncommitted.schedule.plist`).

---

## Troubleshooting

### Check whether the job ran

```sh
# View stdout from the last run
cat ~/.uncommitted/logs/schedule.stdout.log

# View errors from the last run
cat ~/.uncommitted/logs/schedule.stderr.log
```

### Reproduce a failure interactively

```sh
uncommitted schedule run-now
```

`run-now` runs the same pipeline as the scheduled job but in your current
interactive shell, so your environment variables (including AI provider
credentials) are available. If `run-now` succeeds but the scheduled job
fails, the most likely cause is a missing environment variable in launchd.

### Common failure causes

| Symptom | Likely cause |
|---------|-------------|
| `AI generation error` in stderr log | `ANTHROPIC_API_KEY` not set in launchd environment |
| `No registered projects` | `uncommitted project add .` not run |
| Empty stderr log, no output | Job did not fire — check `launchctl list com.uncommitted.schedule` |
| `macOS is required` | Scheduler runs on macOS only |

### Inspect the launchd job manually

```sh
launchctl list com.uncommitted.schedule
```

A `PID` column value of `-` means the job is not currently running. The
`LastExitStatus` column shows the exit code of the most recent run; `0` is
success.

### Reload the job after editing the plist

```sh
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.uncommitted.schedule.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.uncommitted.schedule.plist
```

---

## What the scheduler does not do

- It does **not** post to Instagram or any other platform.
- It does **not** send notifications (beyond what future MVP features may add).
- It does **not** modify project source files or Git history.
- It does **not** collect GitHub PRs, issues, or remote activity.
- It does **not** use Claude Code or Codex logs.
