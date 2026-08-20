export type NativeAutomationTranscriptEntry = {
  kind: "user" | "agent" | "tool" | "status";
  text: string;
};

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

function itemEntry(item: JsonRecord): NativeAutomationTranscriptEntry | null {
  const type = typeof item.type === "string" ? item.type : "";
  const content = text(item.content) || text(item.text);
  if (type === "userMessage" || type === "user_message") {
    return content ? { kind: "user", text: content } : null;
  }
  if (type === "agentMessage" || type === "agent_message") {
    return content ? { kind: "agent", text: content } : null;
  }
  if (type === "commandExecution" || type === "command_execution") {
    const command = typeof item.command === "string" ? `$ ${item.command}` : "Command";
    const output = typeof item.aggregatedOutput === "string"
      ? item.aggregatedOutput
      : typeof item.output === "string"
        ? item.output
        : "";
    const status = typeof item.status === "string" ? ` (${item.status})` : "";
    const exit = typeof item.exitCode === "number" ? ` -- exit ${item.exitCode}` : "";
    return { kind: "tool", text: `${command}${status}${exit}${output ? `\n${output}` : ""}` };
  }
  if (type === "mcpToolCall") {
    const server = typeof item.server === "string" ? item.server : "MCP";
    const tool = typeof item.tool === "string" ? `/${item.tool}` : " tool";
    const status = typeof item.status === "string" ? ` (${item.status})` : "";
    return { kind: "tool", text: `${server}${tool}${status}` };
  }
  if (type === "fileChange") {
    const status = typeof item.status === "string" ? ` (${item.status})` : "";
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
    return { kind: "tool", text: `Files changed${status}${changes ? `\n${changes}` : ""}` };
  }
  if (type && typeof item.status === "string") {
    return { kind: "status", text: `${type}: ${item.status}` };
  }
  return null;
}

/** Extract the compact, read-only subset used by the automation inspector. */
export function parseNativeAutomationTranscript(value: unknown): NativeAutomationTranscriptEntry[] {
  const root = record(value);
  const thread = record(root?.thread) ?? root;
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const entries: NativeAutomationTranscriptEntry[] = [];
  for (const rawTurn of turns) {
    const turn = record(rawTurn);
    if (!turn) continue;
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const rawItem of items) {
      const item = record(rawItem);
      const entry = item && itemEntry(item);
      if (entry) entries.push(entry);
    }
    if (typeof turn.status === "string") {
      entries.push({ kind: "status", text: `Turn ${turn.status}` });
    }
  }
  return entries;
}
