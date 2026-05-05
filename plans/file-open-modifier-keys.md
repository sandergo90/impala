# File Open: Modifier-Key Routing

## Goal

Route file-path triggers across the UI by click gesture: **single-click → Impala** (in-app preview tab + line jump), **Cmd+click → preferred external editor** (existing `openFileInEditor`). Double-click → pin (existing convention, untouched).

## Architecture

- `openFileTab(worktreePath, path, opts)` becomes the single in-app entry point. Its third argument is now an options object: `{ pin?: boolean; line?: number; col?: number }`.
- Line-jump state is parked in the existing `useEditorDocsStore` as a per-document `pendingTarget`. `openFileTab` writes it; the `FileViewer`/`CodeEditor` reads and clears it. `tab-actions.ts` never touches CodeMirror.
- The `OpenInEditorButton` split button (`FileViewer.tsx:225`, `MainView.tsx:292`) and the `preferredEditor` Zustand state are **unchanged**.
- Rationale: see `docs/adr/0001-file-open-modifier-key-scheme.md`.

## Tech Stack

React 19, Zustand, CodeMirror 6 (via `@codemirror/state` + `@codemirror/view`), xterm `ILinkProvider`, cmdk, `useFileTree` from `@pierre/diffs` (FilesPanel).

## Tasks

| # | Name | Dependencies | Files |
|---|------|--------------|-------|
| 1 | Line-jump plumbing + `openFileTab` options | none | `apps/desktop/src/lib/tab-actions.ts`, `apps/desktop/src/stores/editor-docs.ts`, `apps/desktop/src/components/CodeEditor/CodeEditor.tsx`, `apps/desktop/src/components/FileViewer.tsx` |
| 2 | Wire modifier-key scheme across click sites | Task 1 | `apps/desktop/src/components/AnnotationDisplay.tsx`, `apps/desktop/src/components/DiffView.tsx`, `apps/desktop/src/components/FilesPanel.tsx`, `apps/desktop/src/components/FileFinder.tsx`, `apps/desktop/src/lib/terminal-link-provider.ts` |

---

## Task 1 — Line-jump plumbing + `openFileTab` options

**Goal:** Extend `openFileTab` to accept `{ pin?, line?, col? }`. Park the line-jump target in the editor-docs store. Make `CodeEditor` accept a `goto(line, col?)` imperative handle. Wire `FileViewer` to call it whenever the pending target for the active doc changes.

**Files:**
- Modify: `apps/desktop/src/stores/editor-docs.ts` — add `pendingTargets` slot + setters
- Modify: `apps/desktop/src/lib/tab-actions.ts:333-401` — change signature to options object; write target to store; update all internal/external callers
- Modify: `apps/desktop/src/components/CodeEditor/CodeEditor.tsx:17-21` — extend `CodeEditorHandle` with `goto`
- Modify: `apps/desktop/src/components/FileViewer.tsx:249-256` — pass `editorRef`; subscribe to pending target; dispatch `goto` and clear

### Steps

**1. Add pending-target state to `editor-docs.ts`:**

In `EditorDocsState` (around the `removeDoc` line), add:

```ts
pendingTargets: Record<string, { line: number; col?: number }>;
setPendingTarget: (key: string, target: { line: number; col?: number }) => void;
clearPendingTarget: (key: string) => void;
```

In the `create<EditorDocsState>(...)` body, add the initial value and actions:

```ts
pendingTargets: {},
setPendingTarget(key, target) {
  set((s) => ({ pendingTargets: { ...s.pendingTargets, [key]: target } }));
},
clearPendingTarget(key) {
  set((s) => {
    const { [key]: _removed, ...rest } = s.pendingTargets;
    return { pendingTargets: rest };
  });
},
```

Keep `removeDoc` cleanup symmetric: when removing a doc, also clear its pending target. In the existing `removeDoc` action, add a parallel delete from `pendingTargets`.

**2. Update `openFileTab` signature in `tab-actions.ts:333-401`:**

Replace the existing `pin: boolean` parameter with an options object. Anywhere `openFileTab(worktreePath, path, false)` was called, it becomes `openFileTab(worktreePath, path)` (default = preview). `(...path, true)` becomes `(...path, { pin: true })`.

```ts
export interface OpenFileTabOptions {
  pin?: boolean;
  line?: number;
  col?: number;
}

export function openFileTab(
  worktreePath: string,
  path: string,
  opts: OpenFileTabOptions = {},
): UserTab {
  const { pin = false, line, col } = opts;
  // ... existing body, replacing `pin` references with the destructured local

  // After the existing branches that set `activeTerminalsTab`, before return:
  if (line !== undefined) {
    useEditorDocsStore
      .getState()
      .setPendingTarget(buildDocumentKey(worktreePath, path), { line, col });
  }
  // (return the resulting tab as before)
}
```

Add the imports at the top of `tab-actions.ts` if missing:

```ts
import { useEditorDocsStore } from "../stores/editor-docs";
```

`buildDocumentKey` is already imported.

**3. Update all in-tree callers of `openFileTab`** to the new shape:

Run: `rg -n "openFileTab\(" apps/desktop/src`

Expected hits (all currently pass a positional boolean):
- `apps/desktop/src/components/FilesPanel.tsx:78` — `openFileTab(wtPath, path, false)` → `openFileTab(wtPath, path)`
- `apps/desktop/src/components/FilesPanel.tsx:173` — `openFileTab(wtPath, path, true)` → `openFileTab(wtPath, path, { pin: true })`
- `apps/desktop/src/components/FileFinder.tsx:65` — `openFileTab(worktreePath, path, pin)` → `openFileTab(worktreePath, path, { pin })`

(Task 2 will further update these to pass `line` from Cmd-modified click contexts where relevant. Right now we are only changing the call shape.)

**4. Extend `CodeEditorHandle` in `CodeEditor.tsx:17-21`:**

```ts
export interface CodeEditorHandle {
  focus(): void;
  getValue(): string;
  openFind(): void;
  goto(line: number, col?: number): void;
}
```

Inside the main `useEffect` where `editorRef.current` is assigned (lines ~101-107), add:

```ts
editorRef.current = {
  focus: () => view.focus(),
  getValue: () => view.state.doc.toString(),
  openFind: () => openSearchPanel(view),
  goto: (line, col) => {
    const lineCount = view.state.doc.lines;
    const safeLine = Math.max(1, Math.min(line, lineCount));
    const lineInfo = view.state.doc.line(safeLine);
    const safeCol = col !== undefined
      ? Math.max(0, Math.min(col, lineInfo.length))
      : 0;
    const pos = lineInfo.from + safeCol;
    view.dispatch({
      selection: { anchor: pos, head: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus();
  },
};
```

**5. Wire FileViewer to consume the pending target.** In `apps/desktop/src/components/FileViewer.tsx`:

Add imports:

```ts
import { useRef } from "react"; // already imported — extend if needed
import { CodeEditor, detectLanguage, type CodeEditorHandle } from "./CodeEditor";
```

Confirm `CodeEditorHandle` is re-exported from `apps/desktop/src/components/CodeEditor/index.ts`. If it isn't, add `export type { CodeEditorHandle } from "./CodeEditor";`.

Inside the `FileViewer` component, near the top (after the existing hook calls):

```ts
const editorRef = useRef<CodeEditorHandle | null>(null);

const pendingTarget = useEditorDocsStore((s) =>
  docKey ? s.pendingTargets[docKey] : undefined,
);
const clearPendingTarget = useEditorDocsStore((s) => s.clearPendingTarget);
```

Note: `docKey` must exist in scope where the editor renders. Trace from line 214 (`const bufferContent = getCurrent(docKey!);`) — `docKey` is computed earlier; mirror that derivation higher up if needed so the selector can use it. If derivation is tied to load state, gate the selector with `docKey ? ...` as shown above.

Add an effect that fires the goto whenever target or doc changes:

```ts
useEffect(() => {
  if (!docKey || !pendingTarget) return;
  // Defer to next frame so a freshly-mounted CodeEditor has had a chance
  // to attach its handle.
  const id = requestAnimationFrame(() => {
    editorRef.current?.goto(pendingTarget.line, pendingTarget.col);
    clearPendingTarget(docKey);
  });
  return () => cancelAnimationFrame(id);
}, [docKey, pendingTarget, clearPendingTarget]);
```

Update the `<CodeEditor … />` render at line 249 to pass the ref:

```tsx
<CodeEditor
  key={docKey}
  editorRef={editorRef}
  value={bufferContent}
  language={language}
  onChange={(next) => updateDraft(docKey!, next)}
  onSave={handleSave}
  className="flex-1 min-h-0"
/>
```

**6. Verify type-check passes:**

Run: `bun run typecheck`
Expected: no errors. If `CodeEditorHandle` is missing the new `goto` member at any new callsite, fix it.

**7. Smoke-test in dev:**

Run: `bun run dev`

Open a worktree, open a file via `FilesPanel` (single click). Confirm the file opens in the preview tab and nothing scrolls/jumps. The line-jump path is exercised by Task 2 — Task 1 only needs to confirm no regression on the existing single-click → preview behavior.

**8. Commit:**

```bash
git add apps/desktop/src/stores/editor-docs.ts \
        apps/desktop/src/lib/tab-actions.ts \
        apps/desktop/src/components/CodeEditor/CodeEditor.tsx \
        apps/desktop/src/components/CodeEditor/index.ts \
        apps/desktop/src/components/FileViewer.tsx \
        apps/desktop/src/components/FilesPanel.tsx \
        apps/desktop/src/components/FileFinder.tsx
git commit -m "feat(editor): add line-jump plumbing for openFileTab

Extends openFileTab to accept { pin?, line?, col? }. Line targets
are parked on useEditorDocsStore.pendingTargets and consumed by
FileViewer via a CodeEditorHandle.goto(). Sets up the path used
by Task 2 to wire single-click file:line triggers."
```

**Done When:**

- [ ] `bun run typecheck` passes
- [ ] All `openFileTab` callers compile under the new signature
- [ ] Existing single-click → preview behavior still works
- [ ] Pending target is dispatched and cleared (verifiable in Task 2 surfaces)

---

## Task 2 — Wire the modifier-key scheme across click sites

**Goal:** On every clickable file-path surface, single-click routes to `openFileTab` (with `line` when known) and Cmd+click routes to `openFileInEditor` (the existing external-editor helper). Tooltips name both behaviors where the gesture isn't otherwise discoverable.

**Depends on:** Task 1 (uses the new `openFileTab` options).

**Files:**
- Modify: `apps/desktop/src/components/AnnotationDisplay.tsx:36-50` — add bare-click → in-app branch
- Modify: `apps/desktop/src/components/DiffView.tsx:50-64, 283, 470` — `OpenFileButton` becomes Impala-by-default; Cmd+click goes external; tooltip updated
- Modify: `apps/desktop/src/components/FilesPanel.tsx:205-208` — capture-phase click handler for Cmd+click → external
- Modify: `apps/desktop/src/components/FileFinder.tsx:63-67, 145-172, 175-185` — `FileItem` Cmd+click → external; footer hint updated
- Modify: `apps/desktop/src/lib/terminal-link-provider.ts:73-75` — primary activate → in-app; Cmd+click → external

### Steps

**1. `AnnotationDisplay.tsx:36-50` — add the bare-click branch.**

Today, bare-click is a no-op; only Cmd+click does anything. Replace the `onClick` handler with:

```tsx
import { openFileTab } from "../lib/tab-actions";
// (openFileInEditor is already imported)

// ...inside the file:line span:
onClick={(e) => {
  e.stopPropagation();
  if (e.metaKey || e.ctrlKey) {
    const fullPath = `${annotation.repo_path}/${annotation.file_path}`;
    openFileInEditor(fullPath, annotation.line_number);
  } else {
    openFileTab(annotation.repo_path, annotation.file_path, {
      line: annotation.line_number,
    });
  }
}}
title="Click to open in Impala. Cmd+click to open in your IDE."
```

(`annotation.repo_path` is the worktree path; `annotation.file_path` is the workspace-relative path. Verify shape from `apps/desktop/src/types`. If the field names differ, adapt — do not change them.)

**2. `DiffView.tsx:50-64` — `OpenFileButton` accepts a richer `onClick`.**

Change the `onClick` prop type from `() => void` to `(e: React.MouseEvent) => void` so the parent can read `metaKey`. Update the button's `onClick`:

```tsx
function OpenFileButton({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
      className="text-muted-foreground/60 hover:text-foreground transition-colors shrink-0"
      title="Click to open in Impala. Cmd+click to open in your IDE."
    >
      {/* svg unchanged */}
    </button>
  );
}
```

Update both call-sites:

`DiffView.tsx:283`:
```tsx
<OpenFileButton
  onClick={(e) => {
    if (!worktreePath) return;
    if (e.metaKey || e.ctrlKey) {
      openFileInEditor(`${worktreePath}/${file.path}`);
    } else {
      openFileTab(worktreePath, file.path);
    }
  }}
/>
```

`DiffView.tsx:470` (renamed-file branch):
```tsx
<OpenFileButton
  onClick={(e) => {
    if (!worktreePath) return;
    const path = isRenamed ? newPath : file.path;
    if (e.metaKey || e.ctrlKey) {
      openFileInEditor(`${worktreePath}/${path}`);
    } else {
      openFileTab(worktreePath, path);
    }
  }}
/>
```

Add the import: `import { openFileTab } from "../lib/tab-actions";`.

**Note:** these are file-level openings (no line). If there's a per-diff-line annotation/comment surface in this file that already passes a line, also pass `{ line }` there — search `DiffView.tsx` for any other `openFileInEditor` callers and apply the same routing. Run: `rg -n "openFileInEditor" apps/desktop/src/components/DiffView.tsx`.

**3. `FilesPanel.tsx` — Cmd+click on a tree row routes to external editor.**

The tree's `onSelectionChange` (line 71-79) doesn't expose the mouse event. Mirror the existing double-click pattern (lines 162-174) with a capture-phase click handler at the same wrapper. Add this handler in the FilesPanel component:

```tsx
const handleClickCapture = (e: React.MouseEvent<HTMLDivElement>) => {
  if (!wtPath) return;
  if (!e.metaKey && !e.ctrlKey) return;
  const composed = e.nativeEvent.composedPath() as EventTarget[];
  const row = composed.find(
    (el): el is HTMLElement =>
      el instanceof HTMLElement && el.hasAttribute("data-item-path"),
  );
  if (!row) return;
  if (row.getAttribute("data-item-type") !== "file") return;
  const path = row.getAttribute("data-item-path");
  if (!path) return;
  e.preventDefault();
  e.stopPropagation();
  openFileInEditor(`${wtPath}/${path}`);
};
```

Attach with the capture phase on the same wrapper that owns `onDoubleClick` (line 205-208). React's `onClickCapture` runs before the tree's internal click handlers, so `stopPropagation` prevents the selection change from firing when Cmd is held:

```tsx
<div
  className="flex-1 min-h-0 overflow-hidden"
  onDoubleClick={handleDoubleClick}
  onClickCapture={handleClickCapture}
>
```

Add the import: `import { openFileInEditor } from "../lib/open-file-in-editor";`.

**4. `FileFinder.tsx` — Cmd+click on a `FileItem` opens externally; footer mentions IDE.**

`Command.Item` accepts an `onClick` alongside `onSelect`. Extend `FileItem` to take an `onCmdClick`:

```tsx
function FileItem({
  path,
  onSelect,
  onCmdClick,
}: {
  path: string;
  onSelect: () => void;
  onCmdClick: () => void;
}) {
  // ...
  return (
    <Command.Item
      value={path}
      onSelect={onSelect}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          e.stopPropagation();
          onCmdClick();
        }
      }}
      data-path={path}
      className="..."
    >
      {/* unchanged children */}
    </Command.Item>
  );
}
```

Update the two `<FileItem>` callsites (lines 151-156 and 165-171) to pass `onCmdClick`:

```tsx
<FileItem
  key={`recent-${path}`}
  path={path}
  onSelect={() => openPath(path, false)}
  onCmdClick={() => {
    if (!worktreePath) return;
    openFileInEditor(`${worktreePath}/${path}`);
    onClose();
  }}
/>
```

(Apply the same shape to the search-results variant.)

Add the import: `import { openFileInEditor } from "../lib/open-file-in-editor";`.

Update the footer hint at lines 175-185 to add a third entry:

```tsx
<span><kbd className="font-mono">↵</kbd> open</span>
<span><kbd className="font-mono">⌘↵</kbd> pin</span>
<span><kbd className="font-mono">⌘click</kbd> IDE</span>
<span><kbd className="font-mono">esc</kbd> close</span>
```

**5. `terminal-link-provider.ts:73-75` — primary activate → Impala; Cmd+click → external.**

The `activate(event, _text)` callback receives the real `MouseEvent`. We need to figure out the worktree path and the relative path: today, `openFileInEditor(absPath, fl.line, fl.col)` is called with the absolute path. To call `openFileTab`, we need `(worktreePath, relativePath)`.

The provider already takes `getBaseDir`. Compute the relative path:

```ts
import { openFileTab } from "./tab-actions";

// inside the link object:
activate(event: MouseEvent, _text: string) {
  if (event.metaKey || event.ctrlKey) {
    openFileInEditor(absPath, fl.line, fl.col);
    return;
  }
  // baseDir is the worktree path (see useTerminalLinks / consumer of getBaseDir).
  // resolve_file_path returns absPath rooted at baseDir, so the relative path
  // is everything after `${baseDir}/`.
  const relPath = absPath.startsWith(`${baseDir}/`)
    ? absPath.slice(baseDir.length + 1)
    : absPath;
  if (relPath === absPath) {
    // resolved outside the worktree — fall back to external editor
    openFileInEditor(absPath, fl.line, fl.col);
    return;
  }
  openFileTab(baseDir, relPath, { line: fl.line, col: fl.col });
},
```

(Verify `getBaseDir()` returns the worktree path — read the call site in `XtermTerminal.tsx` if uncertain.)

**6. Sweep for any other clickable file-path surfaces:**

Run: `rg -n "openFileInEditor\(" apps/desktop/src` and `rg -n "openFileTab\(" apps/desktop/src`

For each result not already covered above, decide:
- If it's an explicit "open in IDE" affordance (the split button or similar) → leave alone.
- If it's a casual file-path link or row-click → apply the modifier-key scheme.

Document any deliberate skips in the commit message.

**7. Verify:**

```bash
bun run typecheck
```

Expected: no errors.

```bash
bun run dev
```

Manual smoke-tests against a worktree with at least one annotation and one diff:
- [ ] Click `R:42` on an annotation → file opens in Impala preview, cursor on line 42, viewport scrolled.
- [ ] Cmd+click same `R:42` → opens in `preferredEditor` (Cursor by default).
- [ ] Click the per-line "open" button on a changed file in DiffView → opens in Impala preview at line 1.
- [ ] Cmd+click same → opens in `preferredEditor`.
- [ ] Single-click a file in `FilesPanel` → preview opens (existing behavior, no line jump).
- [ ] Cmd+click same → opens in `preferredEditor`. Tree selection should NOT change.
- [ ] Open the file finder (`⌘P`), click a result → preview opens.
- [ ] Cmd+click a result → opens in `preferredEditor`, palette closes.
- [ ] Make a terminal print a file:line link (e.g. `git status`, `cat`, a stack trace), click it → opens in Impala at the right line.
- [ ] Cmd+click same terminal link → opens in `preferredEditor`.
- [ ] Click `R:42`, jump fires; click `R:42` again on the same already-open tab → silent re-center, no flash, no flicker.

**8. Commit:**

```bash
git add apps/desktop/src/components/AnnotationDisplay.tsx \
        apps/desktop/src/components/DiffView.tsx \
        apps/desktop/src/components/FilesPanel.tsx \
        apps/desktop/src/components/FileFinder.tsx \
        apps/desktop/src/lib/terminal-link-provider.ts
git commit -m "feat(editor): single-click opens in Impala, Cmd+click in IDE

Routes every file-path trigger by modifier: bare click goes to the
in-app editor (preview tab + line jump); Cmd+click preserves the
existing external-editor flow. See ADR 0001."
```

**Done When:**

- [ ] `bun run typecheck` passes
- [ ] All ten manual smoke-tests above pass
- [ ] No regression on existing double-click → pin
- [ ] No regression on `OpenInEditorButton` (still external-only)
