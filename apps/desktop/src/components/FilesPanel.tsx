import { useEffect, useMemo, useRef } from "react";
import { useFileTree, FileTree } from "@pierre/trees/react";
import type { GitStatusEntry } from "@pierre/trees";
import { useUIStore, useDataStore } from "../store";
import { useFileTreeData } from "../hooks/useFileTreeData";
import { mapGitStatus } from "../lib/git-status";

export function FilesPanel() {
  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const wtPath = selectedWorktree?.path ?? null;
  const { paths, entriesByPath, expand } = useFileTreeData(wtPath);
  const changedFiles = useDataStore((s) =>
    wtPath ? (s.worktreeDataStates[wtPath]?.changedFiles ?? []) : [],
  );

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
    useUIStore.getState().updateWorktreeNavState(wtPath, {
      selectedFilePath: path,
      activeTab: "files",
    });
  };

  const { model } = useFileTree({
    paths: treePaths,
    initialExpansion: "closed",
    icons: { set: "standard", colored: true },
    gitStatus: gitStatusEntries,
    onSelectionChange: (selected) => handlerRef.current(selected),
  });

  useEffect(() => {
    model.resetPaths(treePaths);
  }, [model, treePaths]);

  useEffect(() => {
    model.setGitStatus(gitStatusEntries);
  }, [model, gitStatusEntries]);

  if (!wtPath) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Select a worktree
      </div>
    );
  }

  return (
    <div className="h-full overflow-hidden">
      <FileTree model={model} style={{ height: "100%" }} />
    </div>
  );
}
