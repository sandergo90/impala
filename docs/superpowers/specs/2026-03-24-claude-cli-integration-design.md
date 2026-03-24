# Claude Code CLI Integration — Design Spec

Add worktree creation and an embedded Ghostty terminal to the Differ app, enabling Claude Code CLI to run inside each worktree.

## Features

1. **Create worktrees** from the sidebar — from a new branch or an existing branch
2. **Embedded terminal** per worktree — powered by Ghostty (`ghostty-web` WASM)
3. **Tab-based navigation** — Terminal tab, Diff tab, with a split toggle to show both
4. **Collapsible/fullscreen** — Each view can take the full main area

## Worktree Creation

### UI

A "+ New Worktree" button at the bottom of the worktrees section in the sidebar. Clicking it opens a dialog with:

- **Branch source**: "New branch" or "Existing branch" (dropdown/radio)
- **New branch**: text input for branch name
- **Existing branch**: dropdown listing local and remote branches
- **Base branch** (new branch only): which branch to create from (defaults to detected base)

### Behavior

- Branch name = worktree directory name
- Worktree location: `<repo-root>/.worktrees/<branch-name>`
- Rust backend runs `git worktree add <path> -b <branch>` (new) or `git worktree add <path> <existing-branch>`
- On success, worktree appears in sidebar and is auto-selected
- On failure, toast error with git stderr output

### Tauri Commands

```
create_worktree(repo_path, branch_name, base_branch?, existing: bool) -> Worktree
list_branches(repo_path) -> [{ name, is_remote }]
```

Git CLI mapping:
- `create_worktree` (new): `git -C <repo> worktree add .worktrees/<branch> -b <branch> <base>`
- `create_worktree` (existing): `git -C <repo> worktree add .worktrees/<branch> <branch>`
- `list_branches`: `git -C <repo> branch -a --format='%(refname:short) %(objecttype)'`

Error cases: branch already exists, worktree path conflict, dirty state — all surfaced as toast errors from git stderr.

## Terminal Integration

### Architecture

```
React (ghostty-web) ←→ Tauri Events ←→ Rust (portable-pty) ←→ shell process
```

- **Frontend**: `ghostty-web` npm package renders the terminal in a React component. Pre-built WASM binary (~400KB). The `ghostty-web` API exposes `Terminal` class with `open(container)`, `write(data)`, and input callback.
- **Backend**: `portable-pty` crate spawns a pseudo-terminal with the user's default shell. The PTY gives Claude Code CLI a real TTY for its interactive TUI.
- **Data transport**: Tauri events for bidirectional streaming. PTY output batched at ~16ms intervals to avoid IPC flooding.

### Data Encoding

PTY output is raw bytes (not always valid UTF-8). All data between the PTY and frontend is **Base64 encoded** to safely pass through Tauri's JSON-based IPC:

- `pty_write(session_id, data: String)` — `data` is Base64-encoded bytes from the terminal
- `pty-output-{session_id}` event — `data` is Base64-encoded bytes from the PTY

The frontend decodes Base64 → `Uint8Array` before writing to `ghostty-web`, and encodes input as Base64 before sending to `pty_write`.

### PTY Management

Each worktree gets its own PTY session managed by Rust:

```rust
struct PtySession {
    id: String,              // worktree path as key
    writer: Box<dyn Write>,  // write stdin to the PTY
    child: Box<dyn Child>,   // the child process handle
}
```

Tauri commands:
```
pty_spawn(worktree_path: String) -> String  // returns session ID
pty_write(session_id: String, data: String) -> ()  // data is Base64
pty_resize(session_id: String, rows: u32, cols: u32) -> ()
pty_kill(session_id: String) -> ()
```

PTY output is streamed via Tauri events:
```
Event: "pty-output-{session_id}" -> { data: String }  // Base64 encoded
Event: "pty-exit-{session_id}" -> { code: i32 }
```

### PTY Environment

The spawned shell inherits the user's environment plus:
- `TERM=xterm-256color`
- `COLORTERM=truecolor`
- Working directory set to the worktree path

### WASM Loading

The `ghostty-web` WASM binary (~400KB) is bundled as a static asset in `apps/desktop/public/` (or imported via the npm package's built-in loader). Loaded asynchronously on first terminal mount. A loading spinner shows until WASM is ready.

Tauri's CSP in `tauri.conf.json` must allow `wasm-unsafe-eval` for WASM instantiation:
```json
"security": { "csp": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'" }
```

### Terminal React Component

```tsx
<GhosttyTerminal
  sessionId={sessionId}
  onData={(base64) => invoke("pty_write", { sessionId, data: base64 })}
  onResize={(rows, cols) => invoke("pty_resize", { sessionId, rows, cols })}
/>
```

The component:
- Calls `ghostty-web`'s `init()` then creates a `Terminal` instance
- Listens to `pty-output-{sessionId}` Tauri events, Base64-decodes, writes to terminal
- Encodes user keystrokes as Base64, sends via `pty_write`
- Sends resize events to `pty_resize`
- On unmount, does NOT kill the PTY (session persists when switching worktrees)

### Session Lifecycle

- PTY spawned when a worktree is first selected (lazy)
- PTY persists when switching between worktrees (background)
- PTY killed when app closes (Rust drop handler on app exit)
- Sessions stored in a `HashMap<String, PtySession>` in Tauri managed state (behind a `Mutex`)
- On PTY exit (`pty-exit` event), frontend shows "Process exited" with a "Restart" button
- Terminal scrollback is lost when switching worktrees (v1 limitation — ghostty-web doesn't retain buffer when the DOM element is removed)

### Tauri Permissions

Add to `backend/tauri/capabilities/default.json`:
```json
"shell:allow-execute",
"shell:allow-spawn"
```
These are already present from Phase 1. No additional permissions needed — `portable-pty` uses Rust's `std::process` internally, not Tauri's shell plugin.

## Layout & Navigation

### Tab Bar

When a worktree is selected, the main area shows a tab bar with:
- **Terminal** — Ghostty terminal fullscreen
- **Diff** — Current diff view (commits, changed files, Pierre diffs, annotations)
- **Split** toggle button — Shows both side by side (vertical split, draggable divider, default 50/50)

### State Per Worktree

The Zustand store changes from flat state to per-worktree state:

```typescript
interface WorktreeState {
  ptySessionId: string | null;
  activeTab: 'terminal' | 'diff';
  showSplit: boolean;
  // Diff state (moved from global)
  commits: CommitInfo[];
  selectedCommit: CommitInfo | null;
  changedFiles: ChangedFile[];
  selectedFile: ChangedFile | null;
  diffText: string | null;
  fileDiffs: Record<string, string>;
  baseBranch: string | null;
  viewMode: 'commit' | 'all-changes';
  annotations: Annotation[];
}

interface AppState {
  // Projects
  projects: Project[];
  selectedProject: Project | null;
  // Worktrees
  worktrees: Worktree[];
  selectedWorktree: Worktree | null;
  worktreeStates: Record<string, WorktreeState>; // keyed by worktree path
  // Global UI preferences
  diffStyle: 'split' | 'unified';
  wrap: boolean;
}
```

When `selectedWorktree` changes, the UI reads from `worktreeStates[worktree.path]`. Diff state is scoped per worktree, not global.

### Sidebar Changes

The sidebar simplifies:
- **Projects** section (unchanged)
- **Worktrees** section with commit count badges
- **"+ New Worktree"** button at bottom
- Selecting a worktree loads its tab view

The separate "Commits" middle panel moves into the Diff tab — when in Diff view, the commit/file list appears as a collapsible left sidebar within the diff panel (similar to current layout but contained within the tab).

### Split View

The split toggle creates a vertical split (terminal left, diff right) using CSS flexbox with a draggable divider. Default 50/50. The split preference is per-worktree (stored in `WorktreeState.showSplit`).

## Tech Stack Additions

| Component | Technology |
|-----------|-----------|
| Terminal rendering | `ghostty-web` (npm, pre-built WASM) |
| PTY management | `portable-pty` crate (Rust) |
| Data transport | Tauri events + Base64 encoding |
| Worktree creation | `git worktree add` via git CLI bridge |
| Branch listing | `git branch -a` via git CLI bridge |

### New Dependencies

**Rust (`backend/tauri/Cargo.toml`):**
- `portable-pty`
- `base64` (for encoding PTY output)

**Frontend (`apps/desktop/package.json`):**
- `ghostty-web`

## Out of Scope (v1)

- Multiple terminals per worktree
- Custom shell selection (uses user's default shell)
- Auto-launching `claude` CLI (user types it)
- Linear ticket integration for worktree creation
- Worktree deletion from UI
- Terminal scrollback persistence across tab switches
