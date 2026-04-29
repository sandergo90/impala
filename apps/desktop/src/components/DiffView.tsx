import { useEffect, useState, useMemo, useCallback, useRef, memo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useUIStore, useDataStore } from "../store";
import { resolveThemeById, getDiffsTheme, getDiffViewerStyle } from "../themes/apply";
import { PatchDiff, MultiFileDiff } from "@pierre/diffs/react";
import { sqliteProvider } from "../providers/sqlite-provider";
import { viewedFilesProvider } from "../providers/viewed-files-provider";
import { InlineAnnotationForm } from "./InlineAnnotationForm";
import { useAnnotationActions } from "../hooks/useAnnotationActions";
import { openFileInEditor } from "../lib/open-file-in-editor";
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
import type { DiffLineAnnotation, FileDiffOptions } from "@pierre/diffs";
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

function OpenFileButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="text-muted-foreground/60 hover:text-foreground transition-colors shrink-0"
      title="Open in editor"
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

function useFileContents(
  worktreePath: string,
  filePath: string,
  commitHash: string | null,
  viewMode: string,
) {
  const [contents, setContents] = useState<{ old: string; new: string } | null>(null);

  useEffect(() => {
    if (!worktreePath || !filePath) return;
    let cancelled = false;

    async function load() {
      try {
        let oldContent = "";
        let newContent = "";

        if (viewMode === "commit" && commitHash) {
          // For a commit: old = commit~1:file, new = commit:file
          const [oldResult, newResult] = await Promise.all([
            invoke<string>("get_file_at_ref", { worktreePath, gitRef: `${commitHash}~1`, filePath }).catch(() => ""),
            invoke<string>("get_file_at_ref", { worktreePath, gitRef: commitHash, filePath }).catch(() => ""),
          ]);
          oldContent = oldResult;
          newContent = newResult;
        } else if (viewMode === "uncommitted") {
          // For uncommitted: old = HEAD:file, new = working copy
          const oldResult = await invoke<string>("get_file_at_ref", { worktreePath, gitRef: "HEAD", filePath }).catch(() => "");
          // Read the working copy from disk. If the file is missing (a legitimate
          // deletion) newContent is "". If the read fails for any other reason,
          // let the error propagate so the outer catch falls back to PatchDiff —
          // otherwise a read failure would render as a full-file deletion.
          const fullPath = `${worktreePath}/${filePath}`;
          const { readTextFile, exists } = await import("@tauri-apps/plugin-fs");
          let workingCopy = "";
          if (await exists(fullPath)) {
            workingCopy = await readTextFile(fullPath);
          }
          oldContent = oldResult;
          newContent = workingCopy;
        } else if (viewMode === "all-changes") {
          // For all-changes: old = base branch version, new = HEAD version
          const baseBranch = await invoke<string>("detect_base_branch", { worktreePath }).catch(() => "main");
          const [oldResult, newResult] = await Promise.all([
            invoke<string>("get_file_at_ref", { worktreePath, gitRef: baseBranch, filePath }).catch(() => ""),
            invoke<string>("get_file_at_ref", { worktreePath, gitRef: "HEAD", filePath }).catch(() => ""),
          ]);
          oldContent = oldResult;
          newContent = newResult;
        }

        if (!cancelled) setContents({ old: oldContent, new: newContent });
      } catch {
        if (!cancelled) setContents(null);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [worktreePath, filePath, commitHash, viewMode]);

  return contents;
}

const FileDiffItem = memo(function FileDiffItem({
  file, patch, isViewed, worktreePath, viewMode, selectedCommitHash,
  collapsedFiles, setCollapsedFiles, generatedFiles, diffOptions, diffViewerStyle,
  annotationsByFile, pendingAnnotation, renderAnnotation, makeGutterUtilityClickHandler,
  toggleViewed, onRequestDiscard, scrollToFile, virtualRow, measureElement, scrollMargin,
}: {
  file: WorktreeDataState["changedFiles"][0];
  patch: string;
  isViewed: boolean;
  worktreePath: string;
  viewMode: string;
  selectedCommitHash: string | null;
  collapsedFiles: Set<string>;
  setCollapsedFiles: React.Dispatch<React.SetStateAction<Set<string>>>;
  generatedFiles: Set<string>;
  diffOptions: FileDiffOptions<AnnotationMeta>;
  diffViewerStyle: React.CSSProperties;
  annotationsByFile: Map<string, DiffLineAnnotation<AnnotationMeta>[]>;
  pendingAnnotation: { filePath?: string; lineNumber: number; side: "deletions" | "additions" } | null;
  renderAnnotation: (annotation: DiffLineAnnotation<AnnotationMeta>) => React.ReactNode;
  makeGutterUtilityClickHandler: (filePath?: string) => (range: { start: number; side?: "deletions" | "additions"; end: number }) => void;
  toggleViewed: (path: string) => void;
  onRequestDiscard: (filePath: string) => void;
  scrollToFile: (index: number) => void;
  virtualRow: { index: number; start: number };
  measureElement: (el: HTMLElement | null) => void;
  scrollMargin: number;
}) {
  const fileContents = useFileContents(worktreePath, file.path, selectedCommitHash, viewMode);

  const isLargeFile = (patch ?? "").length > 100_000;
  const isGenerated = generatedFiles.has(file.path);
  const isCollapsed = collapsedFiles.has(file.path) || (isViewed && !collapsedFiles.has(`expanded:${file.path}`)) || ((isLargeFile || isGenerated) && !collapsedFiles.has(`expanded:${file.path}`));

  const toggleCollapse = () => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (isViewed || isLargeFile || isGenerated) {
        const expandKey = `expanded:${file.path}`;
        if (next.has(expandKey)) next.delete(expandKey);
        else next.add(expandKey);
      } else if (next.has(file.path)) next.delete(file.path);
      else next.add(file.path);
      return next;
    });
  };

  const lineAnnotationsForFile = (() => {
    const saved = annotationsByFile.get(file.path) ?? [];
    if (pendingAnnotation?.filePath === file.path) {
      return [...saved, {
        side: pendingAnnotation.side,
        lineNumber: pendingAnnotation.lineNumber,
        metadata: { type: 'form' as const },
      }];
    }
    return saved.length > 0 ? saved : undefined;
  })();

  const customHeader = (fileDiff: { type: string; name: string; hunks: { additionLines: number; deletionLines: number }[] }) => {
    let additions = 0, deletions = 0;
    for (const hunk of fileDiff.hunks) {
      additions += hunk.additionLines;
      deletions += hunk.deletionLines;
    }
    const lastSlash = fileDiff.name.lastIndexOf("/");
    const dir = lastSlash >= 0 ? fileDiff.name.slice(0, lastSlash + 1) : "";
    const basename = lastSlash >= 0 ? fileDiff.name.slice(lastSlash + 1) : fileDiff.name;
    const nameColor = fileDiff.type === "new" ? "var(--diffs-addition-base, #3fb950)"
      : fileDiff.type === "deleted" ? "var(--diffs-deletion-base, #f85149)"
      : "var(--diffs-color, #e6edf3)";
    return (
      <div
        className="flex items-center w-full cursor-pointer"
        style={{ gap: 10 }}
        onClick={toggleCollapse}
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
        <OpenFileButton onClick={() => worktreePath && openFileInEditor(`${worktreePath}/${file.path}`)} />
        {viewMode === 'uncommitted' && (
          <DiscardButton onClick={() => onRequestDiscard(file.path)} />
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
        <ViewedButton isViewed={isViewed} onClick={(e) => { e.stopPropagation(); toggleViewed(file.path); if (!isViewed) scrollToFile(virtualRow.index); }} />
      </div>
    );
  };

  return (
    <div
      ref={measureElement}
      data-index={virtualRow.index}
      data-file-path={file.path}
      className={`absolute left-0 w-full border-b border-border ${isViewed ? "opacity-75" : ""}`}
      style={{ top: virtualRow.start - scrollMargin }}
    >
      {fileContents ? (
        <MultiFileDiff<AnnotationMeta>
          oldFile={{ name: file.path, contents: fileContents.old }}
          newFile={{ name: file.path, contents: fileContents.new }}
          style={diffViewerStyle}
          options={{ ...diffOptions, collapsed: isCollapsed, onGutterUtilityClick: makeGutterUtilityClickHandler(file.path) }}
          lineAnnotations={lineAnnotationsForFile}
          renderAnnotation={renderAnnotation}
          renderCustomHeader={customHeader}
        />
      ) : (
        <PatchDiff<AnnotationMeta>
          style={diffViewerStyle}
          patch={patch}
          options={{ ...diffOptions, collapsed: isCollapsed, onGutterUtilityClick: makeGutterUtilityClickHandler(file.path) }}
          lineAnnotations={lineAnnotationsForFile}
          renderAnnotation={renderAnnotation}
          renderCustomHeader={customHeader}
        />
      )}
    </div>
  );
});

function VirtualizedCommitView({
  toolbar, changedFiles, fileDiffs, viewedFiles, collapsedFiles, setCollapsedFiles,
  generatedFiles, diffOptions, diffViewerStyle, annotationsByFile,
  pendingAnnotation, renderAnnotation, makeGutterUtilityClickHandler, toggleViewed,
  onRequestDiscard, worktreePath, viewMode, selectedCommitHash,
  totalChangedCount, onShowViewed,
}: {
  toolbar: React.ReactNode;
  changedFiles: WorktreeDataState["changedFiles"];
  fileDiffs: Record<string, string>;
  viewedFiles: Set<string>;
  collapsedFiles: Set<string>;
  setCollapsedFiles: React.Dispatch<React.SetStateAction<Set<string>>>;
  generatedFiles: Set<string>;
  diffOptions: FileDiffOptions<AnnotationMeta>;
  diffViewerStyle: React.CSSProperties;
  annotationsByFile: Map<string, DiffLineAnnotation<AnnotationMeta>[]>;
  pendingAnnotation: { filePath?: string; lineNumber: number; side: "deletions" | "additions" } | null;
  renderAnnotation: (annotation: DiffLineAnnotation<AnnotationMeta>) => React.ReactNode;
  makeGutterUtilityClickHandler: (filePath?: string) => (range: { start: number; side?: "deletions" | "additions"; end: number }) => void;
  toggleViewed: (path: string) => void;
  onRequestDiscard: (filePath: string) => void;
  worktreePath: string;
  viewMode: string;
  selectedCommitHash: string | null;
  totalChangedCount: number;
  onShowViewed: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: changedFiles.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => changedFiles[index]?.path ?? index,
    estimateSize: (index) => {
      const file = changedFiles[index];
      const patch = fileDiffs[file.path];
      const isViewed = viewedFiles.has(file.path);
      const isCollapsed = collapsedFiles.has(file.path) || (isViewed && !collapsedFiles.has(`expanded:${file.path}`));
      if (!patch || isCollapsed) return 44;
      const lineCount = patch.split("\n").length;
      return Math.max(44, lineCount * 20 + 44);
    },
    overscan: 2,
    scrollMargin: listRef.current?.offsetTop ?? 0,
  });

  // Wrap measureElement to defer synchronous measurements out of React's commit phase.
  // Without this, each item measurement triggers resizeItem → notify → rerender during
  // commitAttachRef, cascading into "Maximum update depth exceeded" with many diff files.
  const deferredMeasureElement = useCallback(
    (node: HTMLElement | null) => {
      if (!node) {
        virtualizer.measureElement(node as any);
        return;
      }
      requestAnimationFrame(() => {
        if (node.isConnected) {
          virtualizer.measureElement(node as any);
        }
      });
    },
    [virtualizer],
  );

  const items = virtualizer.getVirtualItems();

  const scrollToFile = useCallback((index: number) => {
    requestAnimationFrame(() => {
      const container = scrollRef.current;
      if (!container) return;
      const item = container.querySelector(`[data-index="${index}"]`);
      if (!item) return;
      const containerRect = container.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      container.scrollTo({
        top: itemRect.top - containerRect.top + container.scrollTop,
        behavior: "smooth",
      });
    });
  }, []);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {toolbar}
      {changedFiles.length === 0 ? (
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
                {totalChangedCount} {totalChangedCount === 1 ? "file" : "files"} marked as viewed
              </div>
            </div>
            <button
              onClick={onShowViewed}
              className="mt-1 px-3 py-1 text-md rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent"
            >
              Show viewed files
            </button>
          </div>
        </div>
      ) : (
      <div ref={scrollRef} className="flex-1 overflow-auto show-scrollbar pr-2">
        <div ref={listRef}>
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((virtualRow) => {
            const file = changedFiles[virtualRow.index];
            const patch = fileDiffs[file.path];
            const isViewed = viewedFiles.has(file.path);

            if (!fileDiffs[file.path]) {
              const isRenamed = file.status.startsWith("R") || file.status.startsWith("C");
              const [oldPath, newPath] = isRenamed ? file.path.split("\t") : [null, file.path];
              return (
                <div
                  key={file.path}
                  ref={deferredMeasureElement}
                  data-index={virtualRow.index}
                  data-file-path={file.path}
                  className={`absolute left-0 w-full border-b border-border ${isViewed ? "opacity-75" : ""}`}
                  style={{ top: virtualRow.start - (virtualizer.options.scrollMargin ?? 0) }}
                >
                  <div className="flex items-center gap-2 px-3 py-1.5 text-sm font-mono text-muted-foreground">
                    {isRenamed ? (
                      <span className="flex-1 truncate">{oldPath} <span className="text-muted-foreground/90">→</span> {newPath}</span>
                    ) : (
                      <span className="flex-1 truncate">{file.path}</span>
                    )}
                    <OpenFileButton onClick={() => worktreePath && openFileInEditor(`${worktreePath}/${isRenamed ? newPath : file.path}`)} />
                    {viewMode === 'uncommitted' && (
                      <DiscardButton onClick={() => onRequestDiscard(isRenamed ? (newPath ?? file.path) : file.path)} />
                    )}
                    <span className="text-md px-1.5 py-0.5 rounded bg-muted">
                      {isRenamed ? (file.status.startsWith("C") ? "Copied" : "Moved") : "New file"}
                    </span>
                    <ViewedButton isViewed={isViewed} onClick={() => { toggleViewed(file.path); if (!isViewed) scrollToFile(virtualRow.index); }} />
                  </div>
                </div>
              );
            }

            return (
              <FileDiffItem
                key={file.path}
                file={file}
                patch={patch}
                isViewed={isViewed}
                worktreePath={worktreePath}
                viewMode={viewMode}
                selectedCommitHash={selectedCommitHash}
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
                onRequestDiscard={onRequestDiscard}
                scrollToFile={scrollToFile}
                virtualRow={virtualRow}
                measureElement={deferredMeasureElement}
                scrollMargin={virtualizer.options.scrollMargin ?? 0}
              />
            );
          })}
          </div>
        </div>
      </div>
      )}
    </div>
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
  const viewKindForViewed: "uncommitted" | "all-changes" | "commit" | null =
    viewMode === "commit" && selectedCommit ? "commit"
    : viewMode === "all-changes" ? "all-changes"
    : viewMode === "uncommitted" ? "uncommitted"
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

  const diffOptions = {
    theme: impalaTheme,
    themeType: activeTheme.type as "dark" | "light",
    overflow: (wrap ? "wrap" : "scroll") as "wrap" | "scroll",
    diffStyle,
    enableGutterUtility: true,
    expandUnchanged: false,
    expansionLineCount: 10,
    hunkSeparators: "line-info" as const,
    unsafeCSS: `:host { --diffs-dark-bg: ${activeTheme.terminal.background}; --diffs-light-bg: ${activeTheme.terminal.background}; --diffs-dark: ${activeTheme.terminal.foreground}; --diffs-light: ${activeTheme.terminal.foreground}; --diffs-color: ${activeTheme.terminal.foreground}; } [data-diffs-header] { position: sticky; top: 0; z-index: 10; } [data-diffs-header='custom'] { background-color: var(--diffs-bg); display: flex; align-items: center; min-height: calc(1lh + (var(--diffs-gap-block, var(--diffs-gap-fallback)) * 3)); padding-inline: 16px; font-family: var(--diffs-header-font-family, var(--diffs-header-font-fallback)); } [data-diffs-header='custom'] ::slotted(*) { width: 100%; } [data-code]::-webkit-scrollbar { height: 10px !important; } [data-code]::-webkit-scrollbar-thumb { background-color: var(--diffs-bg-context) !important; border-radius: 5px !important; border: 2px solid transparent !important; background-clip: padding-box !important; } [data-code]::-webkit-scrollbar-thumb:hover { background-color: var(--diffs-fg-number) !important; background-clip: padding-box !important; } [data-code]::-webkit-scrollbar-track { background: transparent !important; }`,
  } satisfies FileDiffOptions<AnnotationMeta>

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

  // Full commit view: all files stacked with virtualization
  if (showAllFiles) {
    return (
      <>
        <VirtualizedCommitView
          toolbar={toolbar}
          changedFiles={visibleChangedFiles}
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
          onRequestDiscard={requestDiscard}
          worktreePath={worktreePath ?? ""}
          viewMode={viewMode}
          selectedCommitHash={selectedCommit?.hash ?? null}
          totalChangedCount={changedFiles.length}
          onShowViewed={() => setHideViewed(false)}
        />
        {discardDialog}
      </>
    );
  }

  // Single file view with annotations
  return (
    <div className="flex flex-col h-full overflow-hidden">
      {toolbar}
      <div className="flex-1 overflow-auto show-scrollbar pr-2" style={diffViewerStyle}>
        <PatchDiff<AnnotationMeta>
          style={diffViewerStyle}
          patch={diffText!}
          lineAnnotations={lineAnnotations}
          renderAnnotation={renderAnnotation}
          options={{ ...diffOptions, onGutterUtilityClick: makeGutterUtilityClickHandler() }}
        />
      </div>
      {discardDialog}
    </div>
  );
}
