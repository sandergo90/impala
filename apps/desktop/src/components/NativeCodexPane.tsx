import { useCallback, useRef, useState, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@/lib/invoke";
import { useMountEffect } from "../hooks/useMountEffect";
import type { NativeCodexSettings } from "../lib/agent";
import {
  collaborationTree,
  eventBelongsToThread,
  hydrateNativeCodexThread,
  initialNativeCodexPaneState,
  mergeNativeCodexHydration,
  nativePaneDecision,
  reduceNativeCodexEvent,
  seedNativeCodexPaneState,
  serverRequestOutcome,
  toolQuestions,
  type NativeCodexItem,
  type NativeCodexPaneState,
  type PendingCodexRequest,
} from "../lib/native-codex-pane-state";
import { MarkdownPreview } from "./MarkdownPreview";

type Pane = {
  threadId: string;
  transport: "native" | "terminal";
  settings: NativeCodexSettings;
  currentTurnId?: string | null;
  state: string;
};

type NativeCodexGateProps = {
  worktreePath: string;
  paneId: string;
  settings: NativeCodexSettings | null;
  initialPrompt?: string;
  fallback: (resumeThreadId?: string) => ReactNode;
  onTerminalFallback: (threadId: string) => void;
};

export function NativeCodexGate({
  worktreePath,
  paneId,
  settings,
  initialPrompt,
  fallback,
  onTerminalFallback,
}: NativeCodexGateProps) {
  const [existing, setExisting] = useState<Pane | null | undefined>(undefined);
  const [supported, setSupported] = useState<boolean | undefined>(undefined);

  useMountEffect(() => {
    void invoke<Pane | null>("get_native_codex_pane", { worktreePath, paneId })
      .then(async (pane) => {
        setExisting(pane);
        if (!pane && settings) {
          setSupported(
            await invoke<boolean>("preflight_native_codex_settings", {
              settings,
            }).catch(() => false),
          );
        } else {
          setSupported(false);
        }
      })
      .catch(() => {
        setExisting(null);
        setSupported(false);
      });
  });

  if (
    existing === undefined ||
    (!existing && settings && supported === undefined)
  ) {
    return <PaneLoading label="Preparing Codex…" />;
  }

  const decision = nativePaneDecision(
    existing,
    Boolean(settings),
    existing?.transport === "native" || Boolean(supported),
  );
  if (decision === "terminal") {
    return fallback(existing?.threadId);
  }

  return (
    <NativeCodexPane
      worktreePath={worktreePath}
      paneId={paneId}
      settings={existing?.settings ?? settings!}
      initialPrompt={existing ? undefined : initialPrompt}
      onTerminalFallback={onTerminalFallback}
    />
  );
}

function PaneLoading({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}

function ItemCard({
  item,
  worktreePath,
}: {
  item: NativeCodexItem;
  worktreePath: string;
}) {
  const raw = item.raw;
  const isMarkdown = ["agentMessage", "userMessage", "plan"].includes(
    item.kind,
  );
  const isReasoning = item.kind === "reasoning";
  const isCommand = item.kind === "commandExecution";
  const isMcp = item.kind === "mcpToolCall";
  const isFileChange = item.kind === "fileChange";
  const isCollaboration = ["collabAgentToolCall", "subAgentActivity"].includes(
    item.kind,
  );
  const known =
    isMarkdown ||
    isReasoning ||
    isCommand ||
    isMcp ||
    isFileChange ||
    isCollaboration;
  const title = item.status ? `${item.title} -- ${item.status}` : item.title;
  const userImages = Array.isArray(raw.content)
    ? raw.content.flatMap((entry) => {
        const input = asObject(entry);
        if (input?.type === "image" && typeof input.url === "string")
          return [input.url];
        if (input?.type === "localImage" && typeof input.path === "string")
          return [convertFileSrc(input.path)];
        return [];
      })
    : [];

  return (
    <section className="mb-3 rounded border border-border p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
        {title}
      </h3>
      {isMarkdown && item.text ? (
        <MarkdownPreview
          content={item.text}
          filePath="codex-thread.md"
          worktreePath={worktreePath}
          className="max-h-96"
        />
      ) : null}
      {item.kind === "userMessage" && userImages.length ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {userImages.map((src) => (
            <img
              key={src}
              src={src}
              alt="User-provided image"
              className="max-h-64 max-w-full rounded border"
            />
          ))}
        </div>
      ) : null}
      {isReasoning ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">
          {item.text}
        </pre>
      ) : null}
      {isCommand ? (
        <div className="space-y-2 text-xs">
          <pre className="overflow-auto whitespace-pre-wrap">
            {String(raw.command ?? item.text ?? "")}
          </pre>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap">
            {item.output ?? ""}
          </pre>
        </div>
      ) : null}
      {isMcp ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">
          {JSON.stringify(raw, null, 2)}
        </pre>
      ) : null}
      {isFileChange ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">
          {JSON.stringify(raw.changes ?? raw, null, 2)}
        </pre>
      ) : null}
      {isCollaboration ? (
        <pre className="text-xs">{JSON.stringify(raw, null, 2)}</pre>
      ) : null}
      {!known ? (
        <details>
          <summary className="cursor-pointer text-sm">
            Unknown native item
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto text-xs">
            {JSON.stringify(raw, null, 2)}
          </pre>
        </details>
      ) : null}
    </section>
  );
}

type RequestCardProps = {
  request: PendingCodexRequest;
  onRespond: (
    accept: boolean,
    values?: Record<string, string | string[]>,
  ) => void;
};

function RequestCard({ request, onRespond }: RequestCardProps) {
  const [values, setValues] = useState<Record<string, string | string[]>>({});
  const questions = toolQuestions(request.params);
  const mode = String(request.params.mode ?? "");
  const schema = asObject(request.params.requestedSchema);
  const properties = asObject(schema?.properties) ?? {};
  const permission = request.method === "item/permissions/requestApproval";
  const isToolInput = request.method === "item/tool/requestUserInput";
  const isMcp = request.method === "mcpServer/elicitation/request";
  const isUrlMcp = isMcp && mode === "url";

  const update = (id: string, value: string) => {
    setValues((current) => ({ ...current, [id]: value }));
  };

  return (
    <section
      className="mb-2 rounded border border-warning/60 p-3"
      role="group"
      aria-label={`Codex request: ${request.method}`}
    >
      <p className="text-sm font-medium">Codex needs a decision</p>
      <p className="mb-3 text-xs text-muted-foreground">{request.method}</p>
      {isToolInput
        ? questions.map((question) => (
            <fieldset key={question.id} className="mb-3 space-y-2">
              <legend className="font-medium text-sm">{question.header}</legend>
              <p className="text-sm">{question.question}</p>
              {question.options.map((option) => (
                <label
                  key={option.label}
                  className="flex cursor-pointer gap-2 text-sm"
                >
                  <input
                    type="radio"
                    name={question.id}
                    checked={values[question.id] === option.label}
                    onChange={() => update(question.id, option.label)}
                  />
                  <span>
                    {option.label}
                    {option.description ? (
                      <span className="ml-1 text-muted-foreground">
                        -- {option.description}
                      </span>
                    ) : null}
                  </span>
                </label>
              ))}
              {(question.isOther || question.options.length === 0) && (
                <input
                  aria-label={`${question.header} answer`}
                  type={question.isSecret ? "password" : "text"}
                  value={
                    typeof values[question.id] === "string"
                      ? values[question.id]
                      : ""
                  }
                  onChange={(event) => update(question.id, event.target.value)}
                  className="w-full rounded border bg-background p-1"
                />
              )}
            </fieldset>
          ))
        : null}
      {isMcp && isUrlMcp ? (
        <div className="mb-3 text-sm">
          <p>
            {String(
              request.params.message ??
                "Complete this request in the supplied URL.",
            )}
          </p>
          {typeof request.params.url === "string" ? (
            <a
              className="break-all underline"
              href={request.params.url}
              target="_blank"
              rel="noreferrer"
            >
              {request.params.url}
            </a>
          ) : null}
        </div>
      ) : null}
      {isMcp && !isUrlMcp
        ? Object.entries(properties).map(([name, definition]) => {
            const field = asObject(definition);
            const type = String(field?.type ?? "string");
            const choices = Array.isArray(field?.enum) ? field.enum : [];
            return (
              <label key={name} className="mb-2 block text-sm">
                <span className="mb-1 block">{name}</span>
                {type === "boolean" || choices.length ? (
                  <select
                    aria-label={name}
                    value={String(values[name] ?? "")}
                    onChange={(event) => update(name, event.target.value)}
                    className="w-full rounded border bg-background p-1"
                  >
                    <option value="">Select</option>
                    {(choices.length ? choices : [true, false]).map(
                      (choice) => (
                        <option key={String(choice)} value={String(choice)}>
                          {String(choice)}
                        </option>
                      ),
                    )}
                  </select>
                ) : (
                  <input
                    aria-label={name}
                    type={
                      type === "number" || type === "integer"
                        ? "number"
                        : "text"
                    }
                    value={typeof values[name] === "string" ? values[name] : ""}
                    onChange={(event) => update(name, event.target.value)}
                    className="w-full rounded border bg-background p-1"
                  />
                )}
              </label>
            );
          })
        : null}
      <div className="flex gap-2">
        {!permission && !isUrlMcp ? (
          <button
            type="button"
            className="rounded border px-2 py-1 text-sm"
            onClick={() => onRespond(true, values)}
          >
            Approve
          </button>
        ) : null}
        <button
          type="button"
          className="rounded border px-2 py-1 text-sm"
          onClick={() => onRespond(false, values)}
        >
          {permission ? "Reject permission" : isUrlMcp ? "Cancel" : "Decline"}
        </button>
      </div>
    </section>
  );
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type NativeCodexPaneProps = {
  worktreePath: string;
  paneId: string;
  settings: NativeCodexSettings;
  initialPrompt?: string;
  onTerminalFallback: (threadId: string) => void;
};

function NativeCodexPane({
  worktreePath,
  paneId,
  settings,
  initialPrompt,
  onTerminalFallback,
}: NativeCodexPaneProps) {
  const [pane, setPane] = useState<Pane | null>(null);
  const [state, setState] = useState<NativeCodexPaneState>(
    initialNativeCodexPaneState,
  );
  const [text, setText] = useState("");
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const threadIdRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const opened = await invoke<Pane>("open_native_codex_pane", {
      input: { worktreePath, paneId, settings, initialPrompt },
    });
    threadIdRef.current = opened.threadId;
    setPane(opened);

    const thread = await invoke<unknown>("read_native_codex_pane", {
      worktreePath,
      paneId,
    });
    const snapshot = await invoke<{
      threads: Array<{
        threadId: string;
        activeTurn?: string | null;
        status?: string | null;
        eventSequence?: number;
        pendingServerRequests: PendingCodexRequest[];
      }>;
    }>("get_codex_app_server_snapshot");
    const threadSnapshot = snapshot.threads.find(
      (entry) => entry.threadId === opened.threadId,
    );
    const pending = threadSnapshot?.pendingServerRequests ?? [];

    setState((current) => {
      const merged = mergeNativeCodexHydration(
        current,
        hydrateNativeCodexThread(thread),
      );
      const requests = pending.reduce(
        (all, candidate) =>
          all.some(
            (request) =>
              JSON.stringify(request.requestId) ===
              JSON.stringify(candidate.requestId),
          )
            ? all
            : [...all, candidate],
        merged.requests,
      );
      return seedNativeCodexPaneState(
        { ...merged, requests },
        opened,
        threadSnapshot,
      );
    });
  }, [initialPrompt, paneId, settings, worktreePath]);

  useMountEffect(() => {
    void refresh().catch((reason) => setError(String(reason)));
    let unlisten: (() => void) | undefined;
    void listen<unknown>("codex-app-server-event", (event) => {
      const threadId = threadIdRef.current;
      if (threadId && eventBelongsToThread(event.payload, threadId)) {
        setState((current) => reduceNativeCodexEvent(current, event.payload));
      }
    }).then((stop) => {
      unlisten = stop;
    });
    return () => unlisten?.();
  });

  const send = useCallback(async () => {
    if (!text.trim() && !imagePath) return;
    try {
      await invoke("send_native_codex_pane_input", {
        worktreePath,
        paneId,
        input: [
          ...(text.trim() ? [{ type: "text", text: text.trim() }] : []),
          ...(imagePath ? [{ type: "localImage", path: imagePath }] : []),
        ],
      });
      setText("");
      setImagePath(null);
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  }, [imagePath, paneId, text, worktreePath]);

  const respond = useCallback(
    async (
      request: PendingCodexRequest,
      accept: boolean,
      values?: Record<string, string | string[]>,
    ) => {
      const outcome = serverRequestOutcome(request, accept, values);
      try {
        await invoke("respond_to_codex_app_server_request", {
          requestId: request.requestId,
          result: outcome.result ?? null,
          error: outcome.error ?? null,
        });
        setState((current) => ({
          ...current,
          requests: current.requests.filter(
            (candidate) =>
              JSON.stringify(candidate.requestId) !==
              JSON.stringify(request.requestId),
          ),
        }));
      } catch (reason) {
        setError(String(reason));
      }
    },
    [],
  );

  if (!pane) return <PaneLoading label="Starting native Codex…" />;

  const archived = pane.state === "archived";
  const activity = collaborationTree(state.items);
  const active = Boolean(state.activeTurnId);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <span className="rounded bg-muted px-2 py-1">
          Codex {archived ? "archived" : state.status}
        </span>
        <span className="truncate text-muted-foreground">{pane.threadId}</span>
        {state.usage ? (
          <span className="text-muted-foreground">
            Usage {JSON.stringify(state.usage)}
          </span>
        ) : null}
        <div className="ml-auto flex gap-1">
          <PaneAction
            disabled={archived}
            onClick={() =>
              invoke("resume_native_codex_pane", { worktreePath, paneId })
                .then(refresh)
                .catch((reason) => setError(String(reason)))
            }
          >
            Resume
          </PaneAction>
          <PaneAction
            disabled={active || archived}
            onClick={() =>
              invoke("fork_native_codex_pane", { worktreePath, paneId })
                .then(refresh)
                .catch((reason) => setError(String(reason)))
            }
          >
            Fork
          </PaneAction>
          <PaneAction
            disabled={archived}
            onClick={() =>
              invoke("review_native_codex_pane", {
                worktreePath,
                paneId,
              }).catch((reason) => setError(String(reason)))
            }
          >
            Review
          </PaneAction>
          <PaneAction
            onClick={() =>
              invoke("archive_native_codex_pane", {
                worktreePath,
                paneId,
                archived: !archived,
              })
                .then(refresh)
                .catch((reason) => setError(String(reason)))
            }
          >
            {archived ? "Unarchive" : "Archive"}
          </PaneAction>
          <PaneAction
            disabled={active || archived}
            onClick={() =>
              invoke<string>("handoff_native_codex_pane_to_terminal", {
                worktreePath,
                paneId,
              })
                .then(onTerminalFallback)
                .catch((reason) => setError(String(reason)))
            }
          >
            Open in terminal
          </PaneAction>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-auto p-3" aria-live="polite">
        {error ? <ErrorCard>{error}</ErrorCard> : null}
        {state.unsupported.map((entry, index) => (
          <ErrorCard key={index}>
            Unsupported Codex request: {JSON.stringify(entry)}
          </ErrorCard>
        ))}
        {state.requests.map((request) => (
          <RequestCard
            key={JSON.stringify(request.requestId)}
            request={request}
            onRespond={(accept, values) => respond(request, accept, values)}
          />
        ))}
        {activity.length ? (
          <section className="mb-3 rounded border p-3">
            <h3 className="text-xs font-semibold uppercase text-muted-foreground">
              Collaboration
            </h3>
            {activity.map((agent) => (
              <p key={agent.id} className="text-sm">
                {agent.parentId ? `${agent.parentId} → ` : ""}
                {agent.id} {agent.status ?? ""}
              </p>
            ))}
          </section>
        ) : null}
        {state.diff ? (
          <ItemCard
            item={{
              id: "live-diff",
              kind: "fileChange",
              title: "Live turn diff",
              raw: { changes: state.diff },
            }}
            worktreePath={worktreePath}
          />
        ) : null}
        {state.items.map((item) => (
          <ItemCard key={item.id} item={item} worktreePath={worktreePath} />
        ))}
      </main>
      <footer className="shrink-0 border-t border-border p-3">
        <div className="flex gap-2">
          <textarea
            aria-label="Message Codex"
            disabled={archived}
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="min-h-16 flex-1 rounded border bg-background p-2 text-sm disabled:opacity-50"
          />
          <div className="flex flex-col gap-1">
            <PaneAction
              disabled={archived}
              onClick={() =>
                open({
                  multiple: false,
                  directory: false,
                  filters: [
                    {
                      name: "Images",
                      extensions: ["png", "jpg", "jpeg", "webp", "gif"],
                    },
                  ],
                }).then(
                  (path) => typeof path === "string" && setImagePath(path),
                )
              }
            >
              Image
            </PaneAction>
            <PaneAction disabled={archived} onClick={send}>
              {active ? "Steer" : "Send"}
            </PaneAction>
            {active ? (
              <PaneAction
                onClick={() =>
                  invoke("interrupt_native_codex_pane", {
                    worktreePath,
                    paneId,
                  })
                    .then(refresh)
                    .catch((reason) => setError(String(reason)))
                }
              >
                Interrupt
              </PaneAction>
            ) : null}
          </div>
        </div>
        {imagePath ? (
          <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="truncate">Image: {imagePath}</span>
            <button
              type="button"
              aria-label="Remove selected image"
              className="rounded border px-1"
              onClick={() => setImagePath(null)}
            >
              Remove
            </button>
          </p>
        ) : null}
      </footer>
    </div>
  );
}

function PaneAction({
  children,
  disabled,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="rounded border px-2 py-1 text-sm disabled:opacity-50"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ErrorCard({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="mb-2 rounded border border-destructive/50 p-2 text-sm text-destructive"
    >
      {children}
    </div>
  );
}
