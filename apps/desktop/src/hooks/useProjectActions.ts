import type { Action, ProjectConfig } from "../types";
import { useDataStore } from "../store";
import { useInvoke } from "./useInvoke";

const EMPTY_ACTIONS: Action[] = [];

/**
 * Read-on-mount and re-read-when-projectPath-changes hook that populates the
 * project-actions cache. Returns the current cached `actions[]` for the
 * project (defaulting to []), kept in sync via the `useDataStore` selector.
 */
export function useProjectActions(projectPath: string | null): Action[] {
  const cached = useDataStore((s) =>
    projectPath ? s.projectActionsCache[projectPath] ?? null : null,
  );

  useInvoke<ProjectConfig>(
    "read_project_config",
    projectPath ? { projectPath } : undefined,
    {
      enabled: !!projectPath,
      onSuccess: (config) => {
        if (!projectPath) return;
        useDataStore
          .getState()
          .setProjectActionsCache(projectPath, config.actions ?? []);
      },
    },
  );

  return cached ?? EMPTY_ACTIONS;
}
