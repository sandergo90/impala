import { useCallback, useEffect, useState } from "react";
import { invoke } from "@/lib/invoke";
import { listen } from "@tauri-apps/api/event";
import { useUIStore } from "../store";
import type { BrowserAnnotation } from "../types";

/**
 * Browser annotations for the selected worktree. Loaded fresh (including
 * resolved — the panel filters), refreshed on the same `annotations-changed`
 * event the code annotations use.
 */
export function useBrowserAnnotations() {
  const worktreePath = useUIStore((s) => s.selectedWorktree?.path);
  const [browserAnnotations, setBrowserAnnotations] = useState<
    BrowserAnnotation[]
  >([]);

  const refresh = useCallback(() => {
    if (!worktreePath) {
      setBrowserAnnotations([]);
      return;
    }
    invoke<BrowserAnnotation[]>("list_browser_annotations", {
      repo: worktreePath,
      includeResolved: true,
    })
      .then(setBrowserAnnotations)
      .catch(() => setBrowserAnnotations([]));
  }, [worktreePath]);

  useEffect(() => {
    refresh();
    const unlisten = listen("annotations-changed", refresh);
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [refresh]);

  const resolveBrowserAnnotation = useCallback(async (id: string) => {
    await invoke("resolve_browser_annotation", { id });
    // annotations-changed re-fetches, but flip optimistically so the row
    // doesn't lag behind the click.
    setBrowserAnnotations((prev) =>
      prev.map((a) => (a.id === id ? { ...a, resolved: true } : a)),
    );
  }, []);

  return { browserAnnotations, resolveBrowserAnnotation };
}
