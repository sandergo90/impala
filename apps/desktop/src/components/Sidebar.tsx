import { useEffect, useState } from "react";
import { useShallow } from "zustand/shallow";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { useUIStore, useDataStore } from "../store";
import { viewedFilesProvider } from "../providers/viewed-files-provider";
import type { Worktree, CommitInfo, ChangedFile, Project } from "../types";
import { NewWorktreeDialog } from "./NewWorktreeDialog";

function projectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 60%, 50%)`;
}

function ProjectBadge({ name }: { name: string }) {
  return (
    <div
      className="w-5 h-5 rounded-[5px] flex items-center justify-center text-white text-[10px] font-bold shrink-0"
      style={{ background: projectColor(name) }}
    >
      {name[0]?.toUpperCase()}
    </div>
  );
}

function BranchIcon({ active }: { active: boolean }) {
  const color = active ? "#3b82f6" : "#555";
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0">
      <circle cx="4" cy="4" r="2" stroke={color} strokeWidth="1.4" fill="none"/>
      <circle cx="4" cy="12" r="2" stroke={color} strokeWidth="1.4" fill="none"/>
      <line x1="4" y1="6" x2="4" y2="10" stroke={color} strokeWidth="1.4"/>
      <path d="M4 8 L10 4" stroke={color} strokeWidth="1.4"/>
      <circle cx="12" cy="4" r="2" stroke={color} strokeWidth="1.4" fill="none"/>
    </svg>
  );
}

export function Sidebar() {
  const projects = useDataStore((s) => s.projects);
  const addProject = useDataStore((s) => s.addProject);
  const selectedProject = useUIStore((s) => s.selectedProject);
  const worktrees = useDataStore((s) => s.worktrees);
  const setWorktrees = useDataStore((s) => s.setWorktrees);
  const selectedWorktree = useUIStore((s) => s.selectedWorktree);

  const commitCounts = useDataStore(
    useShallow((s) => {
      const counts: Record<string, number> = {};
      for (const [path, state] of Object.entries(s.worktreeDataStates)) {
        counts[path] = state.commits?.length ?? 0;
      }
      return counts;
    })
  );
  const [showNewWorktree, setShowNewWorktree] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);

  const persistProjects = async (projectList: Project[]) => {
    try {
      await invoke("save_projects", {
        projects: projectList.map((p) => p.path),
      });
    } catch (e) {
      toast.error("Failed to save projects");
    }
  };

  const selectWorktree = async (wt: Worktree) => {
    useUIStore.getState().setSelectedWorktree(wt);
    try {
      const dataState = useDataStore.getState().getWorktreeDataState(wt.path);
      if (!dataState.ptySessionId) {
        await invoke("pty_spawn", { sessionId: wt.path, cwd: wt.path });
        useDataStore.getState().updateWorktreeDataState(wt.path, { ptySessionId: wt.path });
      }
      await invoke("watch_worktree", { worktreePath: wt.path });
      const base = await invoke<string>("detect_base_branch", { worktreePath: wt.path });
      useDataStore.getState().updateWorktreeDataState(wt.path, { baseBranch: base });
      const commits = await invoke<CommitInfo[]>("get_diverged_commits", { worktreePath: wt.path, baseBranch: base });
      useDataStore.getState().updateWorktreeDataState(wt.path, { commits });

      // Auto-load uncommitted changes in split view if no persisted nav state
      const navState = useUIStore.getState().getWorktreeNavState(wt.path);
      if (!navState.selectedCommit && navState.viewMode === 'commit') {
        useUIStore.getState().updateWorktreeNavState(wt.path, { viewMode: 'uncommitted', selectedCommit: null, selectedFile: null, showSplit: true });
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
          // Non-critical — user can manually select
        }
      }
    } catch (e) {
      toast.error("Failed to load commits");
    }
  };

  // Load persisted projects on mount and restore selections
  useEffect(() => {
    (async () => {
      try {
        const paths = await invoke<string[]>("load_projects");
        const loaded: Project[] = paths.map((p) => ({
          path: p,
          name: p.split("/").pop() || p,
        }));
        useDataStore.getState().setProjects(loaded);

        const persistedProject = useUIStore.getState().selectedProject;
        if (persistedProject && loaded.some((p) => p.path === persistedProject.path)) {
          try {
            const wts = await invoke<Worktree[]>("list_worktrees", { repoPath: persistedProject.path });
            useDataStore.getState().setWorktrees(wts);

            const persistedWorktree = useUIStore.getState().selectedWorktree;
            if (persistedWorktree && wts.some((wt) => wt.path === persistedWorktree.path)) {
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
    })();
  }, []);

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
        ...useDataStore.getState().projects.filter((p) => p.path !== path),
        project,
      ];
      await persistProjects(updatedProjects);
      await selectProject(project);
    } catch (e) {
      toast.error("Not a git repository or no worktrees found");
    }
  };

  const selectProject = async (project: Project) => {
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
    useDataStore.getState().removeProject(path);
    if (useUIStore.getState().selectedProject?.path === path) {
      useUIStore.getState().setSelectedProject(null);
      useUIStore.getState().setSelectedWorktree(null);
      useDataStore.getState().setWorktrees([]);
    }
    const updated = useDataStore.getState().projects;
    await persistProjects(updated);
  };

  return (
    <div className="flex flex-col h-full text-[12px] overflow-hidden relative bg-sidebar">
      {/* Project Switcher */}
      <div
        onClick={() => setShowDropdown(!showDropdown)}
        className="mx-2.5 mt-2.5 mb-1.5 px-2.5 py-1.5 rounded-md flex items-center gap-2 cursor-pointer hover:bg-[#282828]"
        style={{ background: "rgba(255,255,255,0.06)" }}
      >
        {selectedProject ? (
          <>
            <ProjectBadge name={selectedProject.name} />
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
                <ProjectBadge name={project.name} />
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
            const aheadCount = commitCounts[wt.path] ?? 0;

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
                <BranchIcon active={isSelected} />
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

      <div className="flex-1" />

      {/* Bottom: Open Project (shown when no project selected) */}
      {!selectedProject && (
        <button
          onClick={openProject}
          className="flex items-center gap-1.5 px-3.5 py-2 text-[10px] text-[#444] hover:text-[#888] transition-colors"
          style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2 8h12M8 2v12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          Open Project
        </button>
      )}

      {/* Settings gear — always at bottom */}
      <button
        onClick={() => useUIStore.getState().setCurrentView("settings")}
        className="flex items-center gap-1.5 px-3.5 py-2.5 text-[#444] hover:text-[#888] transition-colors"
        style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <span className="text-[10px]">Settings</span>
      </button>

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
