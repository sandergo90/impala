import { openFileTabFromTree } from "./tab-actions";

export function openFileFromFinder(
  worktreePath: string,
  path: string,
  pin: boolean,
): void {
  openFileTabFromTree(worktreePath, path, { pin });
}
