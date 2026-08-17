export type NativeCodexItem = {
  id: string;
  kind: string;
  title: string;
  text?: string;
  output?: string;
  status?: string;
  raw: Record<string, unknown>;
};

export type PendingCodexRequest = {
  requestId: unknown;
  method: string;
  params: Record<string, unknown>;
};

export type NativeCodexPaneState = {
  status: string;
  activeTurnId: string | null;
  items: NativeCodexItem[];
  error: string | null;
  usage: unknown;
  diff: unknown;
  requests: PendingCodexRequest[];
  unsupported: unknown[];
};

export const initialNativeCodexPaneState: NativeCodexPaneState = {
  status: "idle",
  activeTurnId: null,
  items: [],
  error: null,
  usage: null,
  diff: null,
  requests: [],
  unsupported: [],
};

export function seedNativeCodexPaneState(
  state: NativeCodexPaneState,
  pane: { currentTurnId?: string | null; state: string },
  snapshot?: {
    activeTurn?: string | null;
    status?: string | null;
    eventSequence?: number;
  },
): NativeCodexPaneState {
  const snapshotIsAuthoritative = Boolean(
    snapshot?.eventSequence || snapshot?.activeTurn || snapshot?.status,
  );
  const activeTurnId = snapshotIsAuthoritative
    ? (snapshot?.activeTurn ?? null)
    : (pane.currentTurnId ?? state.activeTurnId);
  return {
    ...state,
    activeTurnId,
    status:
      (snapshotIsAuthoritative ? snapshot?.status : null) ??
      (activeTurnId ? "working" : pane.state || state.status),
  };
}

const supportedRequestMethods = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textFrom(value: Record<string, unknown>): string | undefined {
  if (value.type === "userMessage" && Array.isArray(value.content)) {
    const text = value.content.flatMap((input) => {
      const item = object(input);
      return item?.type === "text" && typeof item.text === "string"
        ? [item.text]
        : [];
    });
    return text.length ? text.join("\n") : undefined;
  }
  if (value.type === "reasoning") {
    const text = [value.summary, value.content].flatMap((parts) =>
      Array.isArray(parts)
        ? parts.filter((part): part is string => typeof part === "string")
        : [],
    );
    return text.length ? text.join("\n") : undefined;
  }
  for (const key of ["text", "content", "message", "reasoning", "command"]) {
    if (typeof value[key] === "string") return value[key] as string;
  }
  return undefined;
}

function errorText(value: unknown, fallback: string): string {
  if (typeof value === "string" && value) return value;
  const error = object(value);
  if (!error) return fallback;
  const message = typeof error.message === "string" ? error.message : fallback;
  const details =
    typeof error.additionalDetails === "string"
      ? error.additionalDetails
      : null;
  return details ? `${message}: ${details}` : message;
}

function planText(params: Record<string, unknown>): string {
  const steps = Array.isArray(params.plan)
    ? params.plan.flatMap((value) => {
        const step = object(value);
        return typeof step?.step === "string"
          ? [
              `- [${typeof step.status === "string" ? step.status : "pending"}] ${step.step}`,
            ]
          : [];
      })
    : [];
  const explanation =
    typeof params.explanation === "string" ? [params.explanation] : [];
  return [...explanation, ...steps].join("\n");
}

function upsertItem(items: NativeCodexItem[], item: NativeCodexItem) {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  return index < 0
    ? [...items, item]
    : items.map((candidate, candidateIndex) =>
        candidateIndex === index ? { ...candidate, ...item } : candidate,
      );
}

export function nativeTerminalFallback(threadId: string) {
  return {
    kind: "terminal" as const,
    launch: "agent" as const,
    codexResumeThreadId: threadId,
  };
}

export function nativePaneDecision(
  existing: { transport: "native" | "terminal"; threadId: string } | null,
  enabled: boolean,
  compatible: boolean,
): "native" | "terminal" {
  if (existing?.transport === "native") return "native";
  if (existing?.transport === "terminal" || !enabled || !compatible)
    return "terminal";
  return "native";
}

export function eventThreadId(event: unknown): string | null {
  const envelope = object(event);
  const params = object(envelope?.params);
  const request = object(envelope?.request);
  const requestParams = object(request?.params);
  for (const candidate of [envelope, params, request, requestParams]) {
    if (typeof candidate?.threadId === "string") return candidate.threadId;
  }
  return null;
}

export function eventBelongsToThread(event: unknown, threadId: string) {
  return eventThreadId(event) === threadId;
}

export function pendingRequestFromEvent(
  event: unknown,
): PendingCodexRequest | null {
  const envelope = object(event);
  const params = object(envelope?.params);
  if (
    !envelope ||
    !params ||
    envelope.id === undefined ||
    !supportedRequestMethods.has(String(envelope.method))
  ) {
    return null;
  }
  return { requestId: envelope.id, method: String(envelope.method), params };
}

export function normalizeNativeCodexItem(
  item: unknown,
): NativeCodexItem | null {
  const raw = object(item);
  if (!raw || typeof raw.id !== "string") return null;
  const kind = typeof raw.type === "string" ? raw.type : "unknown";
  return {
    id: raw.id,
    kind,
    title: kind.replaceAll(/([A-Z])/g, " $1"),
    text: textFrom(raw),
    output:
      typeof raw.aggregatedOutput === "string"
        ? raw.aggregatedOutput
        : typeof raw.output === "string"
          ? raw.output
          : undefined,
    status: typeof raw.status === "string" ? raw.status : undefined,
    raw,
  };
}

function applyDelta(
  state: NativeCodexPaneState,
  itemId: string,
  delta: string,
  commandOutput: boolean,
) {
  return {
    ...state,
    items: state.items.map((item) =>
      item.id !== itemId
        ? item
        : {
            ...item,
            text: commandOutput ? item.text : `${item.text ?? ""}${delta}`,
            output: commandOutput
              ? `${item.output ?? ""}${delta}`
              : item.output,
            raw: {
              ...item.raw,
              ...(commandOutput
                ? { output: `${String(item.raw.output ?? "")}${delta}` }
                : { text: `${String(item.raw.text ?? "")}${delta}` }),
            },
          },
    ),
  };
}

export function reduceNativeCodexEvent(
  state: NativeCodexPaneState,
  event: unknown,
): NativeCodexPaneState {
  const envelope = object(event);
  if (!envelope) return state;
  if (envelope.type === "unsupported-server-request") {
    return {
      ...state,
      status: "failed",
      error: "Codex requested an unsupported action",
      unsupported: [...state.unsupported, envelope],
    };
  }

  const request = pendingRequestFromEvent(envelope);
  if (request) {
    return state.requests.some(
      (candidate) =>
        JSON.stringify(candidate.requestId) ===
        JSON.stringify(request.requestId),
    )
      ? state
      : { ...state, status: "waiting", requests: [...state.requests, request] };
  }

  const method = typeof envelope.method === "string" ? envelope.method : "";
  const params = object(envelope.params);
  const turn = object(params?.turn);
  if (method === "turn/started") {
    return {
      ...state,
      status: "working",
      activeTurnId: typeof turn?.id === "string" ? turn.id : state.activeTurnId,
    };
  }
  if (["turn/completed", "turn/interrupted", "turn/failed"].includes(method)) {
    return {
      ...state,
      status: method.slice(5),
      activeTurnId: null,
      error:
        method === "turn/failed"
          ? errorText(turn?.error ?? params?.error, "Codex turn failed")
          : null,
    };
  }
  if (method === "thread/status/changed") {
    const status = object(params?.status);
    return {
      ...state,
      status: typeof status?.type === "string" ? status.type : state.status,
    };
  }
  if (method === "thread/tokenUsage/updated") {
    return { ...state, usage: params?.tokenUsage ?? state.usage };
  }
  if (method === "turn/plan/updated" && params) {
    const turnId =
      typeof params.turnId === "string" ? params.turnId : "current";
    return {
      ...state,
      items: upsertItem(state.items, {
        id: `turn-plan:${turnId}`,
        kind: "plan",
        title: "Plan",
        text: planText(params),
        raw: { type: "plan", ...params },
      }),
    };
  }
  if (method === "turn/diff/updated")
    return { ...state, diff: params?.diff ?? params };
  if (method === "error")
    return {
      ...state,
      status: "failed",
      error: errorText(params?.error, "Codex error"),
    };

  const itemId = typeof params?.itemId === "string" ? params.itemId : null;
  if (itemId && typeof params?.delta === "string") {
    return applyDelta(
      state,
      itemId,
      params.delta,
      method === "item/commandExecution/outputDelta",
    );
  }
  if (
    itemId &&
    method === "item/fileChange/patchUpdated" &&
    Array.isArray(params?.changes)
  ) {
    return {
      ...state,
      items: state.items.map((item) =>
        item.id === itemId
          ? { ...item, raw: { ...item.raw, changes: params.changes } }
          : item,
      ),
    };
  }
  if (!method.includes("item/")) return state;
  const item = normalizeNativeCodexItem(params?.item);
  return item ? { ...state, items: upsertItem(state.items, item) } : state;
}

export function hydrateNativeCodexThread(
  thread: unknown,
): NativeCodexPaneState {
  const payload = object(object(thread)?.thread) ?? object(thread);
  const turns: unknown[] = Array.isArray(payload?.turns)
    ? (payload.turns as unknown[])
    : [];
  return turns.reduce<NativeCodexPaneState>((state, turn) => {
    const turnItems = object(turn)?.items;
    const items: unknown[] = Array.isArray(turnItems)
      ? (turnItems as unknown[])
      : [];
    return items.reduce<NativeCodexPaneState>((next, item) => {
      const normalized = normalizeNativeCodexItem(item);
      return normalized
        ? { ...next, items: upsertItem(next.items, normalized) }
        : next;
    }, state);
  }, initialNativeCodexPaneState);
}

export function mergeNativeCodexHydration(
  live: NativeCodexPaneState,
  hydrated: NativeCodexPaneState,
): NativeCodexPaneState {
  return {
    ...hydrated,
    ...live,
    items: [
      ...live.items,
      ...hydrated.items.filter(
        (item) => !live.items.some((liveItem) => liveItem.id === item.id),
      ),
    ],
    requests: live.requests,
  };
}

export type ToolQuestion = {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string }[];
  isOther: boolean;
  isSecret: boolean;
};

export function toolQuestions(params: Record<string, unknown>): ToolQuestion[] {
  return Array.isArray(params.questions)
    ? params.questions.flatMap((value) => {
        const question = object(value);
        if (!question || typeof question.id !== "string") return [];
        return [
          {
            id: question.id,
            header: String(question.header ?? question.id),
            question: String(question.question ?? ""),
            options: Array.isArray(question.options)
              ? question.options.flatMap((option) => {
                  const value = object(option);
                  return value && typeof value.label === "string"
                    ? [
                        {
                          label: value.label,
                          description: String(value.description ?? ""),
                        },
                      ]
                    : [];
                })
              : [],
            isOther: question.isOther === true,
            isSecret: question.isSecret === true,
          },
        ];
      })
    : [];
}

export function coerceMcpForm(
  schema: Record<string, unknown>,
  values: Record<string, string>,
): { content?: Record<string, string | number | boolean>; error?: string } {
  const properties = object(schema.properties) ?? {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.map(String) : [],
  );
  const content: Record<string, string | number | boolean> = {};
  for (const [key, definition] of Object.entries(properties)) {
    const raw = values[key] ?? "";
    if (!raw && required.has(key)) return { error: `${key} is required` };
    if (!raw) continue;
    const type = object(definition)?.type;
    if (type === "boolean") content[key] = raw === "true";
    else if (type === "number") {
      const number = Number(raw);
      if (!Number.isFinite(number)) return { error: `${key} must be a number` };
      content[key] = number;
    } else if (type === "integer") {
      const number = Number(raw);
      if (!Number.isFinite(number) || !Number.isInteger(number)) {
        return { error: `${key} must be an integer` };
      }
      content[key] = number;
    } else content[key] = raw;
    const choices = object(definition)?.enum;
    if (
      Array.isArray(choices) &&
      !choices.some((choice) => choice === content[key])
    ) {
      return { error: `${key} must use an offered value` };
    }
  }
  return { content };
}

export function serverRequestOutcome(
  request: PendingCodexRequest,
  accept: boolean,
  values: Record<string, string | string[]> = {},
): { result?: unknown; error?: unknown } {
  if (
    request.method === "item/commandExecution/requestApproval" ||
    request.method === "item/fileChange/requestApproval"
  ) {
    return { result: { decision: accept ? "accept" : "decline" } };
  }
  if (request.method === "item/tool/requestUserInput") {
    return {
      result: {
        answers: Object.fromEntries(
          toolQuestions(request.params).map((question) => [
            question.id,
            {
              answers: Array.isArray(values[question.id])
                ? values[question.id]
                : [values[question.id] ?? ""],
            },
          ]),
        ),
      },
    };
  }
  if (request.method === "mcpServer/elicitation/request") {
    const mode = request.params.mode;
    if (!accept)
      return { result: { action: mode === "url" ? "cancel" : "decline" } };
    if (mode === "url")
      return {
        error: {
          code: -32000,
          message: "Complete the elicitation in the supplied URL",
        },
      };
    const coerced = coerceMcpForm(
      object(request.params.requestedSchema) ?? {},
      values as Record<string, string>,
    );
    return coerced.error
      ? { error: { code: -32602, message: coerced.error } }
      : { result: { action: "accept", content: coerced.content } };
  }
  return {
    error: {
      code: -32000,
      message: accept
        ? "Impala cannot safely construct this permission grant"
        : "Permission declined by user",
    },
  };
}

export function collaborationTree(items: NativeCodexItem[]) {
  const nodes = new Map<
    string,
    { id: string; parentId: string | null; status?: string }
  >();
  for (const item of items) {
    if (item.kind === "collabAgentToolCall") {
      const parentId =
        typeof item.raw.senderThreadId === "string"
          ? item.raw.senderThreadId
          : null;
      const states = object(item.raw.agentsStates);
      const receivers = Array.isArray(item.raw.receiverThreadIds)
        ? item.raw.receiverThreadIds.filter(
            (id): id is string => typeof id === "string",
          )
        : [];
      for (const id of receivers) {
        const state = object(states?.[id]);
        nodes.set(id, {
          id,
          parentId,
          status:
            typeof state?.status === "string" ? state.status : item.status,
        });
      }
    }
    if (
      item.kind === "subAgentActivity" &&
      typeof item.raw.agentThreadId === "string"
    ) {
      nodes.set(item.raw.agentThreadId, {
        id: item.raw.agentThreadId,
        parentId: null,
        status: typeof item.raw.kind === "string" ? item.raw.kind : item.status,
      });
    }
  }
  return [...nodes.values()];
}
