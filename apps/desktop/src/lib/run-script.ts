import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useUIStore } from "../store";

export async function triggerRunScript() {
  const { selectedProject, selectedWorktree, floatingTerminal, setFloatingTerminal } = useUIStore.getState();

  if (!selectedProject || !selectedWorktree) return;

  // Block if setup is running
  if (floatingTerminal.type === 'setup' && floatingTerminal.mode !== 'hidden') {
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
  if (floatingTerminal.sessionId) {
    await invoke("pty_kill", { sessionId: floatingTerminal.sessionId }).catch(() => {});
  }

  // Spawn new session
  const sessionId = `floating-run-${Date.now()}`;
  try {
    await invoke("pty_spawn", {
      sessionId,
      cwd: selectedWorktree.path,
      command: [config.run],
      envVars: {
        CANOPY_PROJECT_PATH: selectedProject.path,
        CANOPY_WORKTREE_PATH: selectedWorktree.path,
        CANOPY_BRANCH: selectedWorktree.branch,
      },
    });

    const label = config.run.length > 30 ? config.run.slice(0, 30) + "..." : config.run;

    setFloatingTerminal({
      mode: "expanded",
      sessionId,
      label,
      type: "run",
      worktreePath: selectedWorktree.path,
      status: "running",
    });
  } catch (e) {
    toast.error(`Failed to run script: ${e}`);
  }
}
