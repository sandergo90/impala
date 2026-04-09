# Superset Feature Adoption: Cmd-Click, Stop Button, Terminal Hardening

**Date**: 2026-04-09
**Status**: Approved
**Source**: Superset releases desktop-v1.3.0 through desktop-v1.4.7

## Overview

Three features inspired by Superset's recent releases, adapted for Impala's Tauri/Rust architecture:

1. **Cmd-click file paths to open in editor** — everywhere (terminal, diff view, annotations)
2. **Stop button for run scripts** — swap play→stop in the title bar while running
3. **Terminal stability** — spawn failure cleanup + basic backpressure

All three share a common foundation: a file-path resolution layer that upgrades `open_in_editor` to support file-level + line:col opening.

---

## 1. Shared File-Path Resolution Layer

### Rust backend — upgrade `open_in_editor`

Current signature: `open_in_editor(editor, path)` — opens a directory.

New signature:

```
open_in_editor(editor: String, path: String, line: Option<u32>, col: Option<u32>)
```

Each editor gets line:col formatting:

| Editor | Command |
|--------|---------|
| VS Code / Cursor | `--goto path:line:col` |
| Zed | `path:line:col` |
| Sublime | `path:line:col` |
| WebStorm | `--line line --column col path` |

When `line` is `None`, behavior is unchanged (opens file/directory as before).

### New Tauri command — `resolve_file_path`

```
resolve_file_path(base_dir: String, candidate_path: String) -> { absolute_path: String, exists: bool }
```

Resolves a candidate path string relative to a worktree root. Handles `./` prefix, relative paths, `~/`. Results cached in a Rust-side LRU (terminal output often references the same files repeatedly).

### TypeScript module — `file-link-parser.ts`

~50 lines. Three regex patterns:

1. `([\w./-]+\.\w+)(?::(\d+)(?::(\d+))?)?` — standard `path:line:col` (TypeScript, Rust, Go, ESLint, Vite, Jest, grep)
2. `File "([^"]+)", line (\d+)` — Python tracebacks
3. `([\w./-]+\.\w+)\((\d+)(?:,(\d+))?\)` — parenthesized `path(line,col)` (MSBuild, C#)

Returns `{ path: string, line?: number, col?: number }[]` from a line of text. No filesystem calls — consumers validate via `resolve_file_path`.

### TypeScript helper — `openFileInEditor(path, line?, col?)`

Wraps the upgraded Tauri command. Reads preferred editor from UIStore. Single entry point used by cmd-click, diff view, annotations, and the existing `OpenInEditorButton`.

---

## 2. Cmd-Click File Paths to Open in Editor

### Terminal link provider (xterm.js)

Register a custom link provider via `registerLinkProvider` on both `XtermTerminal.tsx` and `FloatingTerminal.tsx`:

1. xterm calls the provider with a line of text on hover/click
2. Provider runs the text through `file-link-parser.ts` to extract candidates
3. Calls `resolve_file_path` for each candidate (LRU-cached, fast)
4. Returns link ranges for matches that exist on disk
5. On Cmd+click: `openFileInEditor(path, line, col)`
6. On hover: tooltip `Cmd+click to open in <editor name>`

### Diff view (CommitPanel / changed files list)

Add `onClick` handler to file names in the changes sidebar. If `event.metaKey` is true, call `openFileInEditor` with the full file path. No line number — just opens the file.

### Diff line numbers

In `DiffView`, make line numbers in the gutter Cmd-clickable. Cmd+click a line number calls `openFileInEditor(filePath, lineNumber)`. Cursor changes to pointer when Cmd is held.

### Annotation file references

When annotations reference a file path + line, make those Cmd-clickable. Same `openFileInEditor` call.

### Visual affordance

- Cmd held: file paths in terminal get underline decoration (xterm link provider handles natively)
- Cmd held: cursor changes to pointer over file names in diff view and annotations
- No visible change when Cmd is not held — keeps the UI clean

---

## 3. Stop Button for Run Scripts

### Title bar button state machine

The existing play button in `MainView.tsx` becomes a contextual Run/Stop toggle:

| State | Icon | Label | Action |
|---|---|---|---|
| **Idle** (no script running) | Play | "Run" | Start run script |
| **Running** | Stop (square) | "Stop" | Send Ctrl+C, then escalate |
| **No script configured** | Play (dimmed) | "Run" | Open project settings |

### Stop behavior

1. User clicks stop → send `\x03` (Ctrl+C) to the floating terminal PTY via `pty_write`
2. Floating terminal status changes from "running" to "stopping"
3. If the process exits → status becomes "stopped", button swaps back to Play
4. If process doesn't exit within 3 seconds → escalate via `pty_kill`, show "Force stopped"

No force-stop dropdown — automatic escalation keeps it simple.

### Floating terminal changes

- "Stopped" status (neutral icon) when stopped by user, distinct from "Failed" (red)
- Existing dismiss button stays (kills session and hides terminal)
- New **restart button** (circular arrow icon) when stopped or failed → re-runs the same command

### Hotkey

Reuse `RUN_SCRIPT` hotkey (Cmd+Shift+R) as a toggle. If running → stop. If stopped → start.

---

## 4. Terminal Stability — Spawn Failure Cleanup + Basic Backpressure

### Spawn failure cleanup (Rust — `pty.rs`)

If `CommandBuilder::new().spawn()` fails:

1. Remove the session from `PtyState` HashMap immediately
2. Emit `pty-error-{id}` event with error message (new event type)
3. Frontend listens → shows error in terminal pane (red text) or floating terminal (failed status)

If the read thread or flush thread panics/errors after spawn:

1. Catch the error
2. Clean up the session from `PtyState`
3. Emit `pty-exit-{id}` with non-zero code

### Dead session detection

New command: `pty_is_alive(sessionId: String) -> bool`

Checks if the child process is still running. Frontend calls this when re-attaching to a session (e.g. switching worktrees) to detect and clean up stale sessions.

### Basic backpressure (Rust — `pty.rs`)

Two guards on the existing 16ms flush loop:

1. **Size cap per flush**: max 128KB per event. If more data is pending, flush 128KB and leave the rest for the next tick. Prevents a single massive event from overwhelming the frontend.

2. **Pending buffer high watermark**: if pending buffer exceeds 1MB, pause PTY reads (stop reading from master fd). Resume when it drains below 256KB. Hysteresis (4:1 ratio) prevents oscillation.

### Frontend resilience (`XtermTerminal.tsx`)

Guard on `pty-output-{id}` handler: if xterm's `write()` hasn't processed the previous chunk, buffer locally and retry on next animation frame. Prevents xterm from choking on burst output.

---

## Architecture Summary

```
file-link-parser.ts          (parse text → path candidates)
        │
        ▼
resolve_file_path [Tauri]    (validate path exists, LRU-cached)
        │
        ▼
openFileInEditor()           (read preferred editor → open_in_editor Tauri cmd)
        │
        ├── XtermTerminal link provider (Cmd+click in terminal)
        ├── FloatingTerminal link provider (Cmd+click in floating terminal)
        ├── DiffView file names (Cmd+click in changes sidebar)
        ├── DiffView line numbers (Cmd+click gutter)
        ├── Annotation references (Cmd+click annotation links)
        └── OpenInEditorButton (existing, upgraded to use shared helper)

pty.rs
        ├── Spawn failure cleanup (remove dead sessions, emit pty-error)
        ├── Backpressure (128KB cap, 1MB high watermark, pause/resume reads)
        └── pty_is_alive command (dead session detection)

MainView.tsx / FloatingTerminal.tsx
        └── Run/Stop toggle (play→stop icon, Ctrl+C→escalate→pty_kill)
```

## What's NOT in scope

- Full file tree sidebar (Superset's file browser)
- PR review integration
- Drag-and-drop pane rearrangement
- Notification sound volume
- Multiple agent orchestration
- Force-stop dropdown menu (automatic escalation instead)
