import { useState } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Search,
} from "lucide-react";
import { invoke } from "../lib/invoke";
import { getSubagentTriggerState } from "../lib/subagent-menu-state";
import { cn } from "../lib/utils";
import { useMountEffect } from "../hooks/useMountEffect";

export interface SubagentSummary {
  id: string;
  name: string;
  status: "running" | "waiting" | "done";
  depth: number;
  updatedAt: number;
}

interface SubagentSnapshot {
  agents: SubagentSummary[];
  previousAgents: SubagentSummary[];
  activeCount: number;
}

const EMPTY_SNAPSHOT: SubagentSnapshot = {
  agents: [],
  previousAgents: [],
  activeCount: 0,
};

export function SubagentMenu({
  worktreePath,
  paneId,
}: {
  worktreePath: string;
  paneId: string;
}) {
  const [snapshot, setSnapshot] = useState<SubagentSnapshot>(EMPTY_SNAPSHOT);
  const [open, setOpen] = useState(false);
  const [showPrevious, setShowPrevious] = useState(false);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState({ top: 0, left: 0 });

  useMountEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshVersion = 0;
    const refresh = () => {
      const version = ++refreshVersion;
      if (pollTimer) clearTimeout(pollTimer);
      invoke<SubagentSnapshot>("get_subagents", { worktreePath, paneId })
        .then((next) => {
          if (cancelled || version !== refreshVersion) return;
          setSnapshot(next);
          if (next.activeCount > 0) {
            pollTimer = setTimeout(refresh, 1_000);
          }
        })
        .catch(() => {});
    };
    refresh();
    const unlisten = listen<{ worktreePath: string; paneId: string }>(
      "subagents-changed",
      (event) => {
        if (
          event.payload.worktreePath === worktreePath &&
          event.payload.paneId === paneId
        ) {
          refresh();
        }
      },
    );
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      unlisten.then((fn) => fn());
    };
  });

  const triggerState = getSubagentTriggerState(
    snapshot.agents.length,
    snapshot.previousAgents.length,
  );

  if (!triggerState.visible) return null;

  const normalizedQuery = query.trim().toLowerCase();
  const visibleAgents = normalizedQuery
    ? snapshot.agents.filter((agent) =>
        agent.name.toLowerCase().includes(normalizedQuery),
      )
    : snapshot.agents;
  const visiblePreviousAgents = normalizedQuery
    ? snapshot.previousAgents.filter((agent) =>
        agent.name.toLowerCase().includes(normalizedQuery),
      )
    : snapshot.previousAgents;
  const previousExpanded =
    triggerState.historyOnly || showPrevious || normalizedQuery.length > 0;

  return (
    <>
      <button
        type="button"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          setPosition({
            top: rect.bottom + 6,
            left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)),
          });
          setOpen((value) => !value);
        }}
        className="mx-1.5 flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground outline-none hover:bg-background/70 hover:text-foreground"
        aria-label={
          triggerState.historyOnly
            ? `${triggerState.count} completed subagents. Open subagent history`
            : `${triggerState.count} subagents, ${snapshot.activeCount} active. Open subagent menu`
        }
        aria-expanded={open}
        title={
          triggerState.historyOnly
            ? `${triggerState.count} completed subagents`
            : `${triggerState.count} subagents · ${snapshot.activeCount} active`
        }
      >
        <Circle
          aria-hidden="true"
          className={cn(
            "size-2",
            snapshot.activeCount > 0
              ? "fill-primary text-primary"
              : "fill-muted-foreground/60 text-muted-foreground/60",
          )}
        />
        <span className="tabular-nums">{triggerState.count}</span>
        <ChevronDown aria-hidden="true" className="size-3" />
      </button>
      {open
        ? createPortal(
            <>
              <MenuDismiss onDismiss={() => setOpen(false)} />
              <div
                className="fixed z-40 w-80 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md"
                style={{ top: position.top, left: position.left }}
                role="dialog"
                aria-label="Subagents"
              >
                <div className="border-b border-border p-2">
                  <label className="flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2 text-muted-foreground">
                    <Search aria-hidden="true" className="size-3.5" />
                    <span className="sr-only">Filter subagents</span>
                    <input
                      autoFocus
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder={`Filter ${snapshot.agents.length + snapshot.previousAgents.length} subagents`}
                      className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                    />
                  </label>
                </div>
                <div
                  className="max-h-80 overflow-y-auto p-1.5 [content-visibility:auto]"
                  role="list"
                  aria-label="Subagent status"
                >
                  {visibleAgents.map((agent) => (
                    <AgentMenuRow
                      key={agent.id}
                      name={agent.name}
                      status={agent.status}
                      depth={agent.depth}
                    />
                  ))}
                  {snapshot.previousAgents.length > 0 ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setShowPrevious((value) => !value)}
                        className="mt-1 flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground outline-none hover:bg-accent"
                        aria-expanded={previousExpanded}
                      >
                        {previousExpanded ? (
                          <ChevronDown aria-hidden="true" className="size-3" />
                        ) : (
                          <ChevronRight aria-hidden="true" className="size-3" />
                        )}
                        Previous runs
                        <span className="ml-auto tabular-nums">
                          {snapshot.previousAgents.length}
                        </span>
                      </button>
                      {previousExpanded
                        ? visiblePreviousAgents.map((agent) => (
                            <AgentMenuRow
                              key={agent.id}
                              name={agent.name}
                              status={agent.status}
                              depth={agent.depth}
                            />
                          ))
                        : null}
                    </>
                  ) : null}
                </div>
                <div className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
                  {triggerState.historyOnly
                    ? `${snapshot.previousAgents.length} previous`
                    : `${snapshot.activeCount} running · ${snapshot.agents.length} this turn`}
                </div>
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  );
}

function MenuDismiss({ onDismiss }: { onDismiss: () => void }) {
  useMountEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <div
      aria-hidden="true"
      className="fixed inset-0 z-30"
      onMouseDown={onDismiss}
    />
  );
}

function AgentMenuRow({
  name,
  status,
  depth,
}: {
  name: string;
  status: SubagentSummary["status"];
  depth: number;
}) {
  return (
    <div
      role="listitem"
      className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground"
    >
      <span aria-hidden="true" style={{ width: `${Math.min(depth, 5) * 8}px` }} />
      {status === "done" ? (
        <Check aria-hidden="true" className="size-3.5 shrink-0" />
      ) : (
        <Circle aria-hidden="true" className="size-2.5 shrink-0 fill-primary text-primary" />
      )}
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="text-[10px] capitalize">{status}</span>
    </div>
  );
}
