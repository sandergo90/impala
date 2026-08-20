type NativeAutomationTranscriptEntryBase = {
  id: string;
  kind: "user" | "agent" | "tool" | "status";
};

type NativeAutomationTranscriptMessage = NativeAutomationTranscriptEntryBase & {
  kind: "user" | "agent";
  text: string;
  isTurnResult?: boolean;
};

type NativeAutomationTranscriptTool = NativeAutomationTranscriptEntryBase & {
  kind: "tool";
  activity: "command" | "mcp" | "file";
  summary: string;
  status?: string;
  exitCode?: number;
  details?: string;
};

type NativeAutomationTranscriptStatus = NativeAutomationTranscriptEntryBase & {
  kind: "status";
  text: string;
};

export type NativeAutomationTranscriptEntry =
  | NativeAutomationTranscriptMessage
  | NativeAutomationTranscriptTool
  | NativeAutomationTranscriptStatus;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const item = record(part);
      return typeof item?.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function sourceId(item: JsonRecord, fallback: string): string {
  for (const key of ["id", "itemId", "item_id"]) {
    if (typeof item[key] === "string" && item[key]) return `item:${item[key]}`;
  }
  return fallback;
}

function detail(label: string, value: unknown): string {
  if (value === undefined) return "";
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized === undefined ? "" : `${label}\n${serialized}`;
  } catch {
    return "";
  }
}

function itemEntry(
  item: JsonRecord,
  id: string,
): NativeAutomationTranscriptEntry | null {
  const type = typeof item.type === "string" ? item.type : "";
  const content = text(item.content) || text(item.text);
  if (type === "userMessage" || type === "user_message") {
    return content ? { id, kind: "user", text: content } : null;
  }
  if (type === "agentMessage" || type === "agent_message") {
    return content ? { id, kind: "agent", text: content } : null;
  }
  if (type === "commandExecution" || type === "command_execution") {
    const command = typeof item.command === "string" ? `$ ${item.command}` : "Command";
    const output = typeof item.aggregatedOutput === "string"
      ? item.aggregatedOutput
      : typeof item.output === "string"
        ? item.output
        : "";
    return {
      id,
      kind: "tool",
      activity: "command",
      summary: command,
      status: typeof item.status === "string" ? item.status : undefined,
      exitCode: typeof item.exitCode === "number" ? item.exitCode : undefined,
      details: output || undefined,
    };
  }
  if (type === "mcpToolCall" || type === "mcp_tool_call") {
    const server = typeof item.server === "string" ? item.server : "MCP";
    const tool = typeof item.tool === "string" ? `/${item.tool}` : " tool";
    const details = [
      detail("Arguments", item.arguments ?? item.input ?? item.parameters),
      detail("Result", item.result ?? item.output),
    ].filter(Boolean).join("\n\n");
    return {
      id,
      kind: "tool",
      activity: "mcp",
      summary: `${server}${tool}`,
      status: typeof item.status === "string" ? item.status : undefined,
      details: details || undefined,
    };
  }
  if (type === "fileChange" || type === "file_change") {
    const changes = Array.isArray(item.changes)
      ? item.changes
        .map(record)
        .filter((change): change is JsonRecord => Boolean(change))
        .map((change) => {
          const kind = record(change.kind);
          const changeType = typeof kind?.type === "string"
            ? `${kind.type} `
            : typeof change.kind === "string"
              ? `${change.kind} `
              : "";
          const path = typeof change.path === "string" ? change.path : "";
          return `${changeType}${path}`.trim();
        })
        .filter(Boolean)
        .join("\n")
      : "";
    return {
      id,
      kind: "tool",
      activity: "file",
      summary: "Files changed",
      status: typeof item.status === "string" ? item.status : undefined,
      details: changes || undefined,
    };
  }
  if (type && typeof item.status === "string") {
    return { id, kind: "status", text: `${type}: ${item.status}` };
  }
  return null;
}

/** Extract the compact, read-only subset used by the automation inspector. */
export function parseNativeAutomationTranscript(value: unknown): NativeAutomationTranscriptEntry[] {
  const root = record(value);
  const thread = record(root?.thread) ?? root;
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const entries: NativeAutomationTranscriptEntry[] = [];
  for (const [turnIndex, rawTurn] of turns.entries()) {
    const turn = record(rawTurn);
    if (!turn) continue;
    const items = Array.isArray(turn.items) ? turn.items : [];
    const turnId = sourceId(turn, `turn:${turnIndex}`);
    const turnEntries: NativeAutomationTranscriptEntry[] = [];
    for (const [itemIndex, rawItem] of items.entries()) {
      const item = record(rawItem);
      const entry = item && itemEntry(item, sourceId(item, `${turnId}:item:${itemIndex}`));
      if (entry) turnEntries.push(entry);
    }
    for (let index = turnEntries.length - 1; index >= 0; index -= 1) {
      const entry = turnEntries[index];
      if (entry.kind === "agent") {
        entry.isTurnResult = true;
        break;
      }
    }
    entries.push(...turnEntries);
    if (typeof turn.status === "string") {
      entries.push({ id: `${turnId}:status`, kind: "status", text: `Turn ${turn.status}` });
    }
  }
  return entries;
}
