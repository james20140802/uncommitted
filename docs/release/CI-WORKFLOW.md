# CI Release Artifact Workflow

> **Automated packaging via GitHub Actions.** Use this when you need a reproducible,
> machine-built artifact produced from a clean GitHub environment — not your local machine.
>
> **Workflow file:** `.github/workflows/release-artifact.yml`
> **Does NOT publish to npm. Does NOT deploy any hosted service.**

---

## When to use the CI workflow vs. the local flow

| Situation | Use |
|-----------|-----|
| Need a verifiable artifact built from a clean GitHub environment | **CI workflow** (this doc) |
| Pre-flight smoke check before tagging on your local machine | **Local flow** — see [`MVP-CHECKLIST.md`](MVP-CHECKLIST.md) |
| Debugging a packaging or install issue locally | **Local flow** |

The CI workflow is **not** a substitute for the local pre-flight checks — run both before a real release.

---

## Triggers

### Manual dispatch (only trigger)

1. Go to the repo on GitHub → **Actions** → **Release Artifact**
2. Click **Run workflow**, choose the branch or tag from the dropdown, then click **Run workflow**

> **Note:** Pushing a `v*` tag triggers `release.yml` (the publish workflow), not this artifact-only workflow.
> Use this workflow when you need a standalone CI artifact without publishing to npm.

---

## What the workflow does

The workflow (`.github/workflows/release-artifact.yml`) runs these steps in order:

1. Checkout the repo
2. Install pnpm 10.10.0 and Node.js 22
3. `pnpm install --frozen-lockfile`
4. Install Playwright Chromium (required for renderer tests)
5. `pnpm lint`
6. `pnpm typecheck`
7. `pnpm build`
8. `pnpm test`
9. `pnpm pack` — produces `sangchu04-uncommitted-x.y.z.tgz`
10. Upload the `.tgz` via `actions/upload-artifact`

Packaging only runs if all validation steps pass.

---

## Downloading the artifact

1. Open the workflow run from the **Actions** tab
2. Scroll to **Artifacts** at the bottom of the run summary
3. Click the artifact name (e.g., `uncommitted-cli-v0.1.1`) to download the `.tgz`

Artifacts are retained for **30 days**.

---

## What this workflow does NOT do

- Does **not** publish to npm (no `npm publish`, no `NPM_TOKEN` required)
- Does **not** deploy any hosted service or web dashboard
- Does **not** post to Instagram or any external platform
- Does **not** replace the local smoke test (`pnpm release:smoke`)
- Does **not** automatically close the MVP milestone or update project board fields
