import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { useAppStore } from "../store";
import type { Worktree, CommitInfo, Project } from "../types";
import { NewWorktreeDialog } from "./NewWorktreeDialog";

export function Sidebar() {
  const {
    projects,
    setProjects,
    addProject,
    removeProject,
    selectedProject,
    setSelectedProject,
    worktrees,
    setWorktrees,
    selectedWorktree,
    setSelectedWorktree,
    updateWorktreeState,
  } = useAppStore();

  const [showNewWorktree, setShowNewWorktree] = useState(false);

  // Load persisted projects on mount
  useEffect(() => {
    (async () => {
      try {
        const paths = await invoke<string[]>("load_projects");
        const loaded: Project[] = paths.map((p) => ({
          path: p,
          name: p.split("/").pop() || p,
        }));
        setProjects(loaded);
      } catch (e) {
        toast.error("Failed to load projects");
      }
    })();
  }, [setProjects]);

  const persistProjects = async (projectList: Project[]) => {
    try {
      await invoke("save_projects", {
        projects: projectList.map((p) => p.path),
      });
    } catch (e) {
      toast.error("Failed to save projects");
    }
  };

  const openProject = async () => {
    const selected = await open({ directory: true });
    if (!selected) return;
    const path = selected as string;
    try {
      // Verify it's a valid git repo by listing worktrees
      await invoke<Worktree[]>("list_worktrees", { repoPath: path });
      const project: Project = {
        path,
        name: path.split("/").pop() || path,
      };
      addProject(project);
      const updatedProjects = [
        ...useAppStore.getState().projects.filter((p) => p.path !== path),
        project,
      ];
      await persistProjects(updatedProjects);
      await selectProject(project);
    } catch (e) {
      toast.error("Not a git repository or no worktrees found");
    }
  };

  const selectProject = async (project: Project) => {
    setSelectedProject(project);
    try {
      const wts = await invoke<Worktree[]>("list_worktrees", {
        repoPath: project.path,
      });
      setWorktrees(wts);
    } catch (e) {
      toast.error("Failed to load worktrees");
    }
  };

  const handleRemoveProject = async (
    e: React.MouseEvent,
    path: string,
  ) => {
    e.stopPropagation();
    removeProject(path);
    const updated = useAppStore
      .getState()
      .projects;
    await persistProjects(updated);
  };

  const selectWorktree = async (wt: Worktree) => {
    setSelectedWorktree(wt);
    try {
      // Auto-spawn PTY and start file watcher
      const wtState = useAppStore.getState().getWorktreeState(wt.path);
      if (!wtState.ptySessionId) {
        await invoke("pty_spawn", { sessionId: wt.path, cwd: wt.path });
        updateWorktreeState(wt.path, { ptySessionId: wt.path });
      }
      await invoke("watch_worktree", { worktreePath: wt.path });

      const base = await invoke<string>("detect_base_branch", {
        worktreePath: wt.path,
      });
      updateWorktreeState(wt.path, { baseBranch: base });
      const commits = await invoke<CommitInfo[]>("get_diverged_commits", {
        worktreePath: wt.path,
        baseBranch: base,
      });
      updateWorktreeState(wt.path, { commits });
    } catch (e) {
      toast.error("Failed to load commits");
    }
  };

  return (
    <div className="flex flex-col h-full text-[12px] overflow-hidden">
      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        Projects
      </div>
      {projects.map((project) => (
        <button
          key={project.path}
          onClick={() => selectProject(project)}
          className={`group px-3 py-1 text-left flex items-center justify-between hover:bg-foreground/5 ${
            selectedProject?.path === project.path
              ? "bg-foreground/5 text-foreground font-medium"
              : "text-muted-foreground"
          }`}
        >
          <span className="truncate">{project.name}</span>
          <span
            onClick={(e) => handleRemoveProject(e, project.path)}
            className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary ml-1 px-1"
          >
            ×
          </span>
        </button>
      ))}
      {worktrees.length > 0 && (
        <>
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground mt-2">
            Worktrees
          </div>
          {worktrees.map((wt) => (
            <button
              key={wt.path}
              onClick={() => selectWorktree(wt)}
              className={`px-3 py-1 pl-4 text-left hover:bg-foreground/5 ${
                selectedWorktree?.path === wt.path
                  ? "bg-foreground/5 text-foreground font-medium"
                  : "text-muted-foreground"
              }`}
            >
              {wt.branch}
            </button>
          ))}
        </>
      )}
      {selectedProject && (
        <button
          onClick={() => setShowNewWorktree(true)}
          className="px-3 py-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          + New Worktree
        </button>
      )}
      <button
        onClick={openProject}
        className="mt-auto px-3 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
      >
        + Open Project
      </button>
      {showNewWorktree && selectedProject && (
        <NewWorktreeDialog
          repoPath={selectedProject.path}
          onCreated={async (worktree) => {
            setShowNewWorktree(false);
            try {
              const wts = await invoke<Worktree[]>("list_worktrees", {
                repoPath: selectedProject.path,
              });
              setWorktrees(wts);
              selectWorktree(worktree);
            } catch (e) {
              toast.error("Failed to refresh worktrees");
            }
          }}
          onCancel={() => setShowNewWorktree(false)}
        />
      )}
    </div>
  );
}
