import { useEffect, useState } from "react";
import { TabbedTerminals } from "./TabbedTerminals";
import { useWorktreeRunInfo } from "../hooks/useWorktreeRunInfo";

/**
 * Keeps all visited worktree terminals mounted (hidden when inactive) to avoid remounting
 * — same pattern as before, but each visited worktree now renders a TabbedTerminals.
 */
export function WorktreeTerminals({
  activeWorktreePath,
}: {
  activeWorktreePath: string | null;
}) {
  const [visitedPaths, setVisitedPaths] = useState<Set<string>>(new Set());
  const { info: runInfo, loaded: runInfoLoaded } = useWorktreeRunInfo();

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
      {runInfoLoaded
        ? [...visitedPaths].map((path) => {
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
                  codexResumeThreadId={runInfo[path]?.codexResumeThreadId}
                />
              </div>
            );
          })
        : null}
    </div>
  );
}
