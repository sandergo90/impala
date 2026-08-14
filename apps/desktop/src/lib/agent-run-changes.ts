import { invoke } from "@/lib/invoke";
import { useDataStore, useUIStore } from "../store";
import type { AgentRunChanges, Worktree } from "../types";
import { selectProject, selectWorktree } from "../hooks/useWorktreeActions";
import { splitDiffByFile } from "./diff-files";

export async function openAgentRunChanges(
  worktreePath: string,
  paneId: string,
  label: string,
): Promise<void> {
  if (useUIStore.getState().selectedWorktree?.path !== worktreePath) {
    const data = useDataStore.getState();
    let worktree = data.worktrees.find(
      (candidate) => candidate.path === worktreePath,
    );
    if (!worktree) {
      const worktrees = await invoke<Worktree[]>("list_worktrees", {
        repoPath: worktreePath,
      });
      worktree = worktrees.find((candidate) => candidate.path === worktreePath);
      const primary = worktrees.find((candidate) => candidate.is_primary);
      const project = data.projects.find(
        (candidate) => candidate.path === primary?.path,
      );
      if (!project) throw new Error("The agent project is no longer available");
      await selectProject(project);
    }
    if (!worktree) throw new Error("The agent worktree is no longer available");
    await selectWorktree(worktree);
  }

  const changes = await invoke<AgentRunChanges | null>("get_agent_run_changes", {
    worktreePath,
    paneId,
  });
  if (!changes) throw new Error("Changes for this agent run are unavailable");
  const files = changes.changed_files;
  const generatedFiles = await invoke<string[]>("check_generated_files", {
    worktreePath,
    files: files.map((file) => file.path),
  });

  useUIStore.getState().updateWorktreeNavState(worktreePath, {
    activeTab: "diff",
    viewMode: "agent-run",
    selectedCommit: null,
    selectedFile: null,
    selectedAgentRun: { paneId, label },
  });
  useDataStore.getState().updateWorktreeDataState(worktreePath, {
    changedFiles: files,
    diffText: null,
    fileDiffs: splitDiffByFile(changes.diff),
    generatedFiles,
  });
}
