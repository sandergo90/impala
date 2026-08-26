import { useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowLeft,
  Users,
} from "lucide-react";
import impalaMark from "../assets/impala-mark.png";
import { CodexTranscriptConversation } from "./CodexTranscriptConversation";
import { invoke } from "../lib/invoke";
import {
  parseNativeAutomationTranscript,
  type NativeAutomationTranscriptEntry,
} from "../lib/native-automation-transcript";
import {
  formatSubagentAge,
  formatSubagentName,
  getSubagentTriggerState,
} from "../lib/subagent-menu-state";
import { openSubagentsPane } from "../lib/tab-actions";
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
  transcriptAvailable: boolean;
}

const EMPTY_SNAPSHOT: SubagentSnapshot = {
  agents: [],
  previousAgents: [],
  activeCount: 0,
  transcriptAvailable: false,
};

interface SubagentMenuProps {
  worktreePath: string;
  paneId: string;
}

export function SubagentMenu(props: SubagentMenuProps) {
  return (
    <SubagentMenuForPane
      key={`${props.worktreePath}\0${props.paneId}`}
      {...props}
    />
  );
}

function SubagentMenuForPane({
  worktreePath,
  paneId,
}: SubagentMenuProps) {
  const snapshot = useSubagentSnapshot(worktreePath, paneId);
  const triggerState = getSubagentTriggerState(
    snapshot.agents.length,
    snapshot.previousAgents.length,
  );

  if (!triggerState.visible) return null;

  return (
    <button
      type="button"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        openSubagentsPane(worktreePath, paneId);
      }}
      className="mx-1.5 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-background/70 hover:text-foreground"
      aria-label={`Open ${triggerState.count} subagents in side pane`}
      title={`${triggerState.count} subagents · ${snapshot.activeCount} active`}
    >
      <Users
        aria-hidden="true"
        className={snapshot.activeCount > 0 ? "size-3.5 text-primary" : "size-3.5"}
      />
    </button>
  );
}

function useSubagentSnapshot(worktreePath: string, paneId: string) {
  const [snapshot, setSnapshot] = useState<SubagentSnapshot>(EMPTY_SNAPSHOT);

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
  return snapshot;
}

export function SubagentWorkspacePane(props: SubagentMenuProps) {
  return (
    <SubagentWorkspacePaneForSource
      key={`${props.worktreePath}\0${props.paneId}`}
      {...props}
    />
  );
}

function SubagentWorkspacePaneForSource({
  worktreePath,
  paneId,
}: SubagentMenuProps) {
  const snapshot = useSubagentSnapshot(worktreePath, paneId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const agents = [...snapshot.agents, ...snapshot.previousAgents];
  const accentById = new Map(agents.map((agent, index) => [agent.id, index]));
  const activeAgents = agents.filter((agent) => agent.status !== "done");
  const doneAgents = agents.filter((agent) => agent.status === "done");
  const selected = agents.find((agent) => agent.id === selectedId);

  if (selectedId) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border/70 px-4">
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground"
            aria-label="Back to subagents"
            title="Back to subagents"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
          </button>
          {selected ? (
            <>
              <SubagentIcon
                accentIndex={accentById.get(selected.id) ?? 0}
                className="h-5 w-3"
              />
              <span className="truncate text-base font-medium">
                {formatSubagentName(selected.name)}
              </span>
            </>
          ) : null}
        </div>
        <div className="min-h-0 flex-1">
          {selected ? (
            <SubagentTranscriptPane
              key={`${selected.id}:${selected.status}`}
              threadId={selected.id}
              running={selected.status !== "done"}
              worktreePath={worktreePath}
              sourcePaneId={paneId}
            />
          ) : (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              This subagent is no longer available.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-background px-8 py-8 [content-visibility:auto]">
      <div className="mx-auto max-w-3xl space-y-8">
        <section aria-labelledby="active-subagents-heading">
          <h2
            id="active-subagents-heading"
            className="mb-3 text-sm font-medium text-muted-foreground"
          >
            Active · {activeAgents.length}
          </h2>
          {activeAgents.length > 0 ? (
            activeAgents.map((agent) => (
              <AgentMenuRow
                key={agent.id}
                agent={agent}
                accentIndex={accentById.get(agent.id) ?? 0}
                onClick={
                  snapshot.transcriptAvailable
                    ? () => setSelectedId(agent.id)
                    : undefined
                }
              />
            ))
          ) : (
            <p className="py-1 text-sm text-muted-foreground">
              No active subagents
            </p>
          )}
        </section>

        <section aria-labelledby="done-subagents-heading">
          <h2
            id="done-subagents-heading"
            className="mb-3 text-sm font-medium text-muted-foreground"
          >
            Done · {doneAgents.length}
          </h2>
          {doneAgents.map((agent) => (
            <AgentMenuRow
              key={agent.id}
              agent={agent}
              accentIndex={accentById.get(agent.id) ?? 0}
              onClick={
                snapshot.transcriptAvailable
                  ? () => setSelectedId(agent.id)
                  : undefined
              }
            />
          ))}
        </section>

        {!snapshot.transcriptAvailable && agents.length > 0 ? (
          <p className="text-xs text-muted-foreground/70">
            Transcript viewing is available for Codex subagents.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function SubagentTranscriptPane({
  threadId,
  running,
  worktreePath,
  sourcePaneId,
}: {
  threadId: string;
  running: boolean;
  worktreePath: string;
  sourcePaneId: string;
}) {
  const [transcript, setTranscript] = useState<
    | { status: "loading" }
    | { status: "ready"; entries: NativeAutomationTranscriptEntry[] }
    | { status: "error"; message: string }
  >({ status: "loading" });

  useMountEffect(() => {
    let disposed = false;
    let reading = false;
    async function refresh() {
      if (reading) return;
      reading = true;
      try {
        const thread = await invoke<unknown>("read_subagent_transcript", {
          worktreePath,
          paneId: sourcePaneId,
          threadId,
        });
        if (!disposed) {
          setTranscript({
            status: "ready",
            entries: parseNativeAutomationTranscript(thread),
          });
        }
      } catch (error) {
        if (!disposed) setTranscript({ status: "error", message: String(error) });
      } finally {
        reading = false;
      }
    }
    refresh();
    const timer = running ? window.setInterval(refresh, 1_000) : undefined;
    return () => {
      disposed = true;
      if (timer) window.clearInterval(timer);
    };
  });

  if (transcript.status === "loading") {
    return <div className="h-full" aria-busy="true" aria-label="Loading transcript" />;
  }
  if (transcript.status === "error") {
    return (
      <p className="px-4 py-3 text-sm text-danger">
        Could not read this Codex transcript: {transcript.message}
      </p>
    );
  }
  if (transcript.entries.length === 0) {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">
        This subagent has not produced transcript items yet.
      </p>
    );
  }
  return (
    <div className="h-full min-h-0">
      <CodexTranscriptConversation
        entries={transcript.entries}
        running={running}
        contentClassName="mx-auto w-full max-w-3xl gap-4 px-6 py-8"
      />
    </div>
  );
}

const SUBAGENT_ACCENTS = [
  "text-emerald-400",
  "text-cyan-400",
  "text-violet-400",
  "text-lime-400",
  "text-amber-400",
] as const;

const IMPALA_MASK_STYLE = {
  WebkitMask: `url(${impalaMark}) center / contain no-repeat`,
  mask: `url(${impalaMark}) center / contain no-repeat`,
};

function subagentAccent(index: number) {
  return SUBAGENT_ACCENTS[index % SUBAGENT_ACCENTS.length];
}

function SubagentIcon({
  accentIndex,
  active = false,
  className = "h-7 w-4 -translate-y-px",
  indent = 0,
}: {
  accentIndex: number;
  active?: boolean;
  className?: string;
  indent?: number;
}) {
  return (
    <span
      aria-hidden="true"
      style={{ marginLeft: indent }}
      className={`${className} relative shrink-0 ${subagentAccent(accentIndex)} ${active ? "animate-pulse" : ""}`}
    >
      <span className="absolute left-1/2 top-1/2 aspect-square h-[85%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-current opacity-20 blur-[6px]" />
      <span style={IMPALA_MASK_STYLE} className="absolute inset-0 bg-current" />
    </span>
  );
}

function AgentMenuRow({
  agent,
  accentIndex,
  onClick,
}: {
  agent: SubagentSummary;
  accentIndex: number;
  onClick?: () => void;
}) {
  const content = (
    <>
      <SubagentIcon
        accentIndex={accentIndex}
        active={agent.status !== "done"}
        indent={Math.max(0, Math.min(agent.depth - 1, 4)) * 10}
      />
      <span className="min-w-0 flex-1 truncate text-foreground">
        {formatSubagentName(agent.name)}
      </span>
      <time className="text-xs text-muted-foreground">
        {formatSubagentAge(agent.updatedAt)}
      </time>
    </>
  );
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className="-mx-3 flex h-12 w-[calc(100%+1.5rem)] items-center gap-3 rounded-md px-3 text-left text-base outline-none hover:bg-accent/70"
    >
      {content}
    </button>
  ) : (
    <div className="-mx-3 flex h-12 w-[calc(100%+1.5rem)] items-center gap-3 rounded-md px-3 text-left text-base">
      {content}
    </div>
  );
}
