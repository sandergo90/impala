# Task 3: Cmd-Click in Diff View, Commit Panel, and Annotations

**Plan:** Superset Feature Adoption
**Goal:** Make file paths Cmd-clickable in the diff view (file names + line numbers), commit panel (changed files list), and annotation displays.
**Depends on:** Task 1 (openFileInEditor helper)

**Files:**

- Modify: `apps/desktop/src/components/CommitPanel.tsx:299-315` (add Cmd+click to file items)
- Modify: `apps/desktop/src/components/DiffView.tsx` (add Cmd+click to gutter line numbers via `onGutterUtilityClick` or similar)
- Modify: `apps/desktop/src/components/AnnotationDisplay.tsx:25-88` (add Cmd+click to file:line references)
- Create: `apps/desktop/src/hooks/useCmdClickCursor.ts` (hook for Cmd-held cursor style)

**Context:**

- `CommitPanel.tsx` renders changed files in a sidebar list. Each file is a `<button>` with an `onClick` handler (lines 299-315). We need to add Cmd+click detection that opens the file in editor instead of selecting it in the diff.
- `DiffView.tsx` uses the `PatchDiff` component from `@pierre/diffs/react`. Line numbers are rendered inside this library. We need to check if `PatchDiff` exposes an `onGutterClick` or similar callback. Look at the `onGutterUtilityClick` prop already used at line ~167.
- `AnnotationDisplay.tsx` renders annotations with side:line references. We can make the line reference text clickable.
- The worktree path is needed to construct full file paths. Check what's available in each component's context/props.

**Steps:**

1. Create a small hook that tracks whether Cmd/Meta is held, so we can change the cursor style:

Create `apps/desktop/src/hooks/useCmdClickCursor.ts`:

```typescript
import { useState, useEffect } from "react";

export function useCmdHeld(): boolean {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.key === "Meta") setHeld(true);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === "Meta") setHeld(false);
    };
    const onBlur = () => setHeld(false);

    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  return held;
}
```

2. Add Cmd+click to `CommitPanel.tsx`. Read the file first:

Run: `head -30 apps/desktop/src/components/CommitPanel.tsx`

This tells you the imports and what variables are available. You need the worktree path to construct the full file path for `openFileInEditor`.

Add the import at the top:

```typescript
import { openFileInEditor } from "../lib/open-file-in-editor";
import { useCmdHeld } from "../hooks/useCmdClickCursor";
```

Inside the component, add:

```typescript
const cmdHeld = useCmdHeld();
```

Find the worktree path — it should be available from the store or props. Look for `selectedWorktree` or similar in the component.

Modify the file item `<button>` click handler (around lines 299-315). The current handler is:

```typescript
onClick={() => selectFile(file)}
```

Replace with:

```typescript
onClick={(e) => {
  if (e.metaKey) {
    const worktreePath = /* get from store/props */;
    openFileInEditor(`${worktreePath}/${file.path}`);
    return;
  }
  selectFile(file);
}}
```

Add cursor style to the button:

```typescript
style={{ cursor: cmdHeld ? "pointer" : undefined }}
```

3. Add Cmd+click to annotation displays. Read the file:

Run: `cat -n apps/desktop/src/components/AnnotationDisplay.tsx`

Find where the side:line text is rendered (around line 49). Wrap the line reference in a clickable span:

Add import:

```typescript
import { openFileInEditor } from "../lib/open-file-in-editor";
```

The annotation has `file_path` and `line_number` fields. The component needs access to the worktree path. Check what props are available.

Replace the static line reference (e.g. `L:42` or `R:42`) with a clickable element:

```typescript
<span
  className="font-mono text-muted-foreground mr-2 hover:text-foreground hover:underline cursor-pointer"
  onClick={(e) => {
    if (e.metaKey) {
      openFileInEditor(`${worktreePath}/${annotation.file_path}`, annotation.line_number);
    }
  }}
>
  {a.side === "left" ? "L" : "R"}:{a.line_number}
</span>
```

4. For the diff view gutter line numbers: the `PatchDiff` component from `@pierre/diffs/react` handles rendering internally. Check what callbacks are available:

Run: `grep -n "onGutter\|onClick\|onLine" apps/desktop/src/components/DiffView.tsx`

Look at the `onGutterUtilityClick` prop usage. If the library exposes an `onGutterClick` or `onLineNumberClick` callback, use it to wire up Cmd+click → `openFileInEditor(filePath, lineNumber)`.

If the library doesn't expose such a callback, this specific integration point can be deferred — the commit panel and annotation Cmd+click are the higher-value targets. Add a TODO comment noting the gap.

5. Verify the build:

Run: `cd /Users/sander/Projects/canopy && bun run --filter desktop typecheck 2>&1 | tail -20`
Expected: no TypeScript errors

6. Manual test:
- In the commit panel, hold Cmd and click a file name — it should open in the editor
- In an annotation, Cmd+click the line reference — it should open at that line
- Without Cmd held, normal click behavior should be unchanged

7. Commit:

```bash
git add apps/desktop/src/hooks/useCmdClickCursor.ts apps/desktop/src/components/CommitPanel.tsx apps/desktop/src/components/AnnotationDisplay.tsx apps/desktop/src/components/DiffView.tsx
git commit -m "feat: cmd-click file paths in diff view, commit panel, and annotations

Hold Cmd and click file names in the changes sidebar to open
in editor. Cmd+click annotation line references to jump to
the exact line."
```

**Done When:**

- [ ] Cmd+click on file names in the commit panel opens the file in the preferred editor
- [ ] Cmd+click on annotation line references opens at the correct line
- [ ] Normal click behavior (selecting files, expanding annotations) is unchanged
- [ ] Cursor changes to pointer when Cmd is held over clickable file references
- [ ] TypeScript build passes
- [ ] Committed
