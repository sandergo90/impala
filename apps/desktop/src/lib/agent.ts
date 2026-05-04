import { invoke } from "@tauri-apps/api/core";

export type Agent = "claude" | "codex";

/**
 * Resolve the agent for a worktree. Agent is chosen at creation time and
 * stored at worktree scope; nothing else feeds the resolution. Worktrees
 * created before this design fall back to "claude".
 */
export async function resolveAgent(worktreePath: string): Promise<Agent> {
  const value = await invoke<string | null>("get_setting", {
    key: "selectedAgent",
    scope: worktreePath,
  });
  return value === "codex" ? "codex" : "claude";
}

/**
 * Build the shell command string written to the PTY to launch the agent.
 */
export function buildLaunchCommand(
  agent: Agent,
  flags: string,
  launched: boolean,
): string {
  if (agent === "claude") {
    const parts = ["claude"];
    if (flags.trim()) parts.push(flags.trim());
    if (launched) parts.push("--continue");
    return parts.join(" ") + "\n";
  }
  // codex
  if (launched) {
    const parts = ["codex", "resume", "--last"];
    if (flags.trim()) parts.push(flags.trim());
    return parts.join(" ") + "\n";
  }
  const parts = ["codex"];
  if (flags.trim()) parts.push(flags.trim());
  return parts.join(" ") + "\n";
}

/**
 * Resolve flags for the given agent: project scope > global scope > default.
 * Codex defaults to `--yolo` when nothing is set; claude defaults to empty.
 */
export async function resolveFlags(
  agent: Agent,
  projectPath: string,
): Promise<string> {
  const key = agent === "claude" ? "claudeFlags" : "codexFlags";
  const [project, global] = await Promise.all([
    invoke<string | null>("get_setting", { key, scope: projectPath }),
    invoke<string | null>("get_setting", { key, scope: "global" }),
  ]);
  const fallback = agent === "codex" ? "--yolo" : "";
  return project ?? global ?? fallback;
}
