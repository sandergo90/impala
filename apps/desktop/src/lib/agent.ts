import { invoke } from "@/lib/invoke";

export type Agent = "claude" | "codex";

export function agentForTerminalLaunch(
  agent: Agent,
  codexResumeThreadId?: string,
): Agent {
  return codexResumeThreadId ? "codex" : agent;
}

export interface CodexLaunchOptions {
  model?: string;
  reasoningEffort?:
    "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  serviceTier?: "default" | "fast" | "standard";
}

export interface NativeCodexSettings {
  model?: string;
  effort?: string;
  serviceTier?: string;
  approvalPolicy?: "never" | "on-request" | "untrusted";
  sandbox?: "danger-full-access" | "workspace-write" | "read-only";
}

const APPROVAL_POLICIES = new Set(["never", "on-request", "untrusted"]);
const SANDBOXES = new Set([
  "danger-full-access",
  "workspace-write",
  "read-only",
]);
const UNSAFE_FLAG_TEXT = /["'`$;&|<>()[\]{}\\]/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9._-]+$/;

/**
 * Parse only Codex settings with an exact app-server equivalent. Capability
 * validation belongs to the app-server catalog preflight; this accepts future,
 * shell-safe model, effort, and tier identifiers without starting them itself.
 */
export function parseNativeCodexFlags(
  flags: string,
): NativeCodexSettings | null {
  const text = flags.trim();
  if (!text) return {};
  if (UNSAFE_FLAG_TEXT.test(text)) return null;
  const tokens = text.split(/\s+/);
  const settings: NativeCodexSettings = {};
  const seen = new Set<string>();
  const take = (name: string, value: string | undefined): string | null => {
    if (!value || seen.has(name) || value.startsWith("-")) return null;
    seen.add(name);
    return value;
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (
      token === "--yolo" ||
      token === "--dangerously-bypass-approvals-and-sandbox"
    ) {
      if (seen.has("yolo") || seen.has("approval") || seen.has("sandbox"))
        return null;
      seen.add("yolo");
      settings.approvalPolicy = "never";
      settings.sandbox = "danger-full-access";
      continue;
    }
    const next = () => tokens[++index];
    let value: string | null = null;
    if (token === "-m" || token === "--model") value = take("model", next());
    else if (token.startsWith("--model="))
      value = take("model", token.slice(8));
    if (value !== null) {
      if (!SAFE_IDENTIFIER.test(value)) return null;
      settings.model = value;
      continue;
    }
    if (token === "-s" || token === "--sandbox")
      value = take("sandbox", next());
    else if (token.startsWith("--sandbox="))
      value = take("sandbox", token.slice(10));
    if (value !== null) {
      if (seen.has("yolo")) return null;
      if (
        !SANDBOXES.has(value) ||
        (settings.sandbox && settings.sandbox !== value)
      )
        return null;
      settings.sandbox = value as NativeCodexSettings["sandbox"];
      continue;
    }
    if (token === "-a" || token === "--ask-for-approval")
      value = take("approval", next());
    else if (token.startsWith("--ask-for-approval="))
      value = take("approval", token.slice(19));
    if (value !== null) {
      if (seen.has("yolo")) return null;
      if (
        !APPROVAL_POLICIES.has(value) ||
        (settings.approvalPolicy && settings.approvalPolicy !== value)
      )
        return null;
      settings.approvalPolicy = value as NativeCodexSettings["approvalPolicy"];
      continue;
    }
    if (token === "-c") value = next() ?? null;
    else if (token.startsWith("--config=")) value = token.slice(9) || null;
    if (value !== null) {
      const [key, configValue, ...rest] = value.split("=");
      if (rest.length || !configValue || seen.has(key)) return null;
      if (key === "model_reasoning_effort" && SAFE_IDENTIFIER.test(configValue))
        settings.effort = configValue;
      else if (key === "service_tier" && SAFE_IDENTIFIER.test(configValue))
        settings.serviceTier = configValue;
      else return null;
      seen.add(key);
      continue;
    }
    return null;
  }
  return settings;
}

/** Automations cannot answer app-server approval requests; panes can. */
export function canRunNativeCodexAutomation(
  settings: NativeCodexSettings | null,
): settings is NativeCodexSettings & { approvalPolicy: "never" } {
  return settings?.approvalPolicy === "never";
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
 * `env` entries are prefixed as command-line assignments (`KEY='v' agent`).
 * Impala does not add CODEX_HOME here: an inherited custom value stays in
 * effect, and Codex uses its normal ~/.codex default when none is supplied.
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
  const impalaCodexServer = usesImpalaCodexServer(agent, flags);
  const configuredRemote = agent === "codex" && !impalaCodexServer;
  const appServer = env?.IMPALA_CODEX_APP_SERVER;
  const usesManagedServer =
    impalaCodexServer && appServer?.startsWith("unix:///");
  for (const [key, value] of Object.entries(env ?? {})) {
    parts.push(`${key}=${shellQuote(value)}`);
  }
  if (agent === "codex" && configuredRemote && appServer) {
    parts.push("IMPALA_CODEX_APP_SERVER=''");
  }
  parts.push(agent);
  if (usesManagedServer) {
    parts.push("--remote", shellQuote(appServer!));
  }
  if (flags.trim()) parts.push(flags.trim());
  parts.push(...args.map(shellQuote));
  return parts.join(" ");
}

export function usesImpalaCodexServer(agent: Agent, flags: string): boolean {
  return agent === "codex" && !/(?:^|\s)--remote(?:=|\s|$)/.test(flags);
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

export function buildCodexResumeCommand(
  flags: string,
  threadId: string,
  env?: Record<string, string>,
): string {
  return buildAgentCommand("codex", flags, ["resume", threadId], env);
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
