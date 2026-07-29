import { describe, expect, test } from "bun:test";
import { acknowledgeAutomationRun } from "./automation-run-acknowledgement.ts";

describe("acknowledgeAutomationRun", () => {
  test("acknowledges only the opened run and its worktree", () => {
    const unseenRuns = new Set(["run-1", "run-2", "run-3"]);
    const unseenWorktrees = new Set(["worktree-1", "worktree-2", "worktree-3"]);

    acknowledgeAutomationRun(
      { id: "run-2", worktree_path: "worktree-2" },
      (runId) => unseenRuns.delete(runId),
      (worktreePath) => unseenWorktrees.delete(worktreePath),
    );

    expect([...unseenRuns]).toEqual(["run-1", "run-3"]);
    expect([...unseenWorktrees]).toEqual(["worktree-1", "worktree-3"]);
  });
});
