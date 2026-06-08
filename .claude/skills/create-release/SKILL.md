---
name: create-release
description: Cut a new Impala desktop release (patch/minor/major). Use when the user asks to "create a release", "cut a release", "ship a release", "new patch/minor release", or bump the desktop version. Drives scripts/create-release.sh — never hand-edit versions.
---

# Create an Impala desktop release

Releases are version bumps committed to `main` and pushed as a `desktop-v*.*.*` tag, which fires the `release-desktop.yml` GitHub Actions workflow. The workflow builds and **publishes immediately (never a draft)**, so treat this as an outward-facing, hard-to-reverse action.

**Always use `scripts/create-release.sh`. Never hand-edit version numbers** — the script keeps four (or five) config files in sync and handles the daemon-version subtlety below.

## Steps

1. **Find the current version.** It's the latest release tag, not anything in the working tree:
   ```sh
   git tag --list 'desktop-v*' --sort=-v:refname | head
   ```
   The bump is relative to that: patch = `0.18.4 → 0.18.5`, minor = `→ 0.19.0`, major = `→ 1.0.0`.

2. **Preflight.** The script aborts on a dirty tree, so verify clean and in sync first:
   ```sh
   git fetch origin --quiet && git status -sb
   ```
   Confirm you're on `main` (releases are cut from `main`) and level with `origin/main`. Also needs `gh` authenticated and `jq` installed (the script checks).

3. **Run with an explicit version** to skip the interactive bump menu:
   ```sh
   ./scripts/create-release.sh 0.18.5
   ```
   With no version argument it prompts interactively (patch/minor/major/custom) — pass the version so it runs unattended. Flags: `--publish`, `--merge` (rarely needed; the workflow publishes on its own).

4. **Run it in the background.** The script ends with `gh run watch`, and Tauri builds run 15–30 min — longer than a foreground Bash timeout. Launch with `run_in_background: true`, then read the output file to confirm the early steps (commit `release: desktop vX.Y.Z`, tag `desktop-vX.Y.Z`, push) before letting it watch the build. You're notified when it finishes; success means the release is live.

## What the script does for you

- Bumps the version in `backend/tauri/tauri.conf.json`, `backend/tauri/Cargo.toml`, `backend/mcp/Cargo.toml`, `apps/desktop/package.json`.
- **Daemon version is conditional.** `backend/tauri/daemon/Cargo.toml` is bumped *only* if `backend/tauri/daemon` or `backend/tauri/shared` changed since the last tag. The host's `build.rs` bakes the daemon version in and respawns the daemon when it differs — an unconditional bump would kill in-flight PTY sessions that survive GUI quits. Don't defeat this by bumping the daemon manually.
- Commits, tags `desktop-vX.Y.Z`, pushes branch + tag, then watches the workflow and reports the release URL.

## If the tag already exists

The script offers to delete and recreate the local tag (and the GitHub release) — only do this if the prior attempt failed before publishing.
