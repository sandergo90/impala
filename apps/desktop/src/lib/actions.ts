import type { Action } from "../types";

/**
 * Resolve which Action ID to fire next for a given Worktree, given the
 * Project's current actions[] and an optional last-used pointer for the
 * Worktree.
 *
 *   - If `lastUsedId` is set and still resolves in `actions`, use it.
 *   - Otherwise fall back to `actions[0]`.
 *   - Returns null when `actions` is empty.
 */
export function resolveActionToRun(
  actions: Action[],
  lastUsedId: string | null | undefined,
): Action | null {
  if (actions.length === 0) return null;
  if (lastUsedId) {
    const hit = actions.find((a) => a.id === lastUsedId);
    if (hit) return hit;
  }
  return actions[0];
}

/** Display label for an Action. Falls back to "Untitled" for empty/whitespace names. */
export function actionLabel(action: Action): string {
  const trimmed = action.name.trim();
  return trimmed.length === 0 ? "Untitled" : action.name;
}
