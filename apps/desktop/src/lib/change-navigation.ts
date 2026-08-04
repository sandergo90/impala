import type { ChangedFile, WorktreeNavState } from "../types";

export function shouldOpenChangesNavigator(
  activeTab: WorktreeNavState["activeTab"],
  viewMode: WorktreeNavState["viewMode"],
): boolean {
  return activeTab === "diff" || (viewMode !== "uncommitted" && viewMode !== "all-changes");
}

export function changedFileIndex(
  files: readonly ChangedFile[],
  selectedPath: string | null,
): number {
  return selectedPath ? files.findIndex((file) => file.path === selectedPath) : -1;
}

export function adjacentChangedFile(
  files: readonly ChangedFile[],
  selectedPath: string | null,
  direction: -1 | 1,
): ChangedFile | null {
  const index = changedFileIndex(files, selectedPath);
  const nextIndex = index + direction;
  return index >= 0 && nextIndex >= 0 && nextIndex < files.length
    ? files[nextIndex]
    : null;
}
