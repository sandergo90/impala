import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { openFileTab } from "../../lib/tab-actions";
import { dirname, isExternalHref, joinRelative } from "../../lib/path-utils";

const MARKDOWN_RE = /\.(md|mdx|markdown)$/i;

interface LinkNavOpts {
  getFilePath: () => string | null;
  getWorktreePath: () => string | null;
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

      if (isExternalHref(href)) {
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
        : joinRelative(dirname(filePath), pathOnly);
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
