# Plan Browser Feature — Design Spec

## Overview

Replace the OS file dialog buttons in the plan view with an in-app plan browser that scans known directories for plans. Two tabs in the empty state: "Recent" (DB plans) and "Browse" (disk discovery).

## Browse Tab

- Scans fixed paths (`.claude/plans/`, `docs/plans/` relative to worktree) plus configurable extras from app settings (`planDirectories` key)
- Flat list grouped by location
- Each entry shows: title (from first `# heading`, fallback to filename), modification date, DB status badge if previously reviewed
- Clicking a plan reads the file and creates a DB record (existing flow)

## Recent Tab

- Shows plans from the SQLite database (existing behavior, moved into a tab)
- Status badges (pending/approved/changes requested)

## Backend

- New Tauri command: `scan_plan_directories(worktree_path)` returns metadata (title, path, mod time, is_directory) — does NOT read full content
- Results cached in Rust, invalidated by file watcher
- Reuses existing watcher infrastructure (`watcher.rs`) to watch plan directories
- Emits `plan-directories-changed` event on filesystem changes

## Configurable Paths

- Stored in app settings DB under `planDirectories` key (JSON array of relative paths)
- No UI for now — power users set via settings table

## UI Changes

- OS dialog buttons ("Open Plan Directory", "Open File") removed from toolbar and empty state
- Empty state shows two tabs: "Recent" and "Browse"
- Browse is the primary discovery mechanism
