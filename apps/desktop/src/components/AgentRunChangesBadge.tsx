import { useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { invoke } from "@/lib/invoke";
import { useMountEffect } from "../hooks/useMountEffect";
import { sanitizeEventId } from "../lib/sanitize-event-id";
import { openAgentRunChanges } from "../lib/agent-run-changes";
import type { AgentRunChangeSummary } from "../types";

export function AgentRunChangesBadge({
  worktreePath,
  paneId,
  label,
}: {
  worktreePath: string;
  paneId: string;
  label: string;
}) {
  const [summary, setSummary] = useState<AgentRunChangeSummary | null>(null);

  useMountEffect(() => {
    let cancelled = false;
    const refresh = () => {
      invoke<AgentRunChangeSummary | null>("get_agent_run_change_summary", {
        worktreePath,
        paneId,
      })
        .then((next) => {
          if (!cancelled) setSummary(next);
        })
        .catch(() => {});
    };

    refresh();
    // Ponytail: one debounced snapshot per visible delegated tab is simple and
    // cheap for today's pane counts; batch by worktree if tabs grow into dozens.
    const unlisteners = Promise.all([
      listen(`fs-changed-${sanitizeEventId(worktreePath)}`, refresh),
      listen<AgentRunChangeSummary>("agent-run-changes-completed", (event) => {
        if (
          event.payload.worktree_path === worktreePath &&
          event.payload.pane_id === paneId
        ) {
          setSummary(event.payload);
        }
      }),
    ]);
    return () => {
      cancelled = true;
      unlisteners.then((listeners) => listeners.forEach((unlisten) => unlisten()));
    };
  });

  if (!summary || summary.files === 0) return null;

  const fileLabel = `${summary.files} ${summary.files === 1 ? "file" : "files"}`;
  return (
    <button
      type="button"
      aria-label={`Review changes during ${label}: ${fileLabel}, ${summary.additions} additions, ${summary.deletions} deletions`}
      title={`Changes during ${label} · ${fileLabel}`}
      onClick={(event) => {
        event.stopPropagation();
        openAgentRunChanges(worktreePath, paneId, label).catch((error) =>
          toast.error("Couldn't open agent changes", {
            description: String(error),
          }),
        );
      }}
      onPointerDown={(event) => event.stopPropagation()}
      className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 font-mono text-xs text-muted-foreground outline-none hover:bg-background/70 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span>{summary.files}f</span>
      {summary.additions > 0 ? (
        <span className="text-success">+{summary.additions}</span>
      ) : null}
      {summary.deletions > 0 ? (
        <span className="text-danger">-{summary.deletions}</span>
      ) : null}
    </button>
  );
}
