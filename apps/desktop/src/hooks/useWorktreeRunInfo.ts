import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@/lib/invoke";
import type { Automation, AutomationRun } from "../types";
import { codexAutomationThreadToResume } from "../lib/automation-run-resume";

export interface WorktreeRunInfo {
  runId: string;
  automationId: string;
  automationName: string;
  status: AutomationRun["status"];
  codexResumeThreadId?: string;
  /** Unix seconds of the run's scheduled slot. */
  scheduledFor: number;
}

interface WorktreeRunInfoState {
  info: Record<string, WorktreeRunInfo>;
  loaded: boolean;
}

/**
 * Latest automation run per worktree path — how the sidebar tells
 * automation-spawned worktrees apart from hand-made ones and groups them
 * per automation. `loaded` prevents worktree terminals from launching before
 * the app knows whether an automation thread must be resumed.
 */
export function useWorktreeRunInfo(): WorktreeRunInfoState {
  const [state, setState] = useState<WorktreeRunInfoState>({
    info: {},
    loaded: false,
  });

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
            runId: run.id,
            automationId: run.automation_id,
            automationName: names.get(run.automation_id) ?? "Automation",
            status: run.status,
            codexResumeThreadId: codexAutomationThreadToResume(run),
            scheduledFor: run.scheduled_for,
          };
        }
        setState({ info: next, loaded: true });
      } catch {
        // Best-effort — the sidebar falls back to one flat list.
        if (!stale) setState((current) => ({ ...current, loaded: true }));
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

  return state;
}
