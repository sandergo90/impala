import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { sanitizeEventId } from "../lib/sanitize-event-id";
import { useUIStore } from "../store";

export interface FsEntry {
  name: string;
  kind: "file" | "directory" | "symlink";
  relativePath: string;
  ignored: boolean;
}

interface FsEventPayload {
  kind: "create" | "update" | "delete" | "rename" | "overflow";
  path: string | null;
  oldPath: string | null;
  isDirectory: boolean | null;
}

function parentDirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

export function useFileTreeData(worktreePath: string | null) {
  const [paths, setPaths] = useState<string[]>([]);
  const [entriesByPath, setEntriesByPath] = useState<Map<string, FsEntry>>(new Map());

  const expandedDirsRef = useRef<Set<string>>(new Set());
  const childrenByDirRef = useRef<Map<string, FsEntry[]>>(new Map());
  // Bumped on every worktree change. Async fetches capture the epoch at start
  // and discard their result if it changed by the time they resolve.
  const epochRef = useRef(0);
  // Cache key over the last published paths set; lets recomputePaths skip
  // setState when the union didn't actually change (avoids a downstream
  // model.resetPaths walk on no-op fs events).
  const prevPathsKeyRef = useRef<string>("");

  const fetchDir = useCallback(
    async (relDir: string): Promise<FsEntry[]> => {
      if (!worktreePath) return [];
      const myEpoch = epochRef.current;
      const entries = await invoke<FsEntry[]>("list_directory", {
        worktreePath,
        relDir,
      });
      if (myEpoch !== epochRef.current) return [];
      childrenByDirRef.current.set(relDir, entries);
      return entries;
    },
    [worktreePath],
  );

  const recomputePaths = useCallback(() => {
    const all: string[] = [];
    const byPath = new Map<string, FsEntry>();
    for (const entries of childrenByDirRef.current.values()) {
      for (const e of entries) {
        all.push(e.relativePath);
        byPath.set(e.relativePath, e);
      }
    }
    all.sort();
    const key = all.join("\0");
    if (key === prevPathsKeyRef.current) return;
    prevPathsKeyRef.current = key;
    setPaths(all);
    setEntriesByPath(byPath);
  }, []);

  const refetchAll = useCallback(async () => {
    if (!worktreePath) return;
    const myEpoch = epochRef.current;
    await Promise.all([
      fetchDir(""),
      ...Array.from(expandedDirsRef.current).map((d) => fetchDir(d)),
    ]);
    if (myEpoch !== epochRef.current) return;

    const validDirs = new Set<string>();
    for (const entries of childrenByDirRef.current.values()) {
      for (const e of entries) {
        if (e.kind === "directory") validDirs.add(e.relativePath);
      }
    }
    for (const dir of childrenByDirRef.current.keys()) {
      if (dir !== "") validDirs.add(dir);
    }
    const pruned = new Set<string>();
    for (const dir of expandedDirsRef.current) {
      if (validDirs.has(dir)) pruned.add(dir);
    }
    if (pruned.size !== expandedDirsRef.current.size) {
      expandedDirsRef.current = pruned;
      useUIStore
        .getState()
        .setWorktreeExpandedDirs(worktreePath, Array.from(pruned));
    }

    recomputePaths();
  }, [worktreePath, fetchDir, recomputePaths]);

  const handleFsEvent = useCallback(
    (ev: FsEventPayload) => {
      if (ev.kind === "overflow") {
        void refetchAll();
        return;
      }

      // File-content updates don't change the parent's listing — skip refetch.
      // Directory updates (mtime bumps, permissions) still flow through.
      if (ev.kind === "update" && ev.isDirectory === false) {
        return;
      }

      // Directory rename retarget: rewrite expanded paths under the old prefix
      // so they re-anchor under the new prefix.
      //
      // NOTE: only fires when the watcher emits a paired `rename` event.
      // Currently that's Linux-only — macOS FSEvents does not pair the old
      // and new sides of a rename, so renames there arrive as separate
      // delete + create events and the retarget never runs. The expanded-
      // dirs set self-heals on the next refetchAll prune. See
      // backend/tauri/src/watcher.rs (RenameMode handling) for context.
      if (ev.kind === "rename" && ev.isDirectory && ev.oldPath && ev.path) {
        const newSet = new Set<string>();
        for (const dir of expandedDirsRef.current) {
          if (dir === ev.oldPath || dir.startsWith(ev.oldPath + "/")) {
            const tail = dir.slice(ev.oldPath.length);
            newSet.add(ev.path + tail);
          } else {
            newSet.add(dir);
          }
        }
        expandedDirsRef.current = newSet;
        if (worktreePath) {
          useUIStore
            .getState()
            .setWorktreeExpandedDirs(worktreePath, Array.from(newSet));
        }
      }

      const parents = new Set<string>();
      if (ev.path) parents.add(parentDirOf(ev.path));
      if (ev.oldPath) parents.add(parentDirOf(ev.oldPath));

      for (const parent of parents) {
        // Only refetch parents we've already loaded (root or expanded dirs).
        if (childrenByDirRef.current.has(parent) || parent === "") {
          void fetchDir(parent).then(() => recomputePaths());
        }
      }
    },
    [refetchAll, fetchDir, recomputePaths, worktreePath],
  );

  useEffect(() => {
    epochRef.current += 1;
    childrenByDirRef.current = new Map();
    prevPathsKeyRef.current = "";
    setPaths([]);
    setEntriesByPath(new Map());
    if (!worktreePath) {
      expandedDirsRef.current = new Set();
      return;
    }
    const persisted = useUIStore.getState().worktreeExpandedDirs[worktreePath] ?? [];
    expandedDirsRef.current = new Set(persisted);
    void refetchAll();
  }, [worktreePath, refetchAll]);

  useEffect(() => {
    if (!worktreePath) return;
    let unlisten: UnlistenFn | null = null;
    const eventName = `fs-event-${sanitizeEventId(worktreePath)}`;
    (async () => {
      unlisten = await listen<FsEventPayload>(eventName, (e) => {
        handleFsEvent(e.payload);
      });
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [worktreePath, handleFsEvent]);

  const expand = useCallback(
    async (relDir: string) => {
      if (expandedDirsRef.current.has(relDir)) return;
      const myEpoch = epochRef.current;
      expandedDirsRef.current.add(relDir);
      await fetchDir(relDir);
      if (myEpoch !== epochRef.current) return;
      recomputePaths();
      if (worktreePath) {
        useUIStore
          .getState()
          .setWorktreeExpandedDirs(worktreePath, Array.from(expandedDirsRef.current));
      }
    },
    [fetchDir, recomputePaths, worktreePath],
  );

  return { paths, entriesByPath, expand };
}
