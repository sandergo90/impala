import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { invoke } from "@/lib/invoke";
import {
  useUIStore,
  useDataStore,
  filterWorktreesForDisplay,
} from "../store";
import {
  selectWorktree as sharedSelectWorktree,
  bootProjects,
} from "../hooks/useWorktreeActions";
import { HotkeyDisplay } from "./HotkeyDisplay";
import type { Project, Worktree } from "../types";

/**
 * Companion mode's read-only sidebar: every registered Project as a group,
 * its Worktrees beneath as name-only rows. No creation, deletion, or any
 * other management — selection only. Worktree lists refresh on window focus
 * so worktrees created by the external agent show up when the user flips
 * back to Impala.
 */
export function CompanionSidebar() {
  const navigate = useNavigate();
  const projects = useDataStore((s) => s.projects);
  const selectedProject = useUIStore((s) => s.selectedProject);
  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const filterEnabled = useUIStore((s) => s.worktreeFilterEnabled);
  const baseDirOverride = useUIStore((s) => s.worktreeBaseDirOverride);
  const defaultBaseDir = useUIStore((s) => s.worktreeDefaultBaseDir);
  const baseDir = baseDirOverride ?? defaultBaseDir;

  const [worktreesByProject, setWorktreesByProject] = useState<
    Record<string, Worktree[]>
  >({});

  useEffect(() => {
    void bootProjects();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadAll = () => {
      for (const project of useDataStore.getState().projects) {
        invoke<Worktree[]>("list_worktrees", { repoPath: project.path })
          .then((wts) => {
            if (cancelled) return;
            setWorktreesByProject((prev) => ({ ...prev, [project.path]: wts }));
            // Keep the global list fresh too — the palette and the
            // jump-to-worktree hotkeys read it for the selected project.
            if (useUIStore.getState().selectedProject?.path === project.path) {
              useDataStore.getState().setWorktrees(wts);
            }
          })
          .catch(() => {});
      }
    };
    loadAll();
    window.addEventListener("focus", loadAll);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", loadAll);
    };
  }, [projects]);

  const handleSelect = async (project: Project, wt: Worktree) => {
    const uiState = useUIStore.getState();
    uiState.setGeneralTerminalActive(false);
    const current = uiState.selectedProject;
    if (current?.path !== project.path) {
      if (current) uiState.setPreviousProject(current);
      uiState.setSelectedProject(project);
      useDataStore
        .getState()
        .setWorktrees(worktreesByProject[project.path] ?? []);
    }
    await sharedSelectWorktree(wt);
  };

  return (
    <div className="flex flex-col h-full text-sm overflow-hidden bg-sidebar">
      {/* Search / File Finder Trigger */}
      <button
        onClick={() => useUIStore.getState().setFileFinderOpen(true)}
        className="mx-2.5 mt-2.5 mb-1 px-2.5 py-1.5 rounded-md flex items-center gap-2 bg-accent/60 hover:bg-accent text-muted-foreground/90 hover:text-muted-foreground transition-colors"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <span className="text-sm">Search...</span>
        <HotkeyDisplay
          id="OPEN_FILE_FINDER"
          className="ml-auto bg-background/50 rounded px-1 py-0.5"
        />
      </button>

      <div className="px-3.5 pt-2 pb-1 shrink-0">
        <span className="text-sm uppercase tracking-[1.2px] text-muted-foreground/60 font-semibold">
          Projects
        </span>
      </div>

      <div className="flex-1 overflow-y-auto pb-2">
        {projects.length === 0 && (
          <div className="px-3.5 py-2 text-muted-foreground/60 text-sm">
            No projects yet — exit Companion Mode to add one.
          </div>
        )}
        {projects.map((project) => {
          const worktrees = filterWorktreesForDisplay(
            worktreesByProject[project.path] ?? [],
            filterEnabled,
            baseDir,
          );
          return (
            <div key={project.path} className="mt-1.5">
              <div className="flex items-center gap-2 px-3.5 py-1 min-w-0">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="shrink-0 text-muted-foreground/70"
                >
                  <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                </svg>
                <span
                  className="text-sm text-foreground/90 font-medium truncate"
                  title={project.path}
                >
                  {project.name}
                </span>
              </div>
              {worktrees.map((wt) => {
                const isSelected = selectedWorktree?.path === wt.path;
                return (
                  <button
                    key={wt.path}
                    onClick={() => handleSelect(project, wt)}
                    className={`flex items-center w-full pl-9 pr-3 py-1.5 text-left transition-colors ${
                      isSelected && selectedProject?.path === project.path
                        ? "bg-primary/15 text-foreground font-medium"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    }`}
                  >
                    <span
                      className="text-sm truncate min-w-0"
                      title={wt.title ?? wt.branch}
                    >
                      {wt.title ?? wt.branch}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* Settings gear — always at bottom */}
      <button
        onClick={() => navigate({ to: "/settings" })}
        className="flex items-center gap-1.5 px-3.5 py-2.5 text-muted-foreground/90 hover:text-muted-foreground transition-colors border-t border-border"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <span className="text-sm">Settings</span>
      </button>
    </div>
  );
}
