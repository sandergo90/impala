# CLAUDE.md

## Project: Impala

A desktop app for reviewing git worktree changes. Tauri 2 + React 19 + Rust, with SQLite-backed annotations and an MCP server that exposes those annotations to Claude Code.

### Layout

- `apps/desktop/` — React frontend (Vite, Tailwind v4, TanStack Router, Zustand, shadcn/ui, xterm)
- `backend/tauri/` — Tauri backend (Rust). Workspace members in `shared/` and `daemon/`. Source files under `src/` cover annotations, git, github, linear, plans, pty, hotkeys, watcher, worktrees, etc.
- `backend/mcp/` — Standalone `impala-mcp` binary (stdio MCP server, bundled as a Tauri sidecar)
- `scripts/` — `create-release.sh`, `build-mcp-sidecar.sh`, `build-pty-daemon-sidecar.sh`, `dev-sign.sh`
- `docs/`, `plans/`, `patches/` — design docs, in-flight plans, dependency patches

### Key features

Diff viewer over git worktrees, inline annotations (resolvable, surfaced via MCP), integrated terminal with split view, command palette, themes, auto-updater, plan review flow.

### Tooling

- **Package manager:** Bun (`bun@1.2.10`), Turborepo for the JS workspace
- **Patched deps:** `@pierre/diffs@1.1.7` (see `patches/`)
- **Rust:** Tauri 2, rusqlite (bundled), tokio, notify, portable-pty
- **Frontend libs of note:** `@base-ui/react`, `@pierre/diffs`, `@plannotator/web-highlighter`, `cmdk`, `react-resizable-panels`, `@xterm/*`

### Commands

```sh
bun install
bun run dev        # bunx tauri dev — Vite + Tauri together
bun run build      # loads .env, then bunx tauri build
bun run typecheck  # turbo typecheck
```

Inside `apps/desktop`: `bun run dev` (Vite only), `bun run typecheck` (`tsc --noEmit`).

### Releases

Push a `desktop-v*.*.*` tag to fire the release workflow. **Always use `scripts/create-release.sh`** — never hand-edit versions. Releases are published immediately, never drafts.

---

## Behavioral guidelines

Reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
