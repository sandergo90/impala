import { useEffect, useReducer } from "react";
import { useUIStore } from "../store";

export const AGENT_ACTIVITY_LABELS: Record<string, string> = {
  screenshot: "taking a screenshot",
  console: "reading the console",
  navigate: "navigating",
  page_info: "checking the page",
};

/**
 * Whether an agent recently touched this worktree's browser pane. Events are
 * discrete sub-second calls; the store holds an `until` timestamp (~2.5s past
 * the last event) so consecutive calls read as one continuous activity. This
 * hook re-renders once when the window expires.
 */
export function useBrowserAgentActivity(worktreePath: string): {
  active: boolean;
  kind: string | null;
} {
  const entry = useUIStore(
    (s) => s.browserAgentActivity[worktreePath] ?? null,
  );
  const [, force] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!entry) return;
    const remaining = entry.until - Date.now();
    if (remaining <= 0) return;
    const t = setTimeout(force, remaining + 50);
    return () => clearTimeout(t);
  }, [entry]);

  const active = entry !== null && entry.until > Date.now();
  return { active, kind: active ? entry.kind : null };
}
