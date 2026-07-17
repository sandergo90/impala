import { invoke } from "@/lib/invoke";
import { getHookPort } from "./get-hook-port";
import { encodePtyInput } from "./encode-pty";
import { awaitShellReady } from "./pty-ready";
import { agentPtySessionId, AGENT_PANE_ID } from "./pane-ids";
import { buildLaunchCommand, resolveFlags, type Agent } from "./agent";
import { useUIStore } from "../store";
import { useDataStore } from "../store";

/**
 * Launch the primary agent in a worktree whose pane is not mounted (the
 * automation executor's path). Mirrors TabbedTerminals' spawn recipe — same
 * deterministic session id, same env — so when the user opens the worktree
 * the agent pane simply reattaches to the running PTY.
 */
export async function launchAgentHeadless(opts: {
  worktreePath: string;
  projectPath: string;
  agent: Agent;
  prompt: string;
}): Promise<void> {
  const { worktreePath, projectPath, agent, prompt } = opts;
  const ptyId = agentPtySessionId(worktreePath);
  const hookPort = await getHookPort();

  let extraEnv: Record<string, string> = {};
  try {
    extraEnv = await invoke<Record<string, string>>("prepare_agent_config", {
      worktreePath,
      agent,
    });
  } catch (err) {
    console.warn("Failed to prepare agent config:", err);
  }
  const launch = await invoke<{
    shell_path: string;
    shell_args: string[];
    env: Record<string, string>;
  }>("prepare_shell_launch");

  const isNew = await invoke<boolean>("pty_spawn", {
    sessionId: ptyId,
    cwd: worktreePath,
    command: null,
    shellPath: launch.shell_path,
    shellArgs: launch.shell_args,
    envVars: {
      IMPALA_HOOK_PORT: String(hookPort),
      IMPALA_WORKTREE_PATH: worktreePath,
      ...launch.env,
      ...extraEnv,
    },
  });

  const data = useDataStore.getState().getWorktreeDataState(worktreePath);
  useDataStore.getState().updateWorktreeDataState(worktreePath, {
    paneSessions: { ...data.paneSessions, [AGENT_PANE_ID]: ptyId },
  });

  const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
  if (isNew && !nav.agentLaunched) {
    const flags = await resolveFlags(agent, projectPath);
    const cmd = buildLaunchCommand(agent, flags, prompt);
    await awaitShellReady(ptyId);
    await invoke("pty_write", { sessionId: ptyId, data: encodePtyInput(cmd) });
    useUIStore
      .getState()
      .updateWorktreeNavState(worktreePath, { agentLaunched: true });
  } else if (!isNew && nav.agentLaunched) {
    // The mounted pane won the race and launched the agent bare (it had no
    // prompt to pass). Type the prompt into the running agent instead.
    await invoke("pty_write", {
      sessionId: ptyId,
      data: encodePtyInput(prompt + "\r"),
    });
  }
}
