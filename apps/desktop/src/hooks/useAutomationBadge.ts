import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@/lib/invoke";
import { useUIStore } from "../store";

interface UnseenRunCounts {
  total: number;
  failed: number;
}

const NONE: UnseenRunCounts = { total: 0, failed: 0 };

/**
 * Finished automation runs (completed/failed) the user hasn't seen for the
 * selected project. Cleared when the Automations view marks them seen.
 */
export function useAutomationBadge(): UnseenRunCounts {
  const projectPath = useUIStore((s) => s.selectedProject?.path);
  const [counts, setCounts] = useState<UnseenRunCounts>(NONE);

  const refresh = useCallback(() => {
    if (!projectPath) {
      setCounts(NONE);
      return;
    }
    invoke<UnseenRunCounts>("count_unseen_automation_runs", {
      repo: projectPath,
    })
      .then(setCounts)
      .catch(() => setCounts(NONE));
  }, [projectPath]);

  useEffect(() => {
    refresh();
    const unlistens = [
      listen("automation-runs-changed", refresh),
      listen("automations-changed", refresh),
    ];
    return () => {
      for (const u of unlistens) u.then((fn) => fn());
    };
  }, [refresh]);

  return counts;
}
