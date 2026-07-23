import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  Copy,
  ExternalLink,
  Focus,
  Radio,
  Square,
} from "lucide-react";
import { toast } from "sonner";
import { invoke } from "@/lib/invoke";
import { useMountEffect } from "@/hooks/useMountEffect";
import { Button } from "@/components/ui/button";
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
import { openBrowserTabAt } from "@/lib/tab-actions";
import {
  focusServiceTerminal,
  runningServiceUrl,
  type RunningService,
} from "@/lib/running-services";
import {
  activateGeneralTerminal,
  selectWorktree,
} from "@/hooks/useWorktreeActions";
import type { Worktree } from "@/types";

const POLL_INTERVAL_MS = 5_000;

function worktreeLabel(worktree: Worktree): string {
  return worktree.title ?? worktree.branch;
}

export function RunningServicesMenu({
  projectPath,
  worktrees,
  compact = false,
}: {
  projectPath: string;
  worktrees: Worktree[];
  compact?: boolean;
}) {
  const [services, setServices] = useState<RunningService[]>([]);
  const [open, setOpen] = useState(false);
  const [stopTarget, setStopTarget] = useState<RunningService | null>(null);
  const [stopping, setStopping] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);

  const refresh = async () => {
    if (document.hidden || refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    try {
      setServices(
        await invoke<RunningService[]>("list_running_services", {
          projectPath,
        }),
      );
    } catch {
      // Service discovery is supplementary; don't toast on every poll.
    } finally {
      refreshInFlightRef.current = false;
      if (refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        void refresh();
      }
    }
  };

  useMountEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  });

  const groups = useMemo(
    () =>
      worktrees
        .map((worktree) => ({
          worktree,
          services: services.filter(
            (service) => service.worktreePath === worktree.path,
          ),
        }))
        .filter((group) => group.services.length > 0),
    [services, worktrees],
  );

  if (services.length === 0) return null;

  const openService = async (service: RunningService) => {
    const worktree = worktrees.find(
      (candidate) => candidate.path === service.worktreePath,
    );
    if (!worktree) return;
    await selectWorktree(worktree);
    openBrowserTabAt(service.worktreePath, runningServiceUrl(service), {
      matchOrigin: true,
    });
    setOpen(false);
  };

  const focusTerminal = async (service: RunningService) => {
    const target = focusServiceTerminal(service, worktrees);
    if (!target) {
      toast.info("The owning terminal is no longer open.");
      return;
    }
    if (target.kind === "general") {
      activateGeneralTerminal();
    } else {
      await selectWorktree(target.worktree);
    }
    setOpen(false);
  };

  const copyUrl = async (service: RunningService) => {
    try {
      await navigator.clipboard.writeText(runningServiceUrl(service));
      toast.success(`Copied ${runningServiceUrl(service)}`);
    } catch {
      toast.error("Could not copy the service URL.");
    }
  };

  const stopService = async () => {
    if (!stopTarget) return;
    setStopping(true);
    try {
      await invoke("terminate_running_service", {
        pid: stopTarget.pid,
        port: stopTarget.port,
        projectPath,
      });
      toast.success(`Stopped ${stopTarget.processName} on port ${stopTarget.port}`);
      setStopTarget(null);
      if (refreshInFlightRef.current) {
        refreshQueuedRef.current = true;
      } else {
        await refresh();
      }
    } catch (error) {
      toast.error(String(error));
    } finally {
      setStopping(false);
    }
  };

  return (
    <>
      <div ref={rootRef} className="relative">
        <Button
          variant="ghost"
          size={compact ? "icon" : "default"}
          className={compact ? "relative" : "w-full justify-start text-foreground/75"}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={compact ? `${services.length} running services` : undefined}
          title={compact ? `${services.length} running services` : undefined}
          onClick={() => setOpen((value) => !value)}
        >
          <Radio className="text-success" aria-hidden="true" />
          {compact ? (
            <span className="absolute right-0.5 top-0.5 min-w-3.5 rounded-full bg-success px-0.5 text-center text-[9px] leading-3.5 text-primary-foreground">
              {services.length > 9 ? "9+" : services.length}
            </span>
          ) : (
            <>
              <span>{services.length} {services.length === 1 ? "service" : "services"}</span>
              <ChevronDown className="ml-auto size-3 text-muted-foreground" aria-hidden="true" />
            </>
          )}
        </Button>

        {open && createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="Running services"
            className="fixed z-40 w-[390px] max-h-[min(560px,calc(100vh-24px))] overflow-y-auto rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-xl"
            style={{
              left: (rootRef.current?.getBoundingClientRect().right ?? 0) + 8,
              bottom: Math.max(
                12,
                window.innerHeight -
                  (rootRef.current?.getBoundingClientRect().bottom ??
                    window.innerHeight),
              ),
            }}
          >
            <div className="flex items-center justify-between px-2.5 py-2">
              <div>
                <div className="text-sm font-semibold">Running services</div>
                <div className="text-xs text-muted-foreground">
                  Listening ports in this project
                </div>
              </div>
              <span className="rounded-md bg-success/15 px-2 py-1 text-xs font-medium text-success">
                {services.length} live
              </span>
            </div>

            {groups.map(({ worktree, services: worktreeServices }) => (
              <div key={worktree.path} className="border-t border-border/70 py-1.5">
                <div className="flex items-center justify-between px-2.5 py-1.5">
                  <span className="truncate text-xs font-medium text-muted-foreground">
                    {worktreeLabel(worktree)}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {worktreeServices.length}
                  </span>
                </div>
                {worktreeServices.map((service) => (
                  <div
                    key={`${service.pid}:${service.port}`}
                    className="group flex items-center gap-2 rounded-lg px-2.5 py-2 hover:bg-accent/70"
                  >
                    <span className="size-2 shrink-0 rounded-full bg-success" />
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => void openService(service)}
                    >
                      <span className="flex items-baseline gap-2">
                        <span className="truncate text-sm font-medium">
                          {service.processName || "Service"}
                        </span>
                        <span className="font-mono text-xs text-foreground/80">
                          :{service.port}
                        </span>
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        PID {service.pid} · {service.managed ? "Impala terminal" : "External process"}
                      </span>
                    </button>
                    <div className="flex items-center">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        title="Open in Impala"
                        aria-label={`Open port ${service.port} in Impala`}
                        onClick={() => void openService(service)}
                      >
                        <ExternalLink />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        title="Focus owning terminal"
                        aria-label={`Focus terminal for port ${service.port}`}
                        disabled={!service.sessionId}
                        onClick={() => void focusTerminal(service)}
                      >
                        <Focus />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        title="Copy URL"
                        aria-label={`Copy URL for port ${service.port}`}
                        onClick={() => void copyUrl(service)}
                      >
                        <Copy />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="hover:text-danger"
                        title="Stop service"
                        aria-label={`Stop process on port ${service.port}`}
                        onClick={() => setStopTarget(service)}
                      >
                        <Square />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>,
          document.body,
        )}
      </div>

      <AlertDialog
        open={stopTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !stopping) setStopTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop this service?</AlertDialogTitle>
            <AlertDialogDescription>
              This sends SIGTERM to {stopTarget?.processName || "the process"} (PID{" "}
              {stopTarget?.pid}) listening on port {stopTarget?.port}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={stopping}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={stopping}
              onClick={(event) => {
                event.preventDefault();
                void stopService();
              }}
            >
              {stopping ? "Stopping…" : "Stop service"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
