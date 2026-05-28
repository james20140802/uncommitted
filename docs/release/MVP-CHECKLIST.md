> **CI packaging:** For the GitHub Actions release artifact workflow, see [`CI-WORKFLOW.md`](CI-WORKFLOW.md).

# Uncommitted MVP Release Checklist

> This checklist covers the local steps before pushing a version tag. Pushing a `v*` tag triggers the automated `release.yml` workflow, which publishes the package to npm.
> No auto-publish to Instagram occurs at any step.

Use this checklist before creating the MVP git tag. Every command is copy-pasteable from a macOS terminal at the repo root.

---

## 1. Pre-flight

- [ ] Working tree is clean: `git status --short` → no uncommitted changes
- [ ] On the correct branch (usually `main`): `git branch --show-current`
- [ ] Latest `main` pulled: `git pull origin main`
- [ ] Node version meets requirement: `node --version` (must be >=22.13.0)
- [ ] pnpm version matches packageManager: `pnpm --version` (must be 10.10.0)

```sh
git status --short
git branch --show-current
git pull origin main
node --version
pnpm --version
```

---

## 2. Validation

Run all checks and confirm each exits 0:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

- [ ] `pnpm lint` exits 0
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0 (all tests pass)
- [ ] `pnpm build` exits 0 (dist/ produced)

---

## 3. Package Smoke

Run the full pack + isolated install + `--help` smoke flow:

```sh
pnpm release:smoke
```

This script (`scripts/release/pack-smoke.sh`) does:
1. Clean build (`rm -rf dist && pnpm build`)
2. `npm pack` → `sangchu04-uncommitted-x.y.z.tgz`
3. Install tarball into an isolated temp dir via `pnpm add file:...tgz`
4. Run `uncommitted --help` and assert non-empty output containing "uncommitted"
5. Clean up temp dir and tarball

- [ ] `pnpm release:smoke` prints `SMOKE TEST PASSED` and exits 0

---

## 4. Content Safety

Verify the packed artifact contains no private files:

```sh
npm pack --dry-run
```

Review the file list. Confirm:

- [ ] No `src/` files
- [ ] No `tests/` files
- [ ] No `.github/` files
- [ ] No `docs/` files
- [ ] No `tsconfig*.json`, `eslint.config.js`, `vitest.config.ts`
- [ ] No `.env*`, `*.log`, `coverage/`, `node_modules/`
- [ ] No `.uncommitted/` data, draft outputs, or event logs
- [ ] `dist/cli.js` is present (the bin entry)
- [ ] `README.md` is present

You can also run the automated check:

```sh
pnpm test -- tests/package-artifact.test.ts
```

---

## 5. Dogfooding Install Verification

Install the tarball into a temp project and run end-to-end smoke commands:

```sh
# Build and pack
pnpm build
npm pack
# → sangchu04-uncommitted-x.y.z.tgz

# Install into a temp dir
TMPDIR=$(mktemp -d)
echo '{"name":"smoke","version":"1.0.0","private":true}' > "$TMPDIR/package.json"
cd "$TMPDIR"
pnpm add "file:/path/to/repo/sangchu04-uncommitted-x.y.z.tgz"

# Smoke commands
node node_modules/.bin/uncommitted --help
node node_modules/.bin/uncommitted init --help

# Clean up
cd /path/to/repo
rm -rf "$TMPDIR" sangchu04-uncommitted-x.y.z.tgz
```

- [ ] `uncommitted --help` outputs usage text
- [ ] `uncommitted init --help` outputs sub-command help
- [ ] No crash or missing-module errors

See [README.md](../../README.md#mvp-install-dogfooding) for the full dogfooding install guide.

---

## 6. Version / Tag Decision

1. Decide the new version (semver):
   - **Patch** (`0.1.x`) — bug fix or minor doc update
   - **Minor** (`0.x.0`) — new command or feature
   - **Major** (`x.0.0`) — breaking change

2. Bump `package.json` version:

```sh
# Example: bump to 0.1.1
# Edit package.json manually or use:
npm version 0.1.1 --no-git-tag-version
```

3. Rebuild to embed the new version in dist/:

```sh
pnpm build
```

4. Stage and commit the version bump:

```sh
git add package.json
git commit -m "🔖 chore(release): bump version to 0.1.1"
```

5. Create an annotated git tag:

```sh
git tag -a v0.1.1 -m "MVP v0.1.1 — <one-line summary>"
git log --oneline -3   # verify tag appears
```

- [ ] `package.json` version updated
- [ ] Version bump committed
- [ ] Annotated tag created: `git tag -l 'v*'`

---

## 7. Publish (Automated via Tag Push)

Pushing a `v*` tag to origin triggers the `release.yml` GitHub Actions workflow, which:

1. Builds, lints, typechecks, and tests the package
2. Packs the tarball (`pnpm pack`)
3. Creates a GitHub Release with auto-generated release notes and attaches the tarball
4. Publishes the package to npm as `@sangchu04/uncommitted`

### Prerequisites

- The `NPM_TOKEN` secret must be registered in the GitHub repository settings (Settings → Secrets and variables → Actions).

### Push the tag

```sh
git push origin v0.1.1
```

The `release.yml` workflow runs automatically. Monitor it at:
`https://github.com/james20140802/uncommitted/actions`

### Verify the publish

```sh
npm view @sangchu04/uncommitted
# or install and verify:
npm install -g @sangchu04/uncommitted
uncommitted --help
```

- [ ] `NPM_TOKEN` secret is set in GitHub repo settings
- [ ] Tag pushed: `git push origin v0.1.x`
- [ ] `release.yml` workflow completes successfully
- [ ] `npm view @sangchu04/uncommitted` shows the new version

---

## 8. Rollback Notes

### Revert an annotated tag (if tagged too early)

```sh
git tag -d v0.1.1           # delete local tag
# If pushed to remote:
git push origin :refs/tags/v0.1.1
```

### Revert the version bump commit

```sh
git revert HEAD             # creates a revert commit (safe)
# or, if the commit was just made and not pushed:
git reset --soft HEAD~1     # unstage, keep changes
```

### Delete a generated tarball

```sh
rm -f sangchu04-uncommitted-0.1.1.tgz
```

### Restore a previous version

```sh
git checkout v0.1.0 -- package.json   # restore old package.json
pnpm build                             # rebuild dist/ at old version
```

---

## Checklist Summary

```
[ ] Pre-flight: clean tree, correct branch, pulled main, Node/pnpm versions OK
[ ] Validation: pnpm lint, typecheck, test, build all pass
[ ] Package smoke: pnpm release:smoke exits 0 with SMOKE TEST PASSED
[ ] Content safety: npm pack --dry-run shows only dist/ + README.md
[ ] Dogfooding: tarball installs and runs --help from temp dir
[ ] Version bumped in package.json and committed
[ ] Annotated tag created
[ ] NPM_TOKEN secret set in GitHub repo settings
[ ] Tag pushed to origin; release.yml workflow completes
[ ] npm view @sangchu04/uncommitted shows new version
[ ] No auto-publish to Instagram
```
