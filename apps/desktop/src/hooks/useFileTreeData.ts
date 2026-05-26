import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { sanitizeEventId } from "../lib/sanitize-event-id";
import { dirname } from "../lib/path-utils";
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

function isSafeRelDir(d: string): boolean {
  if (d.startsWith("/")) return false;
  for (const seg of d.split("/")) {
    if (seg === "..") return false;
  }
  return true;
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
      if (ev.path) parents.add(dirname(ev.path));
      if (ev.oldPath) parents.add(dirname(ev.oldPath));

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
    // Drop any persisted dir that escapes the worktree. Legacy state seeded
    // before backend resolve_file_path normalized `..` could contain entries
    // like "../../var/folders/..." — feeding those into list_directory makes
    // the tree builder throw on collisions.
    const cleaned = persisted.filter((d) => isSafeRelDir(d));
    expandedDirsRef.current = new Set(cleaned);
    if (cleaned.length !== persisted.length) {
      useUIStore.getState().setWorktreeExpandedDirs(worktreePath, cleaned);
    }
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
      // Refuse paths that escape the worktree. list_directory will happily
      // walk anywhere on disk if rel_dir contains `..`, and the resulting
      // entries break the path-store builder. Keep the persisted set clean.
      if (!isSafeRelDir(relDir)) return;
      // Defer the persisted-store sync to a microtask so it lands AFTER trees
      // finishes its synchronous click handling (selectOnly → focus → toggle).
      // Trees fires a focus emit before the toggle, and FilesPanel's model
      // subscription would otherwise see the dir in persisted but not yet
      // expanded in the model and prune it — causing the new dir to expand
      // briefly and then collapse on the next resetPaths.
      //
      // Always sync, even when the ref already has this dir: FilesPanel may
      // have pruned it when the user collapsed it, and a re-expand needs to
      // put it back. Append rather than rewrite from the ref: the ref doesn't
      // see UI-driven collapses, so a rewrite would resurrect dirs the user
      // has since collapsed.
      if (worktreePath) {
        const wt = worktreePath;
        queueMicrotask(() => {
          const persisted =
            useUIStore.getState().worktreeExpandedDirs[wt] ?? [];
          if (!persisted.includes(relDir)) {
            useUIStore
              .getState()
              .setWorktreeExpandedDirs(wt, [...persisted, relDir]);
          }
        });
      }
      if (expandedDirsRef.current.has(relDir)) return;
      const myEpoch = epochRef.current;
      expandedDirsRef.current.add(relDir);
      await fetchDir(relDir);
      if (myEpoch !== epochRef.current) return;
      recomputePaths();
    },
    [fetchDir, recomputePaths, worktreePath],
  );

  // Re-fetch a dir we've already loaded and republish paths. Used after our
  // own fs mutations (new file/folder, rename, delete) so the tree updates
  // immediately instead of waiting for the watcher's 2s debounce in
  // backend/tauri/src/watcher.rs to fire.
  const refresh = useCallback(
    async (relDir: string) => {
      if (!worktreePath) return;
      if (relDir !== "" && !childrenByDirRef.current.has(relDir)) return;
      await fetchDir(relDir);
      recomputePaths();
    },
    [worktreePath, fetchDir, recomputePaths],
  );

  const collapseAll = useCallback(() => {
    expandedDirsRef.current = new Set();
    // Drop all loaded child listings except the root so the tree shrinks back
    // to top-level entries only.
    const root = childrenByDirRef.current.get("");
    childrenByDirRef.current = new Map();
    if (root) childrenByDirRef.current.set("", root);
    recomputePaths();
    if (worktreePath) {
      useUIStore.getState().setWorktreeExpandedDirs(worktreePath, []);
    }
  }, [recomputePaths, worktreePath]);

  return { paths, entriesByPath, expand, collapseAll, refresh };
}
