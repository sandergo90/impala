import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useUIStore, useDataStore } from "../store";
import { resolveThemeById } from "../themes/apply";
import { PatchDiff, Virtualizer } from "@pierre/diffs/react";
import { sqliteProvider } from "../providers/sqlite-provider";
import { viewedFilesProvider } from "../providers/viewed-files-provider";
import { InlineAnnotationForm } from "./InlineAnnotationForm";
import { AnnotationDisplay } from "./AnnotationDisplay";
import type { DiffLineAnnotation } from "@pierre/diffs";
import type { Annotation, WorktreeDataState } from "../types";

type AnnotationMeta =
  | { type: 'comment'; annotation: Annotation }
  | { type: 'form' };

function hashPatch(patch: string): string {
  // Strip the diff header (index line contains abbreviated blob hashes whose
  // length can change as the git object database grows). Only hash from the
  // first hunk marker onward so the hash stays stable when metadata changes.
  const hunkStart = patch.indexOf("\n@@");
  const body = hunkStart >= 0 ? patch.slice(hunkStart) : patch;
  let hash = 0;
  for (let i = 0; i < body.length; i++) {
    hash = ((hash << 5) - hash + body.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

function encodeForPty(text: string): string {
  return btoa(
    Array.from(new TextEncoder().encode(text), (b) =>
      String.fromCharCode(b)
    ).join("")
  );
}

function ViewedButton({ isViewed, onClick }: { isViewed: boolean; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 text-xs px-2 py-0.5 rounded border transition-colors ${
        isViewed
          ? "border-blue-500/60 text-blue-400"
          : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
      }`}
    >
      <span className={`w-3.5 h-3.5 rounded flex items-center justify-center ${
        isViewed ? "bg-blue-500" : "border border-muted-foreground"
      }`}>
        {isViewed && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2 5L4 7L8 3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        )}
      </span>
      Viewed
    </button>
  );
}

export function DiffView() {
  const selectedProject = useUIStore((s) => s.selectedProject);
  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const diffStyle = useUIStore((s) => s.diffStyle);
  const setDiffStyle = useUIStore((s) => s.setDiffStyle);
  const wrap = useUIStore((s) => s.wrap);
  const setWrap = useUIStore((s) => s.setWrap);
  const activeThemeId = useUIStore((s) => s.activeThemeId);
  const customThemes = useUIStore((s) => s.customThemes);

  const wtPath = useUIStore((s) => s.selectedWorktree?.path);
  const navState = useUIStore((s) =>
    wtPath ? (s.worktreeNavStates[wtPath] ?? null) : null
  );
  const dataState = useDataStore((s) =>
    wtPath ? (s.worktreeDataStates[wtPath] ?? null) : null
  );

  const selectedFile = navState?.selectedFile ?? null;
  const diffText = dataState?.diffText ?? null;
  const selectedCommit = navState?.selectedCommit ?? null;
  const viewMode = navState?.viewMode ?? 'commit';
  const changedFiles = dataState?.changedFiles ?? [];
  const fileDiffs = dataState?.fileDiffs ?? {};
  const annotations = dataState?.annotations ?? [];

  const worktreePath = selectedWorktree?.path;
  const updateData = useCallback(
    (updates: Partial<WorktreeDataState>) => {
      if (worktreePath) {
        useDataStore.getState().updateWorktreeDataState(worktreePath, updates);
      }
    },
    [worktreePath]
  );


  const [showResolved, setShowResolved] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [viewedFiles, setViewedFiles] = useState<Set<string>>(new Set());
  const [pendingAnnotation, setPendingAnnotation] = useState<{
    lineNumber: number;
    side: 'deletions' | 'additions';
  } | null>(null);

  // Determine the commit hash for viewed-files scoping
  const commitHashForViewed =
    viewMode === "commit" && selectedCommit ? selectedCommit.hash
    : viewMode === "all-changes" ? "all-changes"
    : viewMode === "uncommitted" ? "uncommitted"
    : null;

  // Load viewed files from SQLite when commit context changes
  useEffect(() => {
    if (!worktreePath || !commitHashForViewed) {
      setViewedFiles(new Set());
      return;
    }
    viewedFilesProvider
      .list(worktreePath, commitHashForViewed)
      .then((rows) => {
        // Filter out stale entries where the patch has changed
        const valid = new Set<string>();
        const staleIds: string[] = [];
        for (const row of rows) {
          const currentPatch = fileDiffs[row.file_path];
          if (currentPatch && hashPatch(currentPatch) === row.patch_hash) {
            valid.add(row.file_path);
          } else if (currentPatch) {
            staleIds.push(row.file_path);
          }
        }
        setViewedFiles(valid);
        // Lazily clean up stale entries
        for (const fp of staleIds) {
          viewedFilesProvider.unset(worktreePath, commitHashForViewed, fp);
        }
      })
      .catch(() => setViewedFiles(new Set()));
  }, [worktreePath, commitHashForViewed, fileDiffs]);

  const toggleViewed = useCallback((path: string) => {
    if (!worktreePath || !commitHashForViewed) return;
    const patch = fileDiffs[path];
    if (!patch) return;

    const isCurrentlyViewed = viewedFiles.has(path);
    if (isCurrentlyViewed) {
      viewedFilesProvider.unset(worktreePath, commitHashForViewed, path);
      setViewedFiles((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    } else {
      viewedFilesProvider.set(worktreePath, commitHashForViewed, path, hashPatch(patch));
      setViewedFiles((prev) => new Set(prev).add(path));
    }
  }, [worktreePath, commitHashForViewed, fileDiffs, viewedFiles]);

  // Load annotations when file/commit context changes
  useEffect(() => {
    setPendingAnnotation(null);
    if (!selectedProject || !selectedFile) {
      updateData({ annotations: [] });
      return;
    }

    const repoPath = selectedProject.path;
    const filePath = selectedFile.path;
    const commitHash =
      viewMode === "commit" && selectedCommit
        ? selectedCommit.hash
        : "all-changes";

    sqliteProvider
      .list(repoPath, filePath, commitHash)
      .then((anns) => updateData({ annotations: anns }))
      .catch(() => {
        toast.error("Failed to load annotations");
        updateData({ annotations: [] });
      });
  }, [
    selectedProject?.path,
    selectedFile?.path,
    selectedCommit?.hash,
    viewMode,
    updateData,
  ]);

  // Re-fetch annotations when the DB is modified externally (e.g. MCP server)
  useEffect(() => {
    const unlisten = listen("annotations-changed", () => {
      if (!selectedProject || !selectedFile) return;
      const repoPath = selectedProject.path;
      const filePath = selectedFile.path;
      const commitHash =
        viewMode === "commit" && selectedCommit
          ? selectedCommit.hash
          : "all-changes";
      sqliteProvider
        .list(repoPath, filePath, commitHash)
        .then((anns) => updateData({ annotations: anns }))
        .catch(() => {});
    });

    return () => { unlisten.then((fn) => fn()); };
  }, [selectedProject?.path, selectedFile?.path, selectedCommit?.hash, viewMode, updateData]);

  const lineAnnotations = useMemo((): DiffLineAnnotation<AnnotationMeta>[] => {
    const items: DiffLineAnnotation<AnnotationMeta>[] = annotations.map((a) => ({
      side: a.side === "left" ? ("deletions" as const) : ("additions" as const),
      lineNumber: a.line_number,
      metadata: { type: 'comment' as const, annotation: a },
    }));

    if (pendingAnnotation) {
      items.push({
        side: pendingAnnotation.side,
        lineNumber: pendingAnnotation.lineNumber,
        metadata: { type: 'form' as const },
      });
    }

    return items;
  }, [annotations, pendingAnnotation]);

  const pendingAnnotationRef = useRef(pendingAnnotation);
  pendingAnnotationRef.current = pendingAnnotation;

  const renderGutterUtility = useCallback(
    (getHoveredLine: () => { lineNumber: number; side: 'deletions' | 'additions' } | undefined) => {
      return (
        <button
          className="flex items-center justify-center w-5 h-5 rounded text-blue-400 hover:text-blue-300 hover:bg-blue-500/20 transition-colors text-sm font-bold leading-none"
          onClick={() => {
            const hovered = getHoveredLine();
            if (!hovered) return;
            const pa = pendingAnnotationRef.current;
            if (
              pa &&
              pa.lineNumber === hovered.lineNumber &&
              pa.side === hovered.side
            ) {
              setPendingAnnotation(null);
            } else {
              setPendingAnnotation(hovered);
            }
          }}
        >
          +
        </button>
      );
    },
    []
  );

  // Filtered and sorted annotations for the panel
  const visibleAnnotations = useMemo(() => {
    const filtered = showResolved
      ? annotations
      : annotations.filter((a) => !a.resolved);
    return [...filtered].sort((a, b) => a.line_number - b.line_number);
  }, [annotations, showResolved]);

  const handleCreate = useCallback(
    async (body: string, lineNumber: number, side: "left" | "right") => {
      if (!selectedProject || !selectedFile) return;
      const commitHash =
        viewMode === "commit" && selectedCommit
          ? selectedCommit.hash
          : "all-changes";
      const created = await sqliteProvider.create({
        repo_path: selectedProject.path,
        file_path: selectedFile.path,
        commit_hash: commitHash,
        line_number: lineNumber,
        side,
        body,
      });
      updateData({ annotations: [...annotations, created] });
    },
    [selectedProject, selectedFile, selectedCommit, viewMode, annotations, updateData]
  );

  const renderAnnotation = useCallback(
    (diffAnnotation: DiffLineAnnotation<AnnotationMeta>) => {
      const meta = diffAnnotation.metadata;
      if (!meta) return null;

      if (meta.type === 'form') {
        return (
          <InlineAnnotationForm
            onSubmit={(body) => {
              const side = diffAnnotation.side === "deletions" ? "left" as const : "right" as const;
              handleCreate(body, diffAnnotation.lineNumber, side);
              setPendingAnnotation(null);
            }}
            onCancel={() => setPendingAnnotation(null)}
          />
        );
      }

      const a = meta.annotation;
      if (a.resolved && !showResolved) return null;
      return (
        <div className="px-3 py-1.5 border-t border-border bg-card/60 text-xs">
          <span className="font-mono text-muted-foreground mr-2">
            {a.side === "left" ? "L" : "R"}:{a.line_number}
          </span>
          <span className="text-foreground">{a.body}</span>
          {a.resolved && (
            <span className="ml-2 text-green-400 text-[10px]">(resolved)</span>
          )}
        </div>
      );
    },
    [showResolved, handleCreate]
  );

  const handleResolve = useCallback(
    async (id: string, resolved: boolean) => {
      const updated = await sqliteProvider.update(id, { resolved });
      updateData({
        annotations: annotations.map((a) => (a.id === id ? updated : a)),
      });
    },
    [annotations, updateData]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await sqliteProvider.delete(id);
      updateData({
        annotations: annotations.filter((a) => a.id !== id),
      });
    },
    [annotations, updateData]
  );

  const sendPromptToClaude = useCallback(
    async (prompt: string) => {
      if (!worktreePath) return;

      let sessionId = useDataStore.getState().getWorktreeDataState(worktreePath).ptySessionId;
      if (!sessionId) {
        await invoke("pty_spawn", { sessionId: worktreePath, cwd: worktreePath });
        useDataStore.getState().updateWorktreeDataState(worktreePath, { ptySessionId: worktreePath });
        sessionId = worktreePath;
      }

      await invoke("pty_write", { sessionId, data: encodeForPty(prompt) });
      useUIStore.getState().updateWorktreeNavState(worktreePath, { activeTab: "terminal" });
    },
    [worktreePath]
  );

  const handleSendToClaude = useCallback(
    async (annotation: Annotation) => {
      const prompt = `Review and address the annotation on ${annotation.file_path} line ${annotation.line_number}: ${annotation.body}\n`;
      await sendPromptToClaude(prompt);
    },
    [sendPromptToClaude]
  );

  const handleSendAllToClaude = useCallback(
    async () => {
      if (!selectedFile || !annotations.some((a) => !a.resolved)) return;
      const prompt = `Review and address the annotations on ${selectedFile.path}\n`;
      await sendPromptToClaude(prompt);
    },
    [sendPromptToClaude, selectedFile, annotations]
  );

  const hasFileDiffs = Object.keys(fileDiffs).length > 0;
  const showAllFiles = !selectedFile && hasFileDiffs;
  const showSingleFile = selectedFile && diffText;

  if (!showAllFiles && !showSingleFile) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Select a commit or file to view its diff
      </div>
    );
  }

  const activeTheme = resolveThemeById(activeThemeId, customThemes);
  const differTheme = activeTheme.type === "dark" ? "differ-dark" : "differ-light";

  const diffOptions = {
    theme: differTheme,
    overflow: (wrap ? "wrap" : "scroll") as "wrap" | "scroll",
    diffStyle,
    enableGutterUtility: true,
    unsafeCSS: `[data-diffs-header] { position: sticky; top: 0; z-index: 10; } [data-gutter-utility-slot] { z-index: 1; }`,
  };

  const toolbar = (
    <div className="flex items-center gap-3 px-3 py-2 border-b shrink-0">
      <span className="font-mono font-semibold text-xs flex-1 truncate">
        {selectedFile ? selectedFile.path : selectedCommit?.message ?? "Diff"}
      </span>
      <div className="flex items-center gap-1 text-xs">
        <button
          onClick={() => setDiffStyle("split")}
          className={`px-2 py-0.5 rounded ${
            diffStyle === "split"
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Split
        </button>
        <button
          onClick={() => setDiffStyle("unified")}
          className={`px-2 py-0.5 rounded ${
            diffStyle === "unified"
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Unified
        </button>
        <span className="mx-1 text-border">|</span>
        <button
          onClick={() => setWrap(!wrap)}
          className={`px-2 py-0.5 rounded ${
            wrap
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Wrap
        </button>
        {showSingleFile && (
          <>
            <span className="mx-1 text-border">|</span>
            <button
              onClick={() => setShowResolved(!showResolved)}
              className={`px-2 py-0.5 rounded ${
                showResolved
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Resolved
            </button>
            {annotations.some((a) => !a.resolved) && (
              <button
                onClick={handleSendAllToClaude}
                className="px-2 py-0.5 rounded text-blue-400 hover:text-blue-300 hover:bg-blue-500/20"
              >
                Send to Claude
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );

  // Full commit view: all files stacked with virtualization
  if (showAllFiles) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        {toolbar}
        <Virtualizer
          className="flex-1 overflow-auto"
          config={{ overscrollSize: 500 }}
        >
          {changedFiles.map((file) => {
            const patch = fileDiffs[file.path];
            if (!patch) return null;
            const isViewed = viewedFiles.has(file.path);
            const isLargeFile = patch.length > 100_000;
            const isCollapsed = collapsedFiles.has(file.path) || isViewed || (isLargeFile && !collapsedFiles.has(`expanded:${file.path}`));

            const toggleCollapse = () => {
              setCollapsedFiles((prev) => {
                const next = new Set(prev);
                if (isLargeFile) {
                  const expandKey = `expanded:${file.path}`;
                  if (next.has(expandKey)) {
                    next.delete(expandKey);
                  } else {
                    next.add(expandKey);
                  }
                } else if (next.has(file.path)) {
                  next.delete(file.path);
                } else {
                  next.add(file.path);
                }
                return next;
              });
            };

            const scrollToNextFile = () => {
              // Scroll so the current file's collapsed header stays at top, next file visible below
              requestAnimationFrame(() => requestAnimationFrame(() => {
                const currentEl = document.querySelector(`[data-file-path="${CSS.escape(file.path)}"]`);
                if (!currentEl) return;
                const container = currentEl.closest(".overflow-auto");
                if (container) {
                  const containerRect = container.getBoundingClientRect();
                  const elRect = currentEl.getBoundingClientRect();
                  const offset = elRect.top - containerRect.top + container.scrollTop;
                  container.scrollTo({ top: offset, behavior: "smooth" });
                }
              }));
            };

            return (
              <div key={file.path} data-file-path={file.path} className={`border-b border-border ${isViewed ? "opacity-75" : ""}`}>
                <PatchDiff
                  patch={patch}
                  options={{ ...diffOptions, collapsed: isCollapsed }}
                  renderGutterUtility={renderGutterUtility}
                  renderHeaderPrefix={() => (
                    <button onClick={toggleCollapse} className="text-[10px] text-muted-foreground px-1">
                      {isCollapsed ? "▶" : "▼"}
                    </button>
                  )}
                  renderHeaderMetadata={() => (
                    <ViewedButton isViewed={isViewed} onClick={() => { toggleViewed(file.path); if (!isViewed) scrollToNextFile(); }} />
                  )}
                />
              </div>
            );
          })}
        </Virtualizer>
      </div>
    );
  }

  // Single file view with annotations
  return (
    <div className="flex flex-col h-full overflow-hidden">
      {toolbar}
      <div className="flex-1 overflow-auto">
        <PatchDiff<AnnotationMeta>
          patch={diffText!}
          lineAnnotations={lineAnnotations}
          renderAnnotation={renderAnnotation}
          renderGutterUtility={renderGutterUtility}
          options={diffOptions}
        />
      </div>

      {visibleAnnotations.length > 0 && (
        <div className="border-t bg-background">
          <div className="flex flex-col gap-1.5 p-3 max-h-48 overflow-y-auto">
            {visibleAnnotations.map((a) => (
              <AnnotationDisplay
                key={a.id}
                annotation={a}
                onResolve={handleResolve}
                onDelete={handleDelete}
                onSendToClaude={handleSendToClaude}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
