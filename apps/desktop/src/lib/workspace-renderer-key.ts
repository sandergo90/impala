import { AGENT_PANE_ID } from "./pane-ids";

export function getWorkspaceRendererKey(
  layoutId: string,
  isUserTab: boolean,
): string {
  return isUserTab ? layoutId : AGENT_PANE_ID;
}

export function getPaneBodyKey(
  activeTabId: string,
  overridePaneId?: string,
): string {
  return overridePaneId ?? activeTabId;
}
