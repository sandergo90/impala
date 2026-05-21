# Annotations View Redesign — Code-Anchored Layout

**Date:** 2026-05-21
**Status:** Approved design, ready for implementation plan

## Problem

The Annotations tab (`AnnotationsPanel.tsx` + `AnnotationDisplay.tsx`) renders each
annotation as a bordered card with a redundant "You" avatar, a blue `L:n`/`R:n` link,
relative time, the comment body, and a column of three stacked text buttons
(Resolve / Agent / ×). The result is low density — only three or four annotations fit
on screen — and heavy per-card chrome. There is also no indication of *what* code a
comment refers to without jumping to the diff.

## Goal

Redesign the panel as a **code-anchored review queue**: each annotation shows the diff
line it is pinned to (plus one line of context on each side), so the reviewer sees the
flagged code inline. Increase density and match Impala's dense, hover-driven panels.

## Scope

In scope: `AnnotationsPanel.tsx`, `AnnotationDisplay.tsx`, the `annotations` table and
its create path, and the `Annotation` / `NewAnnotation` types.

Out of scope: DiffView's inline annotation rendering (the comment shown inside the diff
itself), and all PlanAnnotation components — they are unchanged.

## Data layer

Annotations gain a captured code snippet so the panel can render context without
loading or re-parsing diffs.

### Schema

Add a nullable column to the `annotations` table:

```sql
ALTER TABLE annotations ADD COLUMN code_context TEXT
```

Applied as an idempotent migration in `init_db` (`backend/tauri/src/annotations.rs`) —
attempt the `ALTER TABLE`, ignore the "duplicate column name" error so it is safe to
run on every startup.

`code_context` holds a JSON array of up to three entries, ordered by line number:

```json
[
  { "lineNumber": 30, "text": "function Tabs() {" },
  { "lineNumber": 31, "text": "  className={clsx(base, open)}" },
  { "lineNumber": 32, "text": "  onClick={toggle}" }
]
```

The pinned line is identified by the existing `line_number` field — no extra flag
needed. At hunk boundaries fewer than three entries are stored (1 or 2). The column is
`NULL` for annotations created before this change.

### Types

- Rust: `Annotation` gains `pub code_context: Option<String>` (raw JSON string).
  `NewAnnotation` gains `pub code_context: Option<String>`. `create_annotation`,
  `list_annotations`, and `get` SELECT/INSERT statements include the new column.
- TS (`types.ts`): `Annotation` and `NewAnnotation` gain `code_context?: string`.

The MCP server (`backend/mcp/`) reads annotations with explicit column lists and is not
affected; it simply does not request the new column.

### Capture at creation

A new pure helper extracts the snippet from the unified diff text already in the store:

```
extractCodeContext(diffText: string, lineNumber: number, side: "left" | "right")
  : { lineNumber: number; text: string }[]
```

It parses hunk headers (`@@ -a,b +c,d @@`), walks the hunk tracking old- and new-file
line numbers, and returns the target line plus any immediate neighbor that exists
**within the same hunk**. For `side: "right"` it keys off new-file line numbers
(additions + context lines); for `side: "left"`, old-file line numbers
(deletions + context lines). Returns `[]` if the line cannot be located.

`handleCreate` (`hooks/useAnnotationActions.ts`) calls this helper with the file's diff
text from the data store, JSON-stringifies a non-empty result, and passes it as
`code_context` to `sqliteProvider.create`. An empty result is sent as `undefined` /
`NULL`.

This helper is independently testable: given a diff string + line + side, it returns a
known set of context lines.

## Panel — `AnnotationsPanel.tsx`

Structure is unchanged: actions header (`Resolved` toggle + `Send all to Agent`),
empty/scoped-empty states, and the scoped-vs-grouped logic. One change:

- Each file group header gains a **count badge** — a pill (`bg-muted`, rounded-full,
  small) showing the number of annotations in that group, beside the existing mono
  uppercase filename.

## Item — `AnnotationDisplay.tsx`

Rewritten. The card border and the "You" avatar are removed. Each item is:

1. **Code window** — the `code_context` lines rendered in monospace. Real line numbers
   in a right-aligned gutter. The pinned line (matching `line_number`) gets a
   green-tinted background (`rgba(63,162,102,.13)`-equivalent token usage) and lighter
   text; neighbor lines use muted-foreground. Long lines truncate with ellipsis.
2. **Comment row** — a flex row below the code: the comment body on the left with a
   2px left border (`border-l-2 border-border`, padded), and a right-aligned meta
   column holding the relative time (always visible, muted) above the hover actions.
3. **Hover actions** — compact icons `✓` (resolve, green) and `✕` (delete, muted),
   `opacity-0` at rest, `opacity-100` on item hover. The per-item "Agent" action is
   removed entirely — sending to the agent is panel-level only.

### Resolved state

The whole item drops to `opacity-50` and the code window text dims further. The meta
column shows a static `✓ Resolved` label instead of the hover actions (clicking it
un-resolves, preserving today's toggle behavior).

### Fallback — no `code_context`

Annotations created before this change (or where extraction returned `[]`) have no
snippet. For these, render no code window; instead show a small monospace
`L:n` / `R:n` reference line above the comment so the location is still identified.
The comment row and actions are unchanged.

## Verification

- Schema migration runs cleanly on an existing DB and is idempotent across restarts.
- `extractCodeContext` unit tests: mid-hunk line (3 entries), first/last line of a hunk
  (2 entries), deletion-side line, line not found (`[]`).
- Creating an annotation in the diff persists `code_context`; reopening the app shows
  the 3-line window.
- A pre-migration annotation (`code_context = NULL`) renders with the `L:n`/`R:n`
  fallback, not a broken/empty code window.
- Resolve, un-resolve, and delete still work from the new hover actions; `Send all to
  Agent` and the `Resolved` toggle behave as before.
- File group headers show correct counts.
