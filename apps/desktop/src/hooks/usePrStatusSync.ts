import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useDataStore } from "../store";
import type { PrStatus, Worktree } from "../types";

const POLL_INTERVAL_MS = 60_000;

export function usePrStatusSync(worktrees: Worktree[]) {
  const focusedRef = useRef(true);

  // Keyed on the set of paths so renames / reorders / title edits don't
  // trigger a re-hydrate storm — only actual add/remove does.
  const pathKey = worktrees.map((w) => w.path).sort().join("\0");

  useEffect(() => {
    let cancelled = false;
    const w = getCurrentWindow();
    w.isFocused().then((f) => {
      if (!cancelled) focusedRef.current = f;
    });
    const unlisten = w.onFocusChanged(({ payload: focused }) => {
      focusedRef.current = focused;
      if (focused) refreshAll();
    });
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, []);

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

  useEffect(() => {
    for (const path of pathKey.split("\0").filter(Boolean)) {
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
    }
  }, [pathKey]);

  useEffect(() => {
    const id = setInterval(() => {
      if (focusedRef.current) refreshAll();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);
}

function refreshAll() {
  for (const w of useDataStore.getState().worktrees) {
    invoke("refresh_pr_status", { worktreePath: w.path }).catch(() => {});
  }
}
