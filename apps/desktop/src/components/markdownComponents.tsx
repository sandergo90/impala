import { createContext, useContext, useEffect, useState } from "react";
import type { Components } from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  oneDark,
  oneLight,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import { Check, Copy } from "lucide-react";
import { useUIStore } from "../store";
import { resolveThemeById } from "../themes/apply";
import { isExternalHref } from "../lib/path-utils";
import { fetchLinearAttachment, isLinearAttachment } from "../lib/linear-attachment";

/**
 * Provider lets a parent intercept relative-link clicks (e.g. open the linked
 * file in a new tab). Return `true` to mark the click handled; otherwise the
 * link falls through to the default external-link behavior.
 */
export const MarkdownLinkContext = createContext<
  ((href: string) => boolean | void) | null
>(null);

/**
 * Provider lets a parent rewrite relative `<img src>` values to a URL the
 * webview can load (e.g. via Tauri's `asset:` protocol). Return the rewritten
 * src, or `null`/`undefined` to leave it untouched.
 */
export const MarkdownImageContext = createContext<
  ((src: string) => string | null | undefined) | null
>(null);

function CodeBlock({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const activeThemeId = useUIStore((s) => s.activeThemeId);
  const customThemes = useUIStore((s) => s.customThemes);
  const isDark = resolveThemeById(activeThemeId, customThemes).type === "dark";

  const match = /language-(\w+)/.exec(className || "");
  const language = match ? match[1] : "text";
  const code = String(children).replace(/\n$/, "");

  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div className="relative group my-4">
      <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {language !== "text" && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-background/80 text-muted-foreground border border-border backdrop-blur">
            {language}
          </span>
        )}
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? "Copied" : "Copy code"}
          title={copied ? "Copied" : "Copy code"}
          className="h-6 w-6 flex items-center justify-center rounded border border-border bg-background/80 hover:bg-accent text-muted-foreground backdrop-blur"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      <SyntaxHighlighter
        language={language}
        style={(isDark ? oneDark : oneLight) as Record<string, React.CSSProperties>}
        PreTag="div"
        customStyle={{
          margin: 0,
          borderRadius: "0.375rem",
          padding: "1rem",
          fontSize: "0.875rem",
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

function LinearAttachmentImage({
  src,
  alt,
  title,
}: {
  src: string;
  alt?: string;
  title?: string;
}) {
  const linearApiKey = useUIStore((s) => s.linearApiKey);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!linearApiKey) {
      setError("Set your Linear API key in Settings to load this image");
      return;
    }
    let cancelled = false;
    setError(null);
    setDataUrl(null);
    fetchLinearAttachment(linearApiKey, src)
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [src, linearApiKey]);

  if (error) {
    return (
      <span className="inline-block text-xs text-muted-foreground border border-border rounded px-2 py-1 my-2">
        {alt || "Image"} — {error}
      </span>
    );
  }
  if (!dataUrl) {
    return (
      <span className="inline-block text-xs text-muted-foreground border border-border rounded px-2 py-1 my-2">
        Loading {alt || "image"}…
      </span>
    );
  }
  return (
    <img
      src={dataUrl}
      alt={alt ?? ""}
      title={title}
      className="max-w-full h-auto rounded border border-border my-4"
    />
  );
}

function MarkdownImage({
  src,
  alt,
  title,
}: {
  src?: string;
  alt?: string;
  title?: string;
}) {
  const resolveSrc = useContext(MarkdownImageContext);
  if (src && isLinearAttachment(src)) {
    return <LinearAttachmentImage src={src} alt={alt} title={title} />;
  }
  const resolved =
    src && resolveSrc && !isExternalHref(src) ? resolveSrc(src) ?? src : src;
  return (
    <img
      src={resolved}
      alt={alt ?? ""}
      title={title}
      className="max-w-full h-auto rounded border border-border my-4"
    />
  );
}

function MarkdownLink({
  href,
  children,
}: {
  href?: string;
  children?: React.ReactNode;
}) {
  const onLinkClick = useContext(MarkdownLinkContext);
  const className =
    "text-primary underline underline-offset-2 hover:text-primary/80";

  // Internal/relative link with an active interceptor — render without
  // target="_blank" and always preventDefault so the webview never navigates.
  if (href && onLinkClick && !isExternalHref(href)) {
    return (
      <a
        href={href}
        className={className}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onLinkClick(href);
        }}
      >
        {children}
      </a>
    );
  }

  return (
    <a
      href={href}
      className={className}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
}

export const markdownComponents: Partial<Components> = {
  code: ({ className, children, ...rest }) => {
    const isBlock = className?.startsWith("language-");
    if (isBlock) {
      return <CodeBlock className={className}>{children}</CodeBlock>;
    }
    return (
      <code
        className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono"
        {...rest}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => <>{children}</>,
  table: ({ children }) => (
    <div className="overflow-x-auto my-4">
      <table className="w-max min-w-full divide-y divide-border">
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th className="px-4 py-2 text-left text-sm font-semibold bg-muted align-top">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-4 py-2 text-sm border-t border-border align-top">
      {children}
    </td>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-4 border-muted-foreground/30 pl-4 italic my-4">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
  img: ({ src, alt, title }) => (
    <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt} title={title} />
  ),
  hr: () => <hr className="my-8 border-border" />,
  li: ({ children, className }) => {
    const isTaskItem = className?.includes("task-list-item");
    return (
      <li className={isTaskItem ? "list-none flex items-start gap-2" : undefined}>
        {children}
      </li>
    );
  },
};
