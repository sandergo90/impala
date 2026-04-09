# Task 2: Terminal Cmd-Click Link Provider

**Plan:** Superset Feature Adoption
**Goal:** Register an xterm.js link provider on both `XtermTerminal` and `FloatingTerminal` so Cmd+click on file paths opens the file in the user's editor.
**Depends on:** Task 1 (file-link-parser.ts, openFileInEditor, resolve_file_path)

**Files:**

- Create: `apps/desktop/src/lib/terminal-link-provider.ts`
- Modify: `apps/desktop/src/components/XtermTerminal.tsx:132-170` (register link provider after terminal.open)

**Context:**

- xterm.js provides a `registerLinkProvider` API. A link provider implements `provideLinks(bufferLineNumber, callback)` — it receives a line of text and returns link ranges with click handlers.
- The `XtermTerminal` component creates the terminal at line 135 and opens it at line 153. The link provider should be registered right after `terminal.open(container)`.
- `FloatingTerminal` at `apps/desktop/src/components/FloatingTerminal.tsx` renders `<XtermTerminal>` at line 228 — it will get the link provider automatically since it's registered inside `XtermTerminal`.
- The `@xterm/xterm` package is already installed. Check the installed version to confirm `registerLinkProvider` is available (it was added in xterm.js 4.x).

**Steps:**

1. Create the terminal link provider module:

Create `apps/desktop/src/lib/terminal-link-provider.ts`:

```typescript
import { invoke } from "@tauri-apps/api/core";
import type { Terminal, ILinkProvider, ILink } from "@xterm/xterm";
import { parseFileLinks } from "./file-link-parser";
import { openFileInEditor } from "./open-file-in-editor";

// Cache file existence checks to avoid repeated Tauri calls
const existsCache = new Map<string, { exists: boolean; absPath: string; ts: number }>();
const CACHE_TTL_MS = 10_000;

async function resolveAndCache(
  baseDir: string,
  candidate: string,
): Promise<{ absPath: string; exists: boolean }> {
  const key = `${baseDir}:${candidate}`;
  const cached = existsCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { absPath: cached.absPath, exists: cached.exists };
  }
  const [absPath, exists] = await invoke<[string, boolean]>("resolve_file_path", {
    baseDir,
    candidate,
  });
  existsCache.set(key, { absPath, exists, ts: Date.now() });
  return { absPath, exists };
}

export function createFileLinkProvider(
  terminal: Terminal,
  getBaseDir: () => string | null,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      const baseDir = getBaseDir();
      if (!baseDir) {
        callback(undefined);
        return;
      }

      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }

      const text = line.translateToString(true);
      const fileLinks = parseFileLinks(text);

      if (fileLinks.length === 0) {
        callback(undefined);
        return;
      }

      // Resolve all candidates in parallel
      Promise.all(
        fileLinks.map(async (fl) => {
          const { absPath, exists } = await resolveAndCache(baseDir, fl.path);
          if (!exists) return null;
          return {
            range: {
              start: { x: fl.startIndex + 1, y: bufferLineNumber },
              end: { x: fl.endIndex + 1, y: bufferLineNumber },
            },
            text: text.slice(fl.startIndex, fl.endIndex),
            activate(_event: MouseEvent, _text: string) {
              openFileInEditor(absPath, fl.line, fl.col);
            },
            tooltip: `Open in editor`,
          } satisfies ILink;
        }),
      ).then((results) => {
        const links = results.filter((r): r is ILink => r !== null);
        callback(links.length > 0 ? links : undefined);
      });
    },
  };
}
```

2. Register the link provider in `XtermTerminal.tsx`. The terminal needs to know the base directory (worktree path) to resolve relative paths. Add a `baseDir` prop.

In `apps/desktop/src/components/XtermTerminal.tsx`, update the props interface (around line 24):

```typescript
interface XtermTerminalProps {
  sessionId: string;
  baseDir?: string;
  isFocused?: boolean;
  onFocus?: () => void;
  onRestart?: () => void;
  scrollback?: number;
}
```

Update the function signature (line 45):

```typescript
export function XtermTerminal({ sessionId, baseDir, isFocused = true, onFocus, onRestart, scrollback = 10000 }: XtermTerminalProps) {
```

Add the import at the top of the file:

```typescript
import { createFileLinkProvider } from "../lib/terminal-link-provider";
```

After the `terminal.open(container)` call (line 153) and before the WebGL addon loading, register the link provider:

```typescript
      terminal.open(container);

      // Register file link provider for Cmd+click to open in editor
      const baseDirRef = { current: baseDir ?? null };
      const linkDisposable = terminal.registerLinkProvider(
        createFileLinkProvider(terminal, () => baseDirRef.current),
      );
```

Store `baseDirRef` so it can be updated, and add `linkDisposable` to the cleanup function. In the cleanup (around line 279-298), add `linkDisposable?.dispose();` alongside the other disposable cleanups.

3. Pass `baseDir` from the places that render `XtermTerminal`. There are two call sites:

**a) `SplitTreeRenderer.tsx`** — find where `<XtermTerminal>` is rendered and pass the worktree path as `baseDir`. Read the file first to find the exact location:

Run: `grep -n "XtermTerminal" apps/desktop/src/components/SplitTreeRenderer.tsx`

Add `baseDir={worktreePath}` to the `<XtermTerminal>` usage (the worktree path should be available in the component's context — check what props or store values are available).

**b) `FloatingTerminal.tsx`** — the `<XtermTerminal>` is rendered at line 228. The worktree path is available as `wtPath` (line 27). Pass it:

```typescript
<XtermTerminal sessionId={sessionId} baseDir={wtPath ?? undefined} isFocused scrollback={50000} />
```

4. Verify the build:

Run: `cd /Users/sander/Projects/canopy && bun run --filter desktop typecheck 2>&1 | tail -20`
Expected: no TypeScript errors

5. Manual test: open a terminal, run `ls -la src/` or `echo "src/store.ts:10:5"`, then Cmd+click the file path. It should open in your preferred editor.

6. Commit:

```bash
git add apps/desktop/src/lib/terminal-link-provider.ts apps/desktop/src/components/XtermTerminal.tsx apps/desktop/src/components/FloatingTerminal.tsx apps/desktop/src/components/SplitTreeRenderer.tsx
git commit -m "feat: cmd-click file paths in terminal to open in editor

Register xterm.js link provider that detects file paths,
validates them against the filesystem, and opens on Cmd+click.
Works in both split-pane terminals and the floating terminal."
```

**Done When:**

- [ ] Hovering file paths in terminal shows underline decoration
- [ ] Cmd+clicking a file path (e.g. `src/store.ts:42`) opens the file in the preferred editor at the correct line
- [ ] Works in both split-pane terminals and the floating terminal
- [ ] File existence is validated before showing links (no broken links)
- [ ] TypeScript build passes
- [ ] Committed
