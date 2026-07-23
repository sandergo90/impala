import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@/lib/invoke";
import { XtermTerminal, releaseCachedTerminal } from "./XtermTerminal";
import { paneSessionId } from "../lib/split-tree";
import { useDataStore } from "../store";
import { useAppHotkey } from "../hooks/useAppHotkey";

/**
 * A single leaf of the no-worktree general terminal. Passed as `renderLeaf` to
 * the shared `SplitTreeRenderer`, which owns the focus dimming and the pane
 * frame; this component only spawns/attaches the PTY and shows the terminal.
 * Backs the generic terminal only: no worktree env vars, no agent auto-launch.
 */
export function GeneralTerminalLeaf({
  paneId,
  worktreePath,
  isFocused,
  sessionId,
  onSessionSpawned,
  cwd,
}: {
  paneId: string;
  worktreePath: string;
  isFocused: boolean;
  sessionId: string | null;
  onSessionSpawned: (paneId: string, sessionId: string) => void;
  cwd?: string;
}) {
  const handleRestart = useCallback(() => {
    if (!sessionId) return;
    invoke("pty_kill", { sessionId }).catch(() => {});
    releaseCachedTerminal(sessionId);
    const { [paneId]: _, ...remaining } =
      useDataStore.getState().generalTerminalPaneSessions;
    useDataStore.getState().setGeneralTerminalPaneSessions(remaining);
  }, [sessionId, paneId]);

  useAppHotkey("RESTART_SESSION", handleRestart, { enabled: isFocused }, [handleRestart]);

  const spawningRef = useRef(false);
  const spawnCwd = cwd ?? worktreePath;
  useEffect(() => {
    if (sessionId || spawningRef.current) return;
    spawningRef.current = true;

    const ptyId = paneSessionId(paneId);
    invoke<boolean>("pty_spawn", {
      sessionId: ptyId,
      cwd: spawnCwd,
      command: null,
      envVars: {},
    })
      .then(() => {
        onSessionSpawned(paneId, ptyId);
      })
      .catch((err) => {
        console.error("Failed to spawn PTY:", err);
        spawningRef.current = false;
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- onSessionSpawned excluded: backend deduplicates spawns
  }, [paneId, sessionId, spawnCwd]);

  return sessionId ? (
    <XtermTerminal
      key={sessionId}
      sessionId={sessionId}
      baseDir={worktreePath}
      isFocused={isFocused}
      onRestart={handleRestart}
    />
  ) : (
    <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
      Starting terminal...
    </div>
  );
}
