import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import { listen } from "@tauri-apps/api/event";
import { useUIStore, useDataStore } from "../store";
import { resolveThemeById, getDiffsTheme, getDiffViewerStyle } from "../themes/apply";
import { PatchDiff } from "@pierre/diffs/react";
import { sqliteProvider } from "../providers/sqlite-provider";
import { viewedFilesProvider, type ViewedFile } from "../providers/viewed-files-provider";
import { InlineAnnotationForm } from "./InlineAnnotationForm";
import { useAnnotationActions } from "../hooks/useAnnotationActions";
import type { DiffLineAnnotation } from "@pierre/diffs";
import type { Annotation, WorktreeDataState } from "../types";

type AnnotationMeta =
  | { type: 'comment'; annotation: Annotation }
  | { type: 'form' };

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

function DeltaButton({ isActive, onClick }: { isActive: boolean; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={onClick}
      className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
        isActive
          ? "border-amber-500/60 text-amber-400 bg-amber-500/10"
          : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
      }`}
    >
      {isActive ? "Full diff" : "Since viewed"}
    </button>
  );
}

function VirtualizedCommitView({
  toolbar, changedFiles, fileDiffs, viewedFiles, collapsedFiles, setCollapsedFiles,
  generatedFiles, diffOptions, diffViewerStyle, annotationsByFile,
  pendingAnnotation, renderAnnotation, makeGutterUtilityClickHandler, toggleViewed,
  toggleDelta, deltaMode, deltaDiffs, viewedFileRecords, commitHashForViewed, selectedWorktree,
}: {
  toolbar: React.ReactNode;
  changedFiles: WorktreeDataState["changedFiles"];
  fileDiffs: Record<string, string>;
  viewedFiles: Set<string>;
  collapsedFiles: Set<string>;
  setCollapsedFiles: React.Dispatch<React.SetStateAction<Set<string>>>;
  generatedFiles: string[];
  diffOptions: Record<string, unknown>;
  diffViewerStyle: React.CSSProperties;
  annotationsByFile: Map<string, DiffLineAnnotation<AnnotationMeta>[]>;
  pendingAnnotation: { filePath?: string; lineNumber: number; side: "deletions" | "additions" } | null;
  renderAnnotation: (annotation: DiffLineAnnotation<AnnotationMeta>) => React.ReactNode;
  makeGutterUtilityClickHandler: (filePath?: string) => (range: { start: number; side?: "deletions" | "additions"; end: number }) => void;
  toggleViewed: (path: string) => void;
  toggleDelta: (path: string) => void;
  deltaMode: Set<string>;
  deltaDiffs: Record<string, string>;
  viewedFileRecords: Record<string, ViewedFile>;
  commitHashForViewed: string | null;
  selectedWorktree: { head_commit?: string } | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: changedFiles.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const file = changedFiles[index];
      const patch = deltaMode.has(file.path) ? deltaDiffs[file.path] : fileDiffs[file.path];
      const isViewed = viewedFiles.has(file.path);
      const isCollapsed = collapsedFiles.has(file.path) || (isViewed && !deltaMode.has(file.path));
      if (!patch || isCollapsed) return 44;
      const lineCount = patch.split("\n").length;
      return Math.max(44, lineCount * 20 + 44);
    },
    overscan: 2,
    scrollMargin: listRef.current?.offsetTop ?? 0,
  });

  const items = virtualizer.getVirtualItems();

  return (
    <div ref={scrollRef} className="flex flex-col h-full overflow-auto">
      {toolbar}
      <div ref={listRef}>
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((virtualRow) => {
            const file = changedFiles[virtualRow.index];
            const isInDeltaMode = deltaMode.has(file.path);
            const patch = isInDeltaMode ? deltaDiffs[file.path] : fileDiffs[file.path];
            const isViewed = viewedFiles.has(file.path);

            const showDeltaButton = isViewed
              && commitHashForViewed === "all-changes"
              && viewedFileRecords[file.path]?.viewed_at_commit
              && viewedFileRecords[file.path]?.viewed_at_commit !== selectedWorktree?.head_commit;

            if (!fileDiffs[file.path]) {
              return (
                <div
                  key={file.path}
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  data-file-path={file.path}
                  className={`absolute left-0 w-full border-b border-border ${isViewed ? "opacity-75" : ""}`}
                  style={{ top: virtualRow.start - (virtualizer.options.scrollMargin ?? 0) }}
                >
                  <div className="flex items-center gap-2 px-3 py-1.5 text-sm font-mono text-muted-foreground">
                    <span className="flex-1 truncate">{file.path}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted">New file</span>
                    <ViewedButton isViewed={isViewed} onClick={() => toggleViewed(file.path)} />
                  </div>
                </div>
              );
            }

            const isLargeFile = (patch ?? "").length > 100_000;
            const isGenerated = generatedFiles.includes(file.path);
            const isCollapsed = collapsedFiles.has(file.path) || (isViewed && !isInDeltaMode) || ((isLargeFile || isGenerated) && !collapsedFiles.has(`expanded:${file.path}`));

            const toggleCollapse = () => {
              setCollapsedFiles((prev) => {
                const next = new Set(prev);
                if (isLargeFile || isGenerated) {
                  const expandKey = `expanded:${file.path}`;
                  if (next.has(expandKey)) next.delete(expandKey);
                  else next.add(expandKey);
                } else if (next.has(file.path)) next.delete(file.path);
                else next.add(file.path);
                return next;
              });
            };

            return (
              <div
                key={file.path}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                data-file-path={file.path}
                className={`absolute left-0 w-full border-b border-border ${isViewed && !isInDeltaMode ? "opacity-75" : ""}`}
                style={{ top: virtualRow.start - (virtualizer.options.scrollMargin ?? 0) }}
              >
                {isInDeltaMode && !patch?.trim() ? (
                  <PatchDiff<AnnotationMeta>
                    style={diffViewerStyle}
                    patch={fileDiffs[file.path]}
                    options={{ ...diffOptions, collapsed: true, onGutterUtilityClick: makeGutterUtilityClickHandler(file.path) }}
                    renderHeaderPrefix={() => (
                      <button onClick={toggleCollapse} className="text-[10px] text-muted-foreground px-1">
                        {isCollapsed ? "▶" : "▼"}
                      </button>
                    )}
                    renderHeaderMetadata={() => (
                      <div className="flex items-center gap-2">
                        {showDeltaButton && (
                          <DeltaButton isActive={isInDeltaMode} onClick={(e) => { e.stopPropagation(); toggleDelta(file.path); }} />
                        )}
                        <ViewedButton isViewed={isViewed} onClick={() => { toggleViewed(file.path); }} />
                      </div>
                    )}
                  />
                ) : (
                  <PatchDiff<AnnotationMeta>
                    style={diffViewerStyle}
                    patch={patch ?? fileDiffs[file.path]}
                    options={{ ...diffOptions, collapsed: isCollapsed, onGutterUtilityClick: makeGutterUtilityClickHandler(file.path) }}
                    lineAnnotations={(() => {
                      const saved = annotationsByFile.get(file.path) ?? [];
                      if (pendingAnnotation?.filePath === file.path) {
                        return [...saved, {
                          side: pendingAnnotation.side,
                          lineNumber: pendingAnnotation.lineNumber,
                          metadata: { type: 'form' as const },
                        }];
                      }
                      return saved.length > 0 ? saved : undefined;
                    })()}
                    renderAnnotation={renderAnnotation}
                    renderHeaderPrefix={() => (
                      <button onClick={toggleCollapse} className="text-[10px] text-muted-foreground px-1">
                        {isCollapsed ? "▶" : "▼"}
                      </button>
                    )}
                    renderHeaderMetadata={() => (
                      <div className="flex items-center gap-2">
                        {isGenerated && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                            Generated
                          </span>
                        )}
                        {showDeltaButton && (
                          <DeltaButton isActive={isInDeltaMode} onClick={(e) => { e.stopPropagation(); toggleDelta(file.path); }} />
                        )}
                        <ViewedButton isViewed={isViewed} onClick={() => { toggleViewed(file.path); }} />
                      </div>
                    )}
                  />
                )}
                {isInDeltaMode && !patch?.trim() && (
                  <div className="px-4 py-3 text-sm text-muted-foreground">No changes since last viewed</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function DiffView() {
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
  const fileDiffHashes = dataState?.fileDiffHashes ?? {};
  const generatedFiles = dataState?.generatedFiles ?? [];
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


  const showResolved = useUIStore((s) => s.showResolved);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [viewedFiles, setViewedFiles] = useState<Set<string>>(new Set());
  const [viewedFileRecords, setViewedFileRecords] = useState<Record<string, ViewedFile>>({});
  const [pendingAnnotation, setPendingAnnotation] = useState<{
    filePath?: string;
    lineNumber: number;
    side: 'deletions' | 'additions';
  } | null>(null);
  const [deltaMode, setDeltaMode] = useState<Set<string>>(new Set());
  const [deltaDiffs, setDeltaDiffs] = useState<Record<string, string>>({});

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
        const records: Record<string, ViewedFile> = {};
        const staleIds: string[] = [];
        for (const row of rows) {
          const currentPatch = fileDiffs[row.file_path];
          const currentHash = fileDiffHashes[row.file_path];
          if (currentPatch && currentHash === row.patch_hash) {
            valid.add(row.file_path);
            records[row.file_path] = row;
          } else if (currentPatch) {
            staleIds.push(row.file_path);
          }
        }
        setViewedFiles(valid);
        setViewedFileRecords(records);
        // Lazily clean up stale entries
        for (const fp of staleIds) {
          viewedFilesProvider.unset(worktreePath, commitHashForViewed, fp);
        }
      })
      .catch(() => setViewedFiles(new Set()));
  }, [worktreePath, commitHashForViewed, fileDiffHashes]);

  // Clear delta state when file diffs change
  useEffect(() => {
    setDeltaMode(new Set());
    setDeltaDiffs({});
  }, [fileDiffHashes]);

  const toggleViewed = useCallback((path: string) => {
    if (!worktreePath || !commitHashForViewed) return;
    const patchHash = fileDiffHashes[path] ?? "new-file";

    const isCurrentlyViewed = viewedFiles.has(path);
    if (isCurrentlyViewed) {
      viewedFilesProvider.unset(worktreePath, commitHashForViewed, path);
      setViewedFiles((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      setDeltaMode((prev) => { const next = new Set(prev); next.delete(path); return next; });
      setDeltaDiffs((prev) => { const { [path]: _, ...rest } = prev; return rest; });
    } else {
      viewedFilesProvider.set(worktreePath, commitHashForViewed, path, patchHash, selectedWorktree?.head_commit);
      setViewedFiles((prev) => new Set(prev).add(path));
    }
  }, [worktreePath, commitHashForViewed, fileDiffHashes, viewedFiles, selectedWorktree?.head_commit]);

  const toggleDelta = useCallback(async (path: string) => {
    if (deltaMode.has(path)) {
      setDeltaMode((prev) => { const next = new Set(prev); next.delete(path); return next; });
      return;
    }
    const record = viewedFileRecords[path];
    if (!record?.viewed_at_commit || !worktreePath) return;
    try {
      const diff = await invoke<string>("get_file_diff_since_commit", {
        worktreePath,
        sinceCommit: record.viewed_at_commit,
        filePath: path,
      });
      setDeltaDiffs((prev) => ({ ...prev, [path]: diff }));
      setDeltaMode((prev) => new Set(prev).add(path));
    } catch {
      toast.error("Could not load changes since last viewed — the commit may no longer exist");
    }
  }, [deltaMode, viewedFileRecords, worktreePath]);

  // Load all annotations for this worktree
  useEffect(() => {
    setPendingAnnotation(null);
    if (!worktreePath) {
      updateData({ annotations: [] });
      return;
    }

    sqliteProvider
      .list(worktreePath)
      .then((anns) => updateData({ annotations: anns }))
      .catch(() => {
        toast.error("Failed to load annotations");
        updateData({ annotations: [] });
      });
  }, [worktreePath, updateData]);

  // Re-fetch annotations when the DB is modified externally (e.g. MCP server)
  useEffect(() => {
    const unlisten = listen("annotations-changed", () => {
      if (!worktreePath) return;
      sqliteProvider
        .list(worktreePath)
        .then((anns) => updateData({ annotations: anns }))
        .catch(() => {});
    });

    return () => { unlisten.then((fn) => fn()); };
  }, [worktreePath, updateData]);

  // Filter annotations to those matching the current commit context
  const contextCommitHash =
    viewMode === "commit" && selectedCommit
      ? selectedCommit.hash
      : "all-changes";
  const contextAnnotations = useMemo(
    () => annotations.filter((a) => a.commit_hash === contextCommitHash),
    [annotations, contextCommitHash]
  );

  const lineAnnotations = useMemo((): DiffLineAnnotation<AnnotationMeta>[] => {
    const items: DiffLineAnnotation<AnnotationMeta>[] = contextAnnotations.map((a) => ({
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
  }, [contextAnnotations, pendingAnnotation]);

  const annotationsByFile = useMemo(() => {
    const map = new Map<string, DiffLineAnnotation<AnnotationMeta>[]>();
    for (const a of contextAnnotations) {
      const items = map.get(a.file_path) ?? [];
      items.push({
        side: a.side === "left" ? ("deletions" as const) : ("additions" as const),
        lineNumber: a.line_number,
        metadata: { type: 'comment' as const, annotation: a },
      });
      map.set(a.file_path, items);
    }
    return map;
  }, [contextAnnotations]);

  const pendingAnnotationRef = useRef(pendingAnnotation);
  pendingAnnotationRef.current = pendingAnnotation;

  const makeGutterUtilityClickHandler = useCallback(
    (filePath?: string) => (range: { start: number; side?: 'deletions' | 'additions'; end: number }) => {
      const lineNumber = range.start;
      const side = range.side ?? 'additions';
      const pa = pendingAnnotationRef.current;
      if (pa && pa.lineNumber === lineNumber && pa.side === side && pa.filePath === filePath) {
        setPendingAnnotation(null);
      } else {
        setPendingAnnotation({ filePath, lineNumber, side });
      }
    },
    []
  );

  const { handleCreate } = useAnnotationActions();

  const renderAnnotation = useCallback(
    (diffAnnotation: DiffLineAnnotation<AnnotationMeta>) => {
      const meta = diffAnnotation.metadata;
      if (!meta) return null;

      if (meta.type === 'form') {
        return (
          <InlineAnnotationForm
            onSubmit={(body) => {
              const side = diffAnnotation.side === "deletions" ? "left" as const : "right" as const;
              handleCreate(body, diffAnnotation.lineNumber, side, pendingAnnotation?.filePath);
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
    [showResolved, handleCreate, pendingAnnotation?.filePath]
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
  const differTheme = getDiffsTheme(activeTheme);
  const diffViewerStyle = getDiffViewerStyle(activeTheme);

  const diffOptions = {
    theme: differTheme,
    themeType: activeTheme.type as "dark" | "light",
    overflow: (wrap ? "wrap" : "scroll") as "wrap" | "scroll",
    diffStyle,
    enableGutterUtility: true,
    unsafeCSS: `:host { --diffs-dark-bg: ${activeTheme.terminal.background}; --diffs-light-bg: ${activeTheme.terminal.background}; --diffs-dark: ${activeTheme.terminal.foreground}; --diffs-light: ${activeTheme.terminal.foreground}; } [data-diffs-header] { position: sticky; top: 0; z-index: 10; }`,
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
        {showAllFiles && changedFiles.length > 0 && (
          <>
            <span className="mx-1 text-border">|</span>
            <span className="text-muted-foreground tabular-nums">
              {viewedFiles.size} / {changedFiles.length} viewed
            </span>
            <div className="w-16 h-1.5 rounded-full bg-border overflow-hidden">
              <div
                className="h-full rounded-full bg-green-500 transition-all duration-300"
                style={{ width: `${changedFiles.length > 0 ? (viewedFiles.size / changedFiles.length) * 100 : 0}%` }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );

  // Full commit view: all files stacked with virtualization
  if (showAllFiles) {
    return <VirtualizedCommitView
      toolbar={toolbar}
      changedFiles={changedFiles}
      fileDiffs={fileDiffs}
      viewedFiles={viewedFiles}
      collapsedFiles={collapsedFiles}
      setCollapsedFiles={setCollapsedFiles}
      generatedFiles={generatedFiles}
      diffOptions={diffOptions}
      diffViewerStyle={diffViewerStyle}
      annotationsByFile={annotationsByFile}
      pendingAnnotation={pendingAnnotation}
      renderAnnotation={renderAnnotation}
      makeGutterUtilityClickHandler={makeGutterUtilityClickHandler}
      toggleViewed={toggleViewed}
      toggleDelta={toggleDelta}
      deltaMode={deltaMode}
      deltaDiffs={deltaDiffs}
      viewedFileRecords={viewedFileRecords}
      commitHashForViewed={commitHashForViewed}
      selectedWorktree={selectedWorktree}
    />;
  }

  // Single file view with annotations
  return (
    <div className="flex flex-col h-full overflow-hidden">
      {toolbar}
      <div className="flex-1 overflow-auto" style={diffViewerStyle}>
        <PatchDiff<AnnotationMeta>
          style={diffViewerStyle}
          patch={diffText!}
          lineAnnotations={lineAnnotations}
          renderAnnotation={renderAnnotation}
          options={{ ...diffOptions, onGutterUtilityClick: makeGutterUtilityClickHandler() }}
        />
      </div>
    </div>
  );
}
