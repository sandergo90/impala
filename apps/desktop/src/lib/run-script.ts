import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useUIStore } from "../store";

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
        CANOPY_PROJECT_PATH: selectedProject.path,
        CANOPY_WORKTREE_PATH: selectedWorktree.path,
        CANOPY_BRANCH: selectedWorktree.branch,
      },
    });

    // Write the run command into the interactive shell
    const encoded = btoa(config.run + "\n");
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
