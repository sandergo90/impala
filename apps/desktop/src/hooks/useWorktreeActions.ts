import { invoke } from "@/lib/invoke";
import { toast } from "sonner";
import { useUIStore, useDataStore } from "../store";
import type { Worktree, CommitInfo, ChangedFile, Project } from "../types";

export async function selectWorktree(wt: Worktree) {
  // Any worktree selection returns Companion mode's preview to the diff, no
  // matter the path taken (sidebar click, palette, jump hotkey, boot restore).
  useUIStore.getState().setCompanionFilePreview(null);
  useUIStore.getState().setSelectedWorktree(wt);
  const projectPath = useUIStore.getState().selectedProject?.path;
  if (projectPath) {
    useUIStore.getState().setLastWorktreeForProject(projectPath, wt.path);
  }
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
        let additions = 0, deletions = 0;
        for (const line of fullDiff.split("\n")) {
          if (line.startsWith("+++") || line.startsWith("---")) continue;
          if (line.startsWith("+")) additions++;
          else if (line.startsWith("-")) deletions++;
        }
        useDataStore.getState().updateWorktreeDataState(wt.path, { changedFiles: files, fileDiffs, uncommittedStats: { additions, deletions } });
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

/**
 * App boot: load persisted projects, kick off icon discovery, and restore the
 * persisted project/worktree selection. Called from whichever sidebar mounts
 * (full Sidebar or Companion mode's sidebar) — safe to re-run on remount.
 */
export async function bootProjects(): Promise<void> {
  try {
    const paths = await invoke<string[]>("load_projects");
    const loaded: Project[] = paths.map((p) => ({
      path: p,
      name: p.split("/").pop() || p,
    }));
    useDataStore.getState().setProjects(loaded);

    // Discover icons for all projects in parallel
    for (const project of loaded) {
      invoke<string | null>("discover_project_icon", {
        projectPath: project.path,
      })
        .then((icon) => {
          if (icon) useDataStore.getState().setProjectIcon(project.path, icon);
        })
        .catch(() => {});
    }

    const persistedProject = useUIStore.getState().selectedProject;
    if (
      persistedProject &&
      loaded.some((p) => p.path === persistedProject.path)
    ) {
      try {
        const wts = await invoke<Worktree[]>("list_worktrees", {
          repoPath: persistedProject.path,
        });
        useDataStore.getState().setWorktrees(wts);

        const persistedWorktree = useUIStore.getState().selectedWorktree;
        if (
          persistedWorktree &&
          wts.some((wt) => wt.path === persistedWorktree.path)
        ) {
          useUIStore.getState().setGeneralTerminalActive(false);
          await selectWorktree(persistedWorktree);
        } else {
          useUIStore.getState().setSelectedWorktree(null);
        }
      } catch {
        useUIStore.getState().setSelectedProject(null);
        useUIStore.getState().setSelectedWorktree(null);
      }
    } else if (persistedProject) {
      useUIStore.getState().setSelectedProject(null);
      useUIStore.getState().setSelectedWorktree(null);
    }
  } catch (e) {
    toast.error("Failed to load projects");
  }
}

export async function selectProject(project: Project) {
  const current = useUIStore.getState().selectedProject;
  if (current && current.path !== project.path) {
    useUIStore.getState().setPreviousProject(current);
  }
  useUIStore.getState().setSelectedProject(project);
  useUIStore.getState().setSelectedWorktree(null);
  useDataStore.getState().setWorktrees([]);
  try {
    const wts = await invoke<Worktree[]>("list_worktrees", {
      repoPath: project.path,
    });
    useDataStore.getState().setWorktrees(wts);

    // Auto-select the worktree the user was last on in this project, if it
    // still exists.
    const lastPath = useUIStore.getState().lastWorktreeByProject[project.path];
    const lastWorktree = lastPath ? wts.find((wt) => wt.path === lastPath) : undefined;
    if (lastWorktree) {
      useUIStore.getState().setGeneralTerminalActive(false);
      await selectWorktree(lastWorktree);
    }
  } catch (e) {
    toast.error("Failed to load worktrees");
  }
}
