import { expect, test } from "bun:test";
import {
  collaborationTree,
  coerceMcpForm,
  eventBelongsToThread,
  hydrateNativeCodexThread,
  initialNativeCodexPaneState,
  mergeNativeCodexHydration,
  nativePaneDecision,
  pendingRequestFromEvent,
  reduceNativeCodexEvent,
  serverRequestOutcome,
  toolQuestions,
} from "./native-codex-pane-state.ts";

const threadId = "thread-1";

function notification(method, params = {}) {
  return { method, params: { threadId, ...params } };
}

function request(method, params = {}) {
  return { id: method, method, params: { threadId, ...params } };
}

test("isolates ordinary and nested unsupported events by thread", () => {
  expect(eventBelongsToThread(notification("item/completed"), threadId)).toBe(
    true,
  );
  expect(
    eventBelongsToThread(
      notification("item/completed", { threadId: "other" }),
      threadId,
    ),
  ).toBe(false);
  expect(
    eventBelongsToThread(
      { type: "unsupported-server-request", request: { params: { threadId } } },
      threadId,
    ),
  ).toBe(true);
  expect(
    eventBelongsToThread(
      {
        type: "unsupported-server-request",
        request: { params: { threadId: "other" } },
      },
      threadId,
    ),
  ).toBe(false);
});

test("durable transport ownership takes precedence over the creation setting", () => {
  expect(
    nativePaneDecision({ transport: "native", threadId }, false, false),
  ).toBe("native");
  expect(
    nativePaneDecision({ transport: "terminal", threadId }, true, true),
  ).toBe("terminal");
  expect(nativePaneDecision(null, false, true)).toBe("terminal");
  expect(nativePaneDecision(null, true, false)).toBe("terminal");
  expect(nativePaneDecision(null, true, true)).toBe("native");
});

test("uses stable delta notification fields without losing prior item kinds", () => {
  let state = initialNativeCodexPaneState;
  state = reduceNativeCodexEvent(
    state,
    notification("item/started", {
      item: { id: "message", type: "agentMessage", text: "hel" },
    }),
  );
  state = reduceNativeCodexEvent(
    state,
    notification("item/agentMessage/delta", {
      turnId: "turn",
      itemId: "message",
      delta: "lo",
    }),
  );
  state = reduceNativeCodexEvent(
    state,
    notification("item/started", {
      item: { id: "plan", type: "plan", text: "one" },
    }),
  );
  state = reduceNativeCodexEvent(
    state,
    notification("item/plan/delta", {
      turnId: "turn",
      itemId: "plan",
      delta: " two",
    }),
  );
  state = reduceNativeCodexEvent(
    state,
    notification("item/started", {
      item: {
        id: "command",
        type: "commandExecution",
        command: "ls",
        aggregatedOutput: "finished\n",
      },
    }),
  );
  state = reduceNativeCodexEvent(
    state,
    notification("item/commandExecution/outputDelta", {
      turnId: "turn",
      itemId: "command",
      delta: "file\n",
    }),
  );
  state = reduceNativeCodexEvent(
    state,
    notification("item/started", {
      item: { id: "file", type: "fileChange", changes: [] },
    }),
  );
  state = reduceNativeCodexEvent(
    state,
    notification("item/fileChange/patchUpdated", {
      turnId: "turn",
      itemId: "file",
      changes: [{ path: "a.ts", diff: "@@" }],
    }),
  );

  expect(state.items.find((item) => item.id === "message")).toMatchObject({
    kind: "agentMessage",
    text: "hello",
  });
  expect(state.items.find((item) => item.id === "plan")).toMatchObject({
    kind: "plan",
    text: "one two",
  });
  expect(state.items.find((item) => item.id === "command")).toMatchObject({
    kind: "commandExecution",
    output: "finished\nfile\n",
  });
  expect(state.items.find((item) => item.id === "file")).toMatchObject({
    kind: "fileChange",
  });
  expect(state.items.find((item) => item.id === "file").raw.changes).toEqual([
    { path: "a.ts", diff: "@@" },
  ]);
});

test("reduces stable lifecycle, status, usage, diff, errors and unsupported requests", () => {
  let state = reduceNativeCodexEvent(
    initialNativeCodexPaneState,
    notification("turn/started", { turn: { id: "turn-1" } }),
  );
  state = reduceNativeCodexEvent(
    state,
    notification("thread/status/changed", {
      status: { type: "waiting", reason: "approval" },
    }),
  );
  state = reduceNativeCodexEvent(
    state,
    notification("thread/tokenUsage/updated", {
      turnId: "turn-1",
      tokenUsage: { total: 2 },
    }),
  );
  state = reduceNativeCodexEvent(
    state,
    notification("turn/diff/updated", { diff: "diff" }),
  );
  state = reduceNativeCodexEvent(
    state,
    notification("turn/failed", { turn: { error: "failed" } }),
  );
  expect(state.error).toBe("failed");
  state = reduceNativeCodexEvent(state, {
    type: "unsupported-server-request",
    request: { params: { threadId } },
  });

  expect(state.status).toBe("failed");
  expect(state.usage).toEqual({ total: 2 });
  expect(state.diff).toBe("diff");
  expect(state.error).toBe("Codex requested an unsupported action");
  expect(state.unsupported).toHaveLength(1);
});

test("normalizes stable user, reasoning, plan and structured error payloads", () => {
  let state = reduceNativeCodexEvent(
    initialNativeCodexPaneState,
    notification("item/completed", {
      item: {
        id: "user",
        type: "userMessage",
        content: [
          { type: "text", text: "Read this" },
          { type: "localImage", path: "/tmp/example.png" },
          { type: "image", url: "https://example.test/image.png" },
        ],
      },
    }),
  );
  state = reduceNativeCodexEvent(
    state,
    notification("item/completed", {
      item: {
        id: "reasoning",
        type: "reasoning",
        summary: ["Summary"],
        content: ["Detail"],
      },
    }),
  );
  state = reduceNativeCodexEvent(
    state,
    notification("turn/plan/updated", {
      turnId: "turn-1",
      explanation: "Working through the files",
      plan: [{ step: "Inspect", status: "inProgress" }],
    }),
  );
  state = reduceNativeCodexEvent(
    state,
    notification("error", {
      turnId: "turn-1",
      willRetry: false,
      error: { message: "Quota reached", additionalDetails: "Try later" },
    }),
  );

  expect(state.items.find((item) => item.id === "user")).toMatchObject({
    text: "Read this",
  });
  expect(
    state.items.find((item) => item.id === "user").raw.content,
  ).toHaveLength(3);
  expect(state.items.find((item) => item.id === "reasoning")).toMatchObject({
    text: "Summary\nDetail",
  });
  expect(
    state.items.find((item) => item.id === "turn-plan:turn-1"),
  ).toMatchObject({
    kind: "plan",
    text: "Working through the files\n- [inProgress] Inspect",
  });
  expect(state.error).toBe("Quota reached: Try later");
});

test("hydrates without erasing newer live content and groups collaboration activity", () => {
  const hydrated = hydrateNativeCodexThread({
    thread: {
      turns: [{ items: [{ id: "old", type: "agentMessage", text: "old" }] }],
    },
  });
  const live = reduceNativeCodexEvent(
    initialNativeCodexPaneState,
    notification("item/completed", {
      item: {
        id: "collab",
        type: "collabAgentToolCall",
        senderThreadId: "parent",
        receiverThreadIds: ["child-1", "child-2"],
        agentsStates: {
          "child-1": { status: "running" },
          "child-2": { status: "completed" },
        },
        status: "inProgress",
      },
    }),
  );
  const merged = mergeNativeCodexHydration(live, hydrated);

  expect(merged.items.map((item) => item.id)).toEqual(["collab", "old"]);
  expect(collaborationTree(live.items)).toEqual([
    { id: "child-1", parentId: "parent", status: "running" },
    { id: "child-2", parentId: "parent", status: "completed" },
  ]);
  const staleHydration = hydrateNativeCodexThread({
    thread: {
      turns: [
        { items: [{ id: "collab", type: "agentMessage", text: "stale" }] },
      ],
    },
  });
  expect(
    mergeNativeCodexHydration(live, staleHydration).items[0].raw.status,
  ).toBe("inProgress");
  const activity = reduceNativeCodexEvent(
    live,
    notification("item/completed", {
      item: {
        id: "activity",
        type: "subAgentActivity",
        agentThreadId: "child-3",
        kind: "running",
        agentPath: "child",
      },
    }),
  );
  expect(collaborationTree(activity.items)).toContainEqual({
    id: "child-3",
    parentId: null,
    status: "running",
  });
});

test("keeps tool option labels and supports other and secret answers", () => {
  const questions = toolQuestions({
    questions: [
      {
        id: "q",
        header: "Access",
        question: "Choose",
        options: [{ label: "Read", description: "Read-only access" }],
        isOther: true,
        isSecret: true,
      },
    ],
  });

  expect(questions).toEqual([
    {
      id: "q",
      header: "Access",
      question: "Choose",
      options: [{ label: "Read", description: "Read-only access" }],
      isOther: true,
      isSecret: true,
    },
  ]);
  expect(
    serverRequestOutcome(
      pendingRequestFromEvent(
        request("item/tool/requestUserInput", { questions }),
      ),
      true,
      {
        q: ["Read"],
      },
    ),
  ).toEqual({ result: { answers: { q: { answers: ["Read"] } } } });
});

test("uses exact result envelopes for all supported server request methods", () => {
  expect(
    serverRequestOutcome(
      pendingRequestFromEvent(request("item/commandExecution/requestApproval")),
      true,
    ),
  ).toEqual({
    result: { decision: "accept" },
  });
  expect(
    serverRequestOutcome(
      pendingRequestFromEvent(request("item/fileChange/requestApproval")),
      false,
    ),
  ).toEqual({
    result: { decision: "decline" },
  });
  expect(
    serverRequestOutcome(
      pendingRequestFromEvent(
        request("mcpServer/elicitation/request", {
          mode: "form",
          requestedSchema: {
            properties: {
              count: { type: "number" },
              enabled: { type: "boolean" },
            },
            required: ["count"],
          },
        }),
      ),
      true,
      { count: "2", enabled: "true" },
    ),
  ).toEqual({
    result: { action: "accept", content: { count: 2, enabled: true } },
  });
  expect(
    serverRequestOutcome(
      pendingRequestFromEvent(
        request("mcpServer/elicitation/request", {
          mode: "openai/form",
          requestedSchema: { properties: { name: { type: "string" } } },
        }),
      ),
      true,
      { name: "Codex" },
    ),
  ).toEqual({ result: { action: "accept", content: { name: "Codex" } } });
  expect(
    serverRequestOutcome(
      pendingRequestFromEvent(
        request("mcpServer/elicitation/request", { mode: "url" }),
      ),
      false,
    ),
  ).toEqual({
    result: { action: "cancel" },
  });
  expect(
    serverRequestOutcome(
      pendingRequestFromEvent(request("item/permissions/requestApproval")),
      false,
    ),
  ).toEqual({
    error: { code: -32000, message: "Permission declined by user" },
  });
});

test("validates required MCP forms before producing content", () => {
  expect(
    coerceMcpForm(
      { properties: { name: { type: "string" } }, required: ["name"] },
      { name: "" },
    ),
  ).toEqual({ error: "name is required" });
  expect(
    coerceMcpForm(
      { properties: { action: { type: "string", enum: ["read"] } } },
      { action: "write" },
    ),
  ).toEqual({ error: "action must use an offered value" });
});
