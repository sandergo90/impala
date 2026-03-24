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
  const {
    selectedFile,
    diffText,
    diffStyle,
    setDiffStyle,
    wrap,
    setWrap,
    selectedProject,
    selectedCommit,
    viewMode,
    annotations,
    setAnnotations,
    addAnnotation,
    updateAnnotation,
    removeAnnotation,
  } = useAppStore();

  const [showResolved, setShowResolved] = useState(false);
  const [showAnnotationForm, setShowAnnotationForm] = useState(false);

  // Load annotations when file/commit context changes
  useEffect(() => {
    if (!selectedProject || !selectedFile) {
      setAnnotations([]);
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
      .then(setAnnotations)
      .catch(() => {
        toast.error("Failed to load annotations");
        setAnnotations([]);
      });
  }, [
    selectedProject?.path,
    selectedFile?.path,
    selectedCommit?.hash,
    viewMode,
    setAnnotations,
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
    [showResolved],
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
      addAnnotation(created);
      setShowAnnotationForm(false);
    },
    [selectedProject, selectedFile, selectedCommit, viewMode, addAnnotation],
  );

  const handleResolve = useCallback(
    async (id: string, resolved: boolean) => {
      const updated = await sqliteProvider.update(id, { resolved });
      updateAnnotation(id, updated);
    },
    [updateAnnotation],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await sqliteProvider.delete(id);
      removeAnnotation(id);
    },
    [removeAnnotation],
  );

  if (!selectedFile || !diffText) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Select a file to view its diff
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-3 py-2 border-b">
        <span className="font-mono font-semibold text-xs flex-1 truncate">
          {selectedFile.path}
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
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        <PatchDiff<Annotation>
          patch={diffText}
          lineAnnotations={lineAnnotations}
          renderAnnotation={renderAnnotation}
          options={{
            theme: "github-dark",
            overflow: wrap ? "wrap" : "scroll",
            diffStyle,
          }}
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
