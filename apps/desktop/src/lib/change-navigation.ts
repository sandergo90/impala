import type { WorktreeNavState } from "../types";

export function shouldOpenChangesNavigator(
  activeTab: WorktreeNavState["activeTab"],
  viewMode: WorktreeNavState["viewMode"],
): boolean {
  return activeTab === "diff" || (viewMode !== "uncommitted" && viewMode !== "all-changes");
}
