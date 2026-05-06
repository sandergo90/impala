import { EditorView, ViewPlugin } from "@codemirror/view";
import { useUIStore } from "../../store";
import { fetchLinearAttachment, isLinearAttachment } from "../../lib/linear-attachment";

const IMAGE_CLASSES = "max-w-full h-auto rounded border border-border my-4";
const PLACEHOLDER_CLASSES =
  "inline-block text-xs text-muted-foreground border border-border rounded px-2 py-1 my-2";
const PROCESSED_ATTR = "data-impala-linear-handled";

function makePlaceholder(text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = PLACEHOLDER_CLASSES;
  span.textContent = text;
  return span;
}

function processImage(
  img: HTMLImageElement,
  inflight: Set<AbortController>,
): void {
  if (img.getAttribute(PROCESSED_ATTR) === "1") return;
  const src = img.getAttribute("src");
  if (!src || !isLinearAttachment(src)) return;
  img.setAttribute(PROCESSED_ATTR, "1");

  const parent = img.parentNode;
  if (!parent) return;
  const alt = img.getAttribute("alt") ?? "";
  const title = img.getAttribute("title");

  const placeholder = makePlaceholder(`Loading ${alt || "image"}…`);
  parent.replaceChild(placeholder, img);

  const apiKey = useUIStore.getState().linearApiKey;
  if (!apiKey) {
    const err = makePlaceholder(
      `${alt || "Image"} — Set your Linear API key in Settings to load this image`,
    );
    if (placeholder.parentNode) {
      placeholder.parentNode.replaceChild(err, placeholder);
    }
    return;
  }

  const ctrl = new AbortController();
  inflight.add(ctrl);
  fetchLinearAttachment(apiKey, src)
    .then((dataUrl) => {
      inflight.delete(ctrl);
      if (ctrl.signal.aborted) return;
      const real = document.createElement("img");
      real.src = dataUrl;
      real.alt = alt;
      if (title) real.title = title;
      real.className = IMAGE_CLASSES;
      if (placeholder.parentNode) {
        placeholder.parentNode.replaceChild(real, placeholder);
      }
    })
    .catch((e) => {
      inflight.delete(ctrl);
      if (ctrl.signal.aborted) return;
      const err = makePlaceholder(`${alt || "Image"} — ${String(e)}`);
      if (placeholder.parentNode) {
        placeholder.parentNode.replaceChild(err, placeholder);
      }
    });
}

export function linearAttachmentWidget() {
  return ViewPlugin.fromClass(
    class {
      observer: MutationObserver;
      inflight = new Set<AbortController>();

      constructor(view: EditorView) {
        for (const img of view.dom.querySelectorAll("img")) {
          processImage(img as HTMLImageElement, this.inflight);
        }

        this.observer = new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const node of m.addedNodes) {
              if (node instanceof HTMLImageElement) {
                processImage(node, this.inflight);
              } else if (node instanceof HTMLElement) {
                for (const img of node.querySelectorAll("img")) {
                  processImage(img as HTMLImageElement, this.inflight);
                }
              }
            }
          }
        });
        this.observer.observe(view.dom, { childList: true, subtree: true });
      }

      destroy() {
        this.observer.disconnect();
        for (const ctrl of this.inflight) ctrl.abort();
        this.inflight.clear();
      }
    },
  );
}
