import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
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
        <MarkdownImageContext.Provider value={resolveImageSrc}>
          <MarkdownLinkContext.Provider value={handleLinkClick}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
              components={markdownComponents}
            >
              {content}
            </ReactMarkdown>
          </MarkdownLinkContext.Provider>
        </MarkdownImageContext.Provider>
      </article>
    </div>
  );
}
