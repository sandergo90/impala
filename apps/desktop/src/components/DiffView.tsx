import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { invoke } from "@/lib/invoke";
import { toast } from "sonner";
import { useUIStore, useDataStore } from "../store";
import { resolveThemeById, getDiffsTheme, getDiffViewerStyle } from "../themes/apply";
import { PatchDiff, CodeView } from "@pierre/diffs/react";
import type { CodeViewHandle, CodeViewItem } from "@pierre/diffs/react";
import { processFile } from "@pierre/diffs";
import { sqliteProvider } from "../providers/sqlite-provider";
import { viewedFilesProvider } from "../providers/viewed-files-provider";
import { InlineAnnotationForm } from "./InlineAnnotationForm";
import { useAnnotationActions } from "../hooks/useAnnotationActions";
import { openFileInEditor } from "../lib/open-file-in-editor";
import { openFileTab } from "../lib/tab-actions";
import { ChangedFileContextMenu } from "./ChangedFileContextMenu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { DiffLineAnnotation, FileDiffMetadata } from "@pierre/diffs";
import type { Annotation, WorktreeDataState } from "../types";

// Stable empty references to avoid new object identity on every render
const emptyArray: never[] = [];
const emptyRecord: Record<string, string> = {};

type AnnotationMeta =
  | { type: 'comment'; annotation: Annotation }
  | { type: 'form' };

function DiscardButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="text-muted-foreground/60 hover:text-red-500 transition-colors shrink-0"
      title="Discard changes"
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 8a5 5 0 0 1 5-5h1a5 5 0 0 1 5 5v0a5 5 0 0 1-5 5H5" />
        <polyline points="5.5 5.5 3 8 5.5 10.5" />
      </svg>
    </button>
  );
}

function OpenFileButton({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
      className="text-muted-foreground/60 hover:text-foreground transition-colors shrink-0"
      title="Click to open in Impala. Cmd+click to open in your IDE."
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 2h4v4" />
        <path d="M14 2L8 8" />
        <path d="M13 9v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4" />
      </svg>
    </button>
  );
}

function ChangeTypeIcon({ type }: { type: string }) {
  if (type === "new") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" className="shrink-0">
        <line x1="8" y1="4" x2="8" y2="12" stroke="var(--diffs-addition-base, #3fb950)" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="4" y1="8" x2="12" y2="8" stroke="var(--diffs-addition-base, #3fb950)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (type === "deleted") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" className="shrink-0">
        <line x1="4" y1="8" x2="12" y2="8" stroke="var(--diffs-deletion-base, #f85149)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  // modified, rename, etc.
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" className="shrink-0">
      <circle cx="8" cy="8" r="4" fill="none" stroke="var(--diffs-modified-base, #d29922)" strokeWidth="1.5" />
    </svg>
  );
}

function ChangeBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  if (total === 0) return null;
  const maxWidth = 54;
  const delWidth = Math.max(deletions > 0 ? 3 : 0, Math.round((deletions / total) * maxWidth));
  const addWidth = Math.max(additions > 0 ? 3 : 0, maxWidth - delWidth);
  return (
    <div className="flex items-center shrink-0" style={{ gap: deletions > 0 && additions > 0 ? 2 : 0 }}>
      {deletions > 0 && (
        <div style={{ height: 4, width: delWidth, borderRadius: additions > 0 ? "2px 0 0 2px" : 2, background: "var(--diffs-deletion-base, #f85149)" }} />
      )}
      {additions > 0 && (
        <div style={{ height: 4, width: addWidth, borderRadius: deletions > 0 ? "0 2px 2px 0" : 2, background: "var(--diffs-addition-base, #3fb950)" }} />
      )}
    </div>
  );
}

function ViewedButton({ isViewed, onClick }: { isViewed: boolean; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 text-md px-2 py-0.5 rounded border transition-colors ${
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
  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const diffStyle = useUIStore((s) => s.diffStyle);
  const wrap = useUIStore((s) => s.wrap);
  const activeThemeId = useUIStore((s) => s.activeThemeId);
  const customThemes = useUIStore((s) => s.customThemes);

  const wtPath = useUIStore((s) => s.selectedWorktree?.path);

  // Subscribe to each field individually so unrelated nav/data updates
  // (e.g. agentStatus toggling while the agent works) don't re-render the
  // whole diff tree. Selecting the parent object would create a new
  // reference on every updateWorktreeDataState call and flicker the diff.
  const selectedFile = useUIStore((s) =>
    wtPath ? s.worktreeNavStates[wtPath]?.selectedFile ?? null : null
  );
  const selectedCommit = useUIStore((s) =>
    wtPath ? s.worktreeNavStates[wtPath]?.selectedCommit ?? null : null
  );
  const viewMode = useUIStore((s) =>
    wtPath ? s.worktreeNavStates[wtPath]?.viewMode ?? "commit" : "commit"
  );
  const diffText = useDataStore((s) =>
    wtPath ? s.worktreeDataStates[wtPath]?.diffText ?? null : null
  );
  const changedFiles = useDataStore((s) =>
    wtPath ? s.worktreeDataStates[wtPath]?.changedFiles ?? emptyArray : emptyArray
  );
  const fileDiffs = useDataStore((s) =>
    wtPath ? s.worktreeDataStates[wtPath]?.fileDiffs ?? emptyRecord : emptyRecord
  );
  const generatedFilesRaw = useDataStore((s) =>
    wtPath ? s.worktreeDataStates[wtPath]?.generatedFiles ?? emptyArray : emptyArray
  );
  const generatedFiles = useMemo(() => new Set(generatedFilesRaw), [generatedFilesRaw]);
  const annotations = useDataStore((s) =>
    wtPath ? s.worktreeDataStates[wtPath]?.annotations ?? emptyArray : emptyArray
  );

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
  const hideViewed = useUIStore((s) => s.hideViewed);
  const setHideViewed = useUIStore((s) => s.setHideViewed);
  const [pendingAnnotation, setPendingAnnotation] = useState<{
    filePath?: string;
    lineNumber: number;
    side: 'deletions' | 'additions';
  } | null>(null);
  const [fileToDiscard, setFileToDiscard] = useState<string | null>(null);

  const requestDiscard = useCallback((filePath: string) => {
    setFileToDiscard(filePath);
  }, []);

  const confirmDiscard = useCallback(async () => {
    const filePath = fileToDiscard;
    if (!filePath || !worktreePath) return;
    setFileToDiscard(null);
    try {
      await invoke("discard_file_changes", { worktreePath, filePath });
      toast.success(`Discarded changes in ${filePath}`);
    } catch (e) {
      toast.error(`Failed to discard ${filePath}: ${e}`);
    }
  }, [fileToDiscard, worktreePath]);
  const viewKindForViewed: "uncommitted" | "all-changes" | "commit" | "last-turn" | null =
    viewMode === "commit" && selectedCommit ? "commit"
    : viewMode === "all-changes" ? "all-changes"
    : viewMode === "uncommitted" ? "uncommitted"
    : viewMode === "last-turn" ? "last-turn"
    : null;
  const commitHashForViewed =
    viewKindForViewed === "commit" && selectedCommit ? selectedCommit.hash : null;

  // Viewed state is keyed by content sha: the backend computes the right-side
  // blob sha for each changed file and checks it against the DB. Re-check on
  // every data refresh so the UI stays in sync without the frontend needing
  // to know about blob shas.
  useEffect(() => {
    if (!worktreePath || !viewKindForViewed || changedFiles.length === 0) {
      setViewedFiles(new Set());
      return;
    }
    const paths = changedFiles.map((f) => f.path);
    let cancelled = false;
    viewedFilesProvider
      .check(worktreePath, viewKindForViewed, commitHashForViewed, paths)
      .then((viewed) => {
        if (!cancelled) setViewedFiles(new Set(viewed));
      })
      .catch(() => {
        if (!cancelled) setViewedFiles(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [worktreePath, viewKindForViewed, commitHashForViewed, changedFiles]);

  const toggleViewed = useCallback((path: string) => {
    if (!worktreePath || !viewKindForViewed) return;

    setViewedFiles((prev) => {
      const isCurrentlyViewed = prev.has(path);
      if (isCurrentlyViewed) {
        viewedFilesProvider.unset(worktreePath, path);
        const next = new Set(prev);
        next.delete(path);
        return next;
      } else {
        viewedFilesProvider.set(worktreePath, viewKindForViewed, commitHashForViewed, path);
        return new Set(prev).add(path);
      }
    });
  }, [worktreePath, viewKindForViewed, commitHashForViewed]);

  const toggleAllViewed = useCallback(() => {
    if (!worktreePath || !viewKindForViewed || changedFiles.length === 0) return;
    const paths = changedFiles.map((f) => f.path);
    const allViewed = paths.every((p) => viewedFiles.has(p));
    if (allViewed) {
      setViewedFiles(new Set());
      viewedFilesProvider.unsetMany(worktreePath, paths).catch(() => {
        toast.error("Failed to unmark files");
      });
    } else {
      setViewedFiles(new Set(paths));
      viewedFilesProvider
        .setMany(worktreePath, viewKindForViewed, commitHashForViewed, paths)
        .catch(() => {
          toast.error("Failed to mark all files as viewed");
        });
    }
  }, [worktreePath, viewKindForViewed, commitHashForViewed, changedFiles, viewedFiles]);

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
    if (pendingAnnotation?.filePath) {
      const items = map.get(pendingAnnotation.filePath) ?? [];
      items.push({
        side: pendingAnnotation.side,
        lineNumber: pendingAnnotation.lineNumber,
        metadata: { type: 'form' as const },
      });
      map.set(pendingAnnotation.filePath, items);
    }
    return map;
  }, [contextAnnotations, pendingAnnotation]);

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
        <div className="px-3 py-1.5 border-t border-border bg-card/60 text-md">
          <span className="font-mono text-muted-foreground mr-2">
            {a.side === "left" ? "L" : "R"}:{a.line_number}
          </span>
          <span className="text-foreground">{a.body}</span>
          {a.resolved && (
            <span className="ml-2 text-green-400 text-md">(resolved)</span>
          )}
        </div>
      );
    },
    [showResolved, handleCreate, pendingAnnotation?.filePath]
  );

  const globalFontSize = useUIStore((s) => s.fontSize);
  const editorFontSize = useUIStore((s) => s.editorFontSize);
  const editorFontFamily = useUIStore((s) => s.editorFontFamily);

  const hasFileDiffs = Object.keys(fileDiffs).length > 0;
  const visibleChangedFiles = useMemo(
    () => (hideViewed ? changedFiles.filter((f) => !viewedFiles.has(f.path)) : changedFiles),
    [hideViewed, changedFiles, viewedFiles]
  );
  const showAllFiles = !selectedFile && hasFileDiffs;
  const showSingleFile = selectedFile && diffText;

  // Files split: diffable (have a patch — render in CodeView with fetched
  // contents) vs no-diff (renamed/copied/binary — render as a small banner
  // section above CodeView so the user still sees them).
  const diffableFiles = useMemo(
    () => visibleChangedFiles.filter((f) => fileDiffs[f.path]),
    [visibleChangedFiles, fileDiffs]
  );
  const noDiffFiles = useMemo(
    () => visibleChangedFiles.filter((f) => !fileDiffs[f.path]),
    [visibleChangedFiles, fileDiffs]
  );
  const fileByPath = useMemo(() => {
    const map = new Map<string, WorktreeDataState["changedFiles"][0]>();
    for (const f of diffableFiles) map.set(f.path, f);
    return map;
  }, [diffableFiles]);

  // Parse the patch impala's backend already produced — no per-file I/O,
  // no diff recomputation. Tradeoff: hunk expansion is unavailable
  // (isPartial: true), matching the pre-refactor behavior for files over 50KB.
  const parsedDiffs = useMemo(() => {
    const map = new Map<string, FileDiffMetadata>();
    for (const file of diffableFiles) {
      const patch = fileDiffs[file.path];
      if (!patch) continue;
      try {
        const fileDiff = processFile(patch, {
          isGitDiff: true,
          cacheKey: `${file.path}:${patch.length}`,
        });
        if (fileDiff) map.set(file.path, fileDiff);
      } catch {
        // skip
      }
    }
    return map;
  }, [diffableFiles, fileDiffs]);

  const items = useMemo((): CodeViewItem<AnnotationMeta>[] => {
    const result: CodeViewItem<AnnotationMeta>[] = [];
    for (const file of diffableFiles) {
      const fileDiff = parsedDiffs.get(file.path);
      if (!fileDiff) continue;
      const isViewed = viewedFiles.has(file.path);
      const isGenerated = generatedFiles.has(file.path);
      // Auto-collapse huge diffs (>~1000 lines either side) the same way the
      // pre-refactor 100KB heuristic did, but using parsed line counts which
      // are more accurate than patch byte size.
      const lineCount = Math.max(fileDiff.splitLineCount, fileDiff.unifiedLineCount);
      const isLargeFile = lineCount > 1000;
      const isExpandedOverride = collapsedFiles.has(`expanded:${file.path}`);
      const isCollapsed =
        collapsedFiles.has(file.path) ||
        ((isViewed || isGenerated || isLargeFile) && !isExpandedOverride);
      const annotations = annotationsByFile.get(file.path);
      // Bump version when anything Pierre needs to re-render changes
      // (annotations, pending form, collapsed) — without this CodeView may
      // keep the stale rendered item even though we passed a new array.
      const version =
        (annotations?.length ?? 0) * 4 +
        (isCollapsed ? 2 : 0) +
        (annotations?.some((a) => a.metadata?.type === 'form') ? 1 : 0);
      result.push({
        id: file.path,
        type: 'diff',
        fileDiff,
        annotations,
        collapsed: isCollapsed,
        version,
      });
    }
    return result;
  }, [diffableFiles, parsedDiffs, viewedFiles, generatedFiles, collapsedFiles, annotationsByFile]);

  const codeViewRef = useRef<CodeViewHandle<AnnotationMeta>>(null);

  const scrollToFile = useCallback((filePath: string) => {
    codeViewRef.current?.scrollTo({ type: 'item', id: filePath, align: 'start', behavior: 'smooth' });
  }, []);

  const isAutoCollapsed = useCallback((filePath: string) => {
    if (viewedFiles.has(filePath) || generatedFiles.has(filePath)) return true;
    const fd = parsedDiffs.get(filePath);
    if (!fd) return false;
    return Math.max(fd.splitLineCount, fd.unifiedLineCount) > 1000;
  }, [viewedFiles, generatedFiles, parsedDiffs]);

  const toggleCollapse = useCallback((filePath: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (isAutoCollapsed(filePath)) {
        const expandKey = `expanded:${filePath}`;
        if (next.has(expandKey)) next.delete(expandKey);
        else next.add(expandKey);
      } else if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  }, [isAutoCollapsed]);

  if (!showAllFiles && !showSingleFile) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Select a commit or file to view its diff
      </div>
    );
  }

  const activeTheme = resolveThemeById(activeThemeId, customThemes);
  const impalaTheme = getDiffsTheme(activeTheme);
  const fontSize = editorFontSize ?? globalFontSize;
  const diffViewerStyle = getDiffViewerStyle(activeTheme, fontSize, editorFontFamily);

  const baseDiffOptions = {
    theme: impalaTheme,
    themeType: activeTheme.type as "dark" | "light",
    overflow: (wrap ? "wrap" : "scroll") as "wrap" | "scroll",
    diffStyle,
    enableGutterUtility: true,
    expandUnchanged: false,
    expansionLineCount: 10,
    hunkSeparators: "line-info" as const,
    // Bound per-file tokenization work so a single huge minified file in a
    // branch can't stall the worker pool. Files exceeding these caps fall
    // back to plain text rendering.
    tokenizeMaxLength: 200_000,
    tokenizeMaxLineLength: 5_000,
    maxLineDiffLength: 5_000,
    unsafeCSS: `:host { --diffs-dark-bg: ${activeTheme.terminal.background}; --diffs-light-bg: ${activeTheme.terminal.background}; --diffs-dark: ${activeTheme.terminal.foreground}; --diffs-light: ${activeTheme.terminal.foreground}; --diffs-color: ${activeTheme.terminal.foreground}; } [data-diffs-header] { position: sticky; top: 0; z-index: 10; } [data-diffs-header='custom'] { background-color: var(--diffs-bg); display: flex; align-items: center; min-height: calc(1lh + (var(--diffs-gap-block, var(--diffs-gap-fallback)) * 3)); padding-inline: 16px; font-family: var(--diffs-header-font-family, var(--diffs-header-font-fallback)); } [data-diffs-header='custom'] ::slotted(*) { width: 100%; } [data-code]::-webkit-scrollbar { height: 10px !important; } [data-code]::-webkit-scrollbar-thumb { background-color: var(--diffs-bg-context) !important; border-radius: 5px !important; border: 2px solid transparent !important; background-clip: padding-box !important; } [data-code]::-webkit-scrollbar-thumb:hover { background-color: var(--diffs-fg-number) !important; background-clip: padding-box !important; } [data-code]::-webkit-scrollbar-track { background: transparent !important; }`,
  };

  const codeViewOptions = {
    ...baseDiffOptions,
    onGutterUtilityClick: (
      range: { start: number; side?: 'deletions' | 'additions'; end: number },
      context: { item: { id: string } },
    ) => {
      makeGutterUtilityClickHandler(context.item.id)(range);
    },
  };

  const toolbar = (
    <div className="flex items-center gap-3 px-3 py-2 border-b shrink-0">
      <div className="flex items-center gap-1 text-md">
        <button
          onClick={() => useUIStore.getState().setDiffStyle("split")}
          className={`px-2 py-0.5 rounded ${
            diffStyle === "split"
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Split
        </button>
        <button
          onClick={() => useUIStore.getState().setDiffStyle("unified")}
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
          onClick={() => useUIStore.getState().setWrap(!wrap)}
          className={`px-2 py-0.5 rounded ${
            wrap
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Wrap
        </button>
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-1 text-md">
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
            <button
              onClick={toggleAllViewed}
              className="px-2 py-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
            >
              {viewedFiles.size === changedFiles.length ? "Unmark all" : "Mark all viewed"}
            </button>
            <button
              onClick={() => setHideViewed(!hideViewed)}
              className={`px-2 py-0.5 rounded ${
                hideViewed
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              }`}
            >
              Hide viewed
            </button>
          </>
        )}
      </div>
    </div>
  );

  const discardDialog = (
    <AlertDialog
      open={!!fileToDiscard}
      onOpenChange={(open) => { if (!open) setFileToDiscard(null); }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard changes</AlertDialogTitle>
          <AlertDialogDescription>
            This will discard all uncommitted changes in{" "}
            <span className="font-mono text-foreground">{fileToDiscard}</span>.
            This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={confirmDiscard}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Discard
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  const renderCustomHeader = (item: CodeViewItem<AnnotationMeta>) => {
    if (item.type !== 'diff') return null;
    const filePath = item.id;
    const file = fileByPath.get(filePath);
    if (!file) return null;

    const fileDiff = item.fileDiff;
    let additions = 0, deletions = 0;
    for (const hunk of fileDiff.hunks) {
      additions += hunk.additionLines;
      deletions += hunk.deletionLines;
    }

    const isViewed = viewedFiles.has(filePath);
    const isGenerated = generatedFiles.has(filePath);
    const isExpandedOverride = collapsedFiles.has(`expanded:${filePath}`);
    const isCollapsed =
      collapsedFiles.has(filePath) ||
      (isAutoCollapsed(filePath) && !isExpandedOverride);

    const lastSlash = fileDiff.name.lastIndexOf("/");
    const dir = lastSlash >= 0 ? fileDiff.name.slice(0, lastSlash + 1) : "";
    const basename = lastSlash >= 0 ? fileDiff.name.slice(lastSlash + 1) : fileDiff.name;
    const nameColor = fileDiff.type === "new" ? "var(--diffs-addition-base, #3fb950)"
      : fileDiff.type === "deleted" ? "var(--diffs-deletion-base, #f85149)"
      : "var(--diffs-color, #e6edf3)";

    const headerInner = (
      <div
        className="flex items-center w-full cursor-pointer"
        style={{ gap: 10 }}
        onClick={() => toggleCollapse(filePath)}
      >
        <span className="text-md text-muted-foreground shrink-0">
          {isCollapsed ? "▶" : "▼"}
        </span>
        <ChangeTypeIcon type={fileDiff.type} />
        <span className="truncate min-w-0 text-start text-[13px]" style={{ direction: "rtl" }}>
          <bdi>
            <span className="text-muted-foreground">{dir}</span>
            <span style={{ color: nameColor, fontWeight: 500 }}>{basename}</span>
          </bdi>
        </span>
        <OpenFileButton
          onClick={(e) => {
            if (!worktreePath) return;
            if (e.metaKey || e.ctrlKey) {
              openFileInEditor(`${worktreePath}/${filePath}`);
            } else {
              openFileTab(worktreePath, filePath);
            }
          }}
        />
        {viewMode === 'uncommitted' && (
          <DiscardButton onClick={() => requestDiscard(filePath)} />
        )}
        <div className="flex-1" />
        {isGenerated && (
          <span className="text-md px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
            Generated
          </span>
        )}
        <ChangeBar additions={additions} deletions={deletions} />
        <span className="text-muted-foreground text-[11px] font-mono shrink-0">
          {deletions > 0 && <span style={{ color: "var(--diffs-deletion-base, #f85149)" }}>-{deletions}</span>}
          {deletions > 0 && additions > 0 && " "}
          {additions > 0 && <span style={{ color: "var(--diffs-addition-base, #3fb950)" }}>+{additions}</span>}
        </span>
        <ViewedButton
          isViewed={isViewed}
          onClick={(e) => {
            e.stopPropagation();
            toggleViewed(filePath);
            if (!isViewed) scrollToFile(filePath);
          }}
        />
      </div>
    );

    if (!worktreePath) return headerInner;
    return (
      <ChangedFileContextMenu worktreePath={worktreePath} filePath={filePath}>
        {headerInner}
      </ChangedFileContextMenu>
    );
  };

  const noDiffRows = noDiffFiles.length > 0 && (
    <div className="border-b border-border shrink-0">
      {noDiffFiles.map((file) => {
        const isRenamed = file.status.startsWith("R") || file.status.startsWith("C");
        const [oldPath, newPath] = isRenamed ? file.path.split("\t") : [null, file.path];
        const revealPath = isRenamed ? (newPath ?? file.path) : file.path;
        const isViewed = viewedFiles.has(file.path);
        const rowInner = (
          <div className={`flex items-center gap-2 px-3 py-1.5 text-sm font-mono text-muted-foreground border-b border-border last:border-b-0 ${isViewed ? "opacity-75" : ""}`}>
            {isRenamed ? (
              <span className="flex-1 truncate">{oldPath} <span className="text-muted-foreground/90">→</span> {newPath}</span>
            ) : (
              <span className="flex-1 truncate">{file.path}</span>
            )}
            <OpenFileButton
              onClick={(e) => {
                if (!worktreePath) return;
                if (e.metaKey || e.ctrlKey) {
                  openFileInEditor(`${worktreePath}/${revealPath}`);
                } else {
                  openFileTab(worktreePath, revealPath);
                }
              }}
            />
            {viewMode === 'uncommitted' && (
              <DiscardButton onClick={() => requestDiscard(revealPath)} />
            )}
            <span className="text-md px-1.5 py-0.5 rounded bg-muted">
              {isRenamed ? (file.status.startsWith("C") ? "Copied" : "Moved") : "New file"}
            </span>
            <ViewedButton isViewed={isViewed} onClick={() => toggleViewed(file.path)} />
          </div>
        );
        return (
          <div key={file.path}>
            {worktreePath ? (
              <ChangedFileContextMenu worktreePath={worktreePath} filePath={revealPath}>
                {rowInner}
              </ChangedFileContextMenu>
            ) : (
              rowInner
            )}
          </div>
        );
      })}
    </div>
  );

  // Full commit view: CodeView holds all diffable files; no-diff files
  // (renames/binaries) get a small banner above.
  if (showAllFiles) {
    if (visibleChangedFiles.length === 0) {
      return (
        <div className="flex flex-col h-full overflow-hidden">
          {toolbar}
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="flex flex-col items-center gap-3 text-center max-w-sm">
              <div className="w-14 h-14 rounded-full bg-green-500/10 flex items-center justify-center">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-green-500">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </div>
              <div className="space-y-0.5">
                <div className="text-sm font-medium text-foreground">All caught up</div>
                <div className="text-md text-muted-foreground">
                  {changedFiles.length} {changedFiles.length === 1 ? "file" : "files"} marked as viewed
                </div>
              </div>
              <button
                onClick={() => setHideViewed(false)}
                className="mt-1 px-3 py-1 text-md rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent"
              >
                Show viewed files
              </button>
            </div>
          </div>
          {discardDialog}
        </div>
      );
    }
    return (
      <div className="flex flex-col h-full overflow-hidden">
        {toolbar}
        {noDiffRows}
        <CodeView<AnnotationMeta>
          ref={codeViewRef}
          className="flex-1 min-h-0 w-full overflow-y-auto overflow-x-clip overscroll-contain [overflow-anchor:none] show-scrollbar"
          items={items}
          style={diffViewerStyle}
          options={codeViewOptions}
          renderCustomHeader={renderCustomHeader}
          renderAnnotation={renderAnnotation}
        />
        {discardDialog}
      </div>
    );
  }

  // Single file view with annotations — keep PatchDiff on the raw patch
  // string; the CodeView migration is scoped to the multi-file view.
  return (
    <div className="flex flex-col h-full overflow-hidden">
      {toolbar}
      <div className="flex-1 overflow-auto show-scrollbar pr-2" style={diffViewerStyle}>
        <PatchDiff<AnnotationMeta>
          style={diffViewerStyle}
          patch={diffText!}
          lineAnnotations={lineAnnotations}
          renderAnnotation={renderAnnotation}
          options={{ ...baseDiffOptions, onGutterUtilityClick: makeGutterUtilityClickHandler() }}
        />
      </div>
      {discardDialog}
    </div>
  );
}
