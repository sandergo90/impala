import { describe, expect, test } from "bun:test";
import { filterWorktreesByBaseDir } from "./worktree-visibility.ts";

const baseDir = "/Users/test/.impala/worktrees";

function worktree(overrides) {
  return {
    path: "/Users/test/project",
    branch: "feature/local-checkout",
    head_commit: "abc123",
    title: "Local checkout",
    is_primary: false,
    ...overrides,
  };
}

describe("filterWorktreesByBaseDir", () => {
  test("always keeps the primary checkout regardless of branch and location", () => {
    const primary = worktree({ is_primary: true });
    const externalLinked = worktree({
      path: "/Users/test/conductor/project/feature",
      branch: "feature/external",
      title: "External",
    });

    expect(
      filterWorktreesByBaseDir([primary, externalLinked], true, baseDir),
    ).toEqual([primary]);
  });

  test("does not mistake a linked main-branch worktree for the primary checkout", () => {
    const linkedMain = worktree({
      path: "/Users/test/conductor/project/main",
      branch: "main",
      title: null,
    });

    expect(filterWorktreesByBaseDir([linkedMain], true, baseDir)).toEqual([]);
  });

  test("keeps linked worktrees inside the configured base directory", () => {
    const managed = worktree({
      path: `${baseDir}/project/feature`,
      title: "Managed",
    });

    expect(filterWorktreesByBaseDir([managed], true, baseDir)).toEqual([
      managed,
    ]);
  });
});
