import { useMemo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useUIStore, useDataStore } from "../store";
import { useAnnotationActions } from "../hooks/useAnnotationActions";
import { useBrowserAnnotations } from "../hooks/useBrowserAnnotations";
import { AnnotationDisplay } from "./AnnotationDisplay";
import { openBrowserTabAt } from "../lib/tab-actions";
import type { Annotation } from "../types";

export function AnnotationsPanel() {
  const showResolved = useUIStore((s) => s.showResolved);
  const setShowResolved = useUIStore((s) => s.setShowResolved);

  const {
    annotations,
    selectedFile,
    handleResolve,
    handleDelete,
    handleSendAllToAgent,
  } = useAnnotationActions();
  const { browserAnnotations, resolveBrowserAnnotation, deleteBrowserAnnotation } =
    useBrowserAnnotations();

  const visibleBrowser = useMemo(
    () => browserAnnotations.filter((a) => showResolved || !a.resolved),
    [browserAnnotations, showResolved],
  );

  // Filter, scope, sort, and group in a single pass
  const { scoped, grouped } = useMemo(() => {
    const scopedItems: Annotation[] = [];
    const groupedMap = new Map<string, Annotation[]>();
    for (const a of annotations) {
      if (!showResolved && a.resolved) continue;
      if (selectedFile && a.file_path !== selectedFile.path) continue;
      scopedItems.push(a);
    }
    scopedItems.sort((a, b) => a.line_number - b.line_number);
    for (const a of scopedItems) {
      const items = groupedMap.get(a.file_path) ?? [];
      items.push(a);
      groupedMap.set(a.file_path, items);
    }
    return { scoped: scopedItems, grouped: groupedMap };
  }, [annotations, showResolved, selectedFile]);

  const hasAnnotations = annotations.length > 0 || browserAnnotations.length > 0;
  const hasUnresolved =
    annotations.some((a) => !a.resolved) ||
    browserAnnotations.some((a) => !a.resolved);

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
            onClick={handleSendAllToAgent}
            className="px-2 py-0.5 rounded text-sm text-blue-400 hover:text-blue-300 hover:bg-blue-500/20 ml-auto"
          >
            Send to Agent
          </button>
        )}
      </div>

      {/* Annotations list */}
      <div className="overflow-y-auto flex-1 min-h-0">
        {scoped.length === 0 && visibleBrowser.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground/90 text-center">
            {showResolved ? "No annotations" : "No unresolved annotations"}
          </div>
        ) : scoped.length === 0 ? null : selectedFile ? (
          // Single file: flat list
          <div className="flex flex-col">
            {scoped.map((a) => (
              <div key={a.id} className="cursor-pointer" onClick={() => scrollToLine(a)}>
                <AnnotationDisplay
                  annotation={a}
                  onResolve={handleResolve}
                  onDelete={handleDelete}
                />
              </div>
            ))}
          </div>
        ) : (
          // All files: grouped
          <div className="flex flex-col">
            {[...grouped.entries()].map(([filePath, fileAnnotations]) => (
              <div key={filePath}>
                <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5">
                  <span className="truncate font-mono text-sm font-semibold tracking-[1.2px] text-muted-foreground/60">
                    {filePath.split("/").pop()}
                  </span>
                  <span className="shrink-0 rounded-full bg-muted px-1.5 text-xs text-muted-foreground/70">
                    {fileAnnotations.length}
                  </span>
                </div>
                <div className="flex flex-col">
                  {fileAnnotations.map((a) => (
                    <div key={a.id} className="cursor-pointer" onClick={() => scrollToLine(a)}>
                      <AnnotationDisplay
                        annotation={a}
                        onResolve={handleResolve}
                        onDelete={handleDelete}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        {visibleBrowser.length > 0 && (
          <div>
            <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5">
              <span className="truncate font-mono text-sm font-semibold tracking-[1.2px] text-muted-foreground/60">
                Browser
              </span>
              <span className="shrink-0 rounded-full bg-muted px-1.5 text-xs text-muted-foreground/70">
                {visibleBrowser.length}
              </span>
            </div>
            <div className="flex flex-col">
              {visibleBrowser.map((a) => (
                <div
                  key={a.id}
                  className="flex gap-2 px-3 py-2 border-b border-border/30 cursor-pointer hover:bg-accent/30"
                  onClick={() => openBrowserTabAt(a.repo_path, a.url)}
                  title={a.url}
                >
                  {a.screenshot_path && (
                    <img
                      src={convertFileSrc(a.screenshot_path)}
                      alt=""
                      className="h-10 w-14 shrink-0 rounded border border-border/50 object-cover"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div
                      className="truncate font-mono text-xs text-muted-foreground/70"
                      title={a.selector}
                    >
                      {a.selector}
                    </div>
                    <div
                      className={`text-sm ${
                        a.resolved
                          ? "line-through text-muted-foreground/60"
                          : ""
                      }`}
                    >
                      {a.body}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-0.5 self-start">
                    {!a.resolved && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          resolveBrowserAnnotation(a.id).catch(() => {});
                        }}
                        className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                        title="Resolve"
                      >
                        ✓
                      </button>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteBrowserAnnotation(a.id).catch(() => {});
                      }}
                      className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                      title="Delete (removes screenshot)"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
