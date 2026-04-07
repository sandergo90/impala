import { useEffect, useState } from "react";
import { SplitTreeRenderer } from "./SplitTreeRenderer";
import { useUIStore, useDataStore } from "../store";
import { getLeaves } from "../lib/split-tree";

/** Keeps all visited worktree terminals mounted (hidden when inactive) to avoid remounting */
export function WorktreeTerminals({
  activeWorktreePath,
  onFocusPane,
  onSessionSpawned,
  claudeOnly = false,
}: {
  activeWorktreePath: string | null;
  onFocusPane: (paneId: string) => void;
  onSessionSpawned: (paneId: string, sessionId: string) => void;
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
            <WorktreeTerminalPane
              worktreePath={path}
              isActive={isActive}
              onFocusPane={onFocusPane}
              onSessionSpawned={onSessionSpawned}
              claudeOnly={claudeOnly}
            />
          </div>
        );
      })}
    </div>
  );
}

function WorktreeTerminalPane({
  worktreePath,
  isActive,
  onFocusPane,
  onSessionSpawned,
  claudeOnly = false,
}: {
  worktreePath: string;
  isActive: boolean;
  onFocusPane: (paneId: string) => void;
  onSessionSpawned: (paneId: string, sessionId: string) => void;
  claudeOnly?: boolean;
}) {
  // Subscribe to raw stored state to trigger re-renders when nav state changes
  useUIStore((s) => s.worktreeNavStates[worktreePath]);
  const dataState = useDataStore((s) => s.worktreeDataStates[worktreePath]);
  // Compute merged nav state synchronously (getWorktreeNavState creates new objects, can't use in selector)
  const nav = useUIStore.getState().getWorktreeNavState(worktreePath);

  const tree = claudeOnly
    ? getLeaves(nav.splitTree).find((l) => l.paneType === "claude") ??
      nav.splitTree
    : nav.splitTree;

  return (
    <SplitTreeRenderer
      tree={tree}
      worktreePath={worktreePath}
      focusedPaneId={isActive ? nav.focusedPaneId : ""}
      paneSessions={dataState?.paneSessions ?? {}}
      onFocusPane={onFocusPane}
      onSessionSpawned={onSessionSpawned}
    />
  );
}
