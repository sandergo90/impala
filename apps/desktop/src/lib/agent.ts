import { invoke } from "@/lib/invoke";

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
 * `initialPrompt`, when provided, is shell-quoted and passed as the agent's
 * positional `[prompt]` argument so it becomes the first user message.
 */
export function buildLaunchCommand(
  agent: Agent,
  flags: string,
  initialPrompt?: string,
): string {
  const parts: string[] = [agent];
  if (flags.trim()) parts.push(flags.trim());
  if (initialPrompt) parts.push(shellQuote(initialPrompt));
  return parts.join(" ") + "\n";
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
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
