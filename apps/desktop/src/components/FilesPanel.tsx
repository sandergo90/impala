import { useEffect, useMemo, useRef } from "react";
import { useFileTree, FileTree } from "@pierre/trees/react";
import { useUIStore } from "../store";
import { useFileTreeData } from "../hooks/useFileTreeData";

export function FilesPanel() {
  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const wtPath = selectedWorktree?.path ?? null;
  const { paths, dirSet, expand } = useFileTreeData(wtPath);

  // Trees expects directory paths to end with `/`. File paths must not.
  const treePaths = useMemo(() => {
    return paths.map((p) => (dirSet.has(p) ? `${p}/` : p));
  }, [paths, dirSet]);

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
    onSelectionChange: (selected) => handlerRef.current(selected),
  });

  useEffect(() => {
    model.resetPaths(treePaths);
  }, [model, treePaths]);

  if (!wtPath) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Select a worktree to browse files
      </div>
    );
  }

  return (
    <div className="h-full overflow-hidden">
      <FileTree model={model} style={{ height: "100%" }} />
    </div>
  );
}
