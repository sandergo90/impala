import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useUIStore, useDataStore } from "../store";
import type { Worktree, CommitInfo, ChangedFile, Project } from "../types";

export async function selectWorktree(wt: Worktree) {
  useUIStore.getState().setSelectedWorktree(wt);
  try {
    const [, base] = await Promise.all([
      invoke("watch_worktree", { worktreePath: wt.path }),
      invoke<string>("detect_base_branch", { worktreePath: wt.path }),
    ]);
    useDataStore.getState().updateWorktreeDataState(wt.path, { baseBranch: base });
    const commits = await invoke<CommitInfo[]>("get_diverged_commits", { worktreePath: wt.path, baseBranch: base });
    useDataStore.getState().updateWorktreeDataState(wt.path, { commits });

    const navState = useUIStore.getState().getWorktreeNavState(wt.path);
    if (!navState.selectedCommit && navState.viewMode === 'commit') {
      useUIStore.getState().updateWorktreeNavState(wt.path, { viewMode: 'uncommitted', selectedCommit: null, selectedFile: null });
      try {
        const [files, fullDiff] = await Promise.all([
          invoke<ChangedFile[]>("get_uncommitted_files", { worktreePath: wt.path }),
          invoke<string>("get_uncommitted_diff", { worktreePath: wt.path }),
        ]);
        const fileDiffs: Record<string, string> = {};
        const parts = fullDiff.split(/^diff --git /m).filter(Boolean);
        for (const part of parts) {
          const patch = "diff --git " + part;
          const match = patch.match(/^diff --git a\/(.*?) b\//);
          if (match) fileDiffs[match[1]] = patch;
        }
        useDataStore.getState().updateWorktreeDataState(wt.path, { changedFiles: files, fileDiffs });
      } catch {
        // Non-critical
      }
    }
  } catch (e) {
    toast.error("Failed to load commits");
  }
}

export function activateGeneralTerminal() {
  const state = useUIStore.getState();
  const current = state.selectedWorktree;
  if (current) {
    state.setPreviousWorktree(current);
  }
  state.setSelectedWorktree(null);
  state.setGeneralTerminalActive(true);
}

export async function selectProject(project: Project) {
  useUIStore.getState().setSelectedProject(project);
  useUIStore.getState().setSelectedWorktree(null);
  useDataStore.getState().setWorktrees([]);
  try {
    const wts = await invoke<Worktree[]>("list_worktrees", {
      repoPath: project.path,
    });
    useDataStore.getState().setWorktrees(wts);
  } catch (e) {
    toast.error("Failed to load worktrees");
  }
}
