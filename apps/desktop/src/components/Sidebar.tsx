import { useEffect, useState } from "react";
import { useShallow } from "zustand/shallow";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";
import { useUIStore, useDataStore } from "../store";
import { viewedFilesProvider } from "../providers/viewed-files-provider";
import { selectWorktree as sharedSelectWorktree, selectProject as sharedSelectProject } from "../hooks/useWorktreeActions";
import type { Worktree, Project, WorktreeIssue } from "../types";
import { useAgentNotifications } from "../hooks/useAgentNotifications";
import { useAppHotkey } from "../hooks/useAppHotkey";
import { HotkeyDisplay } from "./HotkeyDisplay";
import { NewWorktreeDialog } from "./NewWorktreeDialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

function projectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 60%, 50%)`;
}

function ProjectBadge({ name, iconUrl }: { name: string; iconUrl?: string }) {
  const [iconError, setIconError] = useState(false);

  if (iconUrl && !iconError) {
    return (
      <div className="w-5 h-5 rounded-[5px] overflow-hidden shrink-0">
        <img
          src={iconUrl}
          alt={`${name} icon`}
          className="w-full h-full object-cover"
          onError={() => setIconError(true)}
        />
      </div>
    );
  }

  return (
    <div
      className="w-5 h-5 rounded-[5px] flex items-center justify-center text-white text-xs font-bold shrink-0"
      style={{ background: projectColor(name) }}
    >
      {name[0]?.toUpperCase()}
    </div>
  );
}

function BranchIcon({ active }: { active: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className={`shrink-0 ${active ? "text-primary" : "text-muted-foreground/50"}`}>
      <circle cx="4" cy="4" r="2" stroke="currentColor" strokeWidth="1.4" fill="none"/>
      <circle cx="4" cy="12" r="2" stroke="currentColor" strokeWidth="1.4" fill="none"/>
      <line x1="4" y1="6" x2="4" y2="10" stroke="currentColor" strokeWidth="1.4"/>
      <path d="M4 8 L10 4" stroke="currentColor" strokeWidth="1.4"/>
      <circle cx="12" cy="4" r="2" stroke="currentColor" strokeWidth="1.4" fill="none"/>
    </svg>
  );
}

export function CollapsedSidebar({ onExpand }: { onExpand: () => void }) {
  const navigate = useNavigate();
  const selectedProject = useUIStore((s) => s.selectedProject);
  const projectIcons = useDataStore((s) => s.projectIcons);
  const worktrees = useDataStore((s) => s.worktrees);
  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const agentStatuses = useDataStore(
    useShallow((s) => {
      const statuses: Record<string, string> = {};
      for (const [path, state] of Object.entries(s.worktreeDataStates)) {
        statuses[path] = state.agentStatus ?? "idle";
      }
      return statuses;
    })
  );

  const iconUrl = selectedProject ? projectIcons[selectedProject.path] : undefined;

  return (
    <div className="flex flex-col items-center h-full w-10 bg-sidebar border-r border-border py-2.5 gap-1">
      {/* Project badge */}
      {selectedProject ? (
        iconUrl ? (
          <button
            onClick={onExpand}
            className="w-7 h-7 rounded-[6px] overflow-hidden shrink-0 mb-2 hover:opacity-80 transition-opacity"
            title={selectedProject.name}
          >
            <img src={iconUrl} alt={`${selectedProject.name} icon`} className="w-full h-full object-cover" />
          </button>
        ) : (
        <button
          onClick={onExpand}
          className="w-7 h-7 rounded-[6px] flex items-center justify-center text-white text-xs font-bold shrink-0 mb-2 hover:opacity-80 transition-opacity"
          style={{ background: projectColor(selectedProject.name) }}
          title={selectedProject.name}
        >
          {selectedProject.name[0]?.toUpperCase()}
        </button>
        )
      ) : (
        <button
          onClick={onExpand}
          className="w-7 h-7 rounded-[6px] flex items-center justify-center bg-accent text-muted-foreground hover:text-foreground mb-2 transition-colors"
          title="Select project"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2 8h12M8 2v12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        </button>
      )}

      {/* Worktree icons */}
      {selectedProject && worktrees.map((wt) => {
        const isSelected = selectedWorktree?.path === wt.path;
        const isActive = agentStatuses[wt.path] === "working";
        return (
          <button
            key={wt.path}
            onClick={() => sharedSelectWorktree(wt)}
            className={`relative w-7 h-7 rounded-[5px] flex items-center justify-center transition-colors ${
              isSelected
                ? "bg-primary/15"
                : "hover:bg-accent"
            }`}
            title={wt.branch}
          >
            <BranchIcon active={isSelected} />
            {isActive && (
              <span className="absolute bottom-0 right-0 w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
            )}
          </button>
        );
      })}

      <div className="flex-1" />

      {/* Settings */}
      <button
        onClick={() => navigate({ to: "/settings" })}
        className="w-7 h-7 flex items-center justify-center text-muted-foreground/50 hover:text-muted-foreground transition-colors border-t border-border pt-2"
        title="Settings"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
    </div>
  );
}

export function Sidebar() {
  const navigate = useNavigate();
  const projects = useDataStore((s) => s.projects);
  const addProject = useDataStore((s) => s.addProject);
  const projectIcons = useDataStore((s) => s.projectIcons);
  const setProjectIcon = useDataStore((s) => s.setProjectIcon);
  const selectedProject = useUIStore((s) => s.selectedProject);
  const worktrees = useDataStore((s) => s.worktrees);
  const setWorktrees = useDataStore((s) => s.setWorktrees);
  const selectedWorktree = useUIStore((s) => s.selectedWorktree);

  useAgentNotifications();

  // Listen for agent-status events from the backend
  useEffect(() => {
    const unlisten = listen<{ worktree_path: string; status: string }>("agent-status", (event) => {
      const { worktree_path, status } = event.payload;
      if (status === "working" || status === "idle" || status === "permission") {
        const current = useDataStore.getState().worktreeDataStates[worktree_path];
        if (current?.agentStatus !== status) {
          useDataStore.getState().updateWorktreeDataState(worktree_path, {
            agentStatus: status,
          });
        }
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const commitCounts = useDataStore(
    useShallow((s) => {
      const counts: Record<string, number> = {};
      for (const [path, state] of Object.entries(s.worktreeDataStates)) {
        counts[path] = state.commits?.length ?? 0;
      }
      return counts;
    })
  );

  // Encode as "additions:deletions" strings so useShallow can compare primitives
  const diffStatsRaw = useDataStore(
    useShallow((s) => {
      const stats: Record<string, string> = {};
      for (const [path, state] of Object.entries(s.worktreeDataStates)) {
        let additions = 0;
        let deletions = 0;
        for (const c of state.commits ?? []) {
          additions += c.additions;
          deletions += c.deletions;
        }
        stats[path] = `${additions}:${deletions}`;
      }
      return stats;
    })
  );
  const diffStats = Object.fromEntries(
    Object.entries(diffStatsRaw).map(([path, raw]) => {
      const [a, d] = raw.split(":").map(Number);
      return [path, { additions: a, deletions: d }];
    })
  );

  const agentStatuses = useDataStore(
    useShallow((s) => {
      const statuses: Record<string, string> = {};
      for (const [path, state] of Object.entries(s.worktreeDataStates)) {
        statuses[path] = state.agentStatus ?? "idle";
      }
      return statuses;
    })
  );
  const [showNewWorktree, setShowNewWorktree] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [worktreeToDelete, setWorktreeToDelete] = useState<Worktree | null>(null);

  const deleteWorktree = (wt: Worktree) => {
    if (!selectedProject) return;

    // Optimistic update: close dialog, remove from list, clear selection immediately
    setWorktreeToDelete(null);
    setWorktrees(useDataStore.getState().worktrees.filter((w) => w.path !== wt.path));
    if (selectedWorktree?.path === wt.path) {
      useUIStore.getState().setSelectedWorktree(null);
    }

    // Run actual deletion in background
    (async () => {
      try {
        const dataState = useDataStore.getState().worktreeDataStates[wt.path];
        const ptyKills = dataState?.paneSessions
          ? Object.values(dataState.paneSessions).map((sessionId) =>
              invoke("pty_kill", { sessionId }).catch(() => {})
            )
          : [];
        await Promise.all([
          ...ptyKills,
          invoke("unwatch_worktree", { worktreePath: wt.path }).catch(() => {}),
          viewedFilesProvider.clearForWorktree(wt.path).catch(() => {}),
          invoke("unlink_worktree_issue", { worktreePath: wt.path }).catch(() => {}),
          invoke("clean_linear_context", { worktreePath: wt.path }).catch(() => {}),
        ]);

        await invoke("delete_worktree", {
          repoPath: selectedProject.path,
          worktreePath: wt.path,
          force: true,
        });
      } catch (e) {
        // Rollback: re-fetch the real worktree list
        toast.error(`Failed to remove worktree: ${e}`);
        const updated = await invoke<Worktree[]>("list_worktrees", { repoPath: selectedProject.path });
        setWorktrees(updated);
      }
    })();
  };

  // -- Worktree hotkeys --

  useAppHotkey("NEW_WORKTREE", () => {
    if (selectedProject) setShowNewWorktree(true);
  });

  useAppHotkey("DELETE_WORKTREE", () => {
    if (!selectedWorktree) return;
    const branch = selectedWorktree.branch;
    if (branch === "main" || branch === "master" || branch === "develop") return;
    setWorktreeToDelete(selectedWorktree);
  });

  const persistProjects = async (projectList: Project[]) => {
    try {
      await invoke("save_projects", {
        projects: projectList.map((p) => p.path),
      });
    } catch (e) {
      toast.error("Failed to save projects");
    }
  };

  const selectWorktree = sharedSelectWorktree;

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

        // Discover icons for all projects in parallel
        for (const project of loaded) {
          invoke<string | null>("discover_project_icon", { projectPath: project.path })
            .then((icon) => {
              if (icon) useDataStore.getState().setProjectIcon(project.path, icon);
            })
            .catch(() => {});
        }

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

  const [worktreeIssues, setWorktreeIssues] = useState<Record<string, WorktreeIssue>>({});

  useEffect(() => {
    if (!selectedProject) return;
    (async () => {
      try {
        const issues = await invoke<WorktreeIssue[]>("get_all_worktree_issues");
        const map: Record<string, WorktreeIssue> = {};
        for (const issue of issues) {
          map[issue.worktree_path] = issue;
        }
        setWorktreeIssues(map);
      } catch {
        // Best-effort — sidebar still works without issue labels
      }
    })();
  }, [selectedProject, worktrees]);

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

      // Discover favicon for the new project
      invoke<string | null>("discover_project_icon", { projectPath: project.path })
        .then((icon) => {
          if (icon) setProjectIcon(project.path, icon);
        })
        .catch(() => {});

      await selectProject(project);
    } catch (e) {
      toast.error("Not a git repository or no worktrees found");
    }
  };

  const selectProject = sharedSelectProject;

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
    <div className="flex flex-col h-full text-sm overflow-hidden relative bg-sidebar">
      {/* Project Switcher */}
      <div
        onClick={() => setShowDropdown(!showDropdown)}
        className="mx-2.5 mt-2.5 mb-1.5 px-2.5 py-1.5 rounded-md flex items-center gap-2 cursor-pointer bg-accent hover:bg-accent/80"
      >
        {selectedProject ? (
          <>
            <ProjectBadge name={selectedProject.name} iconUrl={projectIcons[selectedProject.path]} />
            <span className="text-foreground text-sm font-medium truncate">{selectedProject.name}</span>
          </>
        ) : (
          <span className="text-muted-foreground text-sm">Select project</span>
        )}
        <span className="ml-auto text-muted-foreground/50 text-xs">&#9662;</span>
      </div>

      {/* Project Dropdown */}
      {showDropdown && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setShowDropdown(false)} />
          <div
            className="absolute left-2.5 right-2.5 top-[52px] z-30 rounded-md border border-border bg-popover py-1 shadow-lg"
          >
            {projects.map((project) => (
              <div
                key={project.path}
                onClick={() => { selectProject(project); setShowDropdown(false); }}
                className="group flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-accent"
              >
                <ProjectBadge name={project.name} iconUrl={projectIcons[project.path]} />
                <span className={`text-sm truncate ${selectedProject?.path === project.path ? "text-foreground font-medium" : "text-muted-foreground"}`}>
                  {project.name}
                </span>
                <span
                  onClick={(e) => handleRemoveProject(e, project.path)}
                  className="ml-auto opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground px-1 text-xs"
                >
                  &times;
                </span>
              </div>
            ))}
            <div
              className="border-t border-border mt-1 pt-1 flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-accent text-muted-foreground text-xs"
              onClick={() => { openProject(); setShowDropdown(false); }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2 8h12M8 2v12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              Open Project
            </div>
          </div>
        </>
      )}

      {/* Search / Command Palette Trigger */}
      <button
        onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", metaKey: true, bubbles: true }))}
        className="mx-2.5 mb-1 px-2.5 py-1.5 rounded-md flex items-center gap-2 bg-accent/60 hover:bg-accent text-muted-foreground/50 hover:text-muted-foreground transition-colors"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
          <circle cx="11" cy="11" r="8"/>
          <path d="m21 21-4.3-4.3"/>
        </svg>
        <span className="text-xs">Search...</span>
        <HotkeyDisplay id="OPEN_COMMAND_PALETTE" className="ml-auto bg-background/50 rounded px-1 py-0.5" />
      </button>

      {/* Worktrees Section */}
      {selectedProject && (
        <div className="flex flex-col min-h-0 flex-1">
          <div className="mx-3 mb-1.5 border-b border-border/30" />
          <div className="flex items-center justify-between px-3.5 pt-1 pb-1 shrink-0">
            <span className="text-xs uppercase tracking-[1.2px] text-muted-foreground/60 font-semibold">Worktrees</span>
            <button
              onClick={() => setShowNewWorktree(true)}
              className="text-muted-foreground/50 hover:text-muted-foreground text-sm leading-none"
            >
              +
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
          {worktrees.map((wt) => {
            const isSelected = selectedWorktree?.path === wt.path;
            const aheadCount = commitCounts[wt.path] ?? 0;
            const stats = diffStats[wt.path];
            const isMain = wt.branch === "main" || wt.branch === "master" || wt.branch === "develop";
            const isActive = agentStatuses[wt.path] === "working";

            return (
              <div key={wt.path} className="group relative mx-2 my-0.5">
                <button
                  onClick={() => selectWorktree(wt)}
                  className={`flex items-center gap-2 w-full px-3 py-1.5 rounded-[5px] text-left transition-colors ${
                    isSelected
                      ? "bg-primary/15"
                      : "hover:bg-accent"
                  }`}
                >
                  {isActive ? (
                    <span className="w-3 h-3 flex items-center justify-center shrink-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                    </span>
                  ) : (
                    <BranchIcon active={isSelected} />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className={`text-xs truncate ${isSelected ? "text-foreground font-medium" : "text-muted-foreground"}`}>
                      {wt.branch}
                    </div>
                    <div className={`flex items-center gap-1.5 text-xs mt-0.5 ${isSelected ? "text-muted-foreground" : "text-muted-foreground/50"}`}>
                      <span className="truncate">{aheadCount > 0 ? `${aheadCount} ahead` : "up to date"}</span>
                      {stats && (stats.additions > 0 || stats.deletions > 0) && (
                        <span className="flex items-center gap-0.5 font-mono shrink-0">
                          <span className="text-green-500">+{stats.additions}</span>
                          <span className="text-red-500">-{stats.deletions}</span>
                        </span>
                      )}
                      {worktreeIssues[wt.path] && (
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            openUrl(`https://linear.app/issue/${worktreeIssues[wt.path].identifier}`);
                          }}
                          className="font-mono text-xs text-blue-400 hover:text-blue-300 cursor-pointer shrink-0"
                        >
                          {worktreeIssues[wt.path].identifier}
                        </span>
                      )}
                    </div>
                  </div>
                  {!isMain && (
                    <span
                      onClick={(e) => { e.stopPropagation(); setWorktreeToDelete(wt); }}
                      className="text-muted-foreground/0 group-hover:text-muted-foreground/50 hover:!text-destructive text-xs transition-colors px-0.5"
                    >
                      ×
                    </span>
                  )}
                </button>
              </div>
            );
          })}
          </div>
        </div>
      )}

      {/* Bottom: Open Project (shown when no project selected) */}
      {!selectedProject && (
        <button
          onClick={openProject}
          className="flex items-center gap-1.5 px-3.5 py-2 text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors border-t border-border"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2 8h12M8 2v12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          Open Project
        </button>
      )}

      {/* Settings gear — always at bottom */}
      <button
        onClick={() => navigate({ to: "/settings" })}
        className="flex items-center gap-1.5 px-3.5 py-2.5 text-muted-foreground/50 hover:text-muted-foreground transition-colors border-t border-border"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <span className="text-xs">Settings</span>
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

              // Run setup script if configured (fire-and-forget)
              invoke<{ setup?: string; run?: string }>("read_project_config", {
                projectPath: selectedProject.path,
              }).then((config) => {
                if (config.setup?.trim()) {
                  const sessionId = `floating-setup-${Date.now()}`;
                  invoke("pty_spawn", {
                    sessionId,
                    cwd: worktree.path,
                    envVars: {
                      CANOPY_PROJECT_PATH: selectedProject.path,
                      CANOPY_WORKTREE_PATH: worktree.path,
                      CANOPY_BRANCH: worktree.branch,
                    },
                  }).then(() => {
                    // Write the setup command into the interactive shell
                    const encoded = btoa(
                      Array.from(new TextEncoder().encode(config.setup + "\n"), (b) =>
                        String.fromCharCode(b)
                      ).join("")
                    );
                    invoke("pty_write", { sessionId, data: encoded }).catch(() => {});
                    useUIStore.getState().setFloatingTerminal(worktree.path, {
                      mode: "expanded",
                      sessionId,
                      label: "Setup",
                      type: "setup",
                      status: "running",
                    });
                  }).catch((e) => {
                    toast.error(`Failed to run setup script: ${e}`);
                  });
                }
              }).catch(() => {
                // Silently ignore config read failures
              });
            } catch (e) {
              toast.error("Failed to refresh worktrees");
            }
          }}
          onCancel={() => setShowNewWorktree(false)}
        />
      )}

      {/* Delete Worktree Dialog */}
      <AlertDialog open={!!worktreeToDelete} onOpenChange={(open) => { if (!open) setWorktreeToDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete worktree</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the worktree for <span className="font-medium text-foreground">{worktreeToDelete?.branch}</span> and
              delete its working directory. Any uncommitted changes will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => worktreeToDelete && deleteWorktree(worktreeToDelete)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
