export const CLAUDE_PANE_ID = "tab-claude";
export const RUN_PANE_ID = "tab-run";

export function claudePtySessionId(worktreePath: string): string {
  return `pty-${CLAUDE_PANE_ID}-${worktreePath}`;
}

export function runPtySessionId(worktreePath: string): string {
  return `pty-${RUN_PANE_ID}-${worktreePath}`;
}

export function userTabPaneId(tabId: string): string {
  return `tab-user-${tabId}`;
}

export function userTabPtySessionId(worktreePath: string, tabId: string): string {
  return `pty-${userTabPaneId(tabId)}-${worktreePath}`;
}
