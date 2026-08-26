import { ChevronRight, FileCode2, Terminal, Wrench } from "lucide-react";
import { defaultRehypePlugins, Streamdown } from "streamdown";
import {
  groupNativeAutomationTranscript,
  type NativeAutomationTranscriptBlock,
  type NativeAutomationTranscriptEntry,
} from "../lib/native-automation-transcript";
import { markdownComponents } from "./markdownComponents";
import { Bubble, BubbleContent } from "./ui/bubble";
import {
  Marker,
  MarkerContent,
  MarkerIcon,
} from "./ui/marker";
import {
  Message,
  MessageContent,
  MessageFooter,
} from "./ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "./ui/message-scroller";

export function CodexTranscriptConversation({
  entries,
  running,
  contentClassName = "gap-4 px-4 py-4",
}: {
  entries: NativeAutomationTranscriptEntry[];
  running: boolean;
  contentClassName?: string;
}) {
  const blocks = groupNativeAutomationTranscript(entries);
  return (
    <MessageScrollerProvider autoScroll={running}>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent className={contentClassName}>
            {blocks.map((block) => (
              <MessageScrollerItem
                key={block.id}
                messageId={block.id}
                scrollAnchor={block.kind === "user"}
              >
                <TranscriptBlock block={block} />
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

function TranscriptBlock({ block }: { block: NativeAutomationTranscriptBlock }) {
  if (block.kind === "activity") return <TranscriptActivity block={block} />;
  if (block.kind === "reasoning") {
    return (
      <div className="text-sm text-muted-foreground">
        <TranscriptMarkdown content={block.text} />
      </div>
    );
  }
  if (block.kind === "status") {
    return (
      <Marker variant="separator">
        <MarkerContent>{block.text}</MarkerContent>
      </Marker>
    );
  }
  const align = block.kind === "user" ? "end" : "start";
  const variant = block.kind === "user"
    ? "secondary"
    : block.isTurnResult
      ? "tinted"
      : "ghost";
  return (
    <Message align={align}>
      <MessageContent>
        <Bubble align={align} variant={variant}>
          <BubbleContent className="text-base">
            <TranscriptMarkdown content={block.text} />
          </BubbleContent>
        </Bubble>
        {block.isTurnResult ? <MessageFooter>Result</MessageFooter> : null}
      </MessageContent>
    </Message>
  );
}

function TranscriptActivity({
  block,
}: {
  block: Extract<NativeAutomationTranscriptBlock, { kind: "activity" }>;
}) {
  const failed = block.tools.filter((tool) =>
    (tool.exitCode !== undefined && tool.exitCode !== 0) || tool.status === "failed"
  ).length;
  const active = block.tools.some((tool) =>
    tool.status === "inProgress" || tool.status === "running"
  );
  const commandsOnly = block.tools.every((tool) => tool.activity === "command");
  const noun = commandsOnly ? "command" : "tool";
  const label = `Ran ${block.tools.length} ${noun}${block.tools.length === 1 ? "" : "s"}`;
  const status = active ? "running" : failed > 0 ? `${failed} failed` : "completed";
  return (
    <div className="flex flex-col gap-2">
      {block.title ? (
        <div className="text-sm text-foreground">
          <TranscriptMarkdown content={block.title} />
        </div>
      ) : null}
      <details className="group/activity" open={active || failed > 0}>
        <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          <Marker className="py-1">
            <MarkerIcon>
              {commandsOnly ? <Terminal /> : <Wrench />}
            </MarkerIcon>
            <MarkerContent className="flex min-w-0 flex-1 items-center gap-2">
              <span>{label}</span>
              <span className="text-xs text-muted-foreground">{status}</span>
            </MarkerContent>
            <ChevronRight className="shrink-0 transition-transform group-open/activity:rotate-90" />
          </Marker>
        </summary>
        <div className="mt-1 flex flex-col gap-2 pl-6">
          {block.tools.map((tool) => (
            <TranscriptToolActivity key={tool.id} entry={tool} />
          ))}
        </div>
      </details>
    </div>
  );
}

function TranscriptMarkdown({ content }: { content: string }) {
  return (
    <Streamdown
      mode="static"
      components={markdownComponents}
      rehypePlugins={[
        defaultRehypePlugins.sanitize,
        defaultRehypePlugins.harden,
      ]}
    >
      {content}
    </Streamdown>
  );
}

function TranscriptToolActivity({
  entry,
}: {
  entry: Extract<NativeAutomationTranscriptEntry, { kind: "tool" }>;
}) {
  const Icon = entry.activity === "command"
    ? Terminal
    : entry.activity === "file"
      ? FileCode2
      : Wrench;
  const metadata = [
    entry.status,
    entry.exitCode === undefined ? undefined : `exit ${entry.exitCode}`,
  ].filter(Boolean).join(" · ");
  const summary = (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="truncate">{entry.summary}</span>
      {metadata && <span className="shrink-0 text-xs text-muted-foreground">{metadata}</span>}
    </span>
  );
  return (
    <Marker variant="border" className="px-1 py-2">
      <MarkerIcon>
        <Icon />
      </MarkerIcon>
      {entry.details ? (
        <details className="min-w-0 flex-1">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-sm [&::-webkit-details-marker]:hidden">
            {summary}
            <span className="shrink-0 text-xs text-muted-foreground">Details</span>
          </summary>
          <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted px-2 py-1.5 font-mono text-xs text-foreground">
            {entry.details}
          </pre>
        </details>
      ) : summary}
    </Marker>
  );
}
