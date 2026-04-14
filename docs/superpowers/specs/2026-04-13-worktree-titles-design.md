# Worktree Titles — Design

## Goal

Give every worktree a human-readable title that becomes the primary label in the sidebar, so users can recognize worktrees at a glance in a list of 10+, see Linear issue context that is currently hidden, and read prose labels instead of slugified branch names. Branch names remain visible and accessible — they just drop to a secondary role.

## Motivation

Current sidebar rows show the branch name as the primary label. This fails in three ways:

1. Branch names blur together when there are many worktrees.
2. Linear-linked worktrees already have rich context (issue title) that is only visible on hover.
3. Slugified names (`fix-modal-close-regression`) read poorly as prose ("Fix modal close regression").

A stored, editable title fixes all three with one change.

## Data model

A new SQLite table `worktrees`, a sibling to the existing `worktree_issues` table. `worktree_issues` is left unchanged — merging them is an unrelated refactor with its own risk.

```sql
CREATE TABLE IF NOT EXISTS worktrees (
  path  TEXT PRIMARY KEY,
  title TEXT NOT NULL
);
```

The table leaves room for future per-worktree metadata (custom color, archived flag, etc.) without another migration.

## Title generation

All deterministic, local, synchronous. No LLM, no network, no async state. Three sources depending on how the worktree was created:

### Linear tab

Use `selectedIssue.title` verbatim. The user picked the issue deliberately — its title is already what they are thinking of. Prefix-stripping (`[Bug]`, `Fix:`, `EPIC:`) is a rabbit hole with no clean rule that will not occasionally mangle a legitimate title. If the result is ugly, the rename flow handles it.

### New branch / existing branch tabs

De-slugify the branch name:

1. Strip everything up to and including the last `/`. This handles every namespace (`feature/`, `sander/`, `renovate/`, nested `team/sub/foo`) with one rule.
2. Strip a leading ticket-id pattern like `ENG-123-`. The regex: `^[A-Z][A-Z0-9]+-\d+-`.
3. Replace `-` and `_` with spaces.
4. Sentence case: capitalize the first letter only. Leaves acronyms (API, URL) intact.
5. If the result is empty or whitespace, fall back to the raw branch name.

Examples:

| Branch | Title |
|---|---|
| `feature/password-reset` | `Password reset` |
| `fix/modal-close-bug` | `Modal close bug` |
| `ENG-123-add-auth` | `Add auth` |
| `sander/scratch` | `Scratch` |
| `renovate/bun-lock` | `Bun lock` |
| `release/desktop-v0.3.1` | `Desktop v0.3.1` |
| `main` | `main` (see below) |

### Main worktrees

`main`, `master`, and `develop` are structural, not semantic. They do not get a row in the `worktrees` table and are never renamed. The sidebar renders them exactly as today — branch name only, no title, no pill. The sidebar already special-cases these branches for the delete button (`Sidebar.tsx:818-820`), and the same check is reused.

### Lazy backfill

`list_worktrees` walks git worktrees and looks up titles from the `worktrees` table. When a row is missing and the worktree is not a main worktree, insert a row on the fly using the de-slug rules. This handles:

- Pre-existing worktrees from before this feature ships.
- Worktrees created outside Impala (`git worktree add` in the terminal).

The insert is a single upsert per unknown worktree, happens once per worktree, and is negligible overhead on the read path. The existing `list_worktrees` command already holds the DB connection via `DbState`.

## Sidebar display (Option B)

The primary row shows the title with the branch name as a compact monospace pill, and the secondary line is unchanged from today:

```
[icon] Password reset flow  [pw-reset]              [+5 -2]
       3 ahead · ENG-123
```

- **Primary span:** title, truncated with ellipsis when the row is narrow.
- **Pill:** branch name, short-form (the portion after the last `/`), small monospace, muted background, truncated with `max-width` when long. Tooltip (`title=` attr) shows the full branch name.
- **Secondary line:** `{ahead} ahead` or `up to date`, optionally followed by `·` and the clickable Linear identifier. Exactly as today.
- **Full title:** exposed via `title=` attribute on the primary span so hover reveals overflow.

The existing stats badge and hover-delete `×` stay where they are.

### Collapsed sidebar

The collapsed sidebar is icon-only with a native tooltip on hover. The tooltip shows the **title** instead of the branch name. When the worktree has no title (main worktrees), it keeps the branch name.

### Main worktree rows

Render exactly as today. No title, no pill, no rename menu.

## Rename

Right-click a worktree row in the sidebar → context menu → **Rename**. The title becomes an inline text input; Enter saves, Escape cancels, click-away saves.

This introduces a new context-menu primitive in the sidebar (there is no context menu today — delete is a hover `×`). Implementation adds a thin wrapper around `@base-ui/react` (already a dependency, used for AlertDialog) to serve as the foundation for future row actions.

Rename is a pure text edit: it does not affect any Linear link, it does not rewrite git state, it is only the value in the `worktrees.title` column. Main worktrees do not show the context menu.

## Backend surface

New Tauri commands:

- `rename_worktree_title(worktree_path, title)` — update the row; create it if missing.

Modified Tauri commands:

- `list_worktrees(repo_path)` — returns `Vec<Worktree>` where each `Worktree` now includes `title: Option<String>`. Performs lazy-backfill insert for non-main worktrees missing rows.
- `create_worktree(repo_path, branch_name, base_branch, existing, initial_title)` — new optional `initial_title` argument. When present (Linear tab), stores it verbatim. When absent, computes the de-slug title and stores it. Main worktrees are never created through this path.
- `delete_worktree(repo_path, worktree_path, force)` — removes the row from `worktrees`. The frontend delete flow already unlinks `worktree_issues`; the new cleanup mirrors it.

## Frontend surface

- TypeScript `Worktree` type gains `title: string | null`.
- `NewWorktreeDialog` passes `initial_title: selectedIssue.title` to `create_worktree` when the Linear tab is active. Other tabs pass no title and let the backend derive it.
- `Sidebar.tsx` row rendering is rewritten for the Option B layout. The `isMain` branch in the existing code (used for the no-delete-button check) is reused to suppress the title/pill/rename UI for main worktrees.
- A new `ContextMenu` component wraps `@base-ui/react` primitives and is attached to the worktree row `<div>`.
- A new `RenameInput` component (or inline logic in the row) handles the edit-in-place flow and calls `invoke("rename_worktree_title", ...)`.

## Out of scope for v1

- LLM-generated titles from commit history or file changes.
- Configurable prefix-strip list (the strip-before-`/` rule covers every case).
- Title preview/edit in `NewWorktreeDialog` at creation time.
- Merging `worktree_issues` into the `worktrees` table.
- Persisting additional per-worktree metadata beyond `title` (but the schema is ready for it).
