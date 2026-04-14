import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useUIStore, useDataStore } from "../store";
import { encodePtyInput } from "./encode-pty";

const RUN_PANE_ID = "tab-run";

function runPtySessionId(worktreePath: string): string {
  return `pty-${RUN_PANE_ID}-${worktreePath}`;
}

/**
 * Ensure the Run tab's PTY session exists. If TabbedTerminals has already lazy-spawned it,
 * returns the existing session ID. Otherwise spawns a new one and registers it in the data store.
 */
export async function ensureRunTabSession(worktreePath: string): Promise<string> {
  const data = useDataStore.getState().getWorktreeDataState(worktreePath);
  const existing = data.paneSessions[RUN_PANE_ID];
  if (existing) return existing;

  const ptyId = runPtySessionId(worktreePath);
  const project = useUIStore.getState().selectedProject;
  await invoke("pty_spawn", {
    sessionId: ptyId,
    cwd: worktreePath,
    envVars: {
      IMPALA_PROJECT_PATH: project?.path ?? worktreePath,
      IMPALA_WORKTREE_PATH: worktreePath,
    },
  });
  useDataStore.getState().updateWorktreeDataState(worktreePath, {
    paneSessions: { ...data.paneSessions, [RUN_PANE_ID]: ptyId },
  });
  return ptyId;
}

/**
 * Send Ctrl+C to the Run tab's foreground process. Does not kill the PTY —
 * the tab survives so the user can re-run.
 */
export async function stopRunScript() {
  const wt = useUIStore.getState().selectedWorktree;
  if (!wt) return;

  const data = useDataStore.getState().getWorktreeDataState(wt.path);
  const sessionId = data.paneSessions[RUN_PANE_ID];
  if (!sessionId) return;

  const nav = useUIStore.getState().getWorktreeNavState(wt.path);
  if (nav.runStatus !== "running") return;

  useUIStore
    .getState()
    .updateWorktreeNavState(wt.path, { runStatus: "stopping" });

  const encoded = encodePtyInput("\x03");
  await invoke("pty_write", { sessionId, data: encoded }).catch(() => {});

  // Best-effort: assume the process accepts Ctrl+C and clear back to idle after a short delay.
  // Real exit detection lands in Phase 3 alongside the status indicators.
  const worktreePath = wt.path;
  setTimeout(() => {
    const current = useUIStore.getState().getWorktreeNavState(worktreePath);
    if (current.runStatus === "stopping") {
      useUIStore
        .getState()
        .updateWorktreeNavState(worktreePath, { runStatus: "idle" });
    }
  }, 1000);
}

export function toggleRunScript() {
  const wt = useUIStore.getState().selectedWorktree;
  if (!wt) return;
  const nav = useUIStore.getState().getWorktreeNavState(wt.path);
  if (nav.runStatus === "running") {
    stopRunScript();
  } else {
    triggerRunScript();
  }
}

/**
 * Run the configured run script in the Run tab. If the Run tab's PTY doesn't exist yet
 * (e.g. the user hasn't visited the Terminal tab on this worktree), spawn it first.
 * Writes the run command into the existing PTY rather than respawning, so scrollback survives.
 */
export async function triggerRunScript() {
  const project = useUIStore.getState().selectedProject;
  const wt = useUIStore.getState().selectedWorktree;
  if (!project || !wt) return;

  const nav = useUIStore.getState().getWorktreeNavState(wt.path);

  // Block if setup is still running. setupRanAt is set after setup is dispatched,
  // and runStatus stays "idle" until the user (or this function) sets it.
  if (nav.setupRanAt && nav.runStatus === "running") {
    toast("A run is already in progress");
    return;
  }

  let config: { setup?: string; run?: string };
  try {
    config = await invoke("read_project_config", { projectPath: project.path });
  } catch {
    toast.error("Failed to read project config");
    return;
  }

  if (!config.run?.trim()) {
    toast("No run script configured");
    return;
  }

  try {
    const sessionId = await ensureRunTabSession(wt.path);

    // Make sure the Run tab is visible and the Terminal top-level tab is active.
    useUIStore.getState().updateWorktreeNavState(wt.path, {
      activeTab: "terminal",
      activeTerminalsTab: "run",
      runStatus: "running",
    });

    const encoded = encodePtyInput(config.run + "\n");
    await invoke("pty_write", { sessionId, data: encoded });
  } catch (e) {
    toast.error(`Failed to run script: ${e}`);
    useUIStore
      .getState()
      .updateWorktreeNavState(wt.path, { runStatus: "idle" });
  }
}
