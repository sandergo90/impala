import type { AutomationRun } from "../types";

/**
 * Thread id an automation worktree's Agent pane should resume instead of
 * launching a fresh agent. A live run counts: the app server persists the
 * thread as soon as its first turn starts, so `codex resume` attaches to the
 * running turn — the same shape as a delegated agent tab. Only `pending` is
 * excluded; its row can carry a thread id before the rollout exists.
 */
export function codexAutomationThreadToResume(
  run: Pick<
    AutomationRun,
    "status" | "agent_transport" | "agent_provider" | "agent_session_id"
  >,
): string | undefined {
  const threadId = run.agent_session_id?.trim();
  return run.agent_transport === "app-server" &&
    run.agent_provider === "codex" &&
    run.status !== "pending" &&
    threadId
    ? threadId
    : undefined;
}
