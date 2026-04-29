import { invoke } from "@tauri-apps/api/core";

export type Agent = "claude" | "codex";

export const AGENT_LABELS: Record<Agent, string> = {
  claude: "Claude",
  codex: "Codex",
};

/**
 * Resolve the agent for a worktree: worktree scope > project scope >
 * global scope > default ("claude").
 */
export async function resolveAgent(
  worktreePath: string,
  projectPath: string | null,
): Promise<Agent> {
  const candidates = [worktreePath];
  if (projectPath && projectPath !== worktreePath) candidates.push(projectPath);
  candidates.push("global");
  for (const scope of candidates) {
    const value = await invoke<string | null>("get_setting", {
      key: "selectedAgent",
      scope,
    });
    if (value === "claude" || value === "codex") return value;
  }
  return "claude";
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
 * Resolve flags for the given agent: project scope > global scope > "".
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
  return project ?? global ?? "";
}
