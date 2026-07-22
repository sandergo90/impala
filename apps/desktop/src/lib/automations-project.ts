import type { Project } from "../types";

/**
 * The virtual "Automations" project pinned in the sidebar's project picker.
 * Its worktree list is the global automation runs' scratch repos (each a
 * standalone git repo under ~/.impala/automation-runs). The sentinel path
 * never reaches git-facing backend commands — the flows that need paths use
 * the scratch repos' absolute paths.
 */
export const AUTOMATIONS_PROJECT: Project = {
  path: "impala://automation-runs",
  name: "Automations",
};

export function isAutomationsProject(project: Project | null | undefined): boolean {
  return project?.path === AUTOMATIONS_PROJECT.path;
}
