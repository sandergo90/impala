import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useDataStore } from "../store";
import type { PrStatus, Worktree } from "../types";

const POLL_INTERVAL_MS = 60_000;

/**
 * Syncs per-worktree GitHub PR status into useDataStore.worktreeDataStates[path].prStatus.
 *
 * - Reads the cached row via `get_pr_status` for each worktree whenever the list changes.
 * - Listens for `pr-status-updated` events emitted by `refresh_pr_status`.
 * - Calls `refresh_pr_status` on worktree-list change and every 60s while focused.
 * - Re-refreshes on window-focus regain.
 */
export function usePrStatusSync(worktrees: Worktree[]) {
  const focusedRef = useRef(true);

  // Track focus
  useEffect(() => {
    let cancelled = false;
    const w = getCurrentWindow();
    w.isFocused().then((f) => {
      if (!cancelled) focusedRef.current = f;
    });
    const unlisten = w.onFocusChanged(({ payload: focused }) => {
      focusedRef.current = focused;
      if (focused) refreshAll(worktrees);
    });
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, [worktrees]);

  // Subscribe to backend events
  useEffect(() => {
    const unlisten = listen<{ worktreePath: string; status: PrStatus }>(
      "pr-status-updated",
      (event) => {
        useDataStore
          .getState()
          .updateWorktreeDataState(event.payload.worktreePath, {
            prStatus: event.payload.status,
          });
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // On worktree-list change: hydrate from cache, then refresh in background
  useEffect(() => {
    const paths = worktrees.map((w) => w.path);
    paths.forEach((path) => {
      invoke<PrStatus | null>("get_pr_status", { worktreePath: path })
        .then((status) => {
          if (status) {
            useDataStore
              .getState()
              .updateWorktreeDataState(path, { prStatus: status });
          }
        })
        .catch(() => {});
      invoke("refresh_pr_status", { worktreePath: path }).catch(() => {});
    });
  }, [worktrees]);

  // Periodic poll while focused
  useEffect(() => {
    const id = setInterval(() => {
      if (focusedRef.current) refreshAll(worktrees);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [worktrees]);
}

function refreshAll(worktrees: Worktree[]) {
  for (const w of worktrees) {
    invoke("refresh_pr_status", { worktreePath: w.path }).catch(() => {});
  }
}
