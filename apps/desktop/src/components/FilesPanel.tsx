import { useEffect, useMemo, useRef } from "react";
import { useFileTree, FileTree } from "@pierre/trees/react";
import type { GitStatusEntry } from "@pierre/trees";
import { useUIStore, useDataStore } from "../store";
import { useFileTreeData } from "../hooks/useFileTreeData";
import { mapGitStatus } from "../lib/git-status";
import { openFileTab } from "../lib/tab-actions";
import { FileSearchInput } from "./FileSearchInput";
import type { ChangedFile } from "../types";

// Stable reference so the Zustand selector never returns a fresh array,
// which would trip useSyncExternalStore's getSnapshot caching check.
const EMPTY_CHANGED_FILES: ChangedFile[] = [];

export function FilesPanel() {
  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const wtPath = selectedWorktree?.path ?? null;
  const { paths, entriesByPath, expand } = useFileTreeData(wtPath);
  const changedFiles =
    useDataStore((s) =>
      wtPath ? s.worktreeDataStates[wtPath]?.changedFiles : undefined,
    ) ?? EMPTY_CHANGED_FILES;
  const pendingReveal = useUIStore((s) => s.pendingTreeReveal);
  const activeFileTabPath = useUIStore((s) => {
    if (!wtPath) return null;
    const nav = s.worktreeNavStates[wtPath];
    if (!nav) return null;
    const tab = nav.userTabs.find((t) => t.id === nav.activeTerminalsTab);
    return tab && tab.kind === "file" ? tab.path ?? null : null;
  });
  const lastSyncedPathRef = useRef<string | null>(null);

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
  const handlerRef = useRef<(selected: readonly string[]) => void>(() => {});
  handlerRef.current = (selected) => {
    if (!wtPath || selected.length === 0) return;
    const path = selected[selected.length - 1]!;
    if (path.endsWith("/")) {
      void expand(path.slice(0, -1));
      return;
    }
    openFileTab(wtPath, path, false); // preview
  };

  const { model } = useFileTree({
    paths: treePaths,
    initialExpansion: "closed",
    icons: { set: "standard", colored: true },
    gitStatus: gitStatusEntries,
    fileTreeSearchMode: "expand-matches",
    onSelectionChange: (selected) => handlerRef.current(selected),
  });

  useEffect(() => {
    model.resetPaths(treePaths);
  }, [model, treePaths]);

  useEffect(() => {
    model.setGitStatus(gitStatusEntries);
  }, [model, gitStatusEntries]);

  // Single-select a path in the model: deselect anything else, select target.
  // The trees model only exposes `getItem(path).select()/.deselect()`.
  const selectOnly = (path: string) => {
    for (const p of model.getSelectedPaths()) {
      if (p !== path) model.getItem(p)?.deselect();
    }
    model.getItem(path)?.select();
  };

  useEffect(() => {
    if (!wtPath || !pendingReveal || pendingReveal.worktreePath !== wtPath) return;
    const { path } = pendingReveal;
    let cancelled = false;
    (async () => {
      const segments = path.split("/");
      const ancestors: string[] = [];
      for (let i = 1; i < segments.length; i++) {
        ancestors.push(segments.slice(0, i).join("/"));
      }
      await Promise.all(ancestors.map((a) => expand(a)));
      if (cancelled) return;
      // Defer to next frame so resetPaths from the expand() batch flushes
      // into the model before we look up the item.
      requestAnimationFrame(() => {
        if (cancelled) return;
        lastSyncedPathRef.current = path;
        selectOnly(path);
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingReveal?.nonce, wtPath, expand, model]);

  // Active file tab → tree selection. Gated by lastSyncedPathRef so the
  // selectionChange handler (which calls openFileTab) doesn't loop.
  useEffect(() => {
    if (!activeFileTabPath) return;
    if (lastSyncedPathRef.current === activeFileTabPath) return;
    lastSyncedPathRef.current = activeFileTabPath;
    selectOnly(activeFileTabPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFileTabPath, model]);

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
    openFileTab(wtPath, path, true); // pin
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <FileSearchInput model={model} />
      <div
        className="flex-1 min-h-0 overflow-hidden"
        onDoubleClick={handleDoubleClick}
      >
        <FileTree model={model} style={{ height: "100%" }} />
      </div>
    </div>
  );
}
