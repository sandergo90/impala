import { useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useUIStore, useDataStore } from "../store";
import { sqliteProvider } from "../providers/sqlite-provider";
import { paneSessionId } from "../lib/split-tree";
import type { Annotation } from "../types";

function encodeForPty(text: string): string {
  return btoa(
    Array.from(new TextEncoder().encode(text), (b) =>
      String.fromCharCode(b)
    ).join("")
  );
}

export function useAnnotationActions() {
  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const worktreePath = selectedWorktree?.path;

  const wtPath = worktreePath ?? "";
  const navState = useUIStore((s) => wtPath ? (s.worktreeNavStates[wtPath] ?? null) : null);
  const dataState = useDataStore((s) => wtPath ? (s.worktreeDataStates[wtPath] ?? null) : null);

  const selectedFile = navState?.selectedFile ?? null;
  const annotations = dataState?.annotations ?? [];

  const updateData = useCallback(
    (updates: Partial<{ annotations: Annotation[] }>) => {
      if (worktreePath) {
        useDataStore.getState().updateWorktreeDataState(worktreePath, updates);
      }
    },
    [worktreePath]
  );

  // Refresh annotations when DB is modified externally (e.g. MCP server)
  useEffect(() => {
    if (!worktreePath) return;
    const unlisten = listen("annotations-changed", () => {
      sqliteProvider
        .list(worktreePath)
        .then((anns) => updateData({ annotations: anns }))
        .catch(() => {});
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [worktreePath, updateData]);

  const handleCreate = useCallback(
    async (body: string, lineNumber: number, side: "left" | "right", filePath?: string) => {
      if (!worktreePath) return;
      const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
      const resolvedFilePath = filePath ?? nav.selectedFile?.path;
      if (!resolvedFilePath) return;
      const commitHash =
        nav.viewMode === "commit" && nav.selectedCommit
          ? nav.selectedCommit.hash
          : "all-changes";
      const created = await sqliteProvider.create({
        repo_path: worktreePath,
        file_path: resolvedFilePath,
        commit_hash: commitHash,
        line_number: lineNumber,
        side,
        body,
      });
      const currentAnnotations = useDataStore.getState().getWorktreeDataState(worktreePath).annotations;
      updateData({ annotations: [...currentAnnotations, created] });
    },
    [worktreePath, updateData]
  );

  const handleResolve = useCallback(
    async (id: string, resolved: boolean) => {
      if (!worktreePath) return;
      const updated = await sqliteProvider.update(id, { resolved });
      const currentAnnotations = useDataStore.getState().getWorktreeDataState(worktreePath).annotations;
      updateData({
        annotations: currentAnnotations.map((a) => (a.id === id ? updated : a)),
      });
    },
    [worktreePath, updateData]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      if (!worktreePath) return;
      await sqliteProvider.delete(id);
      const currentAnnotations = useDataStore.getState().getWorktreeDataState(worktreePath).annotations;
      updateData({
        annotations: currentAnnotations.filter((a) => a.id !== id),
      });
    },
    [worktreePath, updateData]
  );

  const sendPromptToClaude = useCallback(
    async (prompt: string) => {
      if (!worktreePath) return;

      const paneSessions = useDataStore.getState().getWorktreeDataState(worktreePath).paneSessions;
      const focusedPaneId = useUIStore.getState().getWorktreeNavState(worktreePath).focusedPaneId;
      let sessionId = paneSessions[focusedPaneId] ?? Object.values(paneSessions)[0] ?? null;
      if (!sessionId) {
        sessionId = paneSessionId(focusedPaneId);
        await invoke("pty_spawn", { sessionId, cwd: worktreePath });
        useDataStore.getState().updateWorktreeDataState(worktreePath, {
          paneSessions: { ...paneSessions, [focusedPaneId]: sessionId },
        });
      }

      await invoke("pty_write", { sessionId, data: encodeForPty(prompt + "\r") });
    },
    [worktreePath]
  );

  const handleSendToClaude = useCallback(
    async (annotation: Annotation) => {
      await sendPromptToClaude(`/impala-review ${annotation.id}`);
    },
    [sendPromptToClaude]
  );

  const handleSendAllToClaude = useCallback(
    async () => {
      const unresolved = annotations.filter((a) => !a.resolved);
      if (unresolved.length === 0) return;
      await sendPromptToClaude("/impala-review");
    },
    [sendPromptToClaude, annotations]
  );

  return {
    annotations,
    selectedFile,
    handleCreate,
    handleResolve,
    handleDelete,
    handleSendToClaude,
    handleSendAllToClaude,
  };
}
