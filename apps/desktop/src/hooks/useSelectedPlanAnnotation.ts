import { useCallback } from "react";
import { useUIStore } from "../store";

export function useSelectedPlanAnnotation() {
  const wtPath = useUIStore((s) => s.selectedWorktree)?.path ?? "";

  const selectedAnnotationId = useUIStore((s) => {
    const nav = wtPath ? (s.worktreeNavStates[wtPath] ?? null) : null;
    return nav?.selectedPlanAnnotationId ?? null;
  });

  const setSelectedAnnotationId = useCallback(
    (id: string | null) => {
      if (!wtPath) return;
      useUIStore.getState().updateWorktreeNavState(wtPath, {
        selectedPlanAnnotationId: id,
      });
    },
    [wtPath]
  );

  return [selectedAnnotationId, setSelectedAnnotationId] as const;
}
