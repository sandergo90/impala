import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useUIStore } from "../store";
import { encodePtyInput } from "./encode-pty";

export async function stopRunScript() {
  const { selectedWorktree, getFloatingTerminal, setFloatingTerminal } = useUIStore.getState();
  if (!selectedWorktree) return;

  const ft = getFloatingTerminal(selectedWorktree.path);
  if (ft.type !== "run" || !ft.sessionId) return;
  if (ft.status !== "running") return;

  setFloatingTerminal(selectedWorktree.path, { status: "stopping", label: "Stopping..." });

  const encoded = encodePtyInput("\x03");
  await invoke("pty_write", { sessionId: ft.sessionId, data: encoded }).catch(() => {});

  const sessionId = ft.sessionId;
  const worktreePath = selectedWorktree.path;
  setTimeout(async () => {
    const current = useUIStore.getState().getFloatingTerminal(worktreePath);
    if (current.sessionId === sessionId && current.status === "stopping") {
      await invoke("pty_kill", { sessionId }).catch(() => {});
      setFloatingTerminal(worktreePath, {
        status: "stopped",
        label: "Force stopped",
      });
    }
  }, 3000);
}

export function toggleRunScript() {
  const { selectedWorktree, getFloatingTerminal } = useUIStore.getState();
  if (!selectedWorktree) return;

  const ft = getFloatingTerminal(selectedWorktree.path);
  if (ft.type === "run" && ft.status === "running") {
    stopRunScript();
  } else {
    triggerRunScript();
  }
}

export async function triggerRunScript() {
  const { selectedProject, selectedWorktree, getFloatingTerminal, setFloatingTerminal } = useUIStore.getState();

  if (!selectedProject || !selectedWorktree) return;

  const ft = getFloatingTerminal(selectedWorktree.path);

  // Block if setup is running
  if (ft.type === 'setup' && ft.mode !== 'hidden') {
    toast("Setup in progress...");
    return;
  }

  // Read project config
  let config: { setup?: string; run?: string };
  try {
    config = await invoke("read_project_config", { projectPath: selectedProject.path });
  } catch {
    toast.error("Failed to read project config");
    return;
  }

  if (!config.run?.trim()) {
    toast("No run script configured");
    return;
  }

  // Kill existing floating terminal session if any
  if (ft.sessionId) {
    await invoke("pty_kill", { sessionId: ft.sessionId }).catch(() => {});
  }

  // Spawn new session
  const sessionId = `floating-run-${Date.now()}`;
  try {
    await invoke("pty_spawn", {
      sessionId,
      cwd: selectedWorktree.path,
      envVars: {
        IMPALA_PROJECT_PATH: selectedProject.path,
        IMPALA_WORKTREE_PATH: selectedWorktree.path,
        IMPALA_BRANCH: selectedWorktree.branch,
      },
    });

    // Write the run command into the interactive shell
    const encoded = encodePtyInput(config.run + "\n");
    await invoke("pty_write", { sessionId, data: encoded });

    const label = config.run.length > 30 ? config.run.slice(0, 30) + "..." : config.run;

    setFloatingTerminal(selectedWorktree.path, {
      mode: "expanded",
      sessionId,
      label,
      type: "run",
      status: "running",
    });
  } catch (e) {
    toast.error(`Failed to run script: ${e}`);
  }
}
