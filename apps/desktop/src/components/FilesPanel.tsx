import { useCallback, useEffect, useMemo, useRef } from "react";
import { useFileTree, FileTree } from "@pierre/trees/react";
import type { GitStatusEntry } from "@pierre/trees";
import { useUIStore, useDataStore } from "../store";
import { useFileTreeData } from "../hooks/useFileTreeData";
import { mapGitStatus } from "../lib/git-status";
import { openFileTab } from "../lib/tab-actions";
import { openFileInEditor } from "../lib/open-file-in-editor";
import { getTreesStyle, resolveThemeById } from "../themes/apply";
import type { ChangedFile } from "../types";

// Stable reference so the Zustand selector never returns a fresh array,
// which would trip useSyncExternalStore's getSnapshot caching check.
const EMPTY_CHANGED_FILES: ChangedFile[] = [];

export function FilesPanel() {
  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const wtPath = selectedWorktree?.path ?? null;
  const { paths, entriesByPath, expand, collapseAll } = useFileTreeData(wtPath);
  const changedFiles =
    useDataStore((s) =>
      wtPath ? s.worktreeDataStates[wtPath]?.changedFiles : undefined,
    ) ?? EMPTY_CHANGED_FILES;
  const pendingReveal = useUIStore((s) => s.pendingTreeReveal);
  const persistedExpandedDirs = useUIStore((s) =>
    wtPath ? s.worktreeExpandedDirs[wtPath] : undefined,
  );
  const activeThemeId = useUIStore((s) => s.activeThemeId);
  const customThemes = useUIStore((s) => s.customThemes);
  const treesStyle = useMemo(
    () => getTreesStyle(resolveThemeById(activeThemeId, customThemes)),
    [activeThemeId, customThemes],
  );
  const activeFileTabPath = useUIStore((s) => {
    if (!wtPath) return null;
    const nav = s.worktreeNavStates[wtPath];
    if (!nav) return null;
    const tab = nav.userTabs.find((t) => t.id === nav.activeTerminalsTab);
    return tab && tab.kind === "file" ? tab.path ?? null : null;
  });

  // Trees expects directory paths to end with `/`. File paths must not.
  const treePaths = useMemo(() => {
    return paths.map((p) => {
      const e = entriesByPath.get(p);
      return e?.kind === "directory" ? `${p}/` : p;
    });
  }, [paths, entriesByPath]);

  // Decorate rows with git status (changed files) and ignored dimming.
  // Paths must match the tree-shape: directories end with `/`, files do not.
  const gitStatusEntries = useMemo<readonly GitStatusEntry[]>(() => {
    const out: GitStatusEntry[] = [];
    for (const cf of changedFiles) {
      const status = mapGitStatus(cf.status);
      if (!status) continue;
      out.push({ path: cf.path, status });
    }
    for (const [p, e] of entriesByPath) {
      if (!e.ignored) continue;
      const path = e.kind === "directory" ? `${p}/` : p;
      out.push({ path, status: "ignored" });
    }
    return out;
  }, [changedFiles, entriesByPath]);

  // useFileTree captures onSelectionChange once at model construction. FilesPanel
  // does not remount on worktree switch, so route through a ref to keep wtPath /
  // expand fresh without rebuilding the model.
  const handlerRef = useRef<(selected: readonly string[]) => void>(() => { });
  handlerRef.current = (selected) => {
    if (!wtPath || selected.length === 0) return;
    const path = selected[selected.length - 1]!;
    if (path.endsWith("/")) {
      void expand(path.slice(0, -1));
      return;
    }
    openFileTab(wtPath, path); // preview
  };

  const { model } = useFileTree({
    paths: treePaths,
    initialExpansion: "closed",
    icons: { set: "complete", colored: true },
    gitStatus: gitStatusEntries,
    fileTreeSearchMode: "expand-matches",
    onSelectionChange: (selected) => handlerRef.current(selected),
  });

  useEffect(() => {
    // Trees' initializeExpandedPaths walks every path's segments and silently
    // marks each ancestor as expanded. So including "a/b/c" auto-expands "a"
    // and "a/b" too, even if the user has collapsed them — children stay
    // flagged "expanded" internally and remain in the persisted store, ready
    // to drag the parent back open. Skip dirs whose ancestors aren't in the
    // persisted set so a collapsed parent stays collapsed.
    //
    // Also mirror the model's current expand state for dirs it tracks: trees
    // doesn't surface a public collapse event, so persistedExpandedDirs may
    // briefly contain dirs the user just collapsed.
    const persistedSet = new Set(persistedExpandedDirs ?? []);
    const initialExpandedPaths: string[] = [];
    for (const d of persistedExpandedDirs ?? []) {
      let allAncestorsPersisted = true;
      const segments = d.split("/");
      for (let i = 1; i < segments.length; i++) {
        if (!persistedSet.has(segments.slice(0, i).join("/"))) {
          allAncestorsPersisted = false;
          break;
        }
      }
      if (!allAncestorsPersisted) continue;
      const slashed = `${d}/`;
      const item = model.getItem(slashed);
      if (!item || ("isExpanded" in item && item.isExpanded())) {
        initialExpandedPaths.push(slashed);
      }
    }
    model.resetPaths(treePaths, { initialExpandedPaths });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, treePaths]);

  useEffect(() => {
    model.setGitStatus(gitStatusEntries);
  }, [model, gitStatusEntries]);

  // Trees doesn't surface a public collapse event. Mirror the model's expand
  // state into the persisted store on every change so the next resetPaths
  // doesn't resurrect dirs the user has collapsed (mouse, keyboard, or any
  // other path that bypasses onSelectionChange).
  useEffect(() => {
    if (!wtPath) return;
    return model.subscribe(() => {
      const persisted = useUIStore.getState().worktreeExpandedDirs[wtPath] ?? [];
      if (persisted.length === 0) return;
      const stillExpanded = persisted.filter((d) => {
        const item = model.getItem(`${d}/`);
        return !item || ("isExpanded" in item && item.isExpanded());
      });
      if (stillExpanded.length !== persisted.length) {
        useUIStore.getState().setWorktreeExpandedDirs(wtPath, stillExpanded);
      }
    });
  }, [model, wtPath]);

  // Single-select a path in the model: deselect anything else, select target.
  // The trees model only exposes `getItem(path).select()/.deselect()`.
  const selectOnly = (path: string) => {
    for (const p of model.getSelectedPaths()) {
      if (p !== path) model.getItem(p)?.deselect();
    }
    model.getItem(path)?.select();
  };

  // Expand ancestors, single-select the path, and focus it (which scrolls
  // the row into view). Callers gate on `getSelectedPaths().includes(path)`
  // so this is idempotent — re-running just retries the select once tree
  // data has loaded.
  const revealPath = useCallback(
    (path: string, signal: { cancelled: boolean }) => {
      void (async () => {
        const segments = path.split("/");
        const ancestors: string[] = [];
        for (let i = 1; i < segments.length; i++) {
          ancestors.push(segments.slice(0, i).join("/"));
        }
        await Promise.all(ancestors.map((a) => expand(a)));
        if (signal.cancelled) return;
        // Defer to next frame so resetPaths from the expand() batch flushes
        // into the model before we look up the item.
        requestAnimationFrame(() => {
          if (signal.cancelled) return;
          selectOnly(path);
          model.focusPath(path);
        });
      })();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [expand, model],
  );

  // treePaths is a dep on both reveal effects so the first attempt retries
  // once async data lands. After that, the refs gate further runs — without
  // them, any treePaths change (collapse-all, fs events, expanding an
  // unrelated dir) would call revealPath again and re-expand the ancestors
  // of the active file tab.
  const lastRevealedNonceRef = useRef<number | null>(null);
  const lastRevealedActiveFileRef = useRef<string | null>(null);

  useEffect(() => {
    if (!wtPath || !pendingReveal || pendingReveal.worktreePath !== wtPath) return;
    if (lastRevealedNonceRef.current === pendingReveal.nonce) return;
    if (model.getSelectedPaths().includes(pendingReveal.path)) {
      lastRevealedNonceRef.current = pendingReveal.nonce;
      return;
    }
    if (treePaths.length === 0) return;
    lastRevealedNonceRef.current = pendingReveal.nonce;
    const signal = { cancelled: false };
    revealPath(pendingReveal.path, signal);
    return () => {
      signal.cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingReveal?.nonce, wtPath, revealPath, treePaths]);

  // Active file tab → tree reveal (expand ancestors, select, scroll into view).
  // Covers tab switches and worktree changes — openFileTab calls also dispatch
  // pendingTreeReveal, which the effect above handles.
  useEffect(() => {
    if (!activeFileTabPath) {
      for (const p of model.getSelectedPaths()) model.getItem(p)?.deselect();
      lastRevealedActiveFileRef.current = null;
      return;
    }
    if (lastRevealedActiveFileRef.current === activeFileTabPath) return;
    if (model.getSelectedPaths().includes(activeFileTabPath)) {
      lastRevealedActiveFileRef.current = activeFileTabPath;
      return;
    }
    if (treePaths.length === 0) return;
    lastRevealedActiveFileRef.current = activeFileTabPath;
    const signal = { cancelled: false };
    revealPath(activeFileTabPath, signal);
    return () => {
      signal.cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFileTabPath, revealPath, treePaths]);

  if (!wtPath) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Select a worktree
      </div>
    );
  }

  // Trees renders inside a shadow root, so `event.target` is retargeted to
  // the host element by the time it bubbles out. `composedPath()` exposes
  // the original path including shadow DOM, which is where the row buttons
  // (with `data-item-path`) actually live.
  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!wtPath) return;
    const composed = e.nativeEvent.composedPath() as EventTarget[];
    const row = composed.find(
      (el): el is HTMLElement =>
        el instanceof HTMLElement && el.hasAttribute("data-item-path"),
    );
    if (!row) return;
    if (row.getAttribute("data-item-type") !== "file") return;
    const path = row.getAttribute("data-item-path");
    if (!path) return;
    openFileTab(wtPath, path, { pin: true }); // pin
  };

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

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex items-center gap-1 mx-3 my-2 shrink-0">
        <button
          type="button"
          onClick={() => useUIStore.getState().setFileFinderOpen(true)}
          className="flex flex-1 items-center gap-2 px-2 py-1 text-sm bg-input rounded text-muted-foreground hover:text-foreground cursor-pointer"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <span>Search files…</span>
          <span className="ml-auto font-mono text-xs opacity-70">⌘P</span>
        </button>
        <button
          type="button"
          onClick={collapseAll}
          title="Collapse all folders"
          className="flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 14 10 14 10 20" />
            <polyline points="20 10 14 10 14 4" />
            <line x1="14" y1="10" x2="21" y2="3" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        </button>
      </div>
      <div
        className="flex-1 min-h-0 overflow-hidden"
        onDoubleClick={handleDoubleClick}
        onClickCapture={handleClickCapture}
      >
        <FileTree model={model} style={{ height: "100%", ...treesStyle }} />
      </div>
    </div>
  );
}
