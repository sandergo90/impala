// Hybrid link routing for the ProseMark editor.
//
// - Fragment-only or absolute-scheme links (incl. http/https): open externally
//   via the system shell (or no-op for non-http schemes).
// - Workspace-relative .md / .mdx / .markdown links: open as an in-app file tab.
// - Other workspace-relative paths (.png, .pdf, …): hand off to the OS via
//   the shell `open` command.
//
// Mirrors FileViewer.tsx:377 (`handleLink`) — same scheme/fragment skip logic
// and same `resolveRelativePath` semantics. Impala uses
// `@tauri-apps/plugin-shell`'s `open` for both URLs and file paths
// (see PrHoverCard, RevealInFinderButton, etc.); we route through it here.

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { openFileTab } from "../../lib/tab-actions";
import { dirname } from "../../lib/path-utils";

const MARKDOWN_RE = /\.(md|mdx|markdown)$/i;
const ABSOLUTE_RE = /^[a-z][a-z0-9+.-]*:/i;

interface LinkNavOpts {
  getFilePath: () => string | null;
  getWorktreePath: () => string | null;
}

function resolveRelative(baseDir: string, rel: string): string {
  const segs = baseDir ? baseDir.split("/").filter(Boolean) : [];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (segs.length > 0) segs.pop();
      continue;
    }
    segs.push(seg);
  }
  return segs.join("/");
}

export function linkNavigation(opts: LinkNavOpts): Extension {
  return EditorView.domEventHandlers({
    click(event) {
      const target = event.target as HTMLElement | null;
      const a = target?.closest<HTMLAnchorElement>("a[href]");
      if (!a) return false;
      const href = a.getAttribute("href") ?? "";
      if (!href) return false;
      event.preventDefault();
      event.stopPropagation();

      // Fragment-only or absolute scheme → external (only http/https go to the
      // OS; other schemes are no-ops to match FileViewer's behavior).
      if (
        href.startsWith("#") ||
        href.startsWith("//") ||
        ABSOLUTE_RE.test(href)
      ) {
        if (href.startsWith("http://") || href.startsWith("https://")) {
          void shellOpen(href);
        }
        return true;
      }

      const filePath = opts.getFilePath();
      const worktree = opts.getWorktreePath();
      if (!filePath || !worktree) return true;

      const pathOnly = href.split(/[?#]/)[0];
      if (!pathOnly) return true;
      const resolved = pathOnly.startsWith("/")
        ? pathOnly.replace(/^\/+/, "")
        : resolveRelative(dirname(filePath), pathOnly);
      if (!resolved) return true;

      if (MARKDOWN_RE.test(resolved)) {
        openFileTab(worktree, resolved, { forceNewTab: true, pin: true });
      } else {
        void shellOpen(`${worktree}/${resolved}`);
      }
      return true;
    },
  });
}
