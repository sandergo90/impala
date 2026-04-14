import { useEffect, useState } from "react";
import { TabbedTerminals } from "./TabbedTerminals";

/**
 * Keeps all visited worktree terminals mounted (hidden when inactive) to avoid remounting
 * — same pattern as before, but each visited worktree now renders a TabbedTerminals.
 */
export function WorktreeTerminals({
  activeWorktreePath,
  claudeOnly = false,
}: {
  activeWorktreePath: string | null;
  /** Unused after the tabs refactor. Retained so MainView's existing call sites keep compiling. */
  onFocusPane?: (paneId: string) => void;
  /** Unused after the tabs refactor. Retained so MainView's existing call sites keep compiling. */
  onSessionSpawned?: (paneId: string, sessionId: string) => void;
  claudeOnly?: boolean;
}) {
  const [visitedPaths, setVisitedPaths] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (activeWorktreePath) {
      setVisitedPaths((prev) => {
        if (prev.has(activeWorktreePath)) return prev;
        return new Set([...prev, activeWorktreePath]);
      });
    }
  }, [activeWorktreePath]);

  return (
    <div className="relative h-full">
      {[...visitedPaths].map((path) => {
        const isActive = path === activeWorktreePath;
        return (
          <div
            key={path}
            className="absolute inset-0"
            style={{
              visibility: isActive ? "visible" : "hidden",
              zIndex: isActive ? 1 : 0,
              pointerEvents: isActive ? "auto" : "none",
            }}
          >
            <TabbedTerminals
              worktreePath={path}
              isActive={isActive}
              claudeOnly={claudeOnly}
            />
          </div>
        );
      })}
    </div>
  );
}
