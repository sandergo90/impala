import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import YAML from "yaml";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import {
  markdownComponents,
  MarkdownImageContext,
  MarkdownLinkContext,
} from "./markdownComponents";
import { dirname, joinRelative } from "../lib/path-utils";
import { openFileTab } from "../lib/tab-actions";

const MARKDOWN_RE = /\.(md|mdx|markdown)$/i;

// Let class names survive sanitization — the markdown component overrides key
// off them (`language-*` for code/mermaid blocks, `task-list-item` for
// checklists). Acceptable for a local review tool; the alternative is losing
// syntax highlighting and task-list rendering.
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "className"],
  },
};

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[^\S\r\n]*(?:\r?\n|$)/;

/**
 * Split a leading YAML frontmatter block off the markdown source. Only a
 * block that parses to a plain object counts — anything else (broken YAML,
 * a scalar, a bare `---`) is left in the body untouched.
 */
function splitFrontmatter(content: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
} {
  const match = FRONTMATTER_RE.exec(content);
  if (match) {
    try {
      const parsed: unknown = YAML.parse(match[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return {
          frontmatter: parsed as Record<string, unknown>,
          body: content.slice(match[0].length),
        };
      }
    } catch {
      // fall through — render the document as-is
    }
  }
  return { frontmatter: null, body: content };
}

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function FrontmatterValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground/60">—</span>;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return <span className="font-mono text-sm">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-muted-foreground/60">—</span>;
    }
    if (value.every(isScalar)) {
      return (
        <span className="flex flex-wrap gap-1.5">
          {value.map((item, i) => (
            <span
              key={i}
              className="inline-block px-1.5 py-0.5 rounded bg-muted text-sm"
            >
              {String(item)}
            </span>
          ))}
        </span>
      );
    }
  }
  if (typeof value === "string") {
    return <span className="text-sm">{value}</span>;
  }
  // Nested structures: show as YAML in monospace rather than inventing a
  // recursive layout for a rare case.
  return (
    <pre className="font-mono text-sm whitespace-pre-wrap">
      {YAML.stringify(value).trimEnd()}
    </pre>
  );
}

function FrontmatterBlock({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data);
  if (entries.length === 0) return null;
  return (
    <div className="mb-6 rounded-md border border-border bg-muted/30 px-4 py-3">
      <table className="w-full border-collapse">
        <tbody>
          {entries.map(([key, value]) => (
            <tr key={key} className="align-top">
              <td className="pr-4 py-1 text-sm font-medium text-muted-foreground whitespace-nowrap w-0">
                {key}
              </td>
              <td className="py-1">
                <FrontmatterValue value={value} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function isPassthroughSrc(src: string): boolean {
  return (
    src.startsWith("data:") ||
    src.startsWith("blob:") ||
    src.startsWith("asset:") ||
    src.startsWith("http://") ||
    src.startsWith("https://")
  );
}

interface MarkdownPreviewProps {
  content: string;
  /** Worktree-relative path of the file being previewed. */
  filePath: string;
  worktreePath: string;
  className?: string;
}

export function MarkdownPreview({
  content,
  filePath,
  worktreePath,
  className,
}: MarkdownPreviewProps) {
  const { frontmatter, body } = useMemo(
    () => splitFrontmatter(content),
    [content],
  );

  // Rewrite relative <img src> to a webview-loadable asset URL, resolved
  // against the file's directory (ported from the prosemark image-src-resolver).
  const resolveImageSrc = (src: string): string | null => {
    if (isPassthroughSrc(src)) return null;
    const relDir = dirname(filePath);
    const joined = src.startsWith("/")
      ? src.replace(/^\/+/, "")
      : relDir
        ? `${relDir}/${src}`
        : src;
    return convertFileSrc(`${worktreePath}/${joined}`);
  };

  // Relative links: open markdown in a new tab, hand other files to the OS
  // (ported from the prosemark link-navigation extension).
  const handleLinkClick = (href: string): boolean => {
    const pathOnly = href.split(/[?#]/)[0];
    if (!pathOnly) return true;
    const resolved = pathOnly.startsWith("/")
      ? pathOnly.replace(/^\/+/, "")
      : joinRelative(dirname(filePath), pathOnly);
    if (!resolved) return true;
    if (MARKDOWN_RE.test(resolved)) {
      openFileTab(worktreePath, resolved, { forceNewTab: true, pin: true });
    } else {
      void shellOpen(`${worktreePath}/${resolved}`);
    }
    return true;
  };

  return (
    <div
      className={`markdown-preview overflow-auto select-text ${className ?? ""}`}
      // External links render as plain <a target="_blank"> in the shared
      // markdownComponents; intercept them here so http(s) open in the system
      // browser. Internal links stopPropagation before reaching this handler.
      onClick={(e) => {
        const anchor = (e.target as HTMLElement | null)?.closest?.("a[href]");
        if (!anchor) return;
        const href = anchor.getAttribute("href") ?? "";
        if (href.startsWith("http://") || href.startsWith("https://")) {
          e.preventDefault();
          void shellOpen(href);
        }
      }}
    >
      <article className="max-w-[70%] px-8 py-6">
        {frontmatter && <FrontmatterBlock data={frontmatter} />}
        <MarkdownImageContext.Provider value={resolveImageSrc}>
          <MarkdownLinkContext.Provider value={handleLinkClick}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
              components={markdownComponents}
            >
              {body}
            </ReactMarkdown>
          </MarkdownLinkContext.Provider>
        </MarkdownImageContext.Provider>
      </article>
    </div>
  );
}
