import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { listen } from "@tauri-apps/api/event";
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
import { selectWorktree } from "../hooks/useWorktreeActions";
import {
  AUTOMATION_TEMPLATES,
  type AutomationTemplate,
} from "../lib/automation-templates";
import type { Automation, AutomationRun, Worktree } from "../types";

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

const RUN_STATUS_META: Record<AutomationRun["status"], { dot: string; label: string }> = {
  pending: { dot: "bg-amber-500", label: "starting" },
  launched: { dot: "bg-blue-500", label: "running" },
  completed: { dot: "bg-emerald-500", label: "completed" },
  failed: { dot: "bg-red-500", label: "failed" },
  skipped: { dot: "bg-muted-foreground/40", label: "skipped" },
};

export function AutomationsView() {
  const navigate = useNavigate();
  const project = useUIStore((s) => s.selectedProject);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [editing, setEditing] = useState<Automation | "new" | null>(null);
  const [template, setTemplate] = useState<AutomationTemplate | null>(null);
  const [deleting, setDeleting] = useState<Automation | null>(null);

  const refresh = useCallback(() => {
    if (!project) {
      setAutomations([]);
      setRuns([]);
      return;
    }
    invoke<Automation[]>("list_automations", { repo: project.path })
      .then(setAutomations)
      .catch(() => setAutomations([]));
    invoke<AutomationRun[]>("list_automation_runs", { repo: project.path })
      .then(setRuns)
      .catch(() => setRuns([]));
    // The user is looking at the runs — clear the sidebar badge. Emits (and
    // re-triggers this refresh) only when rows actually flip.
    invoke("mark_automation_runs_seen", { repo: project.path }).catch(() => {});
  }, [project]);

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

  const openRunWorktree = useCallback(
    async (run: AutomationRun) => {
      if (!run.worktree_path || !project) return;
      try {
        const wts = await invoke<Worktree[]>("list_worktrees", {
          repoPath: project.path,
        });
        useDataStore.getState().setWorktrees(wts);
        const wt = wts.find((w) => w.path === run.worktree_path);
        if (!wt) {
          toast.error("The run's worktree no longer exists");
          return;
        }
        useUIStore.getState().setGeneralTerminalActive(false);
        await selectWorktree(wt);
        navigate({ to: "/" });
      } catch (e) {
        toast.error(`Failed to open worktree: ${e}`);
      }
    },
    [project, navigate],
  );

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <div
        className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-4"
        data-tauri-drag-region
      >
        <button
          onClick={() => navigate({ to: "/" })}
          className="ml-16 rounded px-1.5 py-0.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Back"
        >
          ←
        </button>
        <span className="font-semibold">Automations</span>
        {project && (
          <span className="truncate text-sm text-muted-foreground">
            {project.name}
          </span>
        )}
        <div className="flex-1" />
        {project && (
          <button
            onClick={() => setEditing("new")}
            className="rounded-md border border-border px-2.5 py-1 text-sm hover:bg-accent"
          >
            + New automation
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {!project ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select a project to manage its automations.
          </div>
        ) : automations.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6">
            <div className="text-sm font-medium">Start from a template</div>
            <div className="max-w-md text-center text-sm text-muted-foreground">
              Each run creates a fresh worktree, launches the agent with your
              prompt, and lands as a reviewable diff.
            </div>
            <div className="mt-3 grid w-full max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2">
              {AUTOMATION_TEMPLATES.map((t) => (
                <button
                  key={t.name}
                  onClick={() => {
                    setTemplate(t);
                    setEditing("new");
                  }}
                  className="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2.5 text-left hover:bg-accent/40"
                >
                  <span className="text-lg leading-none">{t.emoji}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {t.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {t.description}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <button
              onClick={() => {
                setTemplate(null);
                setEditing("new");
              }}
              className="mt-3 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
            >
              Start from scratch
            </button>
          </div>
        ) : (
          <div className="mx-auto max-w-4xl px-4 py-4">
            <div className="overflow-hidden rounded-lg border border-border">
              {automations.map((a) => {
                const lastRun = lastRunByAutomation.get(a.id);
                return (
                  <AutomationRow
                    key={a.id}
                    automation={a}
                    lastRun={lastRun}
                    onEdit={() => setEditing(a)}
                    onDelete={() => setDeleting(a)}
                    onOpenRun={openRunWorktree}
                  />
                );
              })}
            </div>

            {runs.length > 0 && (
              <div className="mt-6">
                <div className="mb-1.5 px-1 font-mono text-sm font-semibold tracking-[1.2px] text-muted-foreground/60">
                  Recent runs
                </div>
                <div className="overflow-hidden rounded-lg border border-border">
                  {runs.slice(0, 20).map((run) => {
                    const automation = automations.find(
                      (a) => a.id === run.automation_id,
                    );
                    const meta = RUN_STATUS_META[run.status];
                    return (
                      <div
                        key={run.id}
                        className={`flex items-center gap-2 border-b border-border/40 px-3 py-2 text-sm last:border-b-0 ${
                          run.worktree_path ? "cursor-pointer hover:bg-accent/30" : ""
                        }`}
                        onClick={() => openRunWorktree(run)}
                        title={run.error ?? undefined}
                      >
                        <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`} />
                        <span className="truncate">
                          {automation?.name ?? "Automation"}
                        </span>
                        <span className="text-muted-foreground">{meta.label}</span>
                        {run.error && (
                          <span className="truncate text-red-500/90">{run.error}</span>
                        )}
                        <div className="flex-1" />
                        <span className="shrink-0 text-muted-foreground/70">
                          {formatWhen(run.scheduled_for)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {editing && project && (
        <AutomationDialog
          repoPath={project.path}
          automation={editing === "new" ? null : editing}
          template={editing === "new" ? template : null}
          onClose={() => {
            setEditing(null);
            setTemplate(null);
          }}
        />
      )}

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
              will stop firing and its run history will be removed. Worktrees
              from past runs are untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!deleting) return;
                invoke("delete_automation", { id: deleting.id }).catch((e) =>
                  toast.error(String(e)),
                );
                setDeleting(null);
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

function AutomationRow({
  automation,
  lastRun,
  onEdit,
  onDelete,
  onOpenRun,
}: {
  automation: Automation;
  lastRun?: AutomationRun;
  onEdit: () => void;
  onDelete: () => void;
  onOpenRun: (run: AutomationRun) => void;
}) {
  const a = automation;
  const lastMeta = lastRun ? RUN_STATUS_META[lastRun.status] : null;
  return (
    <div className="flex items-center gap-3 border-b border-border/40 px-3 py-2.5 last:border-b-0">
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${
          !a.enabled
            ? "bg-muted-foreground/40"
            : lastRun?.status === "failed"
              ? "bg-red-500"
              : "bg-emerald-500"
        }`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{a.name}</span>
          {!a.enabled && (
            <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground">
              paused
            </span>
          )}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {describeSchedule(a.schedule)} · {a.agent}
          {a.enabled && <> · next {formatWhen(a.next_run_at)}</>}
          {lastRun && lastMeta && (
            <>
              {" · last "}
              <button
                className={`underline-offset-2 ${lastRun.worktree_path ? "hover:underline" : ""}`}
                onClick={() => onOpenRun(lastRun)}
              >
                {lastMeta.label} {formatWhen(lastRun.scheduled_for)}
              </button>
            </>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          onClick={() =>
            invoke("run_automation_now", { id: a.id })
              .then(() => toast.success(`Running "${a.name}" now`))
              .catch((e) => toast.error(String(e)))
          }
          className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Run now"
        >
          ▶
        </button>
        <button
          onClick={() =>
            invoke("set_automation_enabled", { id: a.id, enabled: !a.enabled }).catch(
              (e) => toast.error(String(e)),
            )
          }
          className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          title={a.enabled ? "Pause" : "Resume"}
        >
          {a.enabled ? "⏸" : "⏵"}
        </button>
        <button
          onClick={onEdit}
          className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Edit"
        >
          Edit
        </button>
        <button
          onClick={onDelete}
          className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Delete"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function AutomationDialog({
  repoPath,
  automation,
  template,
  onClose,
}: {
  repoPath: string;
  automation: Automation | null;
  template: AutomationTemplate | null;
  onClose: () => void;
}) {
  const initialSchedule = automation?.schedule ?? template?.schedule;
  const initial = initialSchedule ? matchPreset(initialSchedule) : null;
  const [name, setName] = useState(automation?.name ?? template?.name ?? "");
  const [prompt, setPrompt] = useState(automation?.prompt ?? template?.prompt ?? "");
  const [agent, setAgent] = useState<"claude" | "codex">(automation?.agent ?? "claude");
  const [preset, setPreset] = useState<Preset>(initial?.preset ?? "daily");
  const [time, setTime] = useState(initial?.time ?? "09:00");
  const [weekday, setWeekday] = useState(initial?.weekday ?? "MON");
  const [custom, setCustom] = useState(
    initial?.preset === "custom" && initialSchedule ? initialSchedule : "0 9 * * 1-5",
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

  const save = async () => {
    if (!name.trim() || !prompt.trim()) {
      toast.error("Name and prompt are required");
      return;
    }
    setSaving(true);
    try {
      if (automation) {
        await invoke("update_automation", {
          id: automation.id,
          changes: { name: name.trim(), prompt, agent, schedule },
        });
      } else {
        await invoke("create_automation", {
          automation: { repo_path: repoPath, name: name.trim(), prompt, agent, schedule },
        });
      }
      onClose();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div
        className="w-[560px] max-w-[90vw] rounded-lg border border-border bg-background p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-sm font-semibold">
          {automation ? "Edit automation" : "New automation"}
        </div>

        <label className="mb-1 block text-xs text-muted-foreground">Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Daily standup digest"
          autoFocus
          className="mb-3 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary/50"
        />

        <label className="mb-1 block text-xs text-muted-foreground">Prompt</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Summarize yesterday's git activity across this repo. Group by author, call out anything that looks stuck."
          rows={5}
          className="mb-3 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary/50"
        />

        <div className="mb-3 flex gap-3">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Agent</label>
            <select
              value={agent}
              onChange={(e) => setAgent(e.target.value as "claude" | "codex")}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Repeats</label>
            <div className="flex items-center gap-2">
              <select
                value={preset}
                onChange={(e) => setPreset(e.target.value as Preset)}
                className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              >
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekdays">Weekdays</option>
                <option value="weekly">Weekly</option>
                <option value="custom">Custom (cron)</option>
              </select>
              {preset === "weekly" && (
                <select
                  value={weekday}
                  onChange={(e) => setWeekday(e.target.value)}
                  className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                >
                  {WEEKDAYS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
              )}
              {(preset === "daily" || preset === "weekdays" || preset === "weekly") && (
                <input
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                />
              )}
              {preset === "custom" && (
                <input
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  placeholder="0 9 * * 1-5"
                  className="w-36 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-sm"
                />
              )}
            </div>
          </div>
        </div>

        <div className="mb-4 min-h-[1.25rem] text-xs">
          {scheduleError ? (
            <span className="text-red-500">{scheduleError}</span>
          ) : (
            <span className="text-muted-foreground">
              {preview.length > 0 && (
                <>
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
                </>
              )}
            </span>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !!scheduleError}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? "Saving…" : automation ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
