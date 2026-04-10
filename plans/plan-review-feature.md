# Plan Review Feature — Design Spec

## Overview

Add a plan review and annotation system to Impala, allowing users to review markdown plans (created by Claude's writing-plans skill or manually), annotate them with line-level comments, and send structured feedback back to Claude via approve/request changes flow.

## Trigger & Handoff

- **Primary:** Claude calls `submit_plan_for_review(plan_path, title?, worktree_path?)` MCP tool at the end of the writing-plans skill
- **Fallback:** User manually opens any `.md` file from within Impala (e.g., browsing `.claude/plans/*.md`)
- **Blocking MCP call:** `submit_plan_for_review` does not return until the user clicks Approve or Request Changes. Returns the decision and all annotations in a single response. Includes a timeout with graceful fallback ("review still pending").

## UI Layout

### Center Pane — Plan View
- New `plan` mode alongside existing `diff` / `terminal` / `split`
- Rendered markdown (via `react-markdown`) with a line number gutter
- Click a line number to open annotation form
- Annotation indicators in the gutter for lines with comments
- **Top toolbar:** plan title, Approve button, Request Changes button, Close button

### Right Sidebar — Plan Annotations Panel
- When center pane is in plan view, the right sidebar switches to a dedicated **Plan Annotations** panel (replaces Changes/Annotations tabs)
- Lists all annotations for the current plan
- Click to scroll to annotation in the plan view
- Resolve, delete, edit actions on individual annotations

## Annotation System

### Types
- **Line-level comments:** tied to a specific line in the markdown source
- **Block-level comments:** tied to a block (heading, paragraph, code block, list item)

### Components (new, separate from code review)
- `PlanView.tsx` — center pane plan renderer with line gutters
- `PlanToolbar.tsx` — top bar with title and approve/request changes buttons
- `PlanAnnotationsPanel.tsx` — right sidebar annotation list
- `PlanAnnotationDisplay.tsx` — individual annotation card
- `PlanAnnotationForm.tsx` — inline form for creating/editing annotations

## Notification

When a plan is submitted via MCP:
- **Toast notification:** "New plan ready for review" — clickable to navigate to plan view
- **Badge on worktree** in the sidebar (reuse existing unseen-result dot pattern)

## Multiple Plans & History

- One active plan displayed at a time per worktree
- Submitting a new plan increments the version number
- "Previous versions" dropdown in the toolbar to view earlier submissions
- Plan diffing is deferred to a future iteration

## Database Schema

### `plans` table
```sql
CREATE TABLE plans (
    id TEXT PRIMARY KEY,
    plan_path TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    title TEXT,
    status TEXT DEFAULT 'pending',  -- pending, approved, changes_requested
    version INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

### `plan_annotations` table
```sql
CREATE TABLE plan_annotations (
    id TEXT PRIMARY KEY,
    plan_path TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    line_number INTEGER NOT NULL,
    body TEXT NOT NULL,
    resolved INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

## MCP Tools

### New tools (added to existing `impala-mcp` server)

1. **`submit_plan_for_review(plan_path, title?, worktree_path?)`**
   - Writes plan to `plans` table with status `pending`
   - Notifies Impala frontend via Tauri event
   - **Blocks** until user clicks Approve or Request Changes
   - Returns: `{ status: "approved" | "changes_requested", annotations: [...] }`
   - Timeout with graceful "still pending" response

2. **`get_plan_decision(plan_path)`**
   - Returns current plan status and all annotations
   - Used by skills to re-fetch if the blocking call timed out

3. **`list_plans(worktree_path?)`**
   - Lists all tracked plans, optionally filtered by worktree
   - Supports manual plan browsing in Impala

## Feedback Flow

1. Claude's writing-plans skill creates a plan and calls `submit_plan_for_review`
2. Impala shows toast + badge, user navigates to plan view
3. User reads plan, adds line-level annotations
4. User clicks **Approve** or **Request Changes**
5. Impala updates plan status in SQLite, writes annotations
6. The blocking MCP call returns with the decision and structured annotation data
7. Claude receives the feedback and either proceeds with implementation (approved) or revises the plan (changes requested)

## Manual Open Flow

- User can open any `.md` file in plan view without MCP submission
- Annotations still work and are stored in `plan_annotations`
- No approve/request changes flow — just annotation for personal reference
- `list_plans` MCP tool can surface these to Claude if needed
