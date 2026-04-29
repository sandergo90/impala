import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { sanitizeEventId } from "../lib/sanitize-event-id";

export interface FsEntry {
  name: string;
  kind: "file" | "directory" | "symlink";
  relativePath: string;
  ignored: boolean;
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
    recomputePaths();
  }, [worktreePath, fetchDir, recomputePaths]);

  useEffect(() => {
    epochRef.current += 1;
    expandedDirsRef.current = new Set();
    childrenByDirRef.current = new Map();
    prevPathsKeyRef.current = "";
    setPaths([]);
    setEntriesByPath(new Map());
    if (!worktreePath) return;
    void refetchAll();
  }, [worktreePath, refetchAll]);

  useEffect(() => {
    if (!worktreePath) return;
    let unlisten: UnlistenFn | null = null;
    const eventName = `fs-changed-${sanitizeEventId(worktreePath)}`;
    (async () => {
      unlisten = await listen(eventName, () => {
        void refetchAll();
      });
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [worktreePath, refetchAll]);

  const expand = useCallback(
    async (relDir: string) => {
      if (expandedDirsRef.current.has(relDir)) return;
      const myEpoch = epochRef.current;
      expandedDirsRef.current.add(relDir);
      await fetchDir(relDir);
      if (myEpoch !== epochRef.current) return;
      recomputePaths();
    },
    [fetchDir, recomputePaths],
  );

  return { paths, entriesByPath, expand };
}
