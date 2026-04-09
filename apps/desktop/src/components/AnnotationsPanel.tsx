import { useMemo } from "react";
import { useUIStore, useDataStore } from "../store";
import { useAnnotationActions } from "../hooks/useAnnotationActions";
import { AnnotationDisplay } from "./AnnotationDisplay";
import type { Annotation } from "../types";

export function AnnotationsPanel() {
  const showResolved = useUIStore((s) => s.showResolved);
  const setShowResolved = useUIStore((s) => s.setShowResolved);

  const {
    annotations,
    selectedFile,
    handleResolve,
    handleDelete,
    handleSendToClaude,
    handleSendAllToClaude,
  } = useAnnotationActions();

  // Filter by resolved status
  const filtered = useMemo(() => {
    return showResolved
      ? annotations
      : annotations.filter((a) => !a.resolved);
  }, [annotations, showResolved]);

  // Scope: current file only, or all files grouped
  const scoped = useMemo(() => {
    if (selectedFile) {
      return filtered.filter((a) => a.file_path === selectedFile.path);
    }
    return filtered;
  }, [filtered, selectedFile]);

  // Group by file, sorted by line_number within each group
  const grouped = useMemo(() => {
    const map = new Map<string, Annotation[]>();
    const sorted = [...scoped].sort((a, b) => a.line_number - b.line_number);
    for (const a of sorted) {
      const items = map.get(a.file_path) ?? [];
      items.push(a);
      map.set(a.file_path, items);
    }
    return map;
  }, [scoped]);

  const hasAnnotations = annotations.length > 0;
  const hasUnresolved = annotations.some((a) => !a.resolved);

  const scrollToLine = (annotation: Annotation) => {
    // Select the file if not already selected
    const wtPath = useUIStore.getState().selectedWorktree?.path;
    if (!wtPath) return;

    const nav = useUIStore.getState().getWorktreeNavState(wtPath);

    // If a specific file isn't selected, select it first
    if (!nav.selectedFile || nav.selectedFile.path !== annotation.file_path) {
      const dataState = useDataStore.getState().getWorktreeDataState(wtPath);
      const file = dataState.changedFiles.find((f) => f.path === annotation.file_path);
      if (file) {
        useUIStore.getState().updateWorktreeNavState(wtPath, { selectedFile: file });
        const diff = dataState.fileDiffs[file.path] ?? "";
        useDataStore.getState().updateWorktreeDataState(wtPath, { diffText: diff });
      }
    }

    // Switch to diff tab if not already there
    if (nav.activeTab !== "diff" && nav.activeTab !== "split") {
      useUIStore.getState().updateWorktreeNavState(wtPath, { activeTab: "diff" });
    }

    // Scroll to the line after a brief delay to let the diff render
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const side = annotation.side === "left" ? "deletions" : "additions";
        const lineEl = document.querySelector(
          `[data-line-number="${annotation.line_number}"][data-side="${side}"]`
        ) ?? document.querySelector(
          `[data-line-number="${annotation.line_number}"]`
        );
        if (lineEl) {
          lineEl.scrollIntoView({ behavior: "smooth", block: "center" });
          lineEl.classList.add("annotation-highlight");
          setTimeout(() => lineEl.classList.remove("annotation-highlight"), 1500);
        }
      });
    });
  };

  // Empty state
  if (!hasAnnotations) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground/90 gap-2 px-4">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/90">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <span className="text-sm text-center">Click on lines to add annotations</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Actions header */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border shrink-0">
        <button
          onClick={() => setShowResolved(!showResolved)}
          className={`px-2 py-0.5 rounded text-sm ${
            showResolved
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Resolved
        </button>
        {hasUnresolved && (
          <button
            onClick={handleSendAllToClaude}
            className="px-2 py-0.5 rounded text-sm text-blue-400 hover:text-blue-300 hover:bg-blue-500/20 ml-auto"
          >
            Send to Claude
          </button>
        )}
      </div>

      {/* Annotations list */}
      <div className="overflow-y-auto flex-1 min-h-0">
        {scoped.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground/90 text-center">
            {showResolved ? "No annotations" : "No unresolved annotations"}
          </div>
        ) : selectedFile ? (
          // Single file: flat list
          <div className="flex flex-col gap-1.5 p-2">
            {scoped.map((a) => (
              <div key={a.id} className="cursor-pointer" onClick={() => scrollToLine(a)}>
                <AnnotationDisplay
                  annotation={a}
                  onResolve={handleResolve}
                  onDelete={handleDelete}
                  onSendToClaude={handleSendToClaude}
                />
              </div>
            ))}
          </div>
        ) : (
          // All files: grouped
          <div className="flex flex-col">
            {[...grouped.entries()].map(([filePath, fileAnnotations]) => (
              <div key={filePath}>
                <div className="px-3 py-1.5 text-sm uppercase tracking-[1.2px] text-muted-foreground/60 font-semibold border-b border-border/50 font-mono normal-case text-sm truncate">
                  {filePath.split("/").pop()}
                </div>
                <div className="flex flex-col gap-1.5 p-2">
                  {fileAnnotations.map((a) => (
                    <div key={a.id} className="cursor-pointer" onClick={() => scrollToLine(a)}>
                      <AnnotationDisplay
                        annotation={a}
                        onResolve={handleResolve}
                        onDelete={handleDelete}
                        onSendToClaude={handleSendToClaude}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
