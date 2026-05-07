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
  const { action: resolved } = resolveActionToRun(actions, lastUsedId);
  const buttonLabel = resolved ? actionLabel(resolved) : "Run";
  const noActions = actions.length === 0;
  const playTooltip = useHotkeyTooltip(
    "RUN_SCRIPT",
    isRunning
      ? "Stop script"
      : noActions
        ? "No actions configured"
        : `Run ${buttonLabel}`,
  );

  const playDisabled = !resolved && !isRunning && !isStopping;

  const handleEditActions = () => {
    if (!projectPath) return;
    router.navigate({
      to: "/settings/project/$projectId",
      params: { projectId: encodeURIComponent(projectPath) },
    });
  };

  return (
    <div className="flex items-stretch rounded overflow-hidden">
      <button
        onClick={() => toggleRunScript()}
        disabled={isStopping || playDisabled}
        title={playTooltip}
        className={`flex items-center gap-1.5 px-2 py-1.5 text-md font-medium disabled:opacity-30 disabled:cursor-not-allowed ${
          isRunning || isStopping
            ? "text-red-400 bg-red-500/15 hover:bg-red-500/25"
            : "text-green-400 bg-green-500/15 hover:bg-green-500/25"
        }`}
      >
        {isRunning || isStopping ? (
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
            <rect x="2" y="2" width="12" height="12" rx="1" />
          </svg>
        ) : (
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4 2l10 6-10 6V2z" />
          </svg>
        )}
        <span className="max-w-[120px] truncate">{buttonLabel}</span>
      </button>

      <Menu.Root>
        <Menu.Trigger
          aria-label="Pick an action"
          className={`px-1.5 border-l border-background/30 disabled:opacity-30 disabled:cursor-not-allowed ${
            isRunning || isStopping
              ? "text-red-400 bg-red-500/15 hover:bg-red-500/25"
              : "text-green-400 bg-green-500/15 hover:bg-green-500/25"
          }`}
        >
          <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor">
            <path d="M2 4l4 4 4-4z" />
          </svg>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={4} align="start">
            <Menu.Popup
              className={[
                "bg-popover text-popover-foreground border border-border rounded-md shadow-md",
                "py-1 min-w-[180px] text-sm outline-none",
                "data-open:animate-in data-open:fade-in-0",
                "data-closed:animate-out data-closed:fade-out-0",
              ].join(" ")}
            >
              {actions.length === 0 ? (
                <Menu.Item
                  onClick={handleEditActions}
                  className="px-3 py-1.5 cursor-pointer select-none outline-none text-muted-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                >
                  No actions — Edit actions…
                </Menu.Item>
              ) : (
                <>
                  {actions.map((action) => {
                    const isLastUsed = action.id === lastUsedId;
                    const itemDisabled = isRunning || isStopping;
                    return (
                      <Menu.Item
                        key={action.id}
                        disabled={itemDisabled}
                        onClick={() => {
                          if (itemDisabled) return;
                          if (!action.script.trim()) {
                            toast("Action has no script");
                            return;
                          }
                          triggerRunScript(action.id);
                        }}
                        className={[
                          "px-3 py-1.5 cursor-pointer select-none outline-none flex items-center gap-2",
                          "text-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground",
                          "data-disabled:opacity-40 data-disabled:cursor-not-allowed",
                        ].join(" ")}
                      >
                        <span className="w-3 inline-flex items-center justify-center text-foreground/80">
                          {isLastUsed ? "✓" : ""}
                        </span>
                        <span className="truncate">{actionLabel(action)}</span>
                      </Menu.Item>
                    );
                  })}
                  <div className="my-1 h-px bg-border" />
                  <Menu.Item
                    onClick={handleEditActions}
                    className="px-3 py-1.5 cursor-pointer select-none outline-none text-muted-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                  >
                    Edit actions…
                  </Menu.Item>
                </>
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}
