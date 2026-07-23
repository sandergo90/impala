import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/shallow";
import { invoke } from "@/lib/invoke";
import { open } from "@tauri-apps/plugin-dialog";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { toast } from "sonner";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Clock3, Settings, SquareTerminal } from "lucide-react";
import { useAutomationBadge } from "../hooks/useAutomationBadge";
import { useUIStore, useDataStore, useFilteredWorktrees } from "../store";
import { useEditorDocsStore } from "../stores/editor-docs";
import { releaseCachedTerminal } from "./XtermTerminal";
import { viewedFilesProvider } from "../providers/viewed-files-provider";
import {
  selectWorktree as sharedSelectWorktree,
  selectProject as sharedSelectProject,
  activateGeneralTerminal,
} from "../hooks/useWorktreeActions";
import type {
  Worktree,
  Project,
  WorktreeIssue,
  PrStatus,
} from "../types";
import { usePrStatusSync } from "../hooks/usePrStatusSync";
import { PrBadge } from "./PrBadge";
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
import { ContextMenu } from "@/components/ui/context-menu";
import { RunningServicesMenu } from "./RunningServicesMenu";

import { cn, projectColor } from "../lib/utils";
import { isAutomationsProject } from "../lib/automations-project";
import { encodePtyInput } from "../lib/encode-pty";
import {
  RUN_PANE_ID,
  agentPtySessionId,
  panePtySessionId,
  runPtySessionId,
} from "../lib/pane-ids";
import { getEffectiveUserTabSplitTree } from "../lib/tab-actions";
import { getLeaves } from "../lib/split-tree";

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
      className="w-5 h-5 rounded-[5px] flex items-center justify-center text-white text-sm font-bold shrink-0"
      style={{ background: projectColor(name) }}
    >
      {name[0]?.toUpperCase()}
    </div>
  );
}

function BranchIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      className={`shrink-0 ${active ? "text-primary" : "text-muted-foreground"}`}
    >
      <circle
        cx="4"
        cy="4"
        r="2"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
      />
      <circle
        cx="4"
        cy="12"
        r="2"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
      />
      <line
        x1="4"
        y1="6"
        x2="4"
        y2="10"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path d="M4 8 L10 4" stroke="currentColor" strokeWidth="1.4" />
      <circle
        cx="12"
        cy="4"
        r="2"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
      />
    </svg>
  );
}

function SidebarNavButton({
  label,
  icon,
  active = false,
  compact = false,
  badge,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  active?: boolean;
  compact?: boolean;
  badge?: { count: number; failed: boolean };
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={compact ? label : undefined}
      title={compact ? label : undefined}
      className={cn(
        "relative flex items-center rounded-md text-sm font-medium outline-none transition-colors duration-150",
        compact ? "size-8 justify-center" : "h-9 w-full gap-2 px-2.5",
        // Anchored elements get a border, never a shadow. The ring also keeps the
        // active state visible in light themes, where `accent` and `sidebar`
        // resolve close enough that the tonal fill alone reads as nothing.
        active
          ? "bg-accent text-foreground ring-1 ring-border"
          : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
      )}
    >
      {icon}
      {!compact && <span>{label}</span>}
      {badge && badge.count > 0 &&
        (compact ? (
          <span
            className={cn(
              "absolute right-1 top-1 size-1.5 rounded-full",
              badge.failed ? "bg-danger" : "bg-primary",
            )}
            aria-label={`${badge.count} automation runs to review`}
          />
        ) : (
          <span
            className={cn(
              "ml-auto min-w-5 rounded-full px-1.5 text-center text-[11px] leading-5",
              badge.failed
                ? "bg-accent/60 text-danger"
                : "bg-primary/15 text-primary",
            )}
            title={`${badge.count} finished automation run${badge.count === 1 ? "" : "s"} to review`}
          >
            {badge.count > 9 ? "9+" : badge.count}
          </span>
        ))}
    </button>
  );
}

export function CollapsedSidebar({ onExpand }: { onExpand: () => void }) {
  const navigate = useNavigate();
  const currentPath = useRouterState({
    select: (state) => state.location.pathname,
  });
  const automationBadge = useAutomationBadge();
  const selectedProject = useUIStore((s) => s.selectedProject);
  const visibleProject = isAutomationsProject(selectedProject)
    ? null
    : selectedProject;
  const projectIcons = useDataStore((s) => s.projectIcons);
  const worktrees = useFilteredWorktrees();
  const projectWorktrees = useDataStore((s) => s.worktrees);
  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const generalTerminalActive = useUIStore((s) => s.generalTerminalActive);
  const agentStatuses = useDataStore(
    useShallow((s) => {
      const statuses: Record<string, string> = {};
      for (const [path, state] of Object.entries(s.worktreeDataStates)) {
        statuses[path] = state.agentStatus ?? "idle";
      }
      return statuses;
    }),
  );

  const unseenResults = useDataStore(
    useShallow((s) => {
      const unseen: Record<string, boolean> = {};
      for (const [path, state] of Object.entries(s.worktreeDataStates)) {
        unseen[path] = state.hasUnseenResult ?? false;
      }
      return unseen;
    }),
  );

  const runFailures = useUIStore(
    useShallow((s) => {
      const out: Record<string, boolean> = {};
      for (const [path, nav] of Object.entries(s.worktreeNavStates)) {
        if (nav.hasUnreadRunFailure) out[path] = true;
      }
      return out;
    }),
  );

  const iconUrl = visibleProject
    ? projectIcons[visibleProject.path]
    : undefined;

  return (
    <div className="flex flex-col items-center h-full w-10 bg-sidebar border-r border-border py-2.5 gap-1">
      <div className="flex flex-col items-center gap-1 border-b border-border/60 pb-2 mb-1">
        {selectedProject && (
          <SidebarNavButton
            compact
            label="Terminal"
            icon={<SquareTerminal aria-hidden="true" className="size-4" />}
            active={currentPath === "/" && generalTerminalActive}
            onClick={activateGeneralTerminal}
          />
        )}
        <SidebarNavButton
          compact
          label="Automations"
          icon={<Clock3 aria-hidden="true" className="size-4" />}
          active={currentPath === "/automations"}
          badge={{
            count: automationBadge.total,
            failed: automationBadge.failed > 0,
          }}
          onClick={() => navigate({ to: "/automations" })}
        />
      </div>

      {/* Project badge */}
      {visibleProject ? (
        iconUrl ? (
          <button
            onClick={onExpand}
            className="w-7 h-7 rounded-[6px] overflow-hidden shrink-0 mb-2 hover:opacity-80 transition-opacity"
            title={visibleProject.name}
          >
            <img
              src={iconUrl}
              alt={`${visibleProject.name} icon`}
              className="w-full h-full object-cover"
            />
          </button>
        ) : (
          <button
            onClick={onExpand}
            className="w-7 h-7 rounded-[6px] flex items-center justify-center text-white text-sm font-bold shrink-0 mb-2 hover:opacity-80 transition-opacity"
            style={{ background: projectColor(visibleProject.name) }}
            title={visibleProject.name}
          >
            {visibleProject.name[0]?.toUpperCase()}
          </button>
        )
      ) : (
        <button
          onClick={onExpand}
          className="w-7 h-7 rounded-[6px] flex items-center justify-center bg-accent text-muted-foreground hover:text-foreground mb-2 transition-colors"
          title="Select project"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path
              d="M2 8h12M8 2v12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}

      {/* Worktree icons */}
      {selectedProject &&
        worktrees.map((wt) => {
          const isSelected = selectedWorktree?.path === wt.path;
          const isActive = agentStatuses[wt.path] === "working";
          const hasUnseen = unseenResults[wt.path];
          const isPermission = agentStatuses[wt.path] === "permission";
          const hasRunFailure = runFailures[wt.path] ?? false;
          return (
            <button
              key={wt.path}
              onClick={() => sharedSelectWorktree(wt)}
              aria-pressed={isSelected}
              // The status-dot branches below replace BranchIcon, which is the
              // only non-color selection cue. The inset ring survives them, so
              // the active worktree stays marked in every state.
              className={`relative w-7 h-7 rounded-[5px] flex items-center justify-center transition-colors ${
                isSelected
                  ? "bg-primary/15 ring-1 ring-inset ring-primary"
                  : "hover:bg-accent"
              }`}
              title={wt.title ?? wt.branch}
            >
              {isActive ? (
                <span className="w-3.5 h-3.5 flex items-center justify-center">
                  <span className="w-2 h-2 rounded-full bg-warning animate-pulse" />
                </span>
              ) : hasUnseen ? (
                <span className="w-3.5 h-3.5 flex items-center justify-center">
                  <span className={`w-2 h-2 rounded-full ${isPermission ? "bg-warning" : "bg-success"}`} />
                </span>
              ) : (
                <BranchIcon active={isSelected} />
              )}
              {hasRunFailure && (
                <span className="absolute top-0 right-0 w-1.5 h-1.5 rounded-full bg-danger pointer-events-none" />
              )}
            </button>
          );
        })}

      <div className="flex-1" />

      <div className="flex flex-col items-center gap-1 border-t border-border/60 pt-2">
        {selectedProject && projectWorktrees.length > 0 && (
          <RunningServicesMenu
            key={`${selectedProject.path}:${projectWorktrees.map((worktree) => worktree.path).join("|")}`}
            projectPath={selectedProject.path}
            worktrees={projectWorktrees}
            compact
          />
        )}
        <SidebarNavButton
          compact
          label="Settings"
          icon={<Settings aria-hidden="true" className="size-4" />}
          active={currentPath.startsWith("/settings")}
          onClick={() => navigate({ to: "/settings" })}
        />
      </div>
    </div>
  );
}

export function Sidebar() {
  const navigate = useNavigate();
  const currentPath = useRouterState({
    select: (state) => state.location.pathname,
  });
  const automationBadge = useAutomationBadge();
  const projects = useDataStore((s) => s.projects);
  const addProject = useDataStore((s) => s.addProject);
  const projectIcons = useDataStore((s) => s.projectIcons);
  const setProjectIcon = useDataStore((s) => s.setProjectIcon);
  const selectedProject = useUIStore((s) => s.selectedProject);
  const visibleProject = isAutomationsProject(selectedProject)
    ? null
    : selectedProject;
  const worktrees = useFilteredWorktrees();
  const projectWorktrees = useDataStore((s) => s.worktrees);
  const setWorktrees = useDataStore((s) => s.setWorktrees);
  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const generalTerminalActive = useUIStore((s) => s.generalTerminalActive);

  usePrStatusSync(worktrees);

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
    }),
  );
  const diffStats = Object.fromEntries(
    Object.entries(diffStatsRaw).map(([path, raw]) => {
      const [a, d] = raw.split(":").map(Number);
      return [path, { additions: a, deletions: d }];
    }),
  );

  const agentStatuses = useDataStore(
    useShallow((s) => {
      const statuses: Record<string, string> = {};
      for (const [path, state] of Object.entries(s.worktreeDataStates)) {
        statuses[path] = state.agentStatus ?? "idle";
      }
      return statuses;
    }),
  );

  const unseenResults = useDataStore(
    useShallow((s) => {
      const unseen: Record<string, boolean> = {};
      for (const [path, state] of Object.entries(s.worktreeDataStates)) {
        unseen[path] = state.hasUnseenResult ?? false;
      }
      return unseen;
    }),
  );

  const prStatuses = useDataStore(
    useShallow((s) => {
      const map: Record<string, PrStatus | undefined> = {};
      for (const [path, state] of Object.entries(s.worktreeDataStates)) {
        map[path] = state.prStatus;
      }
      return map;
    }),
  );

  const [showNewWorktree, setShowNewWorktree] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [worktreeToDelete, setWorktreeToDelete] = useState<Worktree | null>(
    null,
  );
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const projectTriggerRef = useRef<HTMLButtonElement>(null);

  // The `fixed inset-0` catcher below only dismisses on pointer. Escape closes
  // the dropdown and returns focus to the trigger so the keyboard path is whole.
  useEffect(() => {
    if (!showDropdown) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setShowDropdown(false);
      projectTriggerRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showDropdown]);

  const startRename = (wt: Worktree) => {
    setEditingPath(wt.path);
    setEditingTitle(wt.title ?? wt.branch);
  };

  const commitRename = async (wt: Worktree) => {
    // Guards against the re-entrant call that blur fires when setEditingPath(null)
    // unmounts the input.
    if (editingPath !== wt.path) return;
    const next = editingTitle.trim();
    setEditingPath(null);
    if (!next || next === wt.title) return;
    setWorktrees(
      useDataStore.getState().worktrees.map((w) =>
        w.path === wt.path ? { ...w, title: next } : w,
      ),
    );
    try {
      await invoke("rename_worktree_title", {
        worktreePath: wt.path,
        title: next,
      });
    } catch (e) {
      toast.error(`Failed to rename: ${e}`);
      if (selectedProject) {
        const updated = await invoke<Worktree[]>("list_worktrees", {
          repoPath: selectedProject.path,
        });
        setWorktrees(updated);
      }
    }
  };

  const cancelRename = () => {
    setEditingPath(null);
  };

  const deleteWorktree = (wt: Worktree) => {
    if (!selectedProject) return;

    // Optimistic update: close dialog, remove from list, clear selection immediately
    setWorktreeToDelete(null);
    setWorktrees(
      useDataStore.getState().worktrees.filter((w) => w.path !== wt.path),
    );
    if (selectedWorktree?.path === wt.path) {
      useUIStore.getState().setSelectedWorktree(null);
    }

    // Drop any open editor docs/buffers for this worktree's file tabs.
    const editorDocs = useEditorDocsStore.getState();
    for (const key of Object.keys(editorDocs.docs)) {
      if (editorDocs.docs[key]?.worktreePath === wt.path) {
        editorDocs.removeDoc(key);
      }
    }

    // Run actual deletion in background
    (async () => {
      try {
        const dataState = useDataStore.getState().worktreeDataStates[wt.path];
        // paneSessions is in-memory only, but the PTY daemon (and any
        // processes running in the tabs) survives app restarts — so sessions
        // may exist without being tracked. Session ids are deterministic per
        // pane, so reconstruct and kill them all: Run, Agent, and every pane
        // of every persisted user tab.
        const sessionIds = new Set(
          Object.values(dataState?.paneSessions ?? {}),
        );
        sessionIds.add(runPtySessionId(wt.path));
        sessionIds.add(agentPtySessionId(wt.path));
        const nav = useUIStore.getState().getWorktreeNavState(wt.path);
        for (const tab of nav.userTabs) {
          for (const group of getLeaves(getEffectiveUserTabSplitTree(tab))) {
            for (const groupTab of group.tabs) {
              if (groupTab.content.kind === "terminal") {
                sessionIds.add(panePtySessionId(wt.path, groupTab.id));
              }
            }
          }
        }
        const ptyKills = [...sessionIds].map((sessionId) => {
          releaseCachedTerminal(sessionId);
          return invoke("pty_kill", { sessionId }).catch(() => {});
        });
        await Promise.all([
          ...ptyKills,
          invoke("clear_agent_worktree_status", {
            worktreePath: wt.path,
          }).catch(() => {}),
          invoke("unwatch_worktree", { worktreePath: wt.path }).catch(() => {}),
          viewedFilesProvider.clearForWorktree(wt.path).catch(() => {}),
          invoke("unlink_worktree_issue", { worktreePath: wt.path }).catch(
            () => {},
          ),
          invoke("unlink_worktree_title", { worktreePath: wt.path }).catch(
            () => {},
          ),
          invoke("delete_pr_status", { worktreePath: wt.path }).catch(() => {}),
        ]);

        if (isAutomationsProject(selectedProject)) {
          // Scratch repo of a global automation run — standalone, no
          // teardown script, removed wholesale (aborts an in-flight run).
          await invoke("delete_automation_run_dir", {
            worktreePath: wt.path,
          });
        } else {
          // Run the project's teardown script (if any) while the worktree
          // still exists. Best-effort: a failure is surfaced but never
          // blocks deletion.
          await invoke("run_teardown_script", {
            repoPath: selectedProject.path,
            worktreePath: wt.path,
          }).catch((e) => {
            toast.error(`Teardown script failed: ${e}`);
          });

          await invoke("delete_worktree", {
            repoPath: selectedProject.path,
            worktreePath: wt.path,
            force: true,
          });
        }
      } catch (e) {
        // Rollback: re-fetch the real worktree list
        toast.error(`Failed to remove worktree: ${e}`);
        const updated = isAutomationsProject(selectedProject)
          ? await invoke<Worktree[]>("list_automation_run_worktrees")
          : await invoke<Worktree[]>("list_worktrees", {
              repoPath: selectedProject.path,
            });
        setWorktrees(updated);
      }
    })();
  };

  // -- Worktree hotkeys --

  useAppHotkey("NEW_WORKTREE", () => {
    if (selectedProject && !isAutomationsProject(selectedProject))
      setShowNewWorktree(true);
  });

  useAppHotkey("DELETE_WORKTREE", () => {
    if (!selectedWorktree) return;
    const branch = selectedWorktree.branch;
    if (branch === "main" || branch === "master" || branch === "develop")
      return;
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

  const selectWorktree = (wt: Worktree) => {
    useUIStore.getState().setGeneralTerminalActive(false);
    return sharedSelectWorktree(wt);
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

        // Discover icons for all projects in parallel
        for (const project of loaded) {
          invoke<string | null>("discover_project_icon", {
            projectPath: project.path,
          })
            .then((icon) => {
              if (icon)
                useDataStore.getState().setProjectIcon(project.path, icon);
            })
            .catch(() => {});
        }

        const persistedProject = useUIStore.getState().selectedProject;
        if (isAutomationsProject(persistedProject)) {
          const wts = await invoke<Worktree[]>(
            "list_automation_run_worktrees",
          ).catch(() => [] as Worktree[]);
          useDataStore.getState().setWorktrees(wts);
          const persistedWorktree = useUIStore.getState().selectedWorktree;
          const restoredWorktree = persistedWorktree
            ? wts.find((wt) => wt.path === persistedWorktree.path)
            : undefined;
          if (restoredWorktree) {
            useUIStore.getState().setGeneralTerminalActive(false);
            await sharedSelectWorktree(restoredWorktree, {
              stayOnRoute: true,
            });
          } else {
            useUIStore.getState().setSelectedWorktree(null);
          }
        } else if (
          persistedProject &&
          loaded.some((p) => p.path === persistedProject.path)
        ) {
          try {
            const wts = await invoke<Worktree[]>("list_worktrees", {
              repoPath: persistedProject.path,
            });
            useDataStore.getState().setWorktrees(wts);

            const persistedWorktree = useUIStore.getState().selectedWorktree;
            const restoredWorktree = persistedWorktree
              ? wts.find((wt) => wt.path === persistedWorktree.path)
              : undefined;
            if (restoredWorktree) {
              useUIStore.getState().setGeneralTerminalActive(false);
              await sharedSelectWorktree(restoredWorktree, {
                stayOnRoute: true,
              });
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

  const [worktreeIssues, setWorktreeIssues] = useState<
    Record<string, WorktreeIssue>
  >({});

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
      invoke<string | null>("discover_project_icon", {
        projectPath: project.path,
      })
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

  const handleRemoveProject = async (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    // Clean up viewed files for all worktrees in this project
    try {
      const wts = await invoke<Worktree[]>("list_worktrees", {
        repoPath: path,
      });
      await Promise.all(
        wts.map((wt) => viewedFilesProvider.clearForWorktree(wt.path)),
      );
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
    <div
      data-sidebar
      className="flex flex-col h-full text-sm overflow-hidden relative bg-sidebar"
    >
      <nav
        aria-label="Workspace navigation"
        className="mx-2.5 mt-2.5 mb-2 flex flex-col gap-0.5 rounded-lg bg-accent/35 p-1"
      >
        {selectedProject && (
          <SidebarNavButton
            label="Terminal"
            icon={<SquareTerminal aria-hidden="true" className="size-4" />}
            active={currentPath === "/" && generalTerminalActive}
            onClick={activateGeneralTerminal}
          />
        )}
        <SidebarNavButton
          label="Automations"
          icon={<Clock3 aria-hidden="true" className="size-4" />}
          active={currentPath === "/automations"}
          badge={{
            count: automationBadge.total,
            failed: automationBadge.failed > 0,
          }}
          onClick={() => navigate({ to: "/automations" })}
        />
      </nav>

      <div className="relative mx-2.5 mb-1.5">
        {/* Project Switcher */}
        <button
          type="button"
          ref={projectTriggerRef}
          aria-haspopup="true"
          aria-expanded={showDropdown}
          onClick={() =>
            projects.length === 0
              ? openProject()
              : setShowDropdown(!showDropdown)
          }
          className="flex w-full items-center gap-2 rounded-md bg-accent px-2.5 py-1.5 text-left cursor-pointer hover:bg-accent/80"
        >
          {visibleProject ? (
            <>
              <ProjectBadge
                name={visibleProject.name}
                iconUrl={projectIcons[visibleProject.path]}
              />
              <span className="text-foreground text-sm font-medium truncate">
                {visibleProject.name}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground text-sm">
              Select project
            </span>
          )}
          <span className="ml-auto text-muted-foreground text-sm">
            &#9662;
          </span>
        </button>

      {/* Project Dropdown */}
      {showDropdown && (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={() => setShowDropdown(false)}
          />
          <div className="absolute left-0 right-0 top-[calc(100%+0.125rem)] z-30 rounded-md border border-border bg-popover py-1 shadow-2xl">
            {projects.map((project) => (
              <div
                key={project.path}
                className="group relative flex items-center"
              >
                <button
                  type="button"
                  onClick={() => {
                    selectProject(project);
                    setShowDropdown(false);
                  }}
                  aria-current={selectedProject?.path === project.path}
                  className="flex w-full items-center gap-2 px-2.5 py-2 text-left cursor-pointer hover:bg-accent"
                >
                  <ProjectBadge
                    name={project.name}
                    iconUrl={projectIcons[project.path]}
                  />
                  <span
                    className={`text-sm truncate ${selectedProject?.path === project.path ? "text-foreground font-medium" : "text-muted-foreground"}`}
                  >
                    {project.name}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${project.name}`}
                  onClick={(e) => handleRemoveProject(e, project.path)}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 size-6 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-sm"
                >
                  &times;
                </button>
              </div>
            ))}
            <button
              type="button"
              className="border-t border-border mt-1 pt-2 flex w-full items-center gap-2 px-2.5 py-2 text-left cursor-pointer hover:bg-accent text-muted-foreground text-sm"
              onClick={() => {
                openProject();
                setShowDropdown(false);
              }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path
                  d="M2 8h12M8 2v12"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
              Open Project
            </button>
          </div>
        </>
      )}
      </div>

      {/* Search / Command Palette Trigger */}
      <button
        onClick={() =>
          window.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "p",
              metaKey: true,
              bubbles: true,
            }),
          )
        }
        className="mx-2.5 mb-1 px-2.5 py-1.5 rounded-md flex items-center gap-2 bg-accent/60 hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
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
          id="OPEN_COMMAND_PALETTE"
          className="ml-auto bg-background/50 rounded px-1 py-0.5"
        />
      </button>

      {/* Worktrees Section */}
      {selectedProject && (
        <div className="flex flex-col min-h-0 flex-1">
          <div className="mx-3 mb-1.5 border-b border-border/30" />
          <div className="flex items-center justify-between px-3.5 pt-1 pb-1 shrink-0">
            <span className="text-sm uppercase tracking-[1.2px] text-muted-foreground font-semibold">
              Worktrees
            </span>
          </div>
          {!isAutomationsProject(selectedProject) && (
            <div className="px-2 pt-0.5 pb-2.5 shrink-0">
              <button
                onClick={() => setShowNewWorktree(true)}
                className="flex items-center justify-center gap-2 w-full px-3 py-2.5 rounded-[5px] border border-border/50 text-sm text-muted-foreground hover:text-foreground hover:border-border hover:bg-accent/50 transition-colors"
              >
                <span>+ New Worktree</span>
                <kbd className="text-xs text-muted-foreground ml-auto">
                  ⌘N
                </kbd>
              </button>
            </div>
          )}

          <div className="flex-1 overflow-y-auto">
            {worktrees.map((wt) => {
              const isSelected = selectedWorktree?.path === wt.path;
              const stats = diffStats[wt.path];
              const isPrimary = wt.is_primary;
              const isActive = agentStatuses[wt.path] === "working";
              const hasUnseen = unseenResults[wt.path];
              const prStatus = prStatuses[wt.path];
              const isPermission = agentStatuses[wt.path] === "permission";

              const cardBorder = isPrimary
                ? ""
                : isSelected
                  ? "border border-primary/30"
                  : "border border-border/50";

              const row = (
                <div className="group relative mx-2 my-1.5">
                  <button
                    onClick={() => selectWorktree(wt)}
                    aria-pressed={isSelected}
                    className={`flex items-start gap-2 w-full px-3 py-2.5 rounded-[5px] text-left transition-colors ${cardBorder} ${
                      isSelected ? "bg-primary/15" : "hover:bg-accent"
                    }`}
                  >
                    <div className="relative shrink-0 mt-0.5">
                      {isActive ? (
                        <span className="w-4 h-4 flex items-center justify-center">
                          <span className="w-2 h-2 rounded-full bg-warning animate-pulse" />
                        </span>
                      ) : hasUnseen ? (
                        <span className="w-4 h-4 flex items-center justify-center">
                          <span className={`w-2 h-2 rounded-full ${isPermission ? "bg-warning" : "bg-success"}`} />
                        </span>
                      ) : (
                        <BranchIcon active={isSelected} />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        {isPrimary ? (
                          <>
                            <span
                              className={`text-sm truncate ${isSelected ? "text-foreground font-medium" : "text-muted-foreground"}`}
                              title={wt.branch}
                            >
                              {wt.branch}
                            </span>
                            <span className="font-mono text-xs bg-accent/60 rounded px-1.5 py-0.5 text-muted-foreground shrink-0">
                              local
                            </span>
                          </>
                        ) : editingPath === wt.path ? (
                          <input
                            autoFocus
                            value={editingTitle}
                            onChange={(e) => setEditingTitle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                commitRename(wt);
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                cancelRename();
                              }
                            }}
                            onBlur={() => commitRename(wt)}
                            onClick={(e) => e.stopPropagation()}
                            className="text-sm bg-background border border-border rounded px-1 py-0.5 min-w-0 flex-1 outline-none"
                          />
                        ) : (
                          <>
                            <span
                              className={`text-sm truncate grow min-w-0 ${isSelected ? "text-foreground font-medium" : "text-muted-foreground"}`}
                              title={wt.title ?? wt.branch}
                            >
                              {wt.title ?? wt.branch}
                            </span>
                          </>
                        )}
                        <span className="relative ml-auto shrink-0">
                          {/* Stats badge — visible by default, invisible on hover (keeps layout space) */}
                          <span
                            className={`flex items-center gap-0.5 text-xs font-mono rounded px-1.5 py-0.5 ${
                              stats &&
                              (stats.additions > 0 || stats.deletions > 0)
                                ? "bg-accent/60 group-hover:invisible"
                                : "invisible"
                            }`}
                          >
                            <span className="text-success">
                              +{stats?.additions ?? 0}
                            </span>
                            <span className="text-danger">
                              -{stats?.deletions ?? 0}
                            </span>
                          </span>
                          {/* Close button — overlaid on hover */}
                          {!isPrimary && (
                            <span
                              onClick={(e) => {
                                e.stopPropagation();
                                setWorktreeToDelete(wt);
                              }}
                              className="absolute right-0 top-1/2 -translate-y-1/2 size-6 hidden group-hover:flex items-center justify-center text-muted-foreground hover:!text-destructive text-sm transition-colors"
                            >
                              ×
                            </span>
                          )}
                        </span>
                      </div>
                      {!isPrimary && editingPath !== wt.path && (
                        <div className="mt-1 flex items-center gap-1 flex-wrap">
                          {isActive && (
                            <span className="inline-flex items-center gap-1 font-mono text-xs bg-accent/60 text-warning rounded px-1.5 py-0.5">
                              ▶ running
                            </span>
                          )}
                          <span
                            className="font-mono text-xs bg-accent/60 rounded px-1.5 py-0.5 text-muted-foreground truncate max-w-[140px]"
                            title={wt.branch}
                          >
                            {wt.branch.split("/").pop() || wt.branch}
                          </span>
                          {worktreeIssues[wt.path] && (
                            <span
                              onClick={(e) => {
                                e.stopPropagation();
                                openUrl(worktreeIssues[wt.path].url);
                              }}
                              className="font-mono text-xs bg-accent/60 text-info hover:text-foreground rounded px-1.5 py-0.5 cursor-pointer"
                            >
                              {worktreeIssues[wt.path].identifier}
                            </span>
                          )}
                          {prStatus?.kind === "has_pr" && (
                            <PrBadge status={prStatus} />
                          )}
                        </div>
                      )}
                    </div>
                  </button>
                </div>
              );

              return isPrimary ? (
                <Fragment key={wt.path}>{row}</Fragment>
              ) : (
                <ContextMenu
                  key={wt.path}
                  items={[
                    { label: "Rename", onSelect: () => startRename(wt) },
                    ...(worktreeIssues[wt.path]
                      ? [
                          {
                            label: "Open issue",
                            onSelect: () =>
                              openUrl(worktreeIssues[wt.path].url),
                          },
                        ]
                      : []),
                    ...(prStatus?.kind === "has_pr"
                      ? [
                          {
                            label: "Open pull request",
                            onSelect: () => {
                              if (prStatus?.kind === "has_pr")
                                openUrl(prStatus.url);
                            },
                          },
                        ]
                      : []),
                    {
                      label: "Delete worktree",
                      onSelect: () => setWorktreeToDelete(wt),
                    },
                  ]}
                >
                  {row}
                </ContextMenu>
              );
            })}
          </div>
        </div>
      )}

      {!selectedProject && <div className="flex-1" />}

      <div className="mx-2.5 mb-2 border-t border-border/60 pt-2">
        {selectedProject && projectWorktrees.length > 0 && (
          <div className="mb-1">
            <RunningServicesMenu
              key={`${selectedProject.path}:${projectWorktrees.map((worktree) => worktree.path).join("|")}`}
              projectPath={selectedProject.path}
              worktrees={projectWorktrees}
            />
          </div>
        )}
        <SidebarNavButton
          label="Settings"
          icon={<Settings aria-hidden="true" className="size-4" />}
          active={currentPath.startsWith("/settings")}
          onClick={() => navigate({ to: "/settings" })}
        />
      </div>

      {/* New Worktree Dialog */}
      {showNewWorktree && selectedProject && (
        <NewWorktreeDialog
          repoPath={selectedProject.path}
          onCreated={async (worktree) => {
            setShowNewWorktree(false);
            setWorktrees([worktree, ...useDataStore.getState().worktrees]);
            selectWorktree(worktree);

            // Force the Terminal top-level tab + Run tab so the user sees setup running.
            useUIStore.getState().updateWorktreeNavState(worktree.path, {
              activeTab: "terminal",
              activeTerminalsTab: "run",
            });

            if (!selectedProject) return;
            invoke<{ setup?: string; run?: string }>("read_project_config", {
              projectPath: selectedProject.path,
            })
              .then(async (config) => {
                if (!config.setup?.trim()) return;

                const ptyId = runPtySessionId(worktree.path);
                try {
                  await invoke("pty_spawn", {
                    sessionId: ptyId,
                    cwd: worktree.path,
                    envVars: {
                      IMPALA_PROJECT_PATH: selectedProject.path,
                      IMPALA_WORKTREE_PATH: worktree.path,
                      IMPALA_BRANCH: worktree.branch,
                    },
                  });

                  const data = useDataStore
                    .getState()
                    .getWorktreeDataState(worktree.path);
                  useDataStore.getState().updateWorktreeDataState(worktree.path, {
                    paneSessions: { ...data.paneSessions, [RUN_PANE_ID]: ptyId },
                  });

                  const encoded = encodePtyInput(config.setup + "\n");
                  await invoke("pty_write", { sessionId: ptyId, data: encoded });

                  useUIStore.getState().updateWorktreeNavState(worktree.path, {
                    setupRanAt: Date.now(),
                  });
                } catch (e) {
                  toast.error(`Failed to run setup script: ${e}`);
                }
              })
              .catch(() => {});
          }}
          onCancel={() => setShowNewWorktree(false)}
        />
      )}

      {/* Delete Worktree Dialog */}
      <AlertDialog
        open={!!worktreeToDelete}
        onOpenChange={(open) => {
          if (!open) setWorktreeToDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete worktree</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the worktree for{" "}
              <span className="font-medium text-foreground">
                {worktreeToDelete?.branch}
              </span>{" "}
              and delete its working directory. Any uncommitted changes will be
              lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                worktreeToDelete && deleteWorktree(worktreeToDelete)
              }
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
