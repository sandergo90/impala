import { useEffect, useRef } from "react";
import { Command } from "cmdk";
import { useNavigate } from "@tanstack/react-router";
import { useUIStore, useDataStore } from "../store";
import { selectWorktree, selectProject } from "../hooks/useWorktreeActions";
import { HotkeyDisplay } from "./HotkeyDisplay";

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const projects = useDataStore((s) => s.projects);
  const worktrees = useDataStore((s) => s.worktrees);
  const selectedProject = useUIStore((s) => s.selectedProject);
  const selectedWorktree = useUIStore((s) => s.selectedWorktree);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      // Focus input on next frame
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  const handleSelectWorktree = (wt: typeof worktrees[0]) => {
    selectWorktree(wt);
    onClose();
  };

  const handleSelectProject = (project: typeof projects[0]) => {
    selectProject(project);
    onClose();
  };

  const handleAction = (action: string) => {
    switch (action) {
      case "settings":
        navigate({ to: "/settings" });
        break;
      case "keyboard-shortcuts":
        navigate({ to: "/settings/keyboard" });
        break;
      case "diff-tab":
        if (selectedWorktree) {
          useUIStore.getState().updateWorktreeNavState(selectedWorktree.path, { activeTab: "diff" });
        }
        break;
      case "terminal-tab":
        if (selectedWorktree) {
          useUIStore.getState().updateWorktreeNavState(selectedWorktree.path, { activeTab: "terminal" });
        }
        break;
      case "split-tab":
        if (selectedWorktree) {
          useUIStore.getState().updateWorktreeNavState(selectedWorktree.path, { activeTab: "split" });
        }
        break;
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="fixed inset-0 bg-black/40" />
      <div className="fixed top-[20%] left-1/2 -translate-x-1/2 z-50 w-full max-w-[640px]" onClick={(e) => e.stopPropagation()}>
        <Command
          className="rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl overflow-hidden"
          loop
        >
          <div className="flex items-center border-b border-border px-3">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted-foreground/90 mr-2">
              <circle cx="11" cy="11" r="8"/>
              <path d="m21 21-4.3-4.3"/>
            </svg>
            <Command.Input
              ref={inputRef}
              placeholder="Search worktrees, projects, actions..."
              className="flex h-10 w-full bg-transparent py-3 text-sm text-foreground placeholder:text-muted-foreground/90 outline-none"
            />
          </div>
          <Command.List className="max-h-[400px] overflow-y-auto p-1.5">
            <Command.Empty className="py-6 text-center text-md text-muted-foreground">
              No results found.
            </Command.Empty>

            {/* Worktrees */}
            {selectedProject && worktrees.length > 0 && (
              <Command.Group heading="Worktrees" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-md [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[1.2px] [&_[cmdk-group-heading]]:text-muted-foreground/60 [&_[cmdk-group-heading]]:font-semibold">
                {worktrees.map((wt) => {
                  const isActive = selectedWorktree?.path === wt.path;
                  return (
                    <Command.Item
                      key={wt.path}
                      value={`worktree ${wt.branch}`}
                      onSelect={() => handleSelectWorktree(wt)}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md text-md cursor-pointer data-[selected=true]:bg-accent"
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className={`shrink-0 ${isActive ? "text-primary" : "text-muted-foreground/90"}`}>
                        <circle cx="4" cy="4" r="2" stroke="currentColor" strokeWidth="1.4" fill="none"/>
                        <circle cx="4" cy="12" r="2" stroke="currentColor" strokeWidth="1.4" fill="none"/>
                        <line x1="4" y1="6" x2="4" y2="10" stroke="currentColor" strokeWidth="1.4"/>
                        <path d="M4 8 L10 4" stroke="currentColor" strokeWidth="1.4"/>
                        <circle cx="12" cy="4" r="2" stroke="currentColor" strokeWidth="1.4" fill="none"/>
                      </svg>
                      <span className={isActive ? "text-foreground font-medium" : "text-muted-foreground"}>
                        {wt.branch}
                      </span>
                      {isActive && (
                        <span className="ml-auto text-md text-primary">active</span>
                      )}
                    </Command.Item>
                  );
                })}
              </Command.Group>
            )}

            {/* Projects */}
            {projects.length > 1 && (
              <Command.Group heading="Projects" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-md [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[1.2px] [&_[cmdk-group-heading]]:text-muted-foreground/60 [&_[cmdk-group-heading]]:font-semibold">
                {projects.map((project) => {
                  const isActive = selectedProject?.path === project.path;
                  const initial = project.name[0]?.toUpperCase() ?? "?";
                  return (
                    <Command.Item
                      key={project.path}
                      value={`project ${project.name}`}
                      onSelect={() => handleSelectProject(project)}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md text-md cursor-pointer data-[selected=true]:bg-accent"
                    >
                      <div
                        className="w-4 h-4 rounded-[3px] flex items-center justify-center text-white text-[8px] font-bold shrink-0"
                        style={{ background: projectColor(project.name) }}
                      >
                        {initial}
                      </div>
                      <span className={isActive ? "text-foreground font-medium" : "text-muted-foreground"}>
                        {project.name}
                      </span>
                      {isActive && (
                        <span className="ml-auto text-md text-primary">active</span>
                      )}
                    </Command.Item>
                  );
                })}
              </Command.Group>
            )}

            {/* Actions */}
            <Command.Group heading="Actions" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-md [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[1.2px] [&_[cmdk-group-heading]]:text-muted-foreground/60 [&_[cmdk-group-heading]]:font-semibold">
              {selectedWorktree && (
                <>
                  <Command.Item
                    value="Switch to Diff view"
                    onSelect={() => handleAction("diff-tab")}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md text-md text-muted-foreground cursor-pointer data-[selected=true]:bg-accent"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted-foreground/90">
                      <path d="M12 3v18"/>
                      <rect width="18" height="18" x="3" y="3" rx="2"/>
                    </svg>
                    Switch to Diff
                  </Command.Item>
                  <Command.Item
                    value="Switch to Terminal view"
                    onSelect={() => handleAction("terminal-tab")}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md text-md text-muted-foreground cursor-pointer data-[selected=true]:bg-accent"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted-foreground/90">
                      <polyline points="4 17 10 11 4 5"/>
                      <line x1="12" x2="20" y1="19" y2="19"/>
                    </svg>
                    Switch to Terminal
                  </Command.Item>
                  <Command.Item
                    value="Switch to Split view"
                    onSelect={() => handleAction("split-tab")}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md text-md text-muted-foreground cursor-pointer data-[selected=true]:bg-accent"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted-foreground/90">
                      <rect width="18" height="18" x="3" y="3" rx="2"/>
                      <path d="M12 3v18"/>
                    </svg>
                    Switch to Split
                  </Command.Item>
                </>
              )}
              <Command.Item
                value="Open Settings"
                onSelect={() => handleAction("settings")}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md text-md text-muted-foreground cursor-pointer data-[selected=true]:bg-accent"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted-foreground/90">
                  <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                Settings
                <HotkeyDisplay id="OPEN_SETTINGS" className="ml-auto text-muted-foreground/90" />
              </Command.Item>
              <Command.Item
                value="Keyboard Shortcuts"
                onSelect={() => handleAction("keyboard-shortcuts")}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md text-md text-muted-foreground cursor-pointer data-[selected=true]:bg-accent"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted-foreground/90">
                  <rect x="2" y="4" width="20" height="16" rx="2" />
                  <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 16h8" />
                </svg>
                Keyboard Shortcuts
                <HotkeyDisplay id="SHOW_KEYBOARD_SHORTCUTS" className="ml-auto text-muted-foreground/90" />
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}

function projectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 60%, 50%)`;
}
