import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store";
import type { Worktree, CommitInfo } from "../types";

export function Sidebar() {
  const {
    repoPath, setRepoPath,
    worktrees, setWorktrees,
    selectedWorktree, setSelectedWorktree,
    setBaseBranch, setCommits,
  } = useAppStore();

  const openProject = async () => {
    const selected = await open({ directory: true });
    if (!selected) return;
    const path = selected as string;
    try {
      const wts = await invoke<Worktree[]>("list_worktrees", { repoPath: path });
      setRepoPath(path);
      setWorktrees(wts);
    } catch (e) {
      console.error("Not a git repository or no worktrees:", e);
    }
  };

  const selectWorktree = async (wt: Worktree) => {
    setSelectedWorktree(wt);
    try {
      const base = await invoke<string>("detect_base_branch", { worktreePath: wt.path });
      setBaseBranch(base);
      const commits = await invoke<CommitInfo[]>("get_diverged_commits", {
        worktreePath: wt.path,
        baseBranch: base,
      });
      setCommits(commits);
    } catch (e) {
      console.error("Failed to load commits:", e);
    }
  };

  const projectName = repoPath ? repoPath.split("/").pop() : null;

  return (
    <div className="flex flex-col h-full w-56 min-w-56 border-r text-sm">
      <div className="px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground border-b">Projects</div>
      {projectName && (
        <div className="px-3 py-1.5 font-semibold text-primary">{projectName}</div>
      )}
      {worktrees.length > 0 && (
        <>
          <div className="px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground border-b mt-2">Worktrees</div>
          {worktrees.map((wt) => (
            <button
              key={wt.path}
              onClick={() => selectWorktree(wt)}
              className={`px-3 py-1.5 pl-5 text-left hover:bg-accent/10 ${
                selectedWorktree?.path === wt.path ? "bg-accent/10 text-primary font-semibold" : "text-muted-foreground"
              }`}
            >
              {wt.branch}
            </button>
          ))}
        </>
      )}
      <button onClick={openProject} className="mt-auto px-3 py-2 border-t text-xs text-muted-foreground hover:text-primary">
        + Open Project
      </button>
    </div>
  );
}
