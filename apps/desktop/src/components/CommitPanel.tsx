import { useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { useUIStore, useDataStore } from "../store";
import type { ChangedFile, CommitInfo, WorktreeNavState, WorktreeDataState } from "../types";

const statusColor: Record<string, string> = {
  M: "text-green-500", A: "text-emerald-500", D: "text-red-500", R: "text-yellow-500",
};

function hashPatch(patch: string): string {
  const hunkStart = patch.indexOf("\n@@");
  const body = hunkStart >= 0 ? patch.slice(hunkStart) : patch;
  let hash = 0;
  for (let i = 0; i < body.length; i++) {
    hash = ((hash << 5) - hash + body.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

export function CommitPanel() {
  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const wtPath = selectedWorktree?.path;
  const navState = useUIStore((s) => wtPath ? (s.worktreeNavStates[wtPath] ?? null) : null);
  const dataState = useDataStore((s) => wtPath ? (s.worktreeDataStates[wtPath] ?? null) : null);

  const worktreePath = wtPath ?? "";
  const baseBranch = dataState?.baseBranch ?? null;
  const commits = dataState?.commits ?? [];
  const selectedCommit = navState?.selectedCommit ?? null;
  const changedFiles = dataState?.changedFiles ?? [];
  const selectedFile = navState?.selectedFile ?? null;
  const viewMode = navState?.viewMode ?? 'commit';

  const updateNav = useCallback((updates: Partial<WorktreeNavState>) =>
    useUIStore.getState().updateWorktreeNavState(worktreePath, updates),
    [worktreePath]
  );

  const updateData = useCallback((updates: Partial<WorktreeDataState>) =>
    useDataStore.getState().updateWorktreeDataState(worktreePath, updates),
    [worktreePath]
  );

  const splitPatch = useCallback((fullDiff: string): { fileDiffs: Record<string, string>; fileDiffHashes: Record<string, string> } => {
    const fileDiffs: Record<string, string> = {};
    const fileDiffHashes: Record<string, string> = {};
    const parts = fullDiff.split(/^diff --git /m).filter(Boolean);
    for (const part of parts) {
      const patch = "diff --git " + part;
      const match = patch.match(/^diff --git a\/(.*?) b\//);
      if (match) {
        fileDiffs[match[1]] = patch;
        fileDiffHashes[match[1]] = hashPatch(patch);
      }
    }
    return { fileDiffs, fileDiffHashes };
  }, []);

  const selectAllChanges = async () => {
    const currentTab = navState?.activeTab ?? 'diff';
    updateNav({ viewMode: 'all-changes', selectedCommit: null, selectedFile: null, activeTab: currentTab === 'split' ? 'split' : 'diff' });
    updateData({ changedFiles: [], diffText: null, fileDiffs: {}, fileDiffHashes: {}, generatedFiles: [] });
    try {
      const [files, fullDiff] = await Promise.all([
        invoke<ChangedFile[]>("get_all_changed_files", { worktreePath }),
        invoke<string>("get_full_branch_diff", { worktreePath }),
      ]);
      const { fileDiffs, fileDiffHashes } = splitPatch(fullDiff);
      const generatedFiles = await invoke<string[]>("check_generated_files", {
        worktreePath,
        files: files.map(f => f.path),
      });
      updateData({ changedFiles: files, fileDiffs, fileDiffHashes, generatedFiles });
    } catch (e) {
      toast.error("Failed to load changed files");
    }
  };

  const selectUncommitted = async () => {
    const currentTab = navState?.activeTab ?? 'diff';
    updateNav({ viewMode: 'uncommitted', selectedCommit: null, selectedFile: null, activeTab: currentTab === 'split' ? 'split' : 'diff' });
    updateData({ changedFiles: [], diffText: null, fileDiffs: {}, fileDiffHashes: {}, generatedFiles: [] });
    try {
      const [files, fullDiff] = await Promise.all([
        invoke<ChangedFile[]>("get_uncommitted_files", { worktreePath }),
        invoke<string>("get_uncommitted_diff", { worktreePath }),
      ]);
      const { fileDiffs, fileDiffHashes } = splitPatch(fullDiff);
      const generatedFiles = await invoke<string[]>("check_generated_files", {
        worktreePath,
        files: files.map(f => f.path),
      });
      updateData({ changedFiles: files, fileDiffs, fileDiffHashes, generatedFiles });
    } catch (e) {
      toast.error("Failed to load uncommitted changes");
    }
  };

  const selectCommit = async (commit: CommitInfo) => {
    const currentTab = navState?.activeTab ?? 'diff';
    updateNav({ viewMode: 'commit', selectedCommit: commit, selectedFile: null, activeTab: currentTab === 'split' ? 'split' : 'diff' });
    updateData({ changedFiles: [], diffText: null, fileDiffs: {}, fileDiffHashes: {}, generatedFiles: [] });
    try {
      const [files, fullDiff] = await Promise.all([
        invoke<ChangedFile[]>("get_changed_files", { worktreePath, commitHash: commit.hash }),
        invoke<string>("get_full_commit_diff", { worktreePath, commitHash: commit.hash }),
      ]);
      const { fileDiffs, fileDiffHashes } = splitPatch(fullDiff);
      const generatedFiles = await invoke<string[]>("check_generated_files", {
        worktreePath,
        files: files.map(f => f.path),
      });
      updateData({ changedFiles: files, fileDiffs, fileDiffHashes, generatedFiles });
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

    // Always refresh commit list so sidebar counts stay accurate
    if (baseBranch) {
      try {
        const commits = await invoke<CommitInfo[]>("get_diverged_commits", { worktreePath, baseBranch });
        updateData({ commits });
      } catch {
        // Silently fail on auto-refresh
      }
    }

    if (viewMode === 'uncommitted') {
      try {
        const [files, fullDiff] = await Promise.all([
          invoke<ChangedFile[]>("get_uncommitted_files", { worktreePath }),
          invoke<string>("get_uncommitted_diff", { worktreePath }),
        ]);
        const { fileDiffs, fileDiffHashes } = splitPatch(fullDiff);
        const generatedFiles = await invoke<string[]>("check_generated_files", {
          worktreePath,
          files: files.map(f => f.path),
        });
        updateData({ changedFiles: files, fileDiffs, fileDiffHashes, generatedFiles });
      } catch {
        // Silently fail on auto-refresh
      }
    } else if (viewMode === 'all-changes') {
      try {
        const [files, fullDiff] = await Promise.all([
          invoke<ChangedFile[]>("get_all_changed_files", { worktreePath }),
          invoke<string>("get_full_branch_diff", { worktreePath }),
        ]);
        const { fileDiffs, fileDiffHashes } = splitPatch(fullDiff);
        const generatedFiles = await invoke<string[]>("check_generated_files", {
          worktreePath,
          files: files.map(f => f.path),
        });
        updateData({ changedFiles: files, fileDiffs, fileDiffHashes, generatedFiles });
      } catch {
        // Silently fail on auto-refresh
      }
    }
  }, [viewMode, worktreePath, baseBranch, splitPatch, updateData]);

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
        <div className="flex items-center gap-1.5 px-3.5 py-2.5 text-xs uppercase tracking-[1.2px] text-muted-foreground/60 font-semibold shrink-0 border-b border-border">
          Commits on <span className="font-mono text-xs text-muted-foreground normal-case tracking-normal">{selectedWorktree.branch}</span>
          {commits.length > 0 && (
            <span className="ml-auto text-xs bg-accent rounded-full px-1.5 py-0.5 text-muted-foreground normal-case tracking-normal font-normal">{commits.length}</span>
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
          <div className={`text-xs font-medium ${viewMode === 'uncommitted' ? "text-foreground" : "text-muted-foreground"}`}>
            Uncommitted Changes
          </div>
          <div className="text-xs text-muted-foreground/50 mt-0.5 font-mono">Working tree</div>
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
          <div className={`text-xs font-medium ${viewMode === 'all-changes' ? "text-foreground" : "text-muted-foreground"}`}>
            All Changes
          </div>
          <div className="text-xs text-muted-foreground/50 mt-0.5 font-mono">vs {baseBranch || "base"}</div>
        </button>

        {/* Commits */}
        {commits.length === 0 ? (
          <div className="px-3.5 py-4 text-muted-foreground/50 text-xs">No commits ahead of {baseBranch}</div>
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
                <div className={`text-xs font-medium truncate ${isSelected ? "text-foreground" : "text-foreground/80"}`}>
                  {commit.message}
                </div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground/50 mt-0.5 font-mono">
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
        <div className="flex items-center px-3.5 py-2 text-xs uppercase tracking-[1.2px] text-muted-foreground/60 font-semibold shrink-0 border-y border-border">
          Changed Files
          {changedFiles.length > 0 && (
            <span className="ml-auto text-xs bg-accent rounded-full px-1.5 py-0.5 text-muted-foreground normal-case tracking-normal font-normal">{changedFiles.length}</span>
          )}
        </div>
        <div className="overflow-y-auto flex-1 min-h-0">
          {changedFiles.map((file) => {
            const isSelected = selectedFile?.path === file.path;
            return (
              <button
                key={file.path}
                onClick={() => selectFile(file)}
                className={`w-full px-3.5 py-1.5 text-left font-mono text-xs flex items-center gap-1.5 transition-colors truncate ${
                  isSelected ? "text-primary bg-primary/[0.06]" : "text-muted-foreground hover:bg-accent"
                }`}
              >
                <span className={`text-xs font-semibold w-3 text-center shrink-0 ${statusColor[file.status] || ""}`}>
                  {file.status}
                </span>
                {file.path.split("/").pop()}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
