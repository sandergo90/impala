import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Action, ProjectConfig } from "../types";
import { useDataStore } from "../store";

/**
 * Read-on-mount and re-read-when-projectPath-changes hook that populates the
 * project-actions cache. Returns the current cached `actions[]` for the
 * project (defaulting to []), kept in sync via the `useDataStore` selector.
 */
export function useProjectActions(projectPath: string | null): Action[] {
  const cached = useDataStore((s) =>
    projectPath ? s.projectActionsCache[projectPath] ?? null : null,
  );

  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    (async () => {
      try {
        const config = await invoke<ProjectConfig>("read_project_config", {
          projectPath,
        });
        if (!cancelled) {
          useDataStore
            .getState()
            .setProjectActionsCache(projectPath, config.actions ?? []);
        }
      } catch {
        // ignore — header renders empty actions if read fails
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  return cached ?? [];
}
