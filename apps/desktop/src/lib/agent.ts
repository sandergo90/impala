import { invoke } from "@/lib/invoke";

export type Agent = "claude" | "codex";

export interface CodexLaunchOptions {
  model?: string;
  reasoningEffort?:
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | "ultra";
  serviceTier?: "default" | "fast" | "standard";
}

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
 * `env` entries are prefixed as command-line assignments (`KEY='v' agent`):
 * PTY env vars can be stomped by the user's shell rc files (a zshrc
 * `export CODEX_HOME=~/.codex` silently rebinds every session to the global
 * config), and a command-line assignment runs after rc files, so it wins.
 */
export function buildLaunchCommand(
  agent: Agent,
  flags: string,
  initialPrompt?: string,
  env?: Record<string, string>,
  codexOptions?: CodexLaunchOptions,
): string {
  return `${buildDirectLaunchCommand(
    agent,
    flags,
    initialPrompt,
    env,
    codexOptions,
  )}\n`;
}

/** Build an agent command passed directly to the PTY's shell. */
export function buildDirectLaunchCommand(
  agent: Agent,
  flags: string,
  initialPrompt?: string,
  env?: Record<string, string>,
  codexOptions?: CodexLaunchOptions,
): string {
  const args: string[] = [];
  if (agent === "codex" && codexOptions?.model) {
    args.push("-m", codexOptions.model);
  }
  if (agent === "codex" && codexOptions?.reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${codexOptions.reasoningEffort}`);
  }
  if (agent === "codex" && codexOptions?.serviceTier) {
    args.push("-c", `service_tier=${codexOptions.serviceTier}`);
  }
  if (initialPrompt) args.push(initialPrompt);
  return buildAgentCommand(agent, flags, args, env);
}

function buildAgentCommand(
  agent: Agent,
  flags: string,
  args: string[],
  env?: Record<string, string>,
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    parts.push(`${key}=${shellQuote(value)}`);
  }
  parts.push(agent);
  if (flags.trim()) parts.push(flags.trim());
  parts.push(...args.map(shellQuote));
  return parts.join(" ");
}

/** Build the direct command for a completed global automation's interactive PTY. */
export function buildAutomationResumeCommand(
  agent: Agent,
  flags: string,
  sessionId: string,
  env?: Record<string, string>,
): string {
  const args =
    agent === "codex" ? ["resume", sessionId] : ["--resume", sessionId];
  return buildAgentCommand(agent, flags, args, env);
}

/** Direct commands still need shell setup for tools such as mise. */
export function buildInteractiveShellArgs(shellArgs: string[]): string[] {
  return [...shellArgs, "-i"];
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
