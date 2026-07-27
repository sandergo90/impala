import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@/lib/invoke";
import type { Automation, AutomationRun } from "../types";

export interface WorktreeRunInfo {
  automationId: string;
  automationName: string;
  status: AutomationRun["status"];
  /** Unix seconds of the run's scheduled slot. */
  scheduledFor: number;
}

/**
 * Latest automation run per worktree path — how the sidebar tells
 * automation-spawned worktrees apart from hand-made ones and groups them
 * per automation. Empty until the first fetch resolves.
 */
export function useWorktreeRunInfo(): Record<string, WorktreeRunInfo> {
  const [info, setInfo] = useState<Record<string, WorktreeRunInfo>>({});

  useEffect(() => {
    let stale = false;
    const refresh = async () => {
      try {
        const [automations, runs] = await Promise.all([
          invoke<Automation[]>("list_automations"),
          invoke<AutomationRun[]>("list_automation_runs"),
        ]);
        if (stale) return;
        const names = new Map(automations.map((a) => [a.id, a.name]));
        const next: Record<string, WorktreeRunInfo> = {};
        // Runs come newest-first; keep the newest run per worktree.
        for (const run of runs) {
          if (!run.worktree_path || next[run.worktree_path]) continue;
          next[run.worktree_path] = {
            automationId: run.automation_id,
            automationName: names.get(run.automation_id) ?? "Automation",
            status: run.status,
            scheduledFor: run.scheduled_for,
          };
        }
        setInfo(next);
      } catch {
        // Best-effort — the sidebar falls back to one flat list.
      }
    };
    refresh();
    const unlistens = [
      listen("automations-changed", refresh),
      listen("automation-runs-changed", refresh),
    ];
    return () => {
      stale = true;
      for (const u of unlistens) u.then((fn) => fn());
    };
  }, []);

  return info;
}
