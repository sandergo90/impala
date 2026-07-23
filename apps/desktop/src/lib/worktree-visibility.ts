import type { Worktree } from "../types";

export function filterWorktreesByBaseDir(
  worktrees: Worktree[],
  enabled: boolean,
  baseDir: string | null,
): Worktree[] {
  if (!enabled || !baseDir) return worktrees;

  const prefix = baseDir.endsWith("/") ? baseDir : `${baseDir}/`;
  return worktrees.filter(
    (worktree) =>
      worktree.is_primary ||
      worktree.path === baseDir ||
      worktree.path.startsWith(prefix),
  );
}
