import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useUIStore, useDataStore } from "../store";
import { encodePtyInput } from "./encode-pty";
import { RUN_PANE_ID, runPtySessionId } from "./pane-ids";
import { resolveActionToRun } from "./actions";
import type { ProjectConfig } from "../types";

/**
 * Ensure the Run tab's PTY session exists. If TabbedTerminals has already
 * lazy-spawned it, returns the existing session ID. Otherwise spawns a new
 * one and registers it in the data store.
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

  // Best-effort: we can't reliably detect when the foreground process has
  // actually exited (the interactive shell stays alive), so flip back to
  // idle after a short timeout.
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

export function toggleRunScript(actionId?: string) {
  const wt = useUIStore.getState().selectedWorktree;
  if (!wt) return;
  const nav = useUIStore.getState().getWorktreeNavState(wt.path);
  if (nav.runStatus === "running") {
    stopRunScript();
  } else {
    triggerRunScript(actionId);
  }
}

/**
 * Run an Action in the Run tab. If `actionId` is provided, runs that specific
 * Action; otherwise falls back to `resolveActionToRun(actions, lastUsedId)`.
 *
 * If the Run tab's PTY doesn't exist yet, spawn it first. Writes the script
 * into the existing PTY rather than respawning, so scrollback survives.
 */
export async function triggerRunScript(actionId?: string) {
  const project = useUIStore.getState().selectedProject;
  const wt = useUIStore.getState().selectedWorktree;
  if (!project || !wt) return;

  const nav = useUIStore.getState().getWorktreeNavState(wt.path);
  if (nav.runStatus === "running") {
    toast("A run is already in progress");
    return;
  }

  let config: ProjectConfig;
  try {
    config = await invoke<ProjectConfig>("read_project_config", {
      projectPath: project.path,
    });
  } catch {
    toast.error("Failed to read project config");
    return;
  }

  const lastUsedId = nav.lastUsedActionId ?? null;

  const action = actionId
    ? config.actions.find((a) => a.id === actionId) ?? null
    : resolveActionToRun(config.actions, lastUsedId);

  if (!action) {
    toast("No actions configured");
    return;
  }

  if (!action.script.trim()) {
    toast("Action has no script");
    return;
  }

  try {
    const sessionId = await ensureRunTabSession(wt.path);

    // Refresh the cache so the header reflects the latest config (e.g., if
    // the settings page just autosaved a rename moments before the play
    // button was clicked).
    useDataStore.getState().setProjectActionsCache(project.path, config.actions);

    useUIStore.getState().updateWorktreeNavState(wt.path, {
      activeTab: "terminal",
      activeTerminalsTab: RUN_PANE_ID,
      runStatus: "running",
      lastUsedActionId: action.id,
    });

    const encoded = encodePtyInput(action.script + "\n");
    await invoke("pty_write", { sessionId, data: encoded });
  } catch (e) {
    toast.error(`Failed to run script: ${e}`);
    useUIStore
      .getState()
      .updateWorktreeNavState(wt.path, { runStatus: "idle" });
  }
}
