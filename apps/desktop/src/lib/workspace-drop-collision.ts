import type { WorkspaceTabDropTarget } from "./tab-actions";

export interface WorkspaceDropCandidate<T> {
  collision: T;
  target: WorkspaceTabDropTarget | undefined;
}

/** Select the collision dnd-kit should treat as the active workspace target. */
export function selectWorkspaceDropCollision<T>(
  candidates: readonly WorkspaceDropCandidate<T>[],
): T | undefined {
  const paneLocal = candidates.find(
    ({ target }) => target?.type === "group" || target?.type === "pane",
  );
  return (paneLocal ?? candidates[0])?.collision;
}
