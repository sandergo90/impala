# Differ Phase 1: Walking Skeleton

> **For Claude:** REQUIRED SUB-SKILL: Use implement-plans to execute this plan.

**Goal:** Open a folder, see its worktrees in the sidebar, select one, see diverged commits, click a changed file, and view a diff rendered by `@pierre/diffs`.

**Architecture:** Tauri v2 desktop app with a React 19 frontend. Rust backend shells out to `git` CLI for all git operations and returns structured JSON. React renders a three-panel layout with `@pierre/diffs` for the diff view.

**Tech Stack:** Tauri v2, React 19, TypeScript, Vite, Tailwind CSS, shadcn/ui (Base UI primitives), @pierre/diffs, Zustand

**Phase:** Phase 1 of 4 — Walking Skeleton

| Phase | Title | Status |
|-------|-------|--------|
| 1 | Walking Skeleton | Current |
| 2 | Multi-Project & Navigation | Planned |
| 3 | Annotations | Planned |
| 4 | Error Handling & Polish | Planned |

## Tasks

| # | Name | Dependencies | Files |
|---|------|-------------|-------|
| 1 | Scaffold Tauri + React App | none | Project root, `src-tauri/`, `src/`, config files |
| 2 | Git CLI Bridge Commands | Task 1 | `src-tauri/src/lib.rs`, `src-tauri/src/git.rs` |
| 3 | Three-Panel UI with Diff View | Task 2 | `src/App.tsx`, `src/store.ts`, `src/components/` |
