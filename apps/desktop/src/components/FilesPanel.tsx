import { useCallback, useEffect, useMemo } from "react";
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

  const onSelectionChange = useCallback(
    (selected: readonly string[]) => {
      if (!wtPath || selected.length === 0) return;
      const path = selected[selected.length - 1]!;
      if (path.endsWith("/")) {
        void expand(path.slice(0, -1));
        return;
      }
      // TODO Task 3: re-enable activeTab switch once union is widened.
      useUIStore.getState().updateWorktreeNavState(wtPath, {
        selectedFilePath: path,
        // activeTab: "files",
      });
    },
    [wtPath, expand],
  );

  const { model } = useFileTree({
    paths: treePaths,
    initialExpansion: "closed",
    onSelectionChange,
  });

  useEffect(() => {
    model.resetPaths(treePaths);
  }, [model, treePaths]);

  if (!wtPath) {
    return (
      <div className="flex items-center justify-center h-full text-md text-muted-foreground">
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
