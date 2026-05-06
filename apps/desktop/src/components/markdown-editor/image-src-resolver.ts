import { EditorView, ViewPlugin } from "@codemirror/view";
import { convertFileSrc } from "@tauri-apps/api/core";
import { dirname } from "../../lib/path-utils";

interface ResolverOpts {
  getFilePath: () => string | null;
  getWorktreePath: () => string | null;
}

function isPassthrough(src: string): boolean {
  return (
    src.startsWith("data:") ||
    src.startsWith("blob:") ||
    src.startsWith("asset:") ||
    src.startsWith("http://") ||
    src.startsWith("https://")
  );
}

function resolveImgSrc(
  img: HTMLImageElement,
  filePath: string,
  worktreePath: string,
): void {
  const src = img.getAttribute("src");
  if (!src) return;
  if (isPassthrough(src)) return;
  const relDir = dirname(filePath);
  const joined = src.startsWith("/")
    ? src.replace(/^\/+/, "")
    : relDir
      ? `${relDir}/${src}`
      : src;
  const absolute = `${worktreePath}/${joined}`;
  img.src = convertFileSrc(absolute);
}

export function imageSrcResolver(opts: ResolverOpts) {
  return ViewPlugin.fromClass(
    class {
      observer: MutationObserver;

      constructor(view: EditorView) {
        const filePath = opts.getFilePath();
        const worktree = opts.getWorktreePath();
        if (filePath && worktree) this.fixAll(view.dom, filePath, worktree);

        this.observer = new MutationObserver((mutations) => {
          const f = opts.getFilePath();
          const w = opts.getWorktreePath();
          if (!f || !w) return;
          for (const m of mutations) {
            for (const node of m.addedNodes) {
              if (node instanceof HTMLImageElement) {
                resolveImgSrc(node, f, w);
              } else if (node instanceof HTMLElement) {
                for (const img of node.querySelectorAll("img")) {
                  resolveImgSrc(img as HTMLImageElement, f, w);
                }
              }
            }
          }
        });
        this.observer.observe(view.dom, { childList: true, subtree: true });
      }

      fixAll(root: HTMLElement, filePath: string, worktreePath: string) {
        for (const img of root.querySelectorAll("img")) {
          resolveImgSrc(img as HTMLImageElement, filePath, worktreePath);
        }
      }

      destroy() {
        this.observer.disconnect();
      }
    },
  );
}
