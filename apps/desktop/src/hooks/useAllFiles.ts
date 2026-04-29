import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { sanitizeEventId } from "../lib/sanitize-event-id";

interface FsEventPayload {
  kind: "create" | "update" | "delete" | "rename" | "overflow";
  path: string | null;
  oldPath: string | null;
  isDirectory: boolean | null;
}

/**
 * Per-worktree cache of every file path under the worktree (POSIX, relative).
 *
 * The list is fetched lazily on first call to `load` (e.g. when the file
 * finder palette opens) and invalidated whenever the watcher reports a
 * structural change (create/delete/rename/overflow). Content updates are
 * ignored — they don't change the file inventory.
 */
export function useAllFiles(worktreePath: string | null) {
  const [paths, setPaths] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  // Bumped on every worktree change. Async fetches capture the epoch at start
  // and discard their result if it changed by the time they resolve.
  const epochRef = useRef(0);
  const loadedRef = useRef(false);

  const load = async () => {
    if (!worktreePath) return;
    if (loadedRef.current) return;
    const myEpoch = epochRef.current;
    setLoading(true);
    try {
      const all = await invoke<string[]>("list_all_files", { worktreePath });
      if (myEpoch !== epochRef.current) return;
      loadedRef.current = true;
      setPaths(all);
    } catch (e) {
      if (myEpoch === epochRef.current) {
        loadedRef.current = true;
        console.error("list_all_files failed:", e);
      }
    } finally {
      if (myEpoch === epochRef.current) setLoading(false);
    }
  };

  // Reset cache when the worktree changes.
  useEffect(() => {
    epochRef.current += 1;
    loadedRef.current = false;
    setPaths([]);
    setLoading(false);
  }, [worktreePath]);

  // Invalidate on relevant fs-events. We don't refetch eagerly here — the
  // next `load()` call will repopulate. This avoids walking the tree on every
  // file save in worktrees the user isn't actively searching in.
  useEffect(() => {
    if (!worktreePath) return;
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    const eventName = `fs-event-${sanitizeEventId(worktreePath)}`;
    (async () => {
      const fn = await listen<FsEventPayload>(eventName, (e) => {
        // Content updates don't change the inventory.
        if (e.payload.kind === "update") return;
        loadedRef.current = false;
      });
      if (cancelled) fn();
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [worktreePath]);

  return { paths, loading, load };
}
