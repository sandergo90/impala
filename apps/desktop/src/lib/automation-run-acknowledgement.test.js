import { describe, expect, test } from "bun:test";
import {
  acknowledgeAutomationRun,
  openSidebarWorktree,
} from "./automation-run-acknowledgement.ts";

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

  test("acknowledges an automation worktree opened from the sidebar", async () => {
    const unseenRuns = new Set(["run-1"]);
    const unseenWorktrees = new Set(["worktree-1"]);
    let opened = false;

    await openSidebarWorktree(
      "run-1",
      "worktree-1",
      async () => {
        opened = true;
      },
      (runId) => unseenRuns.delete(runId),
      (worktreePath) => unseenWorktrees.delete(worktreePath),
    );

    expect(opened).toBe(true);
    expect([...unseenRuns]).toEqual([]);
    expect([...unseenWorktrees]).toEqual([]);
  });

  test("does not acknowledge when the sidebar cannot open the worktree", async () => {
    const seenRuns = [];
    const seenWorktrees = [];

    await expect(
      openSidebarWorktree(
        "run-1",
        "worktree-1",
        async () => {
          throw new Error("open failed");
        },
        (runId) => seenRuns.push(runId),
        (worktreePath) => seenWorktrees.push(worktreePath),
      ),
    ).rejects.toThrow("open failed");

    expect(seenRuns).toEqual([]);
    expect(seenWorktrees).toEqual([]);
  });
});
