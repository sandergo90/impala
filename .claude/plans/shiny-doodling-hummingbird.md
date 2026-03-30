# Unified Right Sidebar with Annotations Panel

## Context

Currently differ has a right-side CommitPanel and a small bottom annotation panel inside DiffView. Inspired by Plannotator's right-side annotations view, we're unifying these into a single right sidebar with tab pills to switch between Changes and Annotations. This removes the bottom panel, centralizes annotation management, and improves discoverability.

## Design Decisions (from grill session)

- **Layout**: Unified right sidebar with `[Changes]` `[Annotations]` tab pills
- **Bottom panel**: Removed from DiffView
- **Title bar**: "Changes" button renamed to "Sidebar", toggles entire sidebar
- **Annotation scope**: Adaptive — all files grouped when no file selected, current file when selected
- **Empty state**: "Click on lines to add annotations" hint
- **Actions**: Resolved filter + "Send all to Claude" in annotations tab header
- **Click-to-scroll**: Clicking annotation scrolls diff to that line
- **Non-diff tabs**: Both tabs always available (annotations useful for Claude in terminal)
- **Inline form**: Stays on diff lines (unchanged)

## Implementation

### Step 1: Create `RightSidebar` wrapper component

**New file**: `apps/desktop/src/components/RightSidebar.tsx`

A container component with tab pills that renders either CommitPanel or AnnotationsPanel:

```
┌───────────────────────┐
│ [Changes] [Annotations]│  ← tab pills (reuse tabPill pattern from App.tsx)
├───────────────────────┤
│                       │
│  <CommitPanel />      │  ← or <AnnotationsPanel />
│  (existing, unchanged)│
│                       │
└───────────────────────┘
```

- Props: none (reads from stores directly)
- State: `activeTab: 'changes' | 'annotations'` (local useState, default 'changes')
- Tab pills: styled identically to existing `tabPill` in App.tsx (11px, rounded-[5px], bg-accent when active)
- Tab bar: `flex items-center gap-1 px-3 py-2 border-b border-border shrink-0`
- Renders `<CommitPanel />` or `<AnnotationsPanel />` based on active tab

### Step 2: Create `AnnotationsPanel` component

**New file**: `apps/desktop/src/components/AnnotationsPanel.tsx`

This component replaces the bottom panel from DiffView. It reads annotations from the store and provides list + actions.

**Data flow** (reuse existing patterns from DiffView):
- Read `annotations` from `useDataStore` via `worktreeDataStates[wtPath].annotations`
- Read `selectedFile` from `useUIStore` via `worktreeNavStates[wtPath].selectedFile`
- Read `changedFiles` from `useDataStore` for the grouped view

**Layout**:
```
┌─────────────────────────┐
│ [✓ Resolved]  [⇒ Claude]│  ← action bar (only when annotations exist)
├─────────────────────────┤
│ Sidebar.tsx             │  ← file group header (when showing all files)
│  • L42 R  "Fix the..."  │  ← AnnotationDisplay (existing component, reused)
│  • L89 R  "Why is..."   │
│                         │
│ App.tsx                 │  ← another file group
│  • L12 R  "Remove..."   │
└─────────────────────────┘
```

Or empty state:
```
┌─────────────────────────┐
│                         │
│    Click on lines to    │
│    add annotations      │
│                         │
└─────────────────────────┘
```

**Scope logic**:
- If `selectedFile` is set → filter annotations to `a.file_path === selectedFile.path`
- If no file selected → show all annotations, grouped by `file_path`, sorted by line_number within each group

**Actions header** (only when annotations exist):
- `showResolved` toggle (same pattern as current DiffView toolbar)
- "Send all to Claude" button (reuse `handleSendAllToClaude` logic — extract to shared hook)

**Click-to-scroll**: Each annotation item is clickable. On click:
1. If on diff tab: select the file (if not already selected), then scroll diff to that line
2. Use `document.querySelector('[data-line-number="N"]')` or PatchDiff's scroll API
3. Brief highlight effect via a CSS animation class

**Reused components**:
- `AnnotationDisplay` from `apps/desktop/src/components/AnnotationDisplay.tsx` — render each annotation card

### Step 3: Extract shared annotation logic into a hook

**New file**: `apps/desktop/src/hooks/useAnnotationActions.ts`

Extract from DiffView.tsx (lines 261-384):
- `handleCreate(body, lineNumber, side, filePath?)`
- `handleResolve(id, resolved)`
- `handleDelete(id)`
- `handleSendToClaude(annotation)`
- `handleSendAllToClaude()`
- `sendPromptToClaude(prompt)`

These are currently defined as `useCallback` hooks in DiffView. Extract them into a custom hook:

```ts
export function useAnnotationActions() {
  // reads selectedProject, selectedFile, selectedCommit, viewMode, annotations, worktreePath from stores
  // returns { handleCreate, handleResolve, handleDelete, handleSendToClaude, handleSendAllToClaude }
}
```

Both `DiffView` and `AnnotationsPanel` will call this hook.

### Step 4: Modify DiffView — remove bottom panel

**File**: `apps/desktop/src/components/DiffView.tsx`

Changes:
1. **Remove** the bottom annotation panel (lines 629-643 — the `visibleAnnotations.length > 0` block)
2. **Remove** the `visibleAnnotations` useMemo (lines 254-259) — no longer needed here
3. **Remove** the "Resolved" and "Send to Claude" buttons from the toolbar (lines 446-467, 469-491) — these move to AnnotationsPanel's action bar
4. **Keep** everything else: inline annotations on diff lines, `renderAnnotation`, `lineAnnotations`, annotation loading, pending form
5. **Replace** local `handleCreate/handleResolve/handleDelete/handleSendToClaude/handleSendAllToClaude` with the shared hook
6. **Keep** the `showResolved` state (needed for inline rendering in `renderAnnotation`)
7. **Keep** the toolbar's Split/Unified/Wrap buttons + Viewed counter

### Step 5: Modify App.tsx — replace CommitPanel with RightSidebar

**File**: `apps/desktop/src/App.tsx`

Changes:
1. **Import** `RightSidebar` instead of (or in addition to) `CommitPanel`
2. **Rename** the `showChanges` state variable to `showSidebar` for clarity
3. **Rename** the title bar button from "Changes" to "Sidebar"
4. **Replace** `<CommitPanel />` with `<RightSidebar />` in the resizable panel (line 448)
5. The `showSidebar` toggle controls visibility of the entire right sidebar

Specific line changes:
- Line 108: `const [showChanges, setShowChanges] = useState(true)` → `const [showSidebar, setShowSidebar] = useState(true)`
- Line 363: `{tabPill("Changes", showChanges, ...)}` → `{tabPill("Sidebar", showSidebar, ...)}`
- Line 403: `defaultSize={showChanges ? "65%" : "85%"}` → `defaultSize={showSidebar ? "65%" : "85%"}`
- Line 443-449: Replace `<CommitPanel />` with `<RightSidebar />`

### Step 6: Sync `showResolved` between DiffView and AnnotationsPanel

Both DiffView (for inline rendering) and AnnotationsPanel (for the list) need `showResolved`. Options:
- **Simplest**: Add `showResolved` to `useUIStore` (not persisted, just runtime state). Both components read from the same source.
- Add to UIState interface and store, no persistence needed.

## Files Summary

| File | Action |
|------|--------|
| `apps/desktop/src/components/RightSidebar.tsx` | **NEW** — tab container |
| `apps/desktop/src/components/AnnotationsPanel.tsx` | **NEW** — annotation list panel |
| `apps/desktop/src/hooks/useAnnotationActions.ts` | **NEW** — shared annotation CRUD + Claude |
| `apps/desktop/src/components/DiffView.tsx` | **MODIFY** — remove bottom panel, use shared hook |
| `apps/desktop/src/App.tsx` | **MODIFY** — replace CommitPanel with RightSidebar, rename toggle |
| `apps/desktop/src/store.ts` | **MODIFY** — add `showResolved` to UIState |
| `apps/desktop/src/components/CommitPanel.tsx` | **UNCHANGED** — rendered inside RightSidebar |
| `apps/desktop/src/components/AnnotationDisplay.tsx` | **UNCHANGED** — reused in AnnotationsPanel |

## Verification

1. `cd apps/desktop && npx tsc --noEmit` — clean compile
2. Run the app with `bun run tauri dev`
3. Test:
   - Right sidebar shows with [Changes] [Annotations] tabs
   - Changes tab renders CommitPanel exactly as before
   - Annotations tab shows empty state when no annotations
   - Click a diff line → inline form appears → submit → annotation shows in panel
   - Toggle resolved filter in annotations panel header
   - Click annotation in panel → diff scrolls to that line
   - "Send all to Claude" sends unresolved to terminal
   - "Sidebar" button in title bar toggles entire right panel
   - Terminal tab: annotations tab still visible and functional
   - All files view: annotations grouped by file
   - Single file view: annotations filtered to current file
