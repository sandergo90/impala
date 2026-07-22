import { invoke } from "@/lib/invoke";
import { toast } from "sonner";
import { useUIStore, useDataStore } from "../store";
import { isAutomationsProject } from "../lib/automations-project";
import { router } from "../router";
import type { Worktree, CommitInfo, ChangedFile, Project } from "../types";

/** Worktree/terminal selection only renders on the main view — leave
 * full-page routes (/automations) when the user picks one. Runtime-only
 * router access, so the import cycle with router.tsx is harmless. */
function ensureMainView() {
  if (router.state.location.pathname !== "/") {
    router.navigate({ to: "/" });
  }
}

export async function selectWorktree(
  wt: Worktree,
  opts?: { stayOnRoute?: boolean },
) {
  // Mount-time selection *restore* passes stayOnRoute — it re-selects the
  // persisted worktree to refresh data, not because the user picked one.
  if (!opts?.stayOnRoute) ensureMainView();
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
  ensureMainView();
  const state = useUIStore.getState();
  const current = state.selectedWorktree;
  if (current) {
    state.setPreviousWorktree(current);
  }
  state.setSelectedWorktree(null);
  state.setGeneralTerminalActive(true);
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
    // The virtual Automations project lists global runs' scratch repos —
    // its sentinel path must never reach git-facing commands.
    const wts = isAutomationsProject(project)
      ? await invoke<Worktree[]>("list_automation_run_worktrees")
      : await invoke<Worktree[]>("list_worktrees", {
          repoPath: project.path,
        });
    useDataStore.getState().setWorktrees(wts);

    // Auto-select the worktree the user was last on in this project, if it
    // still exists.
    const lastPath = useUIStore.getState().lastWorktreeByProject[project.path];
    const lastWorktree = lastPath ? wts.find((wt) => wt.path === lastPath) : undefined;
    if (lastWorktree) {
      useUIStore.getState().setGeneralTerminalActive(false);
      // Part of the project *switch*, not a direct worktree pick — a
      // project-scoped route (/automations) stays put and re-scopes.
      await selectWorktree(lastWorktree, { stayOnRoute: true });
    }
  } catch (e) {
    toast.error("Failed to load worktrees");
  }
}
