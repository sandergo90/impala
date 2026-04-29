import type { GitStatus } from "@pierre/trees";

/**
 * Map a raw git porcelain status code (XY two-char from `git status --porcelain`
 * or single-char from `diff-tree --name-status`) to the trees-package GitStatus.
 *
 * Returns null when the code is unrecognised — callers should drop the entry
 * rather than guess.
 */
export function mapGitStatus(raw: string): GitStatus | null {
  if (!raw) return null;
  const code = raw.trim();
  if (code === "??") return "untracked";
  if (code === "!!") return "ignored";
  const c = code[0]!;
  if (c === "M" || c === "T") return "modified";
  if (c === "A") return "added";
  if (c === "D") return "deleted";
  if (c === "R" || c === "C") return "renamed";
  if (c === "U") return "modified";
  if (c === " " && code.length > 1) {
    return mapGitStatus(code.slice(1));
  }
  return null;
}
