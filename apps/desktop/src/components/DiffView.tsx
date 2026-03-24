import { useEffect, useState, useMemo, useCallback } from "react";
import { toast } from "sonner";
import { useAppStore } from "../store";
import { PatchDiff } from "@pierre/diffs/react";
import { sqliteProvider } from "../providers/sqlite-provider";
import { AnnotationForm } from "./AnnotationForm";
import { AnnotationDisplay } from "./AnnotationDisplay";
import type { DiffLineAnnotation } from "@pierre/diffs";
import type { Annotation } from "../types";

export function DiffView() {
  const selectedProject = useAppStore((s) => s.selectedProject);
  const selectedWorktree = useAppStore((s) => s.selectedWorktree);
  const diffStyle = useAppStore((s) => s.diffStyle);
  const setDiffStyle = useAppStore((s) => s.setDiffStyle);
  const wrap = useAppStore((s) => s.wrap);
  const setWrap = useAppStore((s) => s.setWrap);

  const wtPath = useAppStore((s) => s.selectedWorktree?.path);
  const wtState = useAppStore((s) =>
    wtPath ? (s.worktreeStates[wtPath] ?? null) : null
  );

  const selectedFile = wtState?.selectedFile ?? null;
  const diffText = wtState?.diffText ?? null;
  const selectedCommit = wtState?.selectedCommit ?? null;
  const viewMode = wtState?.viewMode ?? 'commit';
  const changedFiles = wtState?.changedFiles ?? [];
  const fileDiffs = wtState?.fileDiffs ?? {};
  const annotations = wtState?.annotations ?? [];

  const worktreePath = selectedWorktree?.path;
  const update = useCallback(
    (updates: Partial<NonNullable<typeof wtState>>) => {
      if (worktreePath) {
        useAppStore.getState().updateWorktreeState(worktreePath, updates);
      }
    },
    [worktreePath]
  );

  const [showResolved, setShowResolved] = useState(false);
  const [showAnnotationForm, setShowAnnotationForm] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [viewedFiles, setViewedFiles] = useState<Set<string>>(new Set());

  // Load annotations when file/commit context changes
  useEffect(() => {
    if (!selectedProject || !selectedFile) {
      update({ annotations: [] });
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
      .then((anns) => update({ annotations: anns }))
      .catch(() => {
        toast.error("Failed to load annotations");
        update({ annotations: [] });
      });
  }, [
    selectedProject?.path,
    selectedFile?.path,
    selectedCommit?.hash,
    viewMode,
    update,
  ]);

  // Build Pierre lineAnnotations from our annotations for inline rendering
  const lineAnnotations = useMemo((): DiffLineAnnotation<Annotation>[] => {
    return annotations.map((a) => ({
      side: a.side === "left" ? ("deletions" as const) : ("additions" as const),
      lineNumber: a.line_number,
      metadata: a,
    }));
  }, [annotations]);

  // Render inline annotation via Pierre's renderAnnotation slot
  const renderAnnotation = useCallback(
    (diffAnnotation: DiffLineAnnotation<Annotation>) => {
      const a = diffAnnotation.metadata;
      if (!a) return null;
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
    [showResolved]
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
      update({ annotations: [...annotations, created] });
      setShowAnnotationForm(false);
    },
    [selectedProject, selectedFile, selectedCommit, viewMode, annotations, update]
  );

  const handleResolve = useCallback(
    async (id: string, resolved: boolean) => {
      const updated = await sqliteProvider.update(id, { resolved });
      update({
        annotations: annotations.map((a) => (a.id === id ? updated : a)),
      });
    },
    [annotations, update]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await sqliteProvider.delete(id);
      update({
        annotations: annotations.filter((a) => a.id !== id),
      });
    },
    [annotations, update]
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

  const diffOptions = {
    theme: "pierre-dark" as const,
    overflow: (wrap ? "wrap" : "scroll") as "wrap" | "scroll",
    diffStyle,
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
            <button
              onClick={() => setShowAnnotationForm(!showAnnotationForm)}
              className="px-2 py-0.5 rounded bg-accent text-accent-foreground hover:opacity-90"
            >
              + Comment
            </button>
          </>
        )}
      </div>
    </div>
  );

  // Full commit view: all files stacked
  if (showAllFiles) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        {toolbar}
        <div className="flex-1 overflow-auto">
          {changedFiles.map((file) => {
            const patch = fileDiffs[file.path];
            if (!patch) return null;
            const isViewed = viewedFiles.has(file.path);
            const isCollapsed = collapsedFiles.has(file.path) || isViewed;
            return (
              <div key={file.path} className={`border-b border-border ${isViewed ? "opacity-60" : ""}`}>
                <PatchDiff
                  patch={patch}
                  options={{ ...diffOptions, collapsed: isCollapsed }}
                  renderHeaderPrefix={() => (
                    <button
                      onClick={() => {
                        setCollapsedFiles((prev) => {
                          const next = new Set(prev);
                          if (next.has(file.path)) {
                            next.delete(file.path);
                          } else {
                            next.add(file.path);
                          }
                          return next;
                        });
                      }}
                      className="text-[10px] text-muted-foreground px-1"
                    >
                      {isCollapsed ? "▶" : "▼"}
                    </button>
                  )}
                  renderHeaderMetadata={() => (
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer ml-auto pr-2">
                      <input
                        type="checkbox"
                        checked={isViewed}
                        onChange={() => {
                          setViewedFiles((prev) => {
                            const next = new Set(prev);
                            if (next.has(file.path)) {
                              next.delete(file.path);
                            } else {
                              next.add(file.path);
                            }
                            return next;
                          });
                        }}
                        className="rounded"
                      />
                      Viewed
                    </label>
                  )}
                />
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Single file view with annotations
  return (
    <div className="flex flex-col h-full overflow-hidden">
      {toolbar}
      <div className="flex-1 overflow-auto">
        <PatchDiff<Annotation>
          patch={diffText!}
          lineAnnotations={lineAnnotations}
          renderAnnotation={renderAnnotation}
          options={diffOptions}
        />
      </div>

      {/* Annotation panel below the diff */}
      <div className="border-t bg-background">
        {showAnnotationForm && (
          <div className="p-3 border-b">
            <AnnotationForm
              onSubmit={handleCreate}
              onCancel={() => setShowAnnotationForm(false)}
            />
          </div>
        )}
        {visibleAnnotations.length > 0 && (
          <div className="flex flex-col gap-1.5 p-3 max-h-48 overflow-y-auto">
            {visibleAnnotations.map((a) => (
              <AnnotationDisplay
                key={a.id}
                annotation={a}
                onResolve={handleResolve}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
