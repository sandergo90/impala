---
name: create-release
description: Cut a new Impala desktop release (patch/minor/major). Use when the user asks to "create a release", "cut a release", "ship a release", "new patch/minor release", or bump the desktop version. Drives scripts/create-release.sh — never hand-edit versions.
---

# Create an Impala desktop release

A release is a version-bump commit plus a `desktop-v*.*.*` tag. Pushing that tag fires the `release-desktop.yml` workflow (`on: push: tags: "desktop-v*.*.*"`), which builds and **publishes immediately** — the final step is `gh release create … --latest` with no `--draft`. Treat this as an outward-facing, hard-to-reverse action.

**Always use `scripts/create-release.sh`. Never hand-edit version numbers** — the script keeps four (or five) config files in sync and handles the daemon-version subtlety below.

## Steps

1. **Find the current version.** A quick local check:
   ```sh
   git tag --list 'desktop-v*' --sort=-v:refname | head
   ```
   (The script itself derives the current version from `gh release list`, falling back to `tauri.conf.json` — these can differ from local tags if a release was deleted or failed, so prefer `gh release list` if in doubt.) The bump is relative to that: patch = `0.18.4 → 0.18.5`, minor = `→ 0.19.0`, major = `→ 1.0.0`.

2. **Preflight.** The script aborts on a dirty tree, so verify clean and in sync first:
   ```sh
   git fetch origin --quiet && git status -sb
   ```
   Be on `main` and level with `origin/main`. The script is *not* main-enforced — it commits the version bump to your current branch and runs `git push origin <current-branch> <tag>`. The tag (not the branch) triggers the build, but you want the bump commit to land on `main`, so check the branch yourself. Also needs `gh` authenticated and `jq` installed (the script checks both).

3. **Run with an explicit version** to skip the interactive bump menu:
   ```sh
   ./scripts/create-release.sh 0.18.5
   ```
   With no version argument it prompts interactively (patch/minor/major/custom) — pass the version so it runs unattended. (The script also parses `--publish` and `--merge`, but both are currently dead flags — set and never read — so they have no effect.)

4. **Run it in the background.** The script ends with `gh run watch`, and the build runs ~10–15 min (recent successful runs: 9–12 min) — longer than a foreground Bash timeout. Launch with `run_in_background: true`, then read the output file to confirm the early steps (commit `release: desktop vX.Y.Z`, tag `desktop-vX.Y.Z`, push) before letting it watch the build. You're notified when it finishes; success means the release is live.

## What the script does for you

- Bumps the version in `backend/tauri/tauri.conf.json`, `backend/tauri/Cargo.toml`, `backend/mcp/Cargo.toml`, `apps/desktop/package.json`.
- **Daemon version is conditional.** `backend/tauri/daemon/Cargo.toml` is bumped *only* if `backend/tauri/daemon` or `backend/tauri/shared` changed since the last tag (`git diff --quiet "$LATEST_TAG" -- backend/tauri/daemon backend/tauri/shared`). Why: `backend/tauri/build.rs` bakes `daemon/Cargo.toml`'s version into the `BUNDLED_DAEMON_VERSION` env at compile time; at startup the host (`backend/tauri/src/daemon_client.rs`) compares the running daemon's reported version against `BUNDLED_DAEMON_VERSION` and, if they differ, shuts the old daemon down and respawns the bundled one — killing any in-flight PTY sessions (the daemon otherwise survives GUI quit via `setsid`). Bumping the daemon version when nothing in it changed would force that needless respawn. Don't defeat this by bumping the daemon manually.
- Commits as `release: desktop vX.Y.Z`, tags `desktop-vX.Y.Z`, pushes the current branch + tag, then watches the workflow and prints the release URL.

## If the tag already exists

The script offers to delete and recreate the local tag (and the GitHub release) — only do this if the prior attempt failed before publishing.
