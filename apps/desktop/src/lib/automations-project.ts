import type { Project } from "../types";

/**
 * Internal project context for opening a global automation run as a workspace.
 * It is deliberately absent from the project picker: automation discovery and
 * run history live in the Automations view. The sentinel path never reaches
 * git-facing backend commands — flows that need paths use the scratch repos'
 * absolute paths.
 */
export const AUTOMATIONS_PROJECT: Project = {
  path: "impala://automation-runs",
  name: "Automations",
};

export function isAutomationsProject(project: Project | null | undefined): boolean {
  return project?.path === AUTOMATIONS_PROJECT.path;
}
