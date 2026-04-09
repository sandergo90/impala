# Configurable Claude Flags & Settings Consolidation

## 1. Configurable Claude Flags

- **Setting name:** `claudeFlags` — string of CLI flags passed to `claude`
- **Default:** empty (command is just `claude`)
- **Scope:** Global + per-project override (per-project wins when set)
- **Command construction:** `claude ${claudeFlags}` + `--continue` auto-appended on re-launches within same worktree
- **UI:** Simple text input on:
  - Claude Integration settings pane (global)
  - Project settings page (per-project override)

## 2. Database Rename

- `annotations.db` → `impala.db`
- One-time rename on startup: if `annotations.db` exists and `impala.db` does not, rename
- MCP server (`backend/mcp`) updated to use `impala.db` too

## 3. New Tables

### `settings` — generic key-value with scope

```sql
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global',
    value TEXT NOT NULL,
    PRIMARY KEY (key, scope)
);
```

Used for:
- `claudeFlags` (global + per-project scope)
- `linearApiKey` (global)
- `hotkeyOverrides` (global, stored as JSON blob)

### `projects` — project registry

```sql
CREATE TABLE IF NOT EXISTS projects (
    path TEXT PRIMARY KEY
);
```

## 4. Data Migrations (on startup, delete old sources after)

1. Rename `annotations.db` → `impala.db`
2. Read `hotkeys.json` → insert into `settings` table as `hotkeyOverrides` → delete file
3. Read `projects.json` → insert into `projects` table → delete file
4. `linearApiKey` from localStorage → save to `settings` table → remove from localStorage (frontend-initiated)

## 5. What stays unchanged

- `.impala/config.json` for `setup`/`run` scripts (project-scoped, potentially committable)
- UI preferences (theme, font size, sidebar sizes, etc.) in Zustand/localStorage
