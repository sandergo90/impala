import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { useAppStore } from "../store";
import { viewedFilesProvider } from "../providers/viewed-files-provider";
import type { Worktree, CommitInfo, Project } from "../types";
import { NewWorktreeDialog } from "./NewWorktreeDialog";

function projectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 60%, 50%)`;
}

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
  const [showDropdown, setShowDropdown] = useState(false);

  const branchIcon = (active: boolean) => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0">
      <circle cx="4" cy="4" r="2" stroke={active ? "#3b82f6" : "#555"} strokeWidth="1.4" fill="none"/>
      <circle cx="4" cy="12" r="2" stroke={active ? "#3b82f6" : "#555"} strokeWidth="1.4" fill="none"/>
      <line x1="4" y1="6" x2="4" y2="10" stroke={active ? "#3b82f6" : "#555"} strokeWidth="1.4"/>
      <path d="M4 8 L10 4" stroke={active ? "#3b82f6" : "#555"} strokeWidth="1.4"/>
      <circle cx="12" cy="4" r="2" stroke={active ? "#3b82f6" : "#555"} strokeWidth="1.4" fill="none"/>
    </svg>
  );

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
    // Clean up viewed files for all worktrees in this project
    try {
      const wts = await invoke<Worktree[]>("list_worktrees", { repoPath: path });
      await Promise.all(wts.map((wt) => viewedFilesProvider.clearForWorktree(wt.path)));
    } catch {
      // Best-effort cleanup
    }
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
    <div className="flex flex-col h-full text-[12px] overflow-hidden relative">
      {/* Project Switcher */}
      <div
        onClick={() => setShowDropdown(!showDropdown)}
        className="mx-2.5 mt-2.5 mb-1.5 px-2.5 py-1.5 rounded-md flex items-center gap-2 cursor-pointer hover:bg-[#282828]"
        style={{ background: "#222" }}
      >
        {selectedProject ? (
          <>
            <div
              className="w-5 h-5 rounded-[5px] flex items-center justify-center text-white text-[10px] font-bold shrink-0"
              style={{ background: projectColor(selectedProject.name) }}
            >
              {selectedProject.name[0]?.toUpperCase()}
            </div>
            <span className="text-[#e5e5e5] text-[12px] font-medium truncate">{selectedProject.name}</span>
          </>
        ) : (
          <span className="text-[#888] text-[12px]">Select project</span>
        )}
        <span className="ml-auto text-[#555] text-[9px]">&#9662;</span>
      </div>

      {/* Project Dropdown */}
      {showDropdown && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setShowDropdown(false)} />
          <div
            className="absolute left-2.5 right-2.5 top-[52px] z-30 rounded-md border py-1 shadow-lg"
            style={{ background: "#252525", borderColor: "rgba(255,255,255,0.1)" }}
          >
            {projects.map((project) => (
              <div
                key={project.path}
                onClick={() => { selectProject(project); setShowDropdown(false); }}
                className="group flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-white/5"
              >
                <div
                  className="w-5 h-5 rounded-[5px] flex items-center justify-center text-white text-[10px] font-bold shrink-0"
                  style={{ background: projectColor(project.name) }}
                >
                  {project.name[0]?.toUpperCase()}
                </div>
                <span className={`text-[12px] truncate ${selectedProject?.path === project.path ? "text-[#e5e5e5] font-medium" : "text-[#999]"}`}>
                  {project.name}
                </span>
                <span
                  onClick={(e) => handleRemoveProject(e, project.path)}
                  className="ml-auto opacity-0 group-hover:opacity-100 text-[#666] hover:text-[#ccc] px-1 text-[11px]"
                >
                  &times;
                </span>
              </div>
            ))}
            <div
              className="border-t mt-1 pt-1 flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-white/5 text-[#666] text-[11px]"
              style={{ borderColor: "rgba(255,255,255,0.06)" }}
              onClick={() => { openProject(); setShowDropdown(false); }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2 8h12M8 2v12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              Open Project
            </div>
          </div>
        </>
      )}

      {/* Worktrees Section */}
      {selectedProject && (
        <>
          <div className="flex items-center justify-between px-3.5 pt-2 pb-1">
            <span className="text-[9px] uppercase tracking-[1.2px] text-[#555]">Worktrees</span>
            <button
              onClick={() => setShowNewWorktree(true)}
              className="text-[#444] hover:text-[#888] text-[14px] leading-none"
            >
              +
            </button>
          </div>

          {worktrees.map((wt) => {
            const isSelected = selectedWorktree?.path === wt.path;
            const wtCommits = useAppStore.getState().getWorktreeState(wt.path).commits;
            const aheadCount = wtCommits?.length ?? 0;

            return (
              <button
                key={wt.path}
                onClick={() => selectWorktree(wt)}
                className={`flex items-center gap-2 mx-2 my-0.5 px-3 py-1.5 rounded-[5px] text-left transition-colors ${
                  isSelected
                    ? "border-l-2 border-[#3b82f6] pl-2.5"
                    : "hover:bg-white/[0.03]"
                }`}
                style={isSelected ? { background: "rgba(59,130,246,0.08)" } : undefined}
              >
                {branchIcon(isSelected)}
                <div className="min-w-0">
                  <div className={`text-[11px] truncate ${isSelected ? "text-[#e5e5e5] font-medium" : "text-[#999]"}`}>
                    {wt.branch}
                  </div>
                  <div className={`text-[9px] mt-0.5 ${isSelected ? "text-[#6b7280]" : "text-[#555]"}`}>
                    {aheadCount > 0 ? `${aheadCount} commit${aheadCount === 1 ? "" : "s"} ahead` : "up to date"}
                  </div>
                </div>
              </button>
            );
          })}
        </>
      )}

      {/* Bottom: Open Project (shown when no project selected) */}
      {!selectedProject && (
        <button
          onClick={openProject}
          className="mt-auto flex items-center gap-1.5 px-3.5 py-2 text-[10px] text-[#444] hover:text-[#888] transition-colors"
          style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2 8h12M8 2v12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          Open Project
        </button>
      )}

      {/* New Worktree Dialog */}
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
