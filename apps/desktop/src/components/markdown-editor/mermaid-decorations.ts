import { Decoration, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { foldableSyntaxFacet, selectAllDecorationsOnSelectExtension } from "@prosemark/core";
import { cacheHeight, getCachedHeight, renderMermaid, type MermaidTheme } from "./mermaid-renderer";
import { useUIStore } from "../../store";
import { resolveThemeById } from "../../themes/apply";

let widgetCounter = 0;

function getMermaidTheme(): MermaidTheme {
  const state = useUIStore.getState();
  const theme = resolveThemeById(state.activeThemeId, state.customThemes);
  return theme.type;
}

const OBSERVER_KEY = Symbol("mermaidObserver");
type WrapperWithObserver = HTMLElement & { [OBSERVER_KEY]?: IntersectionObserver };

class MermaidWidget extends WidgetType {
  // Memoize the cached-height lookup: once a widget instance has seen a
  // populated cache, avoid re-hashing on every subsequent estimatedHeight
  // read (CodeMirror reads it often during heightmap builds).
  private memoizedHeight: number | null = null;

  constructor(
    readonly source: string,
    readonly id: string,
    readonly theme: MermaidTheme,
  ) {
    super();
  }

  eq(other: MermaidWidget): boolean {
    return this.source === other.source && this.theme === other.theme;
  }

  // Feed the cached height into CodeMirror's heightmap so off-screen widgets
  // contribute their real height to the total document height. This keeps the
  // scrollbar thumb and scroll range stable as widgets enter / leave the
  // viewport — without this, CodeMirror falls back to a one-line placeholder
  // until each widget is measured, and the total shifts every time one is.
  get estimatedHeight(): number {
    if (this.memoizedHeight !== null) return this.memoizedHeight;
    const h = getCachedHeight(this.source, this.theme);
    if (h === undefined) return -1;
    this.memoizedHeight = h;
    return h;
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement("div") as WrapperWithObserver;
    wrapper.className = "cm-mermaid-widget";
    wrapper.contentEditable = "false";

    // Start with a loading placeholder.
    wrapper.textContent = "Loading diagram...";

    // Sticky height: if we've rendered this source+theme before, reserve the
    // measured height immediately so the heightmap doesn't collapse while the
    // async render resolves (widgets get destroyed and re-created whenever
    // they leave and re-enter CodeMirror's viewport).
    const cachedHeight = getCachedHeight(this.source, this.theme);
    if (cachedHeight) {
      wrapper.style.minHeight = `${cachedHeight}px`;
    }

    // Use IntersectionObserver for lazy rendering.
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          observer.disconnect();
          void renderMermaid(this.source, this.theme, this.id).then((result) => {
            if (result.svg) {
              wrapper.innerHTML = result.svg;
              // Add role="img" and aria-label to the SVG.
              const svg = wrapper.querySelector("svg");
              if (svg) {
                svg.setAttribute("role", "img");
                svg.setAttribute("aria-label", `Mermaid diagram: ${this.source.split("\n")[0]}`);
              }
              // Measure once on the very first render and pin that value.
              // Re-writing the cache on subsequent remounts lets sub-pixel
              // rounding drift compound across mounts; keeping the first good
              // measurement keeps the heightmap stable.
              if (!cachedHeight) {
                requestAnimationFrame(() => {
                  const measured = wrapper.offsetHeight;
                  if (measured > 0) {
                    cacheHeight(this.source, this.theme, measured);
                    wrapper.style.minHeight = `${measured}px`;
                  }
                });
              }
            } else if (result.error) {
              wrapper.className = "cm-mermaid-error";
              wrapper.textContent = `Diagram error: ${result.error}`;
            }
          });
        }
      }
    });
    observer.observe(wrapper);
    // Stash for destroy() so we can cancel if the widget is torn down before
    // it ever enters the viewport.
    wrapper[OBSERVER_KEY] = observer;

    return wrapper;
  }

  destroy(dom: HTMLElement): void {
    const observer = (dom as WrapperWithObserver)[OBSERVER_KEY];
    observer?.disconnect();
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Extract the info string and code content from a FencedCode node.
 * The Lezer markdown tree structure for a fenced code block is:
 * - FencedCode containing: CodeMark, CodeInfo, CodeText, CodeMark
 */
function parseFencedCode(
  state: { doc: { sliceString(from: number, to: number): string } },
  node: {
    node: {
      firstChild: {
        name: string;
        from: number;
        to: number;
        nextSibling: typeof node.node.firstChild;
      } | null;
    };
  },
): { info: string; source: string } | undefined {
  let info = "";
  let source = "";

  let child = node.node.firstChild;
  while (child) {
    if (child.name === "CodeInfo") {
      info = state.doc.sliceString(child.from, child.to);
    } else if (child.name === "CodeText") {
      source = state.doc.sliceString(child.from, child.to);
    }
    child = child.nextSibling;
  }

  if (!info) return undefined;
  return { info, source };
}

const mermaidFoldExtension = foldableSyntaxFacet.of({
  nodePath: "FencedCode",
  buildDecorations: (state, node, selectionTouchesRange) => {
    const parsed = parseFencedCode(state, node);
    if (!parsed) return undefined;

    // Check if the info string starts with "mermaid" (case-insensitive)
    if (!parsed.info.trim().toLowerCase().startsWith("mermaid")) return undefined;

    const source = parsed.source.trim();
    if (!source) return undefined;

    const id = `mermaid-${++widgetCounter}`;
    const theme = getMermaidTheme();

    if (selectionTouchesRange) {
      // Cursor is inside: show raw source and render a preview widget below the fence
      return Decoration.widget({
        widget: new MermaidWidget(source, id, theme),
        block: true,
      }).range(node.to);
    }

    // Cursor is outside: replace the entire fence with the rendered SVG
    return Decoration.replace({
      widget: new MermaidWidget(source, id, theme),
      block: true,
      inclusiveStart: true,
    }).range(node.from, node.to);
  },
});

/**
 * Watch the document's `data-theme-type` attribute. When the app theme changes,
 * nudge the editor to rebuild decorations so diagrams re-render under the
 * new theme.
 */
const themeSync = ViewPlugin.fromClass(
  class {
    private readonly observer: MutationObserver;

    constructor(view: EditorView) {
      this.observer = new MutationObserver(() => {
        view.dispatch({ selection: view.state.selection });
      });
      this.observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme-type"],
      });
    }

    destroy() {
      this.observer.disconnect();
    }
  },
);

const mermaidTheme = EditorView.baseTheme({
  ".cm-mermaid-widget": {
    padding: "0.5em 0",
    overflow: "auto",
  },
  ".cm-mermaid-widget svg": {
    maxWidth: "100%",
    height: "auto",
  },
  // Mermaid inlines label backgrounds in the SVG's own <style> tag; the
  // `edgeLabelBackground` themeVariable controls the rect fill but some
  // diagram types still ship with an opaque HTML background on the label
  // wrapper. Strip any remaining fills so labels read as text-only.
  ".cm-mermaid-widget svg .edgeLabel, .cm-mermaid-widget svg .edgeLabel foreignObject div, .cm-mermaid-widget svg .edgeLabel span":
    {
      backgroundColor: "var(--bg) !important",
    },
  ".cm-mermaid-widget svg .edgeLabel rect, .cm-mermaid-widget svg .labelBkg": {
    fill: "var(--bg) !important",
  },
  ".cm-mermaid-error": {
    padding: "0.5em 1em",
    color: "var(--text-error, #ff6b6b)",
    backgroundColor: "var(--code-bg, #2d2d2d)",
    borderRadius: "4px",
    fontSize: "0.85em",
    fontFamily: "'SF Mono', Menlo, Monaco, Consolas, monospace",
  },
});

/**
 * Workaround: foldExtension only rebuilds on docChanged/selection, not on syntax
 * tree progression. When the incremental parser finishes after initial load, folds
 * stay stale. This plugin detects tree changes and nudges a rebuild.
 * (Same pattern as table-decorations.ts)
 */
const foldTreeSync = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate) {
      if (!update.docChanged && syntaxTree(update.state) !== syntaxTree(update.startState)) {
        setTimeout(() => {
          update.view.dispatch({ selection: update.view.state.selection });
        });
      }
    }
  },
);

export function mermaidDecorations() {
  return [
    mermaidFoldExtension,
    mermaidTheme,
    selectAllDecorationsOnSelectExtension("cm-mermaid-widget"),
    foldTreeSync,
    themeSync,
  ];
}
