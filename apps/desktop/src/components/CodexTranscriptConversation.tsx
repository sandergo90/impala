import { FileCode2, Terminal, Wrench } from "lucide-react";
import { defaultRehypePlugins, Streamdown } from "streamdown";
import type { NativeAutomationTranscriptEntry } from "../lib/native-automation-transcript";
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
  return (
    <MessageScrollerProvider autoScroll={running}>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent className={contentClassName}>
            {entries.map((entry) => (
              <MessageScrollerItem
                key={entry.id}
                messageId={entry.id}
                scrollAnchor={entry.kind === "user"}
              >
                <TranscriptEntry entry={entry} />
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

function TranscriptEntry({ entry }: { entry: NativeAutomationTranscriptEntry }) {
  if (entry.kind === "tool") return <TranscriptToolActivity entry={entry} />;
  if (entry.kind === "status") {
    return (
      <Marker variant="separator">
        <MarkerContent>{entry.text}</MarkerContent>
      </Marker>
    );
  }
  const align = entry.kind === "user" ? "end" : "start";
  const variant = entry.kind === "user"
    ? "secondary"
    : entry.isTurnResult
      ? "tinted"
      : "ghost";
  return (
    <Message align={align}>
      <MessageContent>
        <Bubble align={align} variant={variant}>
          <BubbleContent className="text-base">
            <TranscriptMarkdown content={entry.text} />
          </BubbleContent>
        </Bubble>
        {entry.isTurnResult && <MessageFooter>Result</MessageFooter>}
      </MessageContent>
    </Message>
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
