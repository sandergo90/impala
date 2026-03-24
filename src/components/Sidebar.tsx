import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { useAppStore } from "../store";
import type { Worktree, CommitInfo, Project } from "../types";

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
    setBaseBranch,
    setCommits,
  } = useAppStore();

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
      const base = await invoke<string>("detect_base_branch", {
        worktreePath: wt.path,
      });
      setBaseBranch(base);
      const commits = await invoke<CommitInfo[]>("get_diverged_commits", {
        worktreePath: wt.path,
        baseBranch: base,
      });
      setCommits(commits);
    } catch (e) {
      toast.error("Failed to load commits");
    }
  };

  return (
    <div className="flex flex-col h-full w-56 min-w-56 border-r text-sm">
      <div className="px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground border-b">
        Projects
      </div>
      {projects.map((project) => (
        <button
          key={project.path}
          onClick={() => selectProject(project)}
          className={`group px-3 py-1.5 text-left flex items-center justify-between hover:bg-accent/10 ${
            selectedProject?.path === project.path
              ? "bg-accent/10 text-primary font-semibold"
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
          <div className="px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground border-b mt-2">
            Worktrees
          </div>
          {worktrees.map((wt) => (
            <button
              key={wt.path}
              onClick={() => selectWorktree(wt)}
              className={`px-3 py-1.5 pl-5 text-left hover:bg-accent/10 ${
                selectedWorktree?.path === wt.path
                  ? "bg-accent/10 text-primary font-semibold"
                  : "text-muted-foreground"
              }`}
            >
              {wt.branch}
            </button>
          ))}
        </>
      )}
      <button
        onClick={openProject}
        className="mt-auto px-3 py-2 border-t text-xs text-muted-foreground hover:text-primary"
      >
        + Open Project
      </button>
    </div>
  );
}
