import type { AutomationRun } from "../types";

export function acknowledgeAutomationRun(
  run: Pick<AutomationRun, "id" | "worktree_path">,
  markRunSeen: (runId: string) => void,
  markWorktreeSeen: (worktreePath: string) => void,
) {
  markRunSeen(run.id);
  if (run.worktree_path) markWorktreeSeen(run.worktree_path);
}

export async function openSidebarWorktree(
  runId: string | undefined,
  worktreePath: string,
  openWorktree: () => Promise<void>,
  markRunSeen: (runId: string) => void,
  markWorktreeSeen: (worktreePath: string) => void,
) {
  await openWorktree();
  if (runId) {
    acknowledgeAutomationRun(
      { id: runId, worktree_path: worktreePath },
      markRunSeen,
      markWorktreeSeen,
    );
  }
}
