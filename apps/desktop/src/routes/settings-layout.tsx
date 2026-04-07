import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useDataStore } from "../store";

const navItems = [
  { to: "/settings/appearance" as const, label: "Appearance" },
  { to: "/settings/integrations" as const, label: "Integrations" },
];

export function SettingsLayout() {
  const navigate = useNavigate();
  const projects = useDataStore((s) => s.projects);

  return (
    <>
      {/* Title bar */}
      <div
        className="relative flex items-center h-10 shrink-0 border-b border-border/50 bg-background"
        style={{ paddingLeft: "78px" }}
      >
        <div className="absolute inset-0" data-tauri-drag-region />
        <div
          className="flex-1 flex items-center justify-center text-[11px] text-muted-foreground font-medium"
          data-tauri-drag-region
        >
          Settings
        </div>
      </div>

      <div className="flex h-full min-h-0">
        <div className="w-[200px] border-r border-border/50 py-4 flex flex-col shrink-0">
          <button
            onClick={() => navigate({ to: "/" })}
            className="flex items-center gap-2 px-4 pb-4 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M10 2L4 8l6 6"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Back
          </button>

          <div className="px-4 pb-1.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            General
          </div>

          {navItems.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="px-4 py-1.5 text-xs text-left w-full rounded-md mx-0 text-muted-foreground hover:text-foreground"
              activeProps={{
                className:
                  "px-4 py-1.5 text-xs text-left w-full rounded-md mx-0 text-foreground font-medium bg-primary/15",
              }}
            >
              {item.label}
            </Link>
          ))}

          <div className="px-4 pb-1.5 pt-4 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Projects
          </div>

          {projects.length === 0 ? (
            <div className="px-4 py-1.5 text-xs text-muted-foreground/60">
              No projects added
            </div>
          ) : (
            projects.map((project) => (
              <Link
                key={project.path}
                to="/settings/project/$projectId"
                params={{ projectId: encodeURIComponent(project.path) }}
                className="px-4 py-1.5 text-xs text-left w-full rounded-md mx-0 text-muted-foreground hover:text-foreground"
                activeProps={{
                  className:
                    "px-4 py-1.5 text-xs text-left w-full rounded-md mx-0 text-foreground font-medium bg-primary/15",
                }}
              >
                {project.name}
              </Link>
            ))
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-8">
          <Outlet />
        </div>
      </div>
    </>
  );
}
