import type { AutomationRun } from "../types";

export function acknowledgeAutomationRun(
  run: Pick<AutomationRun, "id" | "worktree_path">,
  markRunSeen: (runId: string) => void,
  markWorktreeSeen: (worktreePath: string) => void,
) {
  markRunSeen(run.id);
  if (run.worktree_path) markWorktreeSeen(run.worktree_path);
}
