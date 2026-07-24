import { getCurrentWindow } from "@tauri-apps/api/window";
import { useDataStore } from "../store";
import { useMountEffect } from "./useMountEffect";

function getUnreadWorktreeCount(): number {
  let count = 0;
  for (const state of Object.values(
    useDataStore.getState().worktreeDataStates,
  )) {
    if (state.hasUnseenResult) count++;
  }
  return count;
}

function setDockBadgeCount(count: number) {
  getCurrentWindow()
    .setBadgeCount(count > 0 ? count : undefined)
    .catch((error) => {
      console.warn("Failed to update dock badge:", error);
    });
}

/**
 * Mirrors the number of worktrees with unseen agent results onto the
 * application icon. The badge clears as soon as those worktrees are viewed.
 */
export function useDockBadge() {
  useMountEffect(() => {
    let count = getUnreadWorktreeCount();
    setDockBadgeCount(count);

    const unsubscribe = useDataStore.subscribe(() => {
      const nextCount = getUnreadWorktreeCount();
      if (nextCount === count) return;

      count = nextCount;
      setDockBadgeCount(count);
    });

    return () => {
      unsubscribe();
      setDockBadgeCount(0);
    };
  });
}
