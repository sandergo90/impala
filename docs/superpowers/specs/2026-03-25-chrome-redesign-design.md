# Chrome Redesign: Sidebar, Title Bar, and Commits Panel

## Summary

Redesign all three navigation surfaces (sidebar, title bar, commits panel) for visual consistency and polish. The app's structure and behavior stay the same — this is a visual overhaul, not a feature change.

**Design reference:** `.superpowers/brainstorm/3938-1774437224/full-chrome.html`

## Design Decisions

- **Sidebar layout:** Dropdown project switcher at top, worktree list below with branch icons and commit-ahead counts. "Open Project" pinned at bottom.
- **Title bar:** Sidebar toggle left, branch context center (`project / branch · N ahead of base`), Diff/Terminal/Split tabs and Changes toggle merged into the right side — eliminates the separate tab bar row.
- **Commits panel:** Same structure (Uncommitted Changes, All Changes, commit list, changed files), polished with consistent styling.
- **Accent color:** Blue (`#3b82f6`) for selected states, consistent across all surfaces.
- **Scope:** Visual polish only. No structural or behavioral changes to CommitPanel.

## Visual System

These patterns apply uniformly across all three surfaces.

### Selection & Focus

- **Selected item:** `background: rgba(59,130,246,0.08)`, `border-left: 2px solid #3b82f6`, text brightened to `#e5e5e5`
- **Hover:** `background: rgba(255,255,255,0.03)`
- **Unselected text:** `#999` for names, `#555` for metadata

### Section Headers

- `9px` uppercase, `letter-spacing: 1.2px`, color `#555`
- Optional action button (e.g., `+`) right-aligned in same row

### Borders

- Structural dividers: `1px solid rgba(255,255,255,0.06)`
- Subtle item separators: `1px solid rgba(255,255,255,0.03)`

### Typography

- UI text: system font (`-apple-system, SF Pro Text`), 11-12px
- Code/paths/hashes: `SF Mono` / monospace, 10-11px
- Metadata: 9px, color `#555`

## Component Specifications

### 1. Title Bar (App.tsx)

**Before:** Sidebar toggle left, empty center, "Changes" button right. Separate tab bar row below for Diff/Terminal/Split.

**After:** Single 40px row combining everything:

```
[ traffic lights ] [ sidebar toggle ] ... [ project / branch · N ahead of base ] ... [ Diff | Terminal | Split | Changes ]
```

- **Sidebar toggle:** Same icon, styled as `titlebar-btn` (muted, hover highlight)
- **Context center:** `project` in `#555`, `/` separator in `#444`, `branch` in `#bbb` mono font weight 500, `·` separator, `N ahead of base` in `#555`
- **Tab pills (right):** 11px, padding `4px 10px`, border-radius 5px. Active: `background: rgba(255,255,255,0.08), color: #ddd`. Inactive: `color: #666`. Separator pipe between Split and Changes. When Split is active, Diff and Terminal pills are disabled (`opacity: 0.3, cursor: not-allowed`) — same behavior as current tab buttons.
- **Removes:** The separate tab bar `<div>` currently rendered when a worktree is selected. Tabs move into the title bar.
- **Drag region:** The center context area remains a Tauri drag region.
- **Context data:** "N ahead of base" uses `commits.length` and `baseBranch` from the current worktree state. When no worktree is selected, the center shows nothing. When `baseBranch` is null, omit the "ahead of" text.

### 2. Sidebar (Sidebar.tsx)

**Before:** Flat text list with "PROJECTS" / "WORKTREES" uppercase headers, plain text buttons.

**After:**

#### Project Switcher (top)
- Container: `margin: 10px`, `padding: 6px 10px`, `background: #222`, `border-radius: 6px`
- Left: Colored initial badge — 20x20px, border-radius 5px, white bold letter, background color derived from project name (hash to hue)
- Center: Project name, 12px, weight 500, `#e5e5e5`
- Right: Chevron `▾`, `#555`
- On click: Shows a custom popover dropdown listing all projects + "Open Project" at the bottom. Each project row has a hover-visible `×` remove button (preserving existing remove functionality). Implemented as a simple absolutely-positioned div, not a native menu.
- Hover: `background: #282828`

#### Worktrees Section
- Section header: "Worktrees" with `+` action button (opens New Worktree dialog)
- Each worktree item:
  - Git branch icon (SVG, 14x14) — `#555` default, `#3b82f6` when selected
  - Name: 11px, `#999` default, `#e5e5e5` weight 500 when selected
  - Metadata line below name: "N commits ahead", 9px, `#555` default, `#6b7280` when selected
  - Selected state: blue left border + blue-tinted background (see Visual System)
- Items: `padding: 6px 12px`, `margin: 1px 8px`, `border-radius: 5px`

#### Bottom Action
- "Open Project" with `+` icon, pinned to bottom via `margin-top: auto`
- `border-top: 1px solid rgba(255,255,255,0.06)`, `padding: 8px 14px`
- Color `#444`, hover `#888`

### 3. Commits Panel (CommitPanel.tsx)

**Before:** Functional but visually inconsistent with the sidebar (different spacing, no icons, different selected treatment).

**After:** Same structure, unified styling:

#### Header
- Section header style: "Commits on `branch-name`" where branch name is in mono font, 10px, normal case

#### Special Items (Uncommitted Changes, All Changes)
- Same layout as commit items but with `border-bottom: 1px solid rgba(255,255,255,0.06)` to visually separate from the commit list
- "Uncommitted Changes" — subtitle "Working tree"
- "All Changes" — subtitle "vs `baseBranch`"

#### Commit Items
- Message: 11px, `#bbb`, weight 500, truncated with ellipsis
- Detail row: hash (7 chars) `·` date, mono font 9px, `#555`
- Stats right-aligned: `+N` in `#4ade80`, `-N` in `#f87171`
- Selected: blue left border + tinted background, message brightens to `#e5e5e5`
- Item separators: `1px solid rgba(255,255,255,0.03)`

#### Changed Files
- Section header: "Changed Files", uppercase 9px
- File items: mono font 10px, `#888`
- Status badge: 9px bold, fixed 12px width — M: `#4ade80`, A: `#34d399`, D: `#f87171`
- Show filename only (not full path), truncated with ellipsis
- Selected: `color: #3b82f6`, `background: rgba(59,130,246,0.06)`

## Files to Modify

| File | Change |
|------|--------|
| `apps/desktop/src/App.tsx` | Merge tab bar into title bar, add branch context center, remove separate tab bar div |
| `apps/desktop/src/components/Sidebar.tsx` | Replace flat list with project switcher dropdown + styled worktree list |
| `apps/desktop/src/components/CommitPanel.tsx` | Apply unified visual styling (selection, spacing, typography) |
| `apps/desktop/src/index.css` | No changes expected — all styling via Tailwind classes |

## What Stays the Same

- All existing functionality and state management
- Resizable panel system (ResizablePanelGroup)
- Sidebar collapse/expand behavior
- CommitPanel structure (Uncommitted, All Changes, commits, files)
- DiffView component (untouched)
- All Tauri commands and data flow
