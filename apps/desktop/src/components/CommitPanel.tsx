import { useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { useUIStore, useDataStore } from "../store";
import type { ChangedFile, CommitInfo, WorktreeNavState, WorktreeDataState } from "../types";

const statusColor: Record<string, string> = {
  M: "text-[#4ade80]", A: "text-[#34d399]", D: "text-[#f87171]", R: "text-yellow-500",
};

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

  const splitPatch = useCallback((fullDiff: string): Record<string, string> => {
    const fileDiffs: Record<string, string> = {};
    const parts = fullDiff.split(/^diff --git /m).filter(Boolean);
    for (const part of parts) {
      const patch = "diff --git " + part;
      const match = patch.match(/^diff --git a\/(.*?) b\//);
      if (match) fileDiffs[match[1]] = patch;
    }
    return fileDiffs;
  }, []);

  const selectAllChanges = async () => {
    updateNav({ viewMode: 'all-changes', selectedCommit: null, selectedFile: null, activeTab: 'diff' });
    updateData({ changedFiles: [], diffText: null, fileDiffs: {} });
    try {
      const filesPromise = invoke<ChangedFile[]>("get_all_changed_files", { worktreePath });
      const diffPromise = invoke<string>("get_full_branch_diff", { worktreePath });
      updateData({ changedFiles: await filesPromise });
      updateData({ fileDiffs: splitPatch(await diffPromise) });
    } catch (e) {
      toast.error("Failed to load changed files");
    }
  };

  const selectUncommitted = async () => {
    updateNav({ viewMode: 'uncommitted', selectedCommit: null, selectedFile: null, activeTab: 'diff' });
    updateData({ changedFiles: [], diffText: null, fileDiffs: {} });
    try {
      const filesPromise = invoke<ChangedFile[]>("get_uncommitted_files", { worktreePath });
      const diffPromise = invoke<string>("get_uncommitted_diff", { worktreePath });
      updateData({ changedFiles: await filesPromise });
      updateData({ fileDiffs: splitPatch(await diffPromise) });
    } catch (e) {
      toast.error("Failed to load uncommitted changes");
    }
  };

  const selectCommit = async (commit: CommitInfo) => {
    updateNav({ viewMode: 'commit', selectedCommit: commit, selectedFile: null, activeTab: 'diff' });
    updateData({ changedFiles: [], diffText: null, fileDiffs: {} });
    try {
      const filesPromise = invoke<ChangedFile[]>("get_changed_files", { worktreePath, commitHash: commit.hash });
      const diffPromise = invoke<string>("get_full_commit_diff", { worktreePath, commitHash: commit.hash });
      updateData({ changedFiles: await filesPromise });
      updateData({ fileDiffs: splitPatch(await diffPromise) });
    } catch (e) {
      toast.error("Failed to load commit");
    }
  };

  const selectFile = async (file: ChangedFile) => {
    updateNav({ selectedFile: file });
    try {
      let diff: string;
      if (viewMode === 'uncommitted') {
        // For uncommitted, get diff of working tree
        diff = await invoke<string>("get_uncommitted_diff", {
          worktreePath: worktreePath,
        });
        // Extract just this file's diff from the full output
        const parts = diff.split(/^diff --git /m).filter(Boolean);
        const filePart = parts.find(p => p.includes(`a/${file.path} b/${file.path}`));
        diff = filePart ? "diff --git " + filePart : "";
      } else if (viewMode === 'all-changes') {
        diff = await invoke<string>("get_branch_diff", {
          worktreePath: worktreePath,
          filePath: file.path,
        });
      } else {
        if (!selectedCommit) return;
        diff = await invoke<string>("get_commit_diff", {
          worktreePath: worktreePath,
          commitHash: selectedCommit.hash,
          filePath: file.path,
        });
      }
      updateData({ diffText: diff });
    } catch (e) {
      toast.error("Failed to load diff");
    }
  };

  // Auto-refresh when files or git refs change on disk
  const refreshCurrentView = useCallback(async () => {
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
        updateData({ changedFiles: files, fileDiffs: splitPatch(fullDiff) });
      } catch {
        // Silently fail on auto-refresh
      }
    } else if (viewMode === 'all-changes') {
      try {
        const [files, fullDiff] = await Promise.all([
          invoke<ChangedFile[]>("get_all_changed_files", { worktreePath }),
          invoke<string>("get_full_branch_diff", { worktreePath }),
        ]);
        updateData({ changedFiles: files, fileDiffs: splitPatch(fullDiff) });
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
    <div className="flex flex-col h-full text-sm overflow-hidden">
      {/* Commits section — top half */}
      <div className="flex flex-col min-h-0 flex-1">
        <div className="flex items-center gap-1.5 px-3.5 py-2.5 text-[9px] uppercase tracking-[1.2px] text-[#555] shrink-0"
          style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          Commits on <span className="font-mono text-[10px] text-[#888] normal-case tracking-normal">{selectedWorktree.branch}</span>
        </div>

        <div className="overflow-y-auto flex-1 min-h-0">
        {/* Uncommitted Changes */}
        <button
          onClick={selectUncommitted}
          className={`w-full px-3.5 py-2 text-left transition-colors ${
            viewMode === 'uncommitted'
              ? "border-l-2 border-[#3b82f6] pl-3"
              : "hover:bg-white/[0.02]"
          }`}
          style={{
            ...(viewMode === 'uncommitted' ? { background: "rgba(59,130,246,0.06)" } : {}),
            borderBottom: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          <div className={`text-[11px] font-medium ${viewMode === 'uncommitted' ? "text-[#e5e5e5]" : "text-[#888]"}`}>
            Uncommitted Changes
          </div>
          <div className="text-[9px] text-[#555] mt-0.5 font-mono">Working tree</div>
        </button>

        {/* All Changes */}
        <button
          onClick={selectAllChanges}
          className={`w-full px-3.5 py-2 text-left transition-colors ${
            viewMode === 'all-changes'
              ? "border-l-2 border-[#3b82f6] pl-3"
              : "hover:bg-white/[0.02]"
          }`}
          style={{
            ...(viewMode === 'all-changes' ? { background: "rgba(59,130,246,0.06)" } : {}),
            borderBottom: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          <div className={`text-[11px] font-medium ${viewMode === 'all-changes' ? "text-[#e5e5e5]" : "text-[#888]"}`}>
            All Changes
          </div>
          <div className="text-[9px] text-[#555] mt-0.5 font-mono">vs {baseBranch || "base"}</div>
        </button>

        {/* Commits */}
        {commits.length === 0 ? (
          <div className="px-3.5 py-4 text-[#555] text-[11px]">No commits ahead of {baseBranch}</div>
        ) : (
          commits.map((commit) => {
            const isSelected = viewMode === 'commit' && selectedCommit?.hash === commit.hash;
            return (
              <button
                key={commit.hash}
                onClick={() => selectCommit(commit)}
                className={`w-full px-3.5 py-2 text-left transition-colors ${
                  isSelected
                    ? "border-l-2 border-[#3b82f6] pl-3"
                    : "hover:bg-white/[0.02]"
                }`}
                style={{
                  ...(isSelected ? { background: "rgba(59,130,246,0.06)" } : {}),
                  borderBottom: "1px solid rgba(255,255,255,0.03)",
                }}
              >
                <div className={`text-[11px] font-medium truncate ${isSelected ? "text-[#e5e5e5]" : "text-[#bbb]"}`}>
                  {commit.message}
                </div>
                <div className="flex items-center gap-1 text-[9px] text-[#555] mt-0.5 font-mono">
                  <span>{commit.hash.slice(0, 7)} &middot; {commit.date.split("T")[0]}</span>
                  {(commit.additions > 0 || commit.deletions > 0) && (
                    <span className="ml-auto">
                      <span className="text-[#4ade80]">+{commit.additions}</span>
                      {" "}
                      <span className="text-[#f87171]">-{commit.deletions}</span>
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
        <div className="px-3.5 py-2 text-[9px] uppercase tracking-[1.2px] text-[#555] shrink-0"
          style={{
            borderTop: "1px solid rgba(255,255,255,0.06)",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
          }}>
          Changed Files
        </div>
        <div className="overflow-y-auto flex-1 min-h-0">
          {changedFiles.map((file) => {
            const isSelected = selectedFile?.path === file.path;
            return (
              <button
                key={file.path}
                onClick={() => selectFile(file)}
                className={`w-full px-3.5 py-1.5 text-left font-mono text-[10px] flex items-center gap-1.5 transition-colors truncate ${
                  isSelected ? "text-[#3b82f6]" : "text-[#888] hover:bg-white/[0.02]"
                }`}
                style={isSelected ? { background: "rgba(59,130,246,0.06)" } : undefined}
              >
                <span className={`text-[9px] font-semibold w-3 text-center shrink-0 ${statusColor[file.status] || ""}`}>
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
