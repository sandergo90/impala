import { Menu } from "@base-ui/react/menu";
import { useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { useUIStore } from "../store";
import { useProjectActions } from "../hooks/useProjectActions";
import { actionLabel, resolveActionToRun } from "../lib/actions";
import { toggleRunScript, triggerRunScript } from "../lib/run-script";
import { useHotkeyTooltip } from "./HotkeyDisplay";

interface RunActionsButtonProps {
  projectPath: string | null;
  worktreePath: string | null;
}

export function RunActionsButton({
  projectPath,
  worktreePath,
}: RunActionsButtonProps) {
  const router = useRouter();
  const actions = useProjectActions(projectPath);
  const lastUsedId = useUIStore((s) =>
    worktreePath
      ? s.worktreeNavStates[worktreePath]?.lastUsedActionId ?? null
      : null,
  );
  const runStatus = useUIStore((s) =>
    worktreePath
      ? s.worktreeNavStates[worktreePath]?.runStatus ?? "idle"
      : "idle",
  );

  const isRunning = runStatus === "running";
  const isStopping = runStatus === "stopping";
  const isActive = isRunning || isStopping;
  const { action: resolved } = resolveActionToRun(actions, lastUsedId);
  const buttonLabel = resolved ? actionLabel(resolved) : "Run";
  const noActions = actions.length === 0;

  let tooltipText: string;
  if (isRunning) tooltipText = "Stop script";
  else if (noActions) tooltipText = "No actions configured";
  else tooltipText = `Run ${buttonLabel}`;
  const playTooltip = useHotkeyTooltip("RUN_SCRIPT", tooltipText);

  const playDisabled = !resolved && !isActive;
  const showDropdown = actions.length !== 1;
  const variantClasses = isActive
    ? "text-red-400 bg-red-500/15 hover:bg-red-500/25"
    : "text-green-400 bg-green-500/15 hover:bg-green-500/25";

  const handleEditActions = () => {
    if (!projectPath) return;
    router.navigate({
      to: "/settings/project/$projectId",
      params: { projectId: encodeURIComponent(projectPath) },
    });
  };

  return (
    <div className="flex h-9 items-stretch overflow-hidden rounded-md ring-1 ring-inset ring-black/20">
      <button
        onClick={() => toggleRunScript()}
        disabled={isStopping || playDisabled}
        title={playTooltip}
        className={`flex items-center gap-2 px-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${variantClasses}`}
      >
        {isActive ? (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <rect x="2" y="2" width="12" height="12" rx="1" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4 2l10 6-10 6V2z" />
          </svg>
        )}
        <span className="max-w-[120px] truncate">{buttonLabel}</span>
      </button>

      {showDropdown && (
        <Menu.Root>
          <Menu.Trigger
            aria-label="Pick an action"
            className={`flex w-7 items-center justify-center border-l border-black/20 transition-colors ${variantClasses}`}
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor">
              <path d="M2 4l4 4 4-4z" />
            </svg>
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner sideOffset={6} align="start" className="z-50">
              <Menu.Popup
                className={[
                  "bg-popover text-popover-foreground border border-border/80 rounded-lg shadow-xl shadow-black/30",
                  "py-1 min-w-[200px] text-md outline-none",
                  "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
                  "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
                ].join(" ")}
              >
                {actions.length === 0 ? (
                  <Menu.Item
                    onClick={handleEditActions}
                    className="mx-1 px-2.5 py-1.5 rounded-md cursor-pointer select-none outline-none text-muted-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                  >
                    No actions — Edit actions…
                  </Menu.Item>
                ) : (
                  <>
                    <div className="px-3 pt-1 pb-1 text-[10px] uppercase tracking-[1.2px] text-muted-foreground/60 font-semibold">
                      Actions
                    </div>
                    {actions.map((action) => {
                      const isResolved = action.id === resolved?.id;
                      return (
                        <Menu.Item
                          key={action.id}
                          disabled={isActive}
                          onClick={() => {
                            if (isActive) return;
                            if (!action.script.trim()) {
                              toast("Action has no script");
                              return;
                            }
                            triggerRunScript(action.id);
                          }}
                          className={[
                            "mx-1 px-2.5 py-1.5 rounded-md cursor-pointer select-none outline-none flex items-center gap-2",
                            "text-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground",
                            "data-disabled:opacity-40 data-disabled:cursor-not-allowed",
                          ].join(" ")}
                        >
                          <svg
                            width="9"
                            height="9"
                            viewBox="0 0 16 16"
                            fill="currentColor"
                            className="text-green-400/80 shrink-0"
                          >
                            <path d="M4 2l10 6-10 6V2z" />
                          </svg>
                          <span className="flex-1 truncate">{actionLabel(action)}</span>
                          {isResolved && (
                            <svg
                              width="11"
                              height="11"
                              viewBox="0 0 16 16"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="text-foreground/70 shrink-0"
                            >
                              <path d="M3 8l3.5 3.5L13 5" />
                            </svg>
                          )}
                        </Menu.Item>
                      );
                    })}
                    <div className="my-1 mx-1 h-px bg-border/70" />
                    <Menu.Item
                      onClick={handleEditActions}
                      className="mx-1 px-2.5 py-1.5 rounded-md cursor-pointer select-none outline-none flex items-center gap-2 text-muted-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                    >
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0"
                      >
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                      </svg>
                      <span>Edit actions…</span>
                    </Menu.Item>
                  </>
                )}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      )}
    </div>
  );
}
