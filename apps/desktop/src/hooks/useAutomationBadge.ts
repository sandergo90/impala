import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@/lib/invoke";

interface UnseenRunCounts {
  total: number;
  failed: number;
}

const NONE: UnseenRunCounts = { total: 0, failed: 0 };

/**
 * Finished automation runs (completed/failed) the user hasn't seen — across
 * all projects and global automations, matching the unscoped Automations
 * view. Cleared when the view marks them seen.
 */
export function useAutomationBadge(): UnseenRunCounts {
  const [counts, setCounts] = useState<UnseenRunCounts>(NONE);

  const refresh = useCallback(() => {
    invoke<UnseenRunCounts>("count_unseen_automation_runs")
      .then(setCounts)
      .catch(() => setCounts(NONE));
  }, []);

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
