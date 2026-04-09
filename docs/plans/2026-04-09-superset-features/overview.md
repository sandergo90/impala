# Superset Feature Adoption: Cmd-Click, Stop Button, Terminal Hardening

> **For Claude:** REQUIRED SUB-SKILL: Use implement-plans to execute this plan.

**Goal:** Add cmd-click to open files in editor, a run/stop toggle button, and terminal stability improvements — inspired by Superset's recent releases.

**Architecture:** A shared file-path resolution layer (Rust backend + TypeScript parser/helper) provides the foundation for cmd-click. The stop button and terminal hardening are independent features touching the PTY system and floating terminal. All changes are in the Tauri desktop app.

**Tech Stack:** Rust (Tauri backend, `portable_pty`), TypeScript/React (frontend), xterm.js (terminal), Zustand (state), `@pierre/diffs` (diff viewer)

**Design spec:** `docs/superpowers/specs/2026-04-09-superset-features-design.md`

## Tasks

| # | Name | Dependencies | Files |
|---|------|-------------|-------|
| 1 | Shared file-path resolution layer | none | `backend/tauri/src/lib.rs`, `apps/desktop/src/lib/file-link-parser.ts`, `apps/desktop/src/lib/open-file-in-editor.ts`, `apps/desktop/src/components/OpenInEditorButton.tsx` |
| 2 | Terminal cmd-click link provider | Task 1 | `apps/desktop/src/lib/terminal-link-provider.ts`, `apps/desktop/src/components/XtermTerminal.tsx`, `apps/desktop/src/components/FloatingTerminal.tsx` |
| 3 | Cmd-click in diff view, commit panel, and annotations | Task 1 | `apps/desktop/src/components/DiffView.tsx`, `apps/desktop/src/components/CommitPanel.tsx`, `apps/desktop/src/components/AnnotationDisplay.tsx` |
| 4 | Run/Stop toggle button | none | `apps/desktop/src/lib/run-script.ts`, `apps/desktop/src/views/MainView.tsx`, `apps/desktop/src/components/FloatingTerminal.tsx`, `apps/desktop/src/store.ts` |
| 5 | Terminal stability: spawn cleanup + backpressure | none | `backend/tauri/src/pty.rs`, `apps/desktop/src/components/XtermTerminal.tsx` |
