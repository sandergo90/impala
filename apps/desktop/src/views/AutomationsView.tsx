import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, Bot, PanelRightOpen, X } from "lucide-react";
import { toast } from "sonner";
import { invoke } from "@/lib/invoke";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { useDataStore, useUIStore } from "../store";
import { Sidebar } from "../components/Sidebar";
import { ResizablePanel } from "../components/ResizablePanel";
import {
  releaseCachedTerminal,
  XtermTerminal,
} from "../components/XtermTerminal";
import {
  AGENT_PANE_ID,
  agentPtySessionId,
  automationRunResumePtySessionId,
} from "../lib/pane-ids";
import { launchAutomationResume } from "../lib/agent-launch";
import { cleanupWorktreeForDeletion } from "../lib/worktree-cleanup";
import { createDeferredCleanupScheduler } from "../lib/deferred-cleanup";
import { AUTOMATIONS_PROJECT } from "../lib/automations-project";
import { acknowledgeAutomationRun } from "../lib/automation-run-acknowledgement";
import { selectWorktree } from "../hooks/useWorktreeActions";
import { useMountEffect } from "../hooks/useMountEffect";
import {
  AUTOMATION_TEMPLATES,
  type AutomationTemplate,
} from "../lib/automation-templates";
import type {
  Automation,
  AutomationRun,
  DiffStat,
  Project,
  Worktree,
} from "../types";

const DEFAULT_SIDEBAR_WIDTH = 280;

const WEEKDAYS = [
  { value: "MON", label: "Monday" },
  { value: "TUE", label: "Tuesday" },
  { value: "WED", label: "Wednesday" },
  { value: "THU", label: "Thursday" },
  { value: "FRI", label: "Friday" },
  { value: "SAT", label: "Saturday" },
  { value: "SUN", label: "Sunday" },
];

type Preset = "hourly" | "daily" | "weekdays" | "weekly" | "custom";

function buildCron(preset: Preset, time: string, weekday: string, custom: string): string {
  const [h, m] = time.split(":").map((s) => parseInt(s, 10) || 0);
  switch (preset) {
    case "hourly":
      return "0 * * * *";
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * MON-FRI`;
    case "weekly":
      return `${m} ${h} * * ${weekday}`;
    case "custom":
      return custom.trim();
  }
}

/** Reverse of buildCron for the presets we author; anything else is custom. */
function matchPreset(schedule: string): { preset: Preset; time: string; weekday: string } {
  const m = schedule.match(/^(\d+) (\d+) \* \* (\*|MON-FRI|MON|TUE|WED|THU|FRI|SAT|SUN)$/);
  if (schedule === "0 * * * *") return { preset: "hourly", time: "09:00", weekday: "MON" };
  if (m) {
    const time = `${m[2].padStart(2, "0")}:${m[1].padStart(2, "0")}`;
    if (m[3] === "*") return { preset: "daily", time, weekday: "MON" };
    if (m[3] === "MON-FRI") return { preset: "weekdays", time, weekday: "MON" };
    return { preset: "weekly", time, weekday: m[3] };
  }
  return { preset: "custom", time: "09:00", weekday: "MON" };
}

export function describeSchedule(schedule: string): string {
  const { preset, time, weekday } = matchPreset(schedule);
  const day = WEEKDAYS.find((d) => d.value === weekday)?.label ?? weekday;
  switch (preset) {
    case "hourly":
      return "Hourly";
    case "daily":
      return `Daily at ${time}`;
    case "weekdays":
      return `Weekdays at ${time}`;
    case "weekly":
      return `${day}s at ${time}`;
    case "custom":
      return schedule;
  }
}

function formatWhen(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const now = Date.now();
  const diff = d.getTime() - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return diff >= 0 ? "in <1 min" : "<1 min ago";
  if (abs < 3_600_000) {
    const mins = Math.round(abs / 60_000);
    return diff >= 0 ? `in ${mins} min` : `${mins} min ago`;
  }
  if (abs < 86_400_000) {
    const hours = Math.round(abs / 3_600_000);
    return diff >= 0 ? `in ${hours}h` : `${hours}h ago`;
  }
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** `+N −M · k files` for a run, or "no changes" when it wrote nothing —
 *  the difference between "worth opening" and "skip it" at a glance. */
function DiffStatBadge({ stat }: { stat: DiffStat }) {
  if (stat.files === 0) {
    return <span className="shrink-0 text-sm text-muted-foreground">no changes</span>;
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-sm tabular-nums">
      <span className="text-success">+{stat.additions}</span>
      <span className="text-danger">-{stat.deletions}</span>
      <span className="text-muted-foreground">
        {stat.files} {stat.files === 1 ? "file" : "files"}
      </span>
    </span>
  );
}

const RUN_STATUS_META: Record<AutomationRun["status"], { dot: string; label: string }> = {
  pending: { dot: "bg-warning", label: "starting" },
  launched: { dot: "bg-info", label: "running" },
  completed: { dot: "bg-success", label: "completed" },
  failed: { dot: "bg-danger", label: "failed" },
  aborted: { dot: "bg-muted-foreground/40", label: "aborted" },
  skipped: { dot: "bg-muted-foreground/40", label: "skipped" },
};

export function AutomationsView() {
  const mountedRef = useRef(false);
  useMountEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  });
  const navigate = useNavigate();
  const router = useRouter();
  const project = useUIStore((s) => s.selectedProject);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [claimedRunIds, setClaimedRunIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [automationWorktrees, setAutomationWorktrees] = useState<Worktree[]>([]);
  const [runStats, setRunStats] = useState<Record<string, DiffStat>>({});
  const [inspectedWorktree, setInspectedWorktree] =
    useState<Worktree | null>(null);
  const [worktreePaneWidth, setWorktreePaneWidth] = useState(720);
  const [isWorktreePaneResizing, setIsWorktreePaneResizing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState<{
    template: AutomationTemplate | null;
  } | null>(null);
  const [deleting, setDeleting] = useState<Automation | null>(null);

  const refresh = useCallback(() => {
    // The view is unscoped: every project's automations plus global ones.
    invoke<Automation[]>("list_automations")
      .then(setAutomations)
      .catch(() => setAutomations([]));
    invoke<AutomationRun[]>("list_automation_runs")
      .then(setRuns)
      .catch(() => setRuns([]));
    invoke<Worktree[]>("list_recent_automation_worktrees")
      .then((worktrees) => {
        setAutomationWorktrees(worktrees);
        // Per-worktree so a run whose dir was deleted mid-flight doesn't
        // blank out the others' stats.
        for (const worktree of worktrees) {
          invoke<DiffStat>("get_run_diff_stat", { worktreePath: worktree.path })
            .then((stat) =>
              setRunStats((prev) => ({ ...prev, [worktree.path]: stat })),
            )
            .catch(() => {});
        }
      })
      .catch(() => setAutomationWorktrees([]));
  }, []);

  useEffect(() => {
    refresh();
    const unlistens = [
      listen("automations-changed", refresh),
      listen("automation-runs-changed", refresh),
    ];
    return () => {
      for (const u of unlistens) u.then((fn) => fn());
    };
  }, [refresh]);

  const lastRunByAutomation = useMemo(() => {
    const map = new Map<string, AutomationRun>();
    for (const run of runs) {
      if (!map.has(run.automation_id)) map.set(run.automation_id, run);
    }
    return map;
  }, [runs]);
  const selected = automations.find((a) => a.id === selectedId) ?? null;
  const inspectedRun = inspectedWorktree
    ? runs.find((run) => run.worktree_path === inspectedWorktree.path)
    : undefined;
  const inspectedAutomation = automations.find(
    (automation) => automation.id === inspectedRun?.automation_id,
  );

  const projects = useDataStore((s) => s.projects);

  const acknowledgeRun = useCallback((run: AutomationRun) => {
    acknowledgeAutomationRun(
      run,
      (runId) => {
        invoke("mark_automation_run_seen", { runId }).catch(() => {});
      },
      (worktreePath) => {
        const state =
          useDataStore.getState().worktreeDataStates[worktreePath];
        if (!state?.hasUnseenResult) return;
        useDataStore.getState().updateWorktreeDataState(worktreePath, {
          hasUnseenResult: false,
        });
      },
    );
  }, []);

  const openRunWorktree = useCallback(
    async (run: AutomationRun, automation?: Automation) => {
      if (!run.worktree_path) return;
      try {
        const existingWorktree = automationWorktrees.find(
          (worktree) => worktree.path === run.worktree_path,
        );
        if (automation?.repo_path === "" && !existingWorktree) {
          toast.error("The run's worktree no longer exists");
          return;
        }
        if (
          automation?.repo_path === "" &&
          (run.status === "pending" || run.status === "launched")
        ) {
          try {
            await invoke("claim_global_automation_run", { runId: run.id });
            if (!mountedRef.current) {
              await invoke("release_global_automation_run", {
                worktreePath: run.worktree_path,
              });
              return;
            }
            setClaimedRunIds((current) => {
              const next = new Set(current);
              next.add(run.id);
              return next;
            });
          } catch {
            const latestRuns =
              await invoke<AutomationRun[]>("list_automation_runs");
            setRuns(latestRuns);
            const latest = latestRuns.find(
              (candidate) => candidate.id === run.id,
            );
            if (
              latest?.status === "pending" ||
              latest?.status === "launched"
            ) {
              throw new Error("Failed to claim the active automation run");
            }
          }
        }
        if (existingWorktree) {
          setInspectedWorktree(existingWorktree);
          acknowledgeRun(run);
          return;
        }
        const repo = automation?.repo_path ?? project?.path;
        if (!repo) return;
        const wts = await invoke<Worktree[]>("list_worktrees", {
          repoPath: repo,
        });
        const wt = wts.find((w) => w.path === run.worktree_path);
        if (!wt) {
          toast.error("The run's worktree no longer exists");
          return;
        }
        setInspectedWorktree(wt);
        acknowledgeRun(run);
      } catch (e) {
        toast.error(`Failed to open worktree: ${e}`);
      }
    },
    [acknowledgeRun, automationWorktrees, project],
  );

  // The full diff experience — annotations, viewed tracking, commit panel —
  // lives on the main view. Scope it to the run's project (global runs use the
  // virtual Automations project) and hand off rather than rebuild it here.
  const openFullReview = useCallback(
    async (worktree: Worktree, automation: Automation | undefined) => {
      const repo = automation?.repo_path ?? "";
      const target: Project =
        repo === ""
          ? AUTOMATIONS_PROJECT
          : projects.find((p) => p.path === repo) ?? {
              path: repo,
              name: repo.split("/").pop() || repo,
            };
      try {
        const worktrees =
          repo === ""
            ? await invoke<Worktree[]>("list_automation_run_worktrees")
            : await invoke<Worktree[]>("list_worktrees", { repoPath: repo });
        const found = worktrees.find((w) => w.path === worktree.path);
        if (!found) {
          toast.error("The run's worktree no longer exists");
          return;
        }
        const run = runs.find(
          (candidate) => candidate.worktree_path === worktree.path,
        );
        if (run) acknowledgeRun(run);
        useUIStore.getState().setSelectedProject(target);
        useDataStore.getState().setWorktrees(worktrees);
        useUIStore.getState().setGeneralTerminalActive(false);
        await selectWorktree(found);
      } catch (e) {
        toast.error(`Failed to open review: ${e}`);
      }
    },
    [acknowledgeRun, projects, runs],
  );

  const openCreate = (template: AutomationTemplate | null) => {
    setInspectedWorktree(null);
    setSelectedId(null);
    setCreating({ template });
  };

  const deleteAutomation = useCallback(async (automation: Automation) => {
    // Pause first so the scheduler cannot allocate another run while its
    // existing resources are being removed. Rows remain intact until every
    // process and directory has been handled, making a failed delete retryable.
    const plan = await invoke<{
      automation: Automation;
      runs: AutomationRun[];
    }>("prepare_automation_deletion", { id: automation.id });
    const target = plan.automation;
    const automationRuns = plan.runs;
    const paths = [
      ...new Set(
        automationRuns
          .map((run) => run.worktree_path)
          .filter((path): path is string => !!path),
      ),
    ];
    const existingWorktrees =
      target.repo_path === ""
        ? await invoke<Worktree[]>("list_automation_run_worktrees")
        : await invoke<Worktree[]>("list_worktrees", {
            repoPath: target.repo_path,
          });
    const existingPaths = new Set(
      existingWorktrees.map((worktree) => worktree.path),
    );

    for (const worktreePath of paths) {
      const resumeSessionIds = automationRuns
        .filter((candidate) => candidate.worktree_path === worktreePath)
        .map((run) => automationRunResumePtySessionId(run.id));
      await cleanupWorktreeForDeletion(
        worktreePath,
        resumeSessionIds,
        true,
      );
      if (!existingPaths.has(worktreePath)) continue;

      if (target.repo_path === "") {
        await invoke("delete_automation_run_dir", { worktreePath });
      } else {
        await invoke("run_teardown_script", {
          repoPath: target.repo_path,
          worktreePath,
        }).catch((error) => {
          toast.error(`Teardown script failed: ${error}`);
        });
        await invoke("delete_worktree", {
          repoPath: target.repo_path,
          worktreePath,
          force: true,
        });
      }
    }
    await invoke("delete_automation", { id: target.id });
  }, []);

  const goBack = useCallback(() => {
    if (router.history.canGoBack()) {
      router.history.back();
    } else {
      navigate({ to: "/" });
    }
  }, [navigate, router]);

  const handleEscape = (event: React.KeyboardEvent) => {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      (event.target as Element).closest("[data-sidebar]")
    ) {
      return;
    }
    event.preventDefault();
    if (inspectedWorktree) {
      setInspectedWorktree(null);
      return;
    }
    goBack();
  };

  // Template prompts are repo-flavored ("this repository") — only suggest
  // them inside a project context.
  const suggestions = project
    ? AUTOMATION_TEMPLATES.filter(
        (t) => !automations.some((a) => a.name === t.name),
      )
    : [];
  const sidebarWidth = useUIStore((s) => s.sidebarWidth) ?? DEFAULT_SIDEBAR_WIDTH;

  return (
    <div
      className="flex h-screen flex-col bg-background text-foreground"
      onKeyDown={handleEscape}
    >
      <div
        className="relative flex h-16 shrink-0 items-center gap-3 border-b border-border/50 pr-4"
        style={{ paddingLeft: "88px" }}
      >
        <div className="absolute inset-0" data-tauri-drag-region />
        <button
          type="button"
          onClick={goBack}
          aria-keyshortcuts="Escape"
          title="Back (Esc)"
          className="relative flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          <span>Back</span>
          <kbd className="ml-1 text-xs text-muted-foreground">Esc</kbd>
        </button>
        <div className="flex-1" />
        <button
          onClick={() => openCreate(null)}
          className="relative rounded-md border border-border px-2.5 py-1 text-sm transition-colors hover:bg-accent"
        >
          + New automation
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          style={{ width: sidebarWidth }}
          className="shrink-0 overflow-hidden border-r border-border"
        >
          <Sidebar />
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          {
            <div className="mx-auto max-w-3xl px-8 pb-16 pt-10">
              <h1 className="text-2xl font-semibold">Automations</h1>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Run agents on a schedule — each run creates a fresh worktree
                and lands as a reviewable diff.
              </p>

              {automations.length > 0 && (
                <div className="mt-8 flex flex-col">
                  {automations.map((a) => {
                    const lastRun = lastRunByAutomation.get(a.id);
                    const lastMeta = lastRun ? RUN_STATUS_META[lastRun.status] : null;
                    const isSelected = a.id === selectedId;
                    return (
                      <button
                        key={a.id}
                        onClick={() => {
                          setInspectedWorktree(null);
                          setCreating(null);
                          setSelectedId(a.id);
                        }}
                        className={`flex items-center gap-3.5 rounded-lg px-3 py-3 text-left transition-colors ${
                          isSelected ? "bg-accent/60" : "hover:bg-accent/30"
                        }`}
                      >
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${
                            !a.enabled
                              ? "bg-muted-foreground/40"
                              : lastRun?.status === "failed"
                                ? "bg-danger"
                                : "bg-success"
                          }`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-base font-medium">
                              {a.name}
                            </span>
                            {!a.enabled && (
                              <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground">
                                paused
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 truncate text-sm text-muted-foreground">
                            {a.repo_path === ""
                              ? "Global"
                              : projects.find((p) => p.path === a.repo_path)
                                  ?.name ??
                                (a.repo_path.split("/").pop() || a.repo_path)}
                            {" · "}
                            {describeSchedule(a.schedule)}
                            {a.enabled && <> · Next run {formatWhen(a.next_run_at)}</>}
                            {lastRun && lastMeta && (
                              <> · Last {lastMeta.label} {formatWhen(lastRun.scheduled_for)}</>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              {automationWorktrees.length > 0 && (
                <section className="mt-10" aria-labelledby="automation-worktrees-heading">
                  <div className="mb-6 border-t border-border/50" />
                  <h2
                    id="automation-worktrees-heading"
                    className="px-3 text-xs font-semibold uppercase tracking-[1.2px] text-muted-foreground"
                  >
                    Worktrees from automation runs
                  </h2>
                  <div className="mt-2 flex flex-col">
                    {automationWorktrees.map((worktree) => {
                      const run = runs.find(
                        (candidate) =>
                          candidate.worktree_path === worktree.path,
                      );
                      const automation = automations.find(
                        (candidate) => candidate.id === run?.automation_id,
                      );
                      const meta = run ? RUN_STATUS_META[run.status] : null;
                      const stat = runStats[worktree.path];
                      const isOpen =
                        inspectedWorktree?.path === worktree.path;

                      return (
                        <div
                          key={worktree.path}
                          className={`group flex items-center gap-3.5 rounded-lg pr-3 transition-colors ${
                            isOpen ? "bg-accent/60" : "hover:bg-accent/30"
                          }`}
                        >
                          <button
                            type="button"
                            disabled={!run || !automation}
                            onClick={() =>
                              run &&
                              automation &&
                              openRunWorktree(run, automation)
                            }
                            className="flex min-w-0 flex-1 items-center gap-3.5 rounded-lg py-3 pl-3 text-left disabled:cursor-default"
                          >
                            <span
                              className={`h-2 w-2 shrink-0 rounded-full ${
                                meta?.dot ?? "bg-muted-foreground/40"
                              }`}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-base font-medium">
                                {worktree.title ??
                                  automation?.name ??
                                  "Automation worktree"}
                              </span>
                              <span className="mt-0.5 block truncate text-sm text-muted-foreground">
                                {automation?.repo_path === ""
                                  ? "Global"
                                  : projects.find(
                                        (candidate) =>
                                          candidate.path ===
                                          automation?.repo_path,
                                      )?.name ??
                                    automation?.repo_path.split("/").pop() ??
                                    "Unknown project"}
                                {meta && <> · {meta.label}</>}
                                {run && <> · {formatWhen(run.scheduled_for)}</>}
                              </span>
                            </span>
                          </button>
                          {stat && <DiffStatBadge stat={stat} />}
                          {stat && stat.files > 0 && (
                            <button
                              type="button"
                              onClick={() => openFullReview(worktree, automation)}
                              title="Open the run's diff on the main view"
                              className="shrink-0 rounded-md border border-border px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            >
                              Review
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {suggestions.length > 0 && (
                <>
                  {automations.length > 0 ? (
                    <div className="mb-6 mt-8 border-t border-border/50" />
                  ) : (
                    <div className="mt-8" />
                  )}
                  <div className="px-3 text-xs font-semibold uppercase tracking-[1.2px] text-muted-foreground">
                    Suggestions
                  </div>
                  <div className="mt-2 flex flex-col">
                    {suggestions.map((t) => (
                      <button
                        key={t.name}
                        onClick={() => openCreate(t)}
                        className="flex items-start gap-3.5 rounded-lg px-3 py-3 text-left transition-colors hover:bg-accent/30"
                      >
                        <span className="mt-0.5 text-base leading-none">
                          {t.emoji}
                        </span>
                        <span className="min-w-0">
                          <span className="flex items-baseline gap-2.5">
                            <span className="truncate text-base font-medium">
                              {t.name}
                            </span>
                            <span className="shrink-0 text-sm text-muted-foreground">
                              {describeSchedule(t.schedule)}
                            </span>
                          </span>
                          <span className="mt-0.5 block truncate text-sm text-muted-foreground">
                            {t.description}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {/* Suggestions are empty without a project, so this is the only
                  thing in the column then — point at the create flow and say
                  the non-obvious part: automations don't need a project. */}
              {automations.length === 0 && suggestions.length === 0 && (
                <div className="mt-8 px-3">
                  <p className="text-sm text-muted-foreground">
                    No automations yet. They don't need a project — a global
                    automation runs in a fresh scratch repo each time.
                  </p>
                  <button
                    onClick={() => openCreate(null)}
                    className="mt-3 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90"
                  >
                    Create your first automation
                  </button>
                </div>
              )}
            </div>
          }
        </div>

        {inspectedWorktree && (
          <ResizablePanel
            width={worktreePaneWidth}
            onWidthChange={setWorktreePaneWidth}
            isResizing={isWorktreePaneResizing}
            onResizingChange={setIsWorktreePaneResizing}
            minWidth={420}
            maxWidth={window.innerWidth * 0.75}
            handleSide="left"
            onDoubleClickHandle={() => setWorktreePaneWidth(720)}
          >
            <AutomationWorktreePane
              worktree={inspectedWorktree}
              run={inspectedRun}
              automation={inspectedAutomation}
              stat={runStats[inspectedWorktree.path]}
              onReview={() =>
                openFullReview(inspectedWorktree, inspectedAutomation)
              }
              onClose={() => setInspectedWorktree(null)}
              claimed={!!inspectedRun && claimedRunIds.has(inspectedRun.id)}
              onClaimReleased={(runId) => {
                setClaimedRunIds((current) => {
                  if (!current.has(runId)) return current;
                  const next = new Set(current);
                  next.delete(runId);
                  return next;
                });
              }}
            />
          </ResizablePanel>
        )}

        {!inspectedWorktree && (selected || creating) && (
          <AutomationEditor
            key={selected ? selected.id : "new"}
            repoPath={project?.path ?? ""}
            automation={selected}
            template={creating?.template ?? null}
            runs={selected ? runs.filter((r) => r.automation_id === selected.id) : []}
            runStats={runStats}
            onCreated={(a) => {
              setCreating(null);
              setSelectedId(a.id);
            }}
            onClose={() => {
              setSelectedId(null);
              setCreating(null);
            }}
            onDelete={() => selected && setDeleting(selected)}
            onOpenRun={(run) => openRunWorktree(run, selected ?? undefined)}
          />
        )}
      </div>

      <AlertDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete automation?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-medium text-foreground">
                {deleting?.name}
              </span>{" "}
              will stop firing. All run processes, worktrees, scratch repos,
              instructions, and run history will be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!deleting) return;
                const automation = deleting;
                deleteAutomation(automation)
                  .then(() => {
                    if (
                      inspectedRun?.automation_id === automation.id
                    ) {
                      setInspectedWorktree(null);
                    }
                    setSelectedId(null);
                    setDeleting(null);
                  })
                  .catch((error) => {
                    toast.error(`Failed to delete automation: ${error}`);
                    refresh();
                  });
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AutomationWorktreePane({
  worktree,
  run,
  automation,
  stat,
  onReview,
  onClose,
  claimed,
  onClaimReleased,
}: {
  worktree: Worktree;
  run: AutomationRun | undefined;
  automation: Automation | undefined;
  stat: DiffStat | undefined;
  onReview: () => void;
  onClose: () => void;
  claimed: boolean;
  onClaimReleased: (runId: string) => void;
}) {
  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/50 px-3">
        <Bot aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">
            Agent
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {worktree.title ?? worktree.branch}
          </div>
        </div>
        {stat && <DiffStatBadge stat={stat} />}
        {/* The transcript says what the run intended; the diff says what it
            did. Nothing here renders the diff — hand off to the main view.
            A run that changed nothing has nothing to hand off. */}
        {stat && stat.files > 0 && (
          <button
            type="button"
            onClick={onReview}
            title="Open the run's diff on the main view"
            className="shrink-0 rounded-md border border-border px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Review changes
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close worktree pane"
          title="Close"
          className={iconButtonClass}
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {automation?.repo_path === "" && run ? (
          <GlobalAutomationTerminal
            key={`${run.id}:${claimed ? "claimed" : (run.agent_session_id ?? "")}`}
            run={run}
            worktree={worktree}
            fallbackAgent={automation.agent}
            claimed={claimed}
            onClaimReleased={onClaimReleased}
          />
        ) : (
          <XtermTerminal
            sessionId={agentPtySessionId(worktree.path)}
            baseDir={worktree.path}
            isFocused
            onExit={() => {
              invoke("clear_agent_pane_status", {
                worktreePath: worktree.path,
                paneId: AGENT_PANE_ID,
              }).catch(() => {});
            }}
            onInterrupt={() => {
              invoke("interrupt_agent_turn", {
                worktreePath: worktree.path,
                paneId: AGENT_PANE_ID,
              }).catch(() => {});
            }}
          />
        )}
      </div>
    </div>
  );
}

function GlobalAutomationTerminal({
  run,
  worktree,
  fallbackAgent,
  claimed,
  onClaimReleased,
}: {
  run: AutomationRun;
  worktree: Worktree;
  fallbackAgent: Automation["agent"];
  claimed: boolean;
  onClaimReleased: (runId: string) => void;
}) {
  const claimedCleanupRef = useRef(createDeferredCleanupScheduler());
  const [resumeState, setResumeState] = useState<
    | { status: "starting" }
    | { status: "finishing" }
    | { status: "ready"; ptyId: string }
    | { status: "error"; message: string }
  >({ status: "starting" });

  const isRunning = run.status === "pending" || run.status === "launched";
  const executionPtyId = agentPtySessionId(worktree.path);
  const resumePtyId = automationRunResumePtySessionId(run.id);

  useMountEffect(() => {
    if (claimed) {
      claimedCleanupRef.current.cancelPendingCleanup();
      return () => {
        claimedCleanupRef.current.scheduleCleanup(() => {
          releaseCachedTerminal(executionPtyId);
          onClaimReleased(run.id);
          invoke("release_global_automation_run", {
            worktreePath: worktree.path,
          }).catch((error) => {
            console.error("Failed to release global automation run:", error);
          });
        });
      };
    }
    if (isRunning) return;
    let disposed = false;

    const start = async () => {
      if (!run.agent_session_id) {
        setResumeState({
          status: "error",
          message: "This run has no provider session to resume.",
        });
        return;
      }
      while (
        !disposed &&
        (await invoke<boolean>("pty_is_alive", {
          sessionId: executionPtyId,
        }))
      ) {
        setResumeState({ status: "finishing" });
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (disposed) return;
      releaseCachedTerminal(executionPtyId);
      setResumeState({ status: "starting" });
      releaseCachedTerminal(resumePtyId);
      await invoke("pty_kill", { sessionId: resumePtyId }).catch(() => {});
      const ptyId = await launchAutomationResume({
        runId: run.id,
        worktreePath: worktree.path,
        agent: run.agent_provider ?? fallbackAgent,
        sessionId: run.agent_session_id,
      });
      if (disposed) {
        releaseCachedTerminal(ptyId);
        await invoke("pty_kill", { sessionId: ptyId }).catch(() => {});
        return;
      }
      setResumeState({ status: "ready", ptyId });
    };

    start().catch((error) => {
      if (!disposed) {
        setResumeState({ status: "error", message: String(error) });
      }
    });
    return () => {
      disposed = true;
      releaseCachedTerminal(resumePtyId);
      invoke("pty_kill", { sessionId: resumePtyId }).catch(() => {});
    };
  });

  if (claimed) {
    return (
      <XtermTerminal
        sessionId={executionPtyId}
        baseDir={worktree.path}
        isFocused
        onInterrupt={() => {
          invoke("interrupt_agent_turn", {
            worktreePath: worktree.path,
            paneId: AGENT_PANE_ID,
          }).catch(() => {});
        }}
      />
    );
  }
  if (isRunning) {
    return (
      <XtermTerminal
        sessionId={executionPtyId}
        baseDir={worktree.path}
        isFocused
        readOnly
      />
    );
  }
  if (resumeState.status === "finishing") {
    return (
      <XtermTerminal
        sessionId={executionPtyId}
        baseDir={worktree.path}
        isFocused
        readOnly
      />
    );
  }
  if (resumeState.status === "ready") {
    return (
      <XtermTerminal
        sessionId={resumeState.ptyId}
        baseDir={worktree.path}
        isFocused
      />
    );
  }
  return (
    <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
      {resumeState.status === "error"
        ? resumeState.message
        : "Opening agent session..."}
    </div>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3 px-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

const rowSelectClass =
  "rounded-md bg-transparent px-1.5 py-1 text-right text-sm outline-none transition-colors hover:bg-accent";

/** The app's 28px icon-button form (Sidebar, FilesPanel, settings panes). */
const iconButtonClass =
  "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

/**
 * Codex-style detail pane: status + title, big prompt editor, Details and
 * Frequency row groups, Previous runs. Existing automations save inline
 * (blur for text, immediately for pickers); automation === null is create
 * mode with an explicit Create button.
 */
function AutomationEditor({
  repoPath,
  automation,
  template,
  runs,
  runStats,
  onCreated,
  onClose,
  onDelete,
  onOpenRun,
}: {
  repoPath: string;
  automation: Automation | null;
  template: AutomationTemplate | null;
  runs: AutomationRun[];
  runStats: Record<string, DiffStat>;
  onCreated: (a: Automation) => void;
  onClose: () => void;
  onDelete: () => void;
  onOpenRun: (run: AutomationRun) => void;
}) {
  const isNew = automation === null;
  const projects = useDataStore((s) => s.projects);
  const initialSchedule = automation?.schedule ?? template?.schedule ?? "0 9 * * *";
  const initial = matchPreset(initialSchedule);

  const [targetRepo, setTargetRepo] = useState(automation?.repo_path ?? repoPath);
  const [name, setName] = useState(automation?.name ?? template?.name ?? "");
  const [prompt, setPrompt] = useState(automation?.prompt ?? template?.prompt ?? "");
  const [agent, setAgent] = useState<"claude" | "codex">(automation?.agent ?? "claude");
  const [preset, setPreset] = useState<Preset>(initial.preset);
  const [time, setTime] = useState(initial.time);
  const [weekday, setWeekday] = useState(initial.weekday);
  const [custom, setCustom] = useState(
    initial.preset === "custom" ? initialSchedule : "0 9 * * 1-5",
  );
  const [preview, setPreview] = useState<number[]>([]);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const schedule = buildCron(preset, time, weekday, custom);

  useEffect(() => {
    let stale = false;
    invoke<number[]>("cron_next_occurrences", { schedule, count: 3 })
      .then((next) => {
        if (stale) return;
        setPreview(next);
        setScheduleError(null);
      })
      .catch((e) => {
        if (stale) return;
        setPreview([]);
        setScheduleError(String(e));
      });
    return () => {
      stale = true;
    };
  }, [schedule]);

  const persist = useCallback(
    (changes: {
      name?: string;
      prompt?: string;
      agent?: string;
      schedule?: string;
      repo_path?: string;
    }) => {
      if (!automation) return;
      invoke("update_automation", { id: automation.id, changes }).catch((e) =>
        toast.error(String(e)),
      );
    },
    [automation],
  );

  // Pickers persist immediately on existing automations; buildCron sees the
  // updated value on the next render, so compute the new cron inline.
  const persistSchedule = (p: Preset, t: string, w: string, c: string) => {
    const next = buildCron(p, t, w, c);
    if (automation && next.split(/\s+/).length === 5) persist({ schedule: next });
  };

  const create = async () => {
    if (!name.trim() || !prompt.trim()) {
      toast.error("Name and prompt are required");
      return;
    }
    setSaving(true);
    try {
      const created = await invoke<Automation>("create_automation", {
        automation: { repo_path: targetRepo, name: name.trim(), prompt, agent, schedule },
      });
      if (targetRepo !== repoPath) {
        // The list shows the selected project — the new automation lives
        // elsewhere, so it won't appear here.
        const target = projects.find((p) => p.path === targetRepo);
        toast.success(`Created in ${target?.name ?? targetRepo}`);
      }
      onCreated(created);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex w-[560px] max-w-[45vw] shrink-0 flex-col border-l border-border/50">
      <div className="flex items-center gap-2 px-4 pt-3">
        <span
          className={`text-xs font-medium ${
            isNew
              ? "text-muted-foreground"
              : automation.enabled
                ? "text-success"
                : "text-muted-foreground"
          }`}
        >
          {isNew ? "New automation" : automation.enabled ? "Active" : "Paused"}
        </span>
        <div className="flex-1" />
        {!isNew && (
          <>
            <button
              onClick={() =>
                invoke("run_automation_now", { id: automation.id })
                  .then(() => toast.success(`Running "${automation.name}" now`))
                  .catch((e) => toast.error(String(e)))
              }
              className={iconButtonClass}
              title="Run now"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4 2.5v11l9-5.5z" />
              </svg>
            </button>
            <button
              onClick={() =>
                invoke("set_automation_enabled", {
                  id: automation.id,
                  enabled: !automation.enabled,
                }).catch((e) => toast.error(String(e)))
              }
              className={iconButtonClass}
              title={automation.enabled ? "Pause" : "Resume"}
            >
              {automation.enabled ? (
                <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                  <rect x="3.5" y="2.5" width="3" height="11" rx="0.5" />
                  <rect x="9.5" y="2.5" width="3" height="11" rx="0.5" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M4 2.5v11l9-5.5z" />
                </svg>
              )}
            </button>
            <button
              onClick={onDelete}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              title="Delete"
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              >
                <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.5 7v4M9.5 7v4" />
              </svg>
            </button>
          </>
        )}
        <button
          onClick={onClose}
          className={iconButtonClass}
          title="Close"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (automation && name.trim() && name.trim() !== automation.name) {
              persist({ name: name.trim() });
            }
          }}
          placeholder="Automation title"
          autoFocus={isNew}
          className="-mx-1 mt-1 w-[calc(100%+0.5rem)] rounded-md bg-transparent px-1 text-lg font-semibold outline-none placeholder:text-muted-foreground"
        />

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onBlur={() => {
            if (automation && prompt.trim() && prompt !== automation.prompt) {
              persist({ prompt });
            }
          }}
          placeholder="Prompt each run starts with"
          className="mt-3 h-72 w-full resize-y rounded-lg border border-border/60 bg-muted/20 px-3.5 py-3 text-sm leading-relaxed outline-none transition-colors placeholder:text-muted-foreground"
        />
        {/* The guidance used to live in the placeholder, where it disappeared on
            the first keystroke and was never recoverable. */}
        <p className="mt-1.5 px-1 text-xs text-muted-foreground">
          Make it self-contained, and have it write its output into files so
          the diff carries the result.
        </p>

        <div className="mt-4 mb-1.5 px-1 text-xs font-medium text-muted-foreground">
          Details
        </div>
        <div className="divide-y divide-border/40 rounded-lg border border-border/60">
          <DetailRow label="Project">
            <select
              value={targetRepo}
              onChange={(e) => {
                setTargetRepo(e.target.value);
                if (automation) persist({ repo_path: e.target.value });
              }}
              className={rowSelectClass}
            >
              <option value="">No project (global)</option>
              {/* Keep the current value selectable even if its project was
                  removed from the tracked list. */}
              {targetRepo !== "" && !projects.some((p) => p.path === targetRepo) && (
                <option value={targetRepo}>
                  {targetRepo.split("/").pop() ?? targetRepo}
                </option>
              )}
              {projects.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.name}
                </option>
              ))}
            </select>
          </DetailRow>
          <DetailRow label="Agent">
            <select
              value={agent}
              onChange={(e) => {
                const next = e.target.value as "claude" | "codex";
                setAgent(next);
                if (automation) persist({ agent: next });
              }}
              className={rowSelectClass}
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
          </DetailRow>
          <DetailRow label="Runs in">
            <span className="py-1 text-sm text-muted-foreground">
              {targetRepo === ""
                ? "Fresh scratch repo per run"
                : "New worktree per run"}
            </span>
          </DetailRow>
        </div>

        <div className="mt-4 mb-1.5 px-1 text-xs font-medium text-muted-foreground">
          Frequency
        </div>
        <div className="divide-y divide-border/40 rounded-lg border border-border/60">
          <DetailRow label="Repeat">
            <select
              value={preset}
              onChange={(e) => {
                const next = e.target.value as Preset;
                setPreset(next);
                persistSchedule(next, time, weekday, custom);
              }}
              className={rowSelectClass}
            >
              <option value="hourly">Hourly</option>
              <option value="daily">Daily</option>
              <option value="weekdays">Weekdays</option>
              <option value="weekly">Weekly</option>
              <option value="custom">Custom (cron)</option>
            </select>
          </DetailRow>
          {preset === "weekly" && (
            <DetailRow label="On">
              <select
                value={weekday}
                onChange={(e) => {
                  setWeekday(e.target.value);
                  persistSchedule(preset, time, e.target.value, custom);
                }}
                className={rowSelectClass}
              >
                {WEEKDAYS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </DetailRow>
          )}
          {(preset === "daily" || preset === "weekdays" || preset === "weekly") && (
            <DetailRow label="At">
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                onBlur={() => persistSchedule(preset, time, weekday, custom)}
                className={rowSelectClass}
              />
            </DetailRow>
          )}
          {preset === "custom" && (
            <DetailRow label="Cron">
              <input
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onBlur={() => persistSchedule(preset, time, weekday, custom)}
                placeholder="0 9 * * 1-5"
                className={`${rowSelectClass} w-32 font-mono`}
              />
            </DetailRow>
          )}
        </div>

        <div className="mt-1.5 min-h-[1.1rem] px-1 text-xs">
          {scheduleError ? (
            <span className="text-danger">{scheduleError}</span>
          ) : (
            preview.length > 0 && (
              <span className="text-muted-foreground">
                Next:{" "}
                {preview
                  .map((t) =>
                    new Date(t * 1000).toLocaleString(undefined, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    }),
                  )
                  .join(" · ")}
              </span>
            )
          )}
        </div>

        {isNew ? (
          <button
            onClick={create}
            disabled={saving || !!scheduleError}
            className="mt-4 w-full rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? "Creating…" : "Create automation"}
          </button>
        ) : (
          runs.length > 0 && (
            <>
              <div className="mt-5 mb-1.5 px-1 text-xs font-medium text-muted-foreground">
                Previous runs
              </div>
              <div className="flex flex-col">
                {runs.slice(0, 15).map((run) => {
                  const meta = RUN_STATUS_META[run.status];
                  const stat = run.worktree_path
                    ? runStats[run.worktree_path]
                    : undefined;
                  return (
                    <button
                      key={run.id}
                      type="button"
                      onClick={() => onOpenRun(run)}
                      disabled={!run.worktree_path}
                      title={run.error ?? "Open agent run"}
                      className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm transition-colors enabled:cursor-pointer enabled:hover:bg-accent/40 disabled:cursor-default"
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} />
                      <span className="truncate">{meta.label}</span>
                      {run.error && (
                        <span className="truncate text-xs text-danger">
                          {run.error}
                        </span>
                      )}
                      <div className="flex-1" />
                      {stat && stat.files > 0 && (
                        <span className="shrink-0 text-xs tabular-nums">
                          <span className="text-success">+{stat.additions}</span>{" "}
                          <span className="text-danger">-{stat.deletions}</span>
                        </span>
                      )}
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatWhen(run.scheduled_for)}
                      </span>
                      {run.worktree_path && (
                        <PanelRightOpen
                          aria-hidden="true"
                          className="size-3.5 shrink-0 text-muted-foreground"
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )
        )}
      </div>
    </div>
  );
}
