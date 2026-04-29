import { useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { useUIStore, useDataStore } from "../store";
import { openFileInEditor } from "../lib/open-file-in-editor";
import { useCmdHeld } from "../hooks/useCmdClickCursor";
import { ChangedFileContextMenu } from "./ChangedFileContextMenu";
import type { ChangedFile, CommitInfo, WorktreeNavState, WorktreeDataState } from "../types";

const statusColor: Record<string, string> = {
  M: "text-green-500", A: "text-emerald-500", D: "text-red-500", R: "text-yellow-500",
};

function countDiffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

export function CommitPanel() {
  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const wtPath = selectedWorktree?.path;
  const navState = useUIStore((s) => wtPath ? (s.worktreeNavStates[wtPath] ?? null) : null);
  const dataState = useDataStore((s) => wtPath ? (s.worktreeDataStates[wtPath] ?? null) : null);

  const cmdHeld = useCmdHeld();
  const worktreePath = wtPath ?? "";
  const baseBranch = dataState?.baseBranch ?? null;
  const commits = dataState?.commits ?? [];
  const selectedCommit = navState?.selectedCommit ?? null;
  const changedFiles = dataState?.changedFiles ?? [];
  const selectedFile = navState?.selectedFile ?? null;
  const viewMode = navState?.viewMode ?? 'commit';
  const uncommittedStats = dataState?.uncommittedStats ?? { additions: 0, deletions: 0 };
  const allChangesStats = dataState?.allChangesStats ?? { additions: 0, deletions: 0 };

  const updateNav = useCallback((updates: Partial<WorktreeNavState>) =>
    useUIStore.getState().updateWorktreeNavState(worktreePath, updates),
    [worktreePath]
  );

  const updateData = useCallback((updates: Partial<WorktreeDataState>) =>
    useDataStore.getState().updateWorktreeDataState(worktreePath, updates),
    [worktreePath]
  );

  const splitPatch = useCallback((fullDiff: string): Record<string, string> => {
    const fileDiffs: Record<string, string> = {};
    // Strip `* Unmerged path <file>` lines that git emits for merge-conflicted
    // files — @pierre/diffs' parser doesn't know what to do with them and
    // throws. Conflicted files have no textual diff anyway.
    const cleaned = fullDiff.replace(/^\* Unmerged path .*\n?/gm, "");
    const parts = cleaned.split(/^diff --git /m).filter(Boolean);
    for (const part of parts) {
      const patch = "diff --git " + part;
      const match = patch.match(/^diff --git a\/(.*?) b\//);
      if (match) {
        fileDiffs[match[1]] = patch;
      }
    }
    return fileDiffs;
  }, []);

  const selectAllChanges = async () => {
    const currentTab = navState?.activeTab ?? 'diff';
    updateNav({ viewMode: 'all-changes', selectedCommit: null, selectedFile: null, activeTab: currentTab === 'split' ? 'split' : 'diff' });
    updateData({ changedFiles: [], diffText: null, fileDiffs: {}, generatedFiles: [] });
    try {
      const [files, fullDiff] = await Promise.all([
        invoke<ChangedFile[]>("get_all_changed_files", { worktreePath }),
        invoke<string>("get_full_branch_diff", { worktreePath }),
      ]);
      const fileDiffs = splitPatch(fullDiff);
      const generatedFiles = await invoke<string[]>("check_generated_files", {
        worktreePath,
        files: files.map(f => f.path),
      });
      updateData({ changedFiles: files, fileDiffs, generatedFiles, allChangesStats: countDiffStats(fullDiff) });
    } catch (e) {
      toast.error("Failed to load changed files");
    }
  };

  const selectUncommitted = async () => {
    const currentTab = navState?.activeTab ?? 'diff';
    updateNav({ viewMode: 'uncommitted', selectedCommit: null, selectedFile: null, activeTab: currentTab === 'split' ? 'split' : 'diff' });
    updateData({ changedFiles: [], diffText: null, fileDiffs: {}, generatedFiles: [] });
    try {
      const [files, fullDiff] = await Promise.all([
        invoke<ChangedFile[]>("get_uncommitted_files", { worktreePath }),
        invoke<string>("get_uncommitted_diff", { worktreePath }),
      ]);
      const fileDiffs = splitPatch(fullDiff);
      const generatedFiles = await invoke<string[]>("check_generated_files", {
        worktreePath,
        files: files.map(f => f.path),
      });
      updateData({ changedFiles: files, fileDiffs, generatedFiles, uncommittedStats: countDiffStats(fullDiff) });
    } catch (e) {
      toast.error("Failed to load uncommitted changes");
    }
  };

  const selectCommit = async (commit: CommitInfo) => {
    const currentTab = navState?.activeTab ?? 'diff';
    updateNav({ viewMode: 'commit', selectedCommit: commit, selectedFile: null, activeTab: currentTab === 'split' ? 'split' : 'diff' });
    updateData({ changedFiles: [], diffText: null, fileDiffs: {}, generatedFiles: [] });
    try {
      const [files, fullDiff] = await Promise.all([
        invoke<ChangedFile[]>("get_changed_files", { worktreePath, commitHash: commit.hash }),
        invoke<string>("get_full_commit_diff", { worktreePath, commitHash: commit.hash }),
      ]);
      const fileDiffs = splitPatch(fullDiff);
      const generatedFiles = await invoke<string[]>("check_generated_files", {
        worktreePath,
        files: files.map(f => f.path),
      });
      updateData({ changedFiles: files, fileDiffs, generatedFiles });
    } catch (e) {
      toast.error("Failed to load commit");
    }
  };

  const selectFile = (file: ChangedFile) => {
    updateNav({ selectedFile: file });
    const currentFileDiffs = useDataStore.getState().getWorktreeDataState(worktreePath).fileDiffs;
    const diff = currentFileDiffs[file.path] ?? "";
    updateData({ diffText: diff });
  };

  // Auto-refresh when files or git refs change on disk
  const refreshCurrentView = useCallback(async () => {
    // Keep selectedWorktree.head_commit in sync with actual HEAD
    try {
      const headCommit = await invoke<string>("get_head_commit", { worktreePath });
      const current = useUIStore.getState().selectedWorktree;
      if (current && current.path === worktreePath && current.head_commit !== headCommit) {
        useUIStore.getState().setSelectedWorktree({ ...current, head_commit: headCommit });
      }
    } catch {
      // Silently fail
    }

    // Always refresh commit list so sidebar counts stay accurate.
    // Skip the store update if the list is unchanged to avoid churning
    // downstream re-renders (which can flicker the diff panel).
    if (baseBranch) {
      try {
        const nextCommits = await invoke<CommitInfo[]>("get_diverged_commits", { worktreePath, baseBranch });
        const prev = useDataStore.getState().getWorktreeDataState(worktreePath).commits;
        const sameLen = prev.length === nextCommits.length;
        const sameHashes = sameLen && prev.every((c, i) => c.hash === nextCommits[i].hash);
        if (!sameHashes) {
          updateData({ commits: nextCommits });
        }
      } catch {
        // Silently fail on auto-refresh
      }
    }

    // Committed diffs are immutable, so skip the refetch.
    if (viewMode === 'commit') {
      return;
    }

    if (viewMode === 'uncommitted') {
      try {
        const [files, fullDiff] = await Promise.all([
          invoke<ChangedFile[]>("get_uncommitted_files", { worktreePath }),
          invoke<string>("get_uncommitted_diff", { worktreePath }),
        ]);
        const fileDiffs = splitPatch(fullDiff);
        const generatedFiles = await invoke<string[]>("check_generated_files", {
          worktreePath,
          files: files.map(f => f.path),
        });
        updateData({ changedFiles: files, fileDiffs, generatedFiles, uncommittedStats: countDiffStats(fullDiff) });
      } catch {
        // Silently fail on auto-refresh
      }
    } else if (viewMode === 'all-changes') {
      try {
        const [files, fullDiff] = await Promise.all([
          invoke<ChangedFile[]>("get_all_changed_files", { worktreePath }),
          invoke<string>("get_full_branch_diff", { worktreePath }),
        ]);
        const fileDiffs = splitPatch(fullDiff);
        const generatedFiles = await invoke<string[]>("check_generated_files", {
          worktreePath,
          files: files.map(f => f.path),
        });
        updateData({ changedFiles: files, fileDiffs, generatedFiles, allChangesStats: countDiffStats(fullDiff) });
      } catch {
        // Silently fail on auto-refresh
      }
    }
  }, [viewMode, worktreePath, baseBranch, splitPatch, updateData]);

  useEffect(() => {
    if (!worktreePath) return;
    refreshCurrentView();
  }, [worktreePath, refreshCurrentView]);

  useEffect(() => {
    const safeId = worktreePath.replace(/[^a-zA-Z0-9\-_]/g, "-");
    let unlisten: (() => void) | null = null;

    listen(`fs-changed-${safeId}`, () => {
      // Invalidate branch cache so next "All Changes" fetch is fresh
      invoke("invalidate_branch_cache", { worktreePath });
      // Only refresh diffs if viewing diffs — skip heavy git operations when on terminal/split tab
      const tab = useUIStore.getState().getWorktreeNavState(worktreePath)?.activeTab;
      if (tab === "terminal") return;
      refreshCurrentView();
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [worktreePath, refreshCurrentView]);

  if (!selectedWorktree || (!navState && !dataState)) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Select a worktree
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full text-sm overflow-hidden bg-card">
      {/* Commits section — top half */}
      <div className="flex flex-col min-h-0 flex-1">
        <div className="flex items-center gap-1.5 px-3.5 py-2.5 text-sm uppercase tracking-[1.2px] text-muted-foreground/60 font-semibold shrink-0 border-b border-border">
          Commits on <span className="font-mono text-sm text-muted-foreground normal-case tracking-normal">{selectedWorktree.branch}</span>
          {commits.length > 0 && (
            <span className="ml-auto text-sm bg-accent rounded-full px-1.5 py-0.5 text-muted-foreground normal-case tracking-normal font-normal">{commits.length}</span>
          )}
        </div>

        <div className="overflow-y-auto flex-1 min-h-0">
        {/* Uncommitted Changes */}
        <button
          onClick={selectUncommitted}
          className={`w-full px-3.5 py-2 text-left transition-colors border-b border-border ${
            viewMode === 'uncommitted'
              ? "bg-primary/12"
              : "hover:bg-accent"
          }`}
        >
          <div className={`text-sm font-medium ${viewMode === 'uncommitted' ? "text-foreground" : "text-muted-foreground"}`}>
            Uncommitted Changes
          </div>
          <div className="flex items-center gap-1 text-sm text-muted-foreground/90 mt-0.5 font-mono">
            <span>Working tree</span>
            {(uncommittedStats.additions > 0 || uncommittedStats.deletions > 0) && (
              <span className="ml-auto">
                <span className="text-green-500">+{uncommittedStats.additions}</span>
                {" "}
                <span className="text-red-500">-{uncommittedStats.deletions}</span>
              </span>
            )}
          </div>
        </button>

        {/* All Changes */}
        <button
          onClick={selectAllChanges}
          className={`w-full px-3.5 py-2 text-left transition-colors border-b border-border ${
            viewMode === 'all-changes'
              ? "bg-primary/12"
              : "hover:bg-accent"
          }`}
        >
          <div className={`text-sm font-medium ${viewMode === 'all-changes' ? "text-foreground" : "text-muted-foreground"}`}>
            All Changes
          </div>
          <div className="flex items-center gap-1 text-sm text-muted-foreground/90 mt-0.5 font-mono">
            <span>vs {baseBranch || "base"}</span>
            {(allChangesStats.additions > 0 || allChangesStats.deletions > 0) && (
              <span className="ml-auto">
                <span className="text-green-500">+{allChangesStats.additions}</span>
                {" "}
                <span className="text-red-500">-{allChangesStats.deletions}</span>
              </span>
            )}
          </div>
        </button>

        {/* Commits */}
        {commits.length === 0 ? (
          <div className="px-3.5 py-4 text-muted-foreground/90 text-sm">No commits ahead of {baseBranch}</div>
        ) : (
          commits.map((commit) => {
            const isSelected = viewMode === 'commit' && selectedCommit?.hash === commit.hash;
            return (
              <button
                key={commit.hash}
                onClick={() => selectCommit(commit)}
                className={`w-full px-3.5 py-2 text-left transition-colors border-b border-border/50 ${
                  isSelected
                    ? "bg-primary/12"
                    : "hover:bg-accent"
                }`}
              >
                <div className={`text-sm font-medium truncate ${isSelected ? "text-foreground" : "text-foreground/80"}`}>
                  {commit.message}
                </div>
                <div className="flex items-center gap-1 text-sm text-muted-foreground/90 mt-0.5 font-mono">
                  <span>{commit.hash.slice(0, 7)} &middot; {commit.date.split("T")[0]} {commit.date.split("T")[1]?.slice(0, 5)}</span>
                  {(commit.additions > 0 || commit.deletions > 0) && (
                    <span className="ml-auto">
                      <span className="text-green-500">+{commit.additions}</span>
                      {" "}
                      <span className="text-red-500">-{commit.deletions}</span>
                    </span>
                  )}
                </div>
              </button>
            );
          })
        )}
        </div>
      </div>

      {/* Changed Files — bottom half */}
      <div className="flex flex-col min-h-0 flex-1">
        <div className="flex items-center px-3.5 py-2 text-sm uppercase tracking-[1.2px] text-muted-foreground/60 font-semibold shrink-0 border-y border-border">
          Changed Files
          {changedFiles.length > 0 && (
            <span className="ml-auto text-sm bg-accent rounded-full px-1.5 py-0.5 text-muted-foreground normal-case tracking-normal font-normal">{changedFiles.length}</span>
          )}
        </div>
        <div className="overflow-y-auto flex-1 min-h-0">
          {changedFiles.map((file) => {
            const isSelected = selectedFile?.path === file.path;
            const button = (
              <button
                onClick={(e) => {
                  if (e.metaKey && worktreePath) {
                    e.stopPropagation();
                    openFileInEditor(`${worktreePath}/${file.path}`);
                  } else {
                    selectFile(file);
                  }
                }}
                className={`w-full px-3.5 py-1.5 text-left font-mono text-sm flex items-center gap-1.5 transition-colors truncate ${
                  isSelected ? "text-primary bg-primary/[0.06]" : "text-muted-foreground hover:bg-accent"
                }`}
                style={cmdHeld ? { cursor: "pointer" } : undefined}
              >
                <span className={`text-sm font-semibold w-3 text-center shrink-0 ${statusColor[file.status] || ""}`}>
                  {file.status}
                </span>
                {file.path.split("/").pop()}
              </button>
            );
            if (!worktreePath) {
              return <div key={file.path}>{button}</div>;
            }
            return (
              <ChangedFileContextMenu
                key={file.path}
                worktreePath={worktreePath}
                filePath={file.path}
              >
                {button}
              </ChangedFileContextMenu>
            );
          })}
        </div>
      </div>
    </div>
  );
}
