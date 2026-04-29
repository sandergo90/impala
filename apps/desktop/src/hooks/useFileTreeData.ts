import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface FsEntry {
  name: string;
  kind: "file" | "directory" | "symlink";
  relativePath: string;
  ignored: boolean;
}

function sanitizeEventId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "-");
}

export function useFileTreeData(worktreePath: string | null) {
  const [paths, setPaths] = useState<string[]>([]);
  const [dirSet, setDirSet] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const expandedDirsRef = useRef<Set<string>>(new Set());
  const childrenByDirRef = useRef<Map<string, FsEntry[]>>(new Map());

  const fetchDir = useCallback(
    async (relDir: string): Promise<FsEntry[]> => {
      if (!worktreePath) return [];
      const entries = await invoke<FsEntry[]>("list_directory", {
        worktreePath,
        relDir,
      });
      childrenByDirRef.current.set(relDir, entries);
      return entries;
    },
    [worktreePath],
  );

  const recomputePaths = useCallback(() => {
    const all = new Set<string>();
    const dirs = new Set<string>();
    for (const entries of childrenByDirRef.current.values()) {
      for (const e of entries) {
        all.add(e.relativePath);
        if (e.kind === "directory") dirs.add(e.relativePath);
      }
    }
    setPaths(Array.from(all));
    setDirSet(dirs);
  }, []);

  const refetchAll = useCallback(async () => {
    if (!worktreePath) return;
    setLoading(true);
    try {
      await fetchDir("");
      for (const dir of expandedDirsRef.current) {
        await fetchDir(dir);
      }
      recomputePaths();
    } finally {
      setLoading(false);
    }
  }, [worktreePath, fetchDir, recomputePaths]);

  useEffect(() => {
    expandedDirsRef.current = new Set();
    childrenByDirRef.current = new Map();
    setPaths([]);
    setDirSet(new Set());
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
      expandedDirsRef.current.add(relDir);
      await fetchDir(relDir);
      recomputePaths();
    },
    [fetchDir, recomputePaths],
  );

  const collapse = useCallback((relDir: string) => {
    expandedDirsRef.current.delete(relDir);
  }, []);

  const ignoredMap = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const entries of childrenByDirRef.current.values()) {
      for (const e of entries) m.set(e.relativePath, e.ignored);
    }
    return m;
  }, [paths]);

  return { paths, dirSet, ignoredMap, loading, expand, collapse, refetchAll };
}
