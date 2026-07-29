import { invoke } from "@/lib/invoke";
import { releaseCachedTerminal } from "../components/XtermTerminal";
import { viewedFilesProvider } from "../providers/viewed-files-provider";
import { useDataStore, useUIStore } from "../store";
import { useEditorDocsStore } from "../stores/editor-docs";
import {
  agentPtySessionId,
  panePtySessionId,
  runPtySessionId,
} from "./pane-ids";
import { getLeaves } from "./split-tree";
import { getEffectiveUserTabSplitTree } from "./tab-actions";

/** Stop every deterministic PTY and clear per-worktree state before deletion. */
export async function cleanupWorktreeForDeletion(
  worktreePath: string,
  extraSessionIds: string[] = [],
  requirePtyStop = false,
): Promise<void> {
  const editorDocs = useEditorDocsStore.getState();
  for (const key of Object.keys(editorDocs.docs)) {
    if (editorDocs.docs[key]?.worktreePath === worktreePath) {
      editorDocs.removeDoc(key);
    }
  }

  const dataState = useDataStore.getState().worktreeDataStates[worktreePath];
  const sessionIds = new Set([
    ...Object.values(dataState?.paneSessions ?? {}),
    runPtySessionId(worktreePath),
    agentPtySessionId(worktreePath),
    ...extraSessionIds,
  ]);
  const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
  for (const tab of nav.userTabs) {
    for (const group of getLeaves(getEffectiveUserTabSplitTree(tab))) {
      for (const groupTab of group.tabs) {
        if (groupTab.content.kind === "terminal") {
          sessionIds.add(panePtySessionId(worktreePath, groupTab.id));
        }
      }
    }
  }

  const ptyKills = [...sessionIds].map(async (sessionId) => {
    releaseCachedTerminal(sessionId);
    if (requirePtyStop) {
      await invoke("pty_kill", { sessionId });
    } else {
      await invoke("pty_kill", { sessionId }).catch(() => {});
    }
  });
  await Promise.all([
    ...ptyKills,
    invoke("clear_agent_worktree_status", { worktreePath }).catch(() => {}),
    invoke("unwatch_worktree", { worktreePath }).catch(() => {}),
    viewedFilesProvider.clearForWorktree(worktreePath).catch(() => {}),
    invoke("unlink_worktree_issue", { worktreePath }).catch(() => {}),
    invoke("unlink_worktree_title", { worktreePath }).catch(() => {}),
    invoke("delete_pr_status", { worktreePath }).catch(() => {}),
  ]);
  useDataStore.getState().updateWorktreeDataState(worktreePath, {
    hasUnseenResult: false,
  });
}
