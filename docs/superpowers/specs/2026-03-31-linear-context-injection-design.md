# Linear Issue Context for Claude Code Sessions

## Summary

When a worktree is created from a Linear issue, Differ writes the issue's full context (title, description, comments) into a delimited section of `~/.claude/projects/<worktree-path>/CLAUDE.md`. This section is refreshed each time a terminal is spawned for that worktree (rate-limited to once per 5 minutes). Claude Code automatically reads the file, giving every session full awareness of the task.

## Design Decisions

- **`~/.claude/projects/` path** — lives outside the repo, no gitignore needed, Claude Code auto-discovers it per project directory.
- **Write on creation + refresh on spawn** — available immediately, stays fresh as the issue evolves.
- **Section markers, not full overwrite** — Differ owns the content between `<!-- DIFFER:LINEAR_CONTEXT:START -->` and `<!-- DIFFER:LINEAR_CONTEXT:END -->` markers. Any user-written content outside these markers is preserved.
- **Fetch description + comments** — title and description provide the task spec; comments capture decisions and clarifications that aren't in the description.
- **Only Linear-created worktrees** — no manual linking flow. The `worktree_issues` table already tracks which worktrees have linked issues.
- **Best-effort, non-blocking** — failures to fetch or write should not block worktree creation or terminal spawn. Log and move on.
- **Single command** — one Tauri command `write_linear_context` used at both creation and spawn.
- **Rate-limited refresh** — on terminal spawn, skip refresh if the file was updated less than 5 minutes ago (check file mtime). Avoids spamming the Linear API when switching between worktrees or opening multiple panes.
- **Cleanup on delete** — when a worktree is deleted, remove the Linear context section from the CLAUDE.md file (and delete the file + directory if nothing else remains).

## Data Flow

### On worktree creation (frontend → backend)

The existing `handleCreate` in `NewWorktreeDialog.tsx` already calls `link_worktree_issue` after creating the worktree. Add `write_linear_context` to the same `Promise.all`:

```
create_worktree → link_worktree_issue
                → start_linear_issue
                → write_linear_context(api_key, issue_id, worktree_path)  ← NEW
```

### On terminal spawn (frontend → backend)

`SplitTreeRenderer.tsx` spawns PTY sessions in `LeafPane`'s `useEffect`. Before `pty_spawn`, if the worktree has a linked issue, fire-and-forget a `write_linear_context` call:

```
LeafPane useEffect:
  get_worktree_issue(worktree_path)
  → if linked: write_linear_context(api_key, issue_id, worktree_path)  // fire-and-forget
  → getHookPort() → pty_spawn(...)
```

The backend skips the refresh if the file was updated within the last 5 minutes.

### On worktree deletion

The existing `delete_worktree` flow should also clean up the Linear context:

```
delete_worktree → unlink_worktree_issue
               → clean_linear_context(worktree_path)  ← NEW
```

## Backend Changes

### New GraphQL query: `get_issue_detail`

Fetch full issue content including description and comments. Add to `linear.rs`.

```graphql
query($issueId: String!) {
  issue(id: $issueId) {
    identifier
    title
    description
    url
    state { name }
    comments(first: 50) {
      nodes {
        body
        createdAt
        user { displayName }
      }
    }
  }
}
```

New structs in `linear.rs`:

```rust
pub struct LinearIssueDetail {
    pub identifier: String,
    pub title: String,
    pub description: Option<String>,
    pub url: String,
    pub status: String,
    pub comments: Vec<LinearComment>,
}

pub struct LinearComment {
    pub author: String,
    pub body: String,
    pub created_at: String,
}
```

### New module: `linear_context.rs`

**`write_context(api_key, issue_id, worktree_path, force)`**

1. Resolve target path: `~/.claude/projects/<encoded-worktree-path>/CLAUDE.md`
2. If `!force`, check file mtime — skip if updated within last 5 minutes
3. Call `linear::get_issue_detail(api_key, issue_id)`
4. Format the Linear section as markdown (see File Format below)
5. If file exists, read it, replace content between section markers (or append if markers not found)
6. If file doesn't exist, create it with just the section
7. Create parent directories as needed, write file

**`clean_context(worktree_path)`**

1. Resolve target path
2. If file exists, read it, remove section between markers
3. If remaining content is empty/whitespace, delete the file
4. If directory is now empty, delete the directory

### New Tauri commands

```rust
#[tauri::command]
fn write_linear_context(api_key: String, issue_id: String, worktree_path: String) -> Result<(), String>

#[tauri::command]
fn clean_linear_context(worktree_path: String) -> Result<(), String>
```

Register both in `lib.rs` invoke handler. Add `mod linear_context;` to `lib.rs`.

## File Format

The Linear section written between markers in `~/.claude/projects/<encoded-worktree-path>/CLAUDE.md`:

```markdown
<!-- DIFFER:LINEAR_CONTEXT:START -->
# Linear Issue Context

**[FOO-42] Implement dark mode toggle**
Status: In Progress
URL: https://linear.app/team/issue/FOO-42

## Description

<issue description body, verbatim markdown>

## Comments

**Alice** (2026-03-30):
We should use CSS variables for this

**Bob** (2026-03-31):
Agreed, see the design tokens in tokens.css
<!-- DIFFER:LINEAR_CONTEXT:END -->
```

If the user has their own content in the file, it remains untouched outside the markers.

## Frontend Changes

### `NewWorktreeDialog.tsx`

Add `write_linear_context` to the `Promise.all` after worktree creation:

```typescript
await Promise.all([
  invoke("link_worktree_issue", { ... }).catch(() => {}),
  invoke("start_linear_issue", { ... }).catch(() => {}),
  invoke("write_linear_context", {       // ← NEW
    apiKey: linearApiKey,
    issueId: selectedIssue.id,
    worktreePath: worktree.path,
  }).catch(() => {}),
]);
```

### `SplitTreeRenderer.tsx` — `LeafPane` component

Add `linearApiKey` from the store at the component level, and fire-and-forget a context refresh in the existing PTY spawn `useEffect`:

```typescript
const linearApiKey = useUIStore((s) => s.linearApiKey);

// Inside the existing useEffect that auto-spawns PTY:
if (linearApiKey) {
  invoke<WorktreeIssue | null>("get_worktree_issue", { worktreePath })
    .then((issue) => {
      if (issue) {
        invoke("write_linear_context", {
          apiKey: linearApiKey,
          issueId: issue.issue_id,
          worktreePath,
        }).catch(() => {});
      }
    })
    .catch(() => {});
}

// Existing pty_spawn logic follows unchanged
```

### Worktree deletion flow

Wherever `delete_worktree` is called, also call `clean_linear_context`:

```typescript
await invoke("delete_worktree", { repoPath, worktreePath, force });
invoke("clean_linear_context", { worktreePath }).catch(() => {});
```

## Path Encoding

Claude Code uses the convention of replacing `/` with `-` for project directory paths under `~/.claude/projects/`. For a worktree at `/Users/sander/Projects/myapp/worktrees/feature-x`, the CLAUDE.md goes to:

```
~/.claude/projects/-Users-sander-Projects-myapp-worktrees-feature-x/CLAUDE.md
```

## Error Handling

- **Network failure** (Linear API down): silently skip, don't block. The worktree is still usable.
- **Write failure** (permissions, disk): log warning, don't block.
- **Missing API key on refresh**: skip refresh silently. Key might have been removed since worktree creation.
- **Issue deleted in Linear**: the fetch will fail; skip gracefully.
- **Cleanup failure on delete**: log and continue. Orphaned files are harmless.
