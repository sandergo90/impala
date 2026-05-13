import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useDataStore, useUIStore } from "../store";
import type { WorktreeDataState } from "../types";

function isAgentStatus(status: string): status is WorktreeDataState["agentStatus"] {
  return status === "working" || status === "idle" || status === "permission";
}

export function useAgentStatusSync() {
  const windowFocusedRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    const window = getCurrentWindow();
    window.isFocused().then((focused) => {
      if (!cancelled) windowFocusedRef.current = focused;
    });
    const unlisten = window.onFocusChanged(({ payload: focused }) => {
      windowFocusedRef.current = focused;
      if (focused) {
        const selected = useUIStore.getState().selectedWorktree;
        if (selected) {
          const state = useDataStore.getState().worktreeDataStates[selected.path];
          if (state?.hasUnseenResult) {
            useDataStore.getState().updateWorktreeDataState(selected.path, {
              hasUnseenResult: false,
            });
          }
        }
      }
    });
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    invoke<Record<string, string>>("get_agent_statuses").then((statuses) => {
      for (const [path, status] of Object.entries(statuses)) {
        if (isAgentStatus(status)) {
          useDataStore.getState().updateWorktreeDataState(path, {
            agentStatus: status,
          });
        }
      }
    });
  }, []);

  useEffect(() => {
    const unlisten = listen<{ worktree_path: string; status: string }>(
      "agent-status",
      (event) => {
        const { worktree_path, status } = event.payload;
        if (!isAgentStatus(status)) return;

        const current =
          useDataStore.getState().worktreeDataStates[worktree_path];
        const updates: Partial<WorktreeDataState> = {};

        if (current?.agentStatus !== status) {
          updates.agentStatus = status;
        }

        if (status === "idle" || status === "permission") {
          const selected = useUIStore.getState().selectedWorktree;
          const isFocused =
            windowFocusedRef.current && selected?.path === worktree_path;
          if (!isFocused && !current?.hasUnseenResult) {
            updates.hasUnseenResult = true;
          }
        } else if (status === "working" && current?.hasUnseenResult) {
          updates.hasUnseenResult = false;
        }

        if (Object.keys(updates).length > 0) {
          useDataStore
            .getState()
            .updateWorktreeDataState(worktree_path, updates);
        }
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const selectedWorktreePath = useUIStore((s) => s.selectedWorktree?.path);
  useEffect(() => {
    if (!selectedWorktreePath) return;
    const state =
      useDataStore.getState().worktreeDataStates[selectedWorktreePath];
    if (state?.hasUnseenResult) {
      useDataStore.getState().updateWorktreeDataState(selectedWorktreePath, {
        hasUnseenResult: false,
      });
    }
  }, [selectedWorktreePath]);
}
