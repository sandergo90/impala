# Differ — Design Spec

A Tauri-based Mac app for reviewing git worktree changes with rich diff rendering and annotations.

## Problem

There's no dedicated Mac app for viewing git worktree changes with high-quality diff rendering. Existing tools either lack worktree awareness or have basic diff UIs. Pierre's `@pierre/diffs` library provides best-in-class diff rendering but is web-only with no standalone app.

## Solution

A lightweight Tauri desktop app that lets a solo developer open multiple git projects, browse their worktrees, view diverged commits, and review changed files using `@pierre/diffs` — with inline annotations for personal code review notes.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| App shell | Tauri v2 (Rust backend) |
| Frontend | React 19, TypeScript |
| Bundler | Vite |
| Styling | Tailwind CSS |
| Components | [shadcn/ui with Base UI primitives](https://ui.shadcn.com/docs/components/base/accordion) (`--base base`) |
| Diff rendering | @pierre/diffs (React, split/unified, annotations) |
| State management | Zustand |
| Annotation storage | SQLite via tauri-plugin-sql |
| Git operations | Git CLI via Rust `Command::new("git")` |

## Architecture

### Three Layers

1. **Tauri Shell (Rust)** — Thin bridge that executes git CLI commands and returns structured JSON to the frontend. Handles file system access and SQLite for annotations. No git library — just `Command::new("git")` with `--porcelain` flags where available.

2. **React Frontend** — Single-page app with a three-panel layout. Uses `@pierre/diffs` for rendering diffs with annotations. State managed with Zustand.

3. **Annotation Layer** — SQLite database managed by Tauri, exposed via commands. A `CommentProvider` interface abstracts storage so a future backend (GitHub, API) can be swapped in.

### Git Command Execution

All git commands run with `-C <worktree_path>` to target the correct worktree. This ensures commands execute in the right context regardless of the app's working directory.

### Data Flow

```
First launch
  → Empty state: single "Open Project" button
  → Opened projects persisted in Tauri app data directory (projects.json)
  → On subsequent launches, previously opened projects are restored

User opens folder
  → Tauri: git -C <path> worktree list --porcelain
  → React: renders worktree sidebar

User selects worktree
  → Tauri: detect_base_branch, then git -C <path> log <base>..HEAD --format=...
  → React: renders diverged commit list

User selects commit
  → Tauri: git -C <path> diff-tree --no-commit-id -r --name-status <hash>
  → React: renders changed file list

User selects file (single commit mode)
  → Tauri: git -C <path> diff <hash>~1..<hash> -- <file>
  → React: @pierre/diffs renders the diff for that commit

User selects "All Changes" view
  → Tauri: git -C <path> diff <base>...HEAD -- <file>
  → React: @pierre/diffs renders the aggregate diff against the base branch

User adds annotation
  → React: calls Tauri create_annotation command
  → Tauri: SQLite insert
  → React: annotation rendered via Pierre's annotation framework
```

## UI Layout

Three-panel layout:

```
┌──────────────┬───────────────────┬─────────────────────────────────┐
│ Projects     │ Commits           │ Diff View                       │
│              │ on feature/auth   │ ┌─────────────────────────────┐ │
│ ● my-app     │                   │ │ src/auth/login.tsx          │ │
│   api-server │ ● Add login form  │ │ [Split] [Unified] [Wrap]    │ │
│              │   Setup middleware│ ├─────────────┬───────────────┤ │
│ Worktrees    │   Add user model  │ │ - old code  │ + new code    │ │
│              │                   │ │             │               │ │
│  feature/auth│ Changed Files     │ │             │               │ │
│  fix/header  │                   │ │             │               │ │
│  refactor/api│ M login.tsx       │ ├─────────────┴───────────────┤ │
│              │ M validate.ts     │ │ 💬 Annotation on line 4     │ │
│              │ A types.ts        │ │ "Should we validate email?" │ │
│ + Open       │ D old-auth.ts     │ └─────────────────────────────┘ │
└──────────────┴───────────────────┴─────────────────────────────────┘
```

- **Left sidebar**: Projects list + worktrees for selected project (with diverged commit counts)
- **Middle panel**: Diverged commits on selected worktree + changed files for selected commit. An "All Changes" option at the top shows the aggregate diff against the base branch.
- **Right panel**: Diff view rendered by `@pierre/diffs` with split/unified/wrap toggles, plus inline annotations

## Tauri Backend Commands

### Git Operations

| Command | Git CLI | Returns |
|---------|---------|---------|
| `list_worktrees(repo_path)` | `git worktree list --porcelain` | `[{ path, branch, head_commit }]` |
| `get_diverged_commits(worktree_path, base_branch?)` | `git log <base>..HEAD --format=...` | `[{ hash, message, author, date }]` |
| `get_changed_files(worktree_path, commit_hash)` | `git diff-tree --no-commit-id -r --name-status` | `[{ status, path }]` |
| `get_commit_diff(worktree_path, commit_hash, file_path)` | `git diff <hash>~1..<hash> -- <file>` | Raw unified diff for a single commit |
| `get_branch_diff(worktree_path, file_path)` | `git diff <base>...HEAD -- <file>` | Raw unified diff for all changes against base |
| `get_file_content(worktree_path, ref, file_path)` | `git show <ref>:<path>` | File content string |
| `detect_base_branch(worktree_path)` | Tries branches in order | Branch name string |

### Base Branch Detection

Tries branches in this order:
1. `develop`
2. `main`
3. `master`
4. Fallback: default remote branch (`git symbolic-ref refs/remotes/origin/HEAD`)
5. Final fallback: first commit on the current branch (`git rev-list --max-parents=0 HEAD`) — shows all commits if no known base branch exists

### Annotation CRUD

| Command | Description |
|---------|------------|
| `create_annotation(annotation)` | Insert into SQLite |
| `list_annotations(repo, file?, commit?)` | Query by scope — all params optional except repo. Omit file/commit to get all annotations for a project. |
| `update_annotation(id, changes)` | Partial update |
| `delete_annotation(id)` | Hard delete |

## Annotation Data Model

### SQLite Schema

```sql
CREATE TABLE annotations (
  id TEXT PRIMARY KEY,        -- UUID
  repo_path TEXT NOT NULL,
  file_path TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  side TEXT NOT NULL,          -- 'left' or 'right'
  body TEXT NOT NULL,
  resolved INTEGER DEFAULT 0, -- boolean
  created_at TEXT NOT NULL,    -- ISO 8601
  updated_at TEXT NOT NULL     -- ISO 8601
);

CREATE INDEX idx_annotations_scope
  ON annotations(repo_path, file_path, commit_hash);
```

### CommentProvider Interface

```typescript
interface Annotation {
  id: string
  repoPath: string
  filePath: string
  commitHash: string
  lineNumber: number
  side: 'left' | 'right'
  body: string
  resolved: boolean
  createdAt: string
  updatedAt: string
}

interface NewAnnotation {
  repoPath: string
  filePath: string
  commitHash: string
  lineNumber: number
  side: 'left' | 'right'
  body: string
}

interface CommentProvider {
  list(repo: string, file: string, commit: string): Promise<Annotation[]>
  create(annotation: NewAnnotation): Promise<Annotation>
  update(id: string, changes: { body?: string; resolved?: boolean }): Promise<Annotation>
  delete(id: string): Promise<void>
}
```

The SQLite provider implements this interface for v1. The interface enables future backends (GitHub PR comments, team API) without changing the frontend.

## Key Behaviors

- **Multi-project**: User can open multiple unrelated git repos. All appear in the left sidebar.
- **Diverged commits only**: Shows commits on the worktree's branch since it diverged from the base branch — not the full history.
- **Diff view toggle**: Split (side-by-side) and unified (stacked) views, switchable via toolbar. Both rendered by `@pierre/diffs`.
- **Line wrapping toggle**: Wrap long lines on/off.
- **Annotation rendering**: Uses Pierre's annotation framework (`[data-line-annotation]` slots) to render inline comments on diff lines.
- **Resolve annotations**: Mark annotations as resolved without deleting. Resolved annotations can be hidden/shown.
- **Annotation integration with Pierre**: Annotations are passed as props to `@pierre/diffs` components and rendered into Pierre's `[data-line-annotation]` slots. See [Pierre annotation docs](https://diffs.com/docs) for the slot API.

## Persistence

- **Opened projects**: Stored in `projects.json` in Tauri's app data directory (`~Library/Application Support/com.differ.app/`). Contains the list of repo paths. Restored on launch.
- **Annotations database**: SQLite file stored in the same app data directory (`annotations.db`). A single database for all projects, scoped by `repo_path`.
- **UI state** (selected project, worktree, panel sizes): Stored in Zustand with persistence to `localStorage`.

## Error & Empty States

| State | Behavior |
|-------|----------|
| First launch, no projects | Empty state with "Open Project" button |
| Folder is not a git repo | Toast error: "Not a git repository" |
| No worktrees (only main checkout) | Show the main checkout as the single worktree |
| No diverged commits | Middle panel shows "No commits ahead of `<base>`" |
| Git binary not found | Blocking error dialog on startup with install instructions |
| Diff generation fails | Error message in diff panel with the git error output |

## Out of Scope (v1)

- Team/collaborative features (sharing annotations)
- GitHub/GitLab integration
- Merge conflict resolution
- Creating or managing worktrees from the app
- Commit or push operations
- File editing
