import { useEffect, useRef, useState, useCallback, type RefObject } from "react";
import Highlighter from "@plannotator/web-highlighter";
import type { PlanAnnotation } from "../types";

export interface CommentPopoverState {
  anchorEl: HTMLElement;
  contextText: string;
  source: any;
}

interface UsePlanHighlighterOptions {
  containerRef: RefObject<HTMLElement | null>;
  annotations: PlanAnnotation[];
  selectedAnnotationId: string | null;
  onSelectAnnotation: (id: string | null) => void;
  // Filename the user is currently viewing (basename, e.g. "task-1.md") or
  // null for single-file plans. Annotations with a non-matching file_name are
  // skipped when applying highlights.
  activeFileName?: string | null;
  // Any value that changes when the rendered markdown changes; used to
  // re-run applyAnnotations after React rebuilds the article DOM.
  contentKey?: unknown;
}

export function usePlanHighlighter({
  containerRef,
  annotations,
  selectedAnnotationId,
  onSelectAnnotation,
  activeFileName,
  contentKey,
}: UsePlanHighlighterOptions) {
  const highlighterRef = useRef<Highlighter | null>(null);
  const onSelectAnnotationRef = useRef(onSelectAnnotation);
  const pendingSourceRef = useRef<any>(null);
  // Tracks whether the container element is mounted so the init effect can re-run
  const [containerReady, setContainerReady] = useState(false);

  const [commentPopover, setCommentPopover] = useState<CommentPopoverState | null>(null);

  useEffect(() => {
    onSelectAnnotationRef.current = onSelectAnnotation;
  }, [onSelectAnnotation]);

  // Detect when the container element actually mounts in the DOM
  useEffect(() => {
    const el = containerRef.current;
    setContainerReady(!!el);
  });

  const findTextInDOM = useCallback(
    (searchText: string): Range | null => {
      if (!containerRef.current) return null;

      // `Selection.toString()` (what web-highlighter captures at annotate
      // time) inserts "\n" / "\n\n" at block boundaries, while
      // `Node.textContent` concatenates text nodes with no separators.
      // Strip all whitespace on both sides and keep a map from stripped
      // offsets back to the raw textContent positions so we can rebuild a
      // Range once we find the match.
      const walker = document.createTreeWalker(
        containerRef.current,
        NodeFilter.SHOW_TEXT,
        null
      );
      const textNodes: Text[] = [];
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) textNodes.push(node);
      if (textNodes.length === 0) return null;

      let normHaystack = "";
      // map[i] = index into the raw concatenated textContent for the i-th
      // char of normHaystack.
      const map: number[] = [];
      let rawIndex = 0;
      for (const t of textNodes) {
        const text = t.textContent || "";
        for (let i = 0; i < text.length; i++, rawIndex++) {
          const ch = text[i];
          if (/\s/.test(ch)) continue;
          normHaystack += ch;
          map.push(rawIndex);
        }
      }

      const normNeedle = searchText.replace(/\s+/g, "");
      if (!normNeedle) return null;

      const idx = normHaystack.indexOf(normNeedle);
      if (idx === -1) return null;

      const startRaw = map[idx];
      const endRaw = map[idx + normNeedle.length - 1] + 1;
      if (startRaw === undefined || endRaw === undefined) return null;

      let charCount = 0;
      let startNode: Text | null = null;
      let startOffset = 0;
      let endNode: Text | null = null;
      let endOffset = 0;
      for (const t of textNodes) {
        const len = t.textContent?.length ?? 0;
        if (!startNode && charCount + len > startRaw) {
          startNode = t;
          startOffset = startRaw - charCount;
        }
        if (startNode && charCount + len >= endRaw) {
          endNode = t;
          endOffset = endRaw - charCount;
          break;
        }
        charCount += len;
      }
      if (!startNode || !endNode) return null;

      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      return range;
    },
    [containerRef]
  );

  const applyAnnotations = useCallback(
    (anns: PlanAnnotation[]) => {
      if (!containerRef.current) return;

      anns.forEach((ann) => {
        // Directory plans scope annotations per-file. Skip anything that
        // doesn't match the file currently on screen. Annotations made
        // before scoping existed have file_name = null and fall through
        // (so old data still renders on whichever file the text appears in).
        if (ann.file_name && ann.file_name !== activeFileName) return;

        // Skip if already highlighted
        const existing = containerRef.current?.querySelector(
          `[data-annotation-id="${ann.id}"]`
        );
        if (existing) return;

        const range = findTextInDOM(ann.original_text);
        if (!range) return;

        try {
          const textNodes: { node: Text; start: number; end: number }[] = [];
          const walker = document.createTreeWalker(
            range.commonAncestorContainer.nodeType === Node.TEXT_NODE
              ? range.commonAncestorContainer.parentNode!
              : range.commonAncestorContainer,
            NodeFilter.SHOW_TEXT,
            null
          );

          let tNode: Text | null;
          let inRange = false;

          while ((tNode = walker.nextNode() as Text | null)) {
            if (tNode === range.startContainer) {
              inRange = true;
              const start = range.startOffset;
              const end =
                tNode === range.endContainer ? range.endOffset : tNode.length;
              if (end > start) textNodes.push({ node: tNode, start, end });
              if (tNode === range.endContainer) break;
              continue;
            }
            if (tNode === range.endContainer) {
              if (inRange) {
                const end = range.endOffset;
                if (end > 0) textNodes.push({ node: tNode, start: 0, end });
              }
              break;
            }
            if (inRange && tNode.length > 0) {
              textNodes.push({ node: tNode, start: 0, end: tNode.length });
            }
          }

          // Wrap in reverse order to preserve offsets
          textNodes.reverse().forEach(({ node: n, start, end }) => {
            const nodeRange = document.createRange();
            nodeRange.setStart(n, start);
            nodeRange.setEnd(n, end);
            const mark = document.createElement("mark");
            mark.className = "plan-annotation-highlight";
            mark.dataset.annotationId = ann.id;
            nodeRange.surroundContents(mark);
            mark.addEventListener("click", () => {
              onSelectAnnotationRef.current?.(ann.id);
            });
          });
        } catch (e) {
          console.warn(`Failed to restore highlight for annotation ${ann.id}:`, e);
        }
      });
    },
    [findTextInDOM, containerRef, activeFileName]
  );

  const removeHighlight = useCallback(
    (id: string) => {
      highlighterRef.current?.remove(id);
      const marks = containerRef.current?.querySelectorAll(
        `[data-annotation-id="${id}"]`
      );
      marks?.forEach((el) => {
        const parent = el.parentNode;
        while (el.firstChild) parent?.insertBefore(el.firstChild, el);
        el.remove();
        parent?.normalize();
      });
    },
    [containerRef]
  );

  useEffect(() => {
    if (!containerRef.current || !containerReady) return;

    const highlighter = new Highlighter({
      $root: containerRef.current,
      exceptSelectors: [".plan-comment-popover", "button", "textarea"],
      wrapTag: "mark",
      style: { className: "plan-annotation-highlight" },
    });

    highlighterRef.current = highlighter;

    highlighter.on(
      Highlighter.event.CREATE,
      ({ sources }: { sources: any[] }) => {
        if (sources.length === 0) return;
        const source = sources[0];
        const doms = highlighter.getDoms(source.id);
        if (!doms?.length) return;

        if (pendingSourceRef.current) {
          highlighter.remove(pendingSourceRef.current.id);
        }

        pendingSourceRef.current = source;
        setCommentPopover({
          anchorEl: doms[0] as HTMLElement,
          contextText: source.text.slice(0, 80),
          source,
        });
      }
    );

    highlighter.on(Highlighter.event.CLICK, ({ id }: { id: string }) => {
      onSelectAnnotationRef.current?.(id);
    });

    highlighter.run();

    return () => {
      highlighter.dispose();
      highlighterRef.current = null;
    };
  }, [containerRef, containerReady]);

  useEffect(() => {
    // Remove marks for annotations that no longer exist
    const annotationIds = new Set(annotations.map((a) => a.id));
    const marks = containerRef.current?.querySelectorAll("[data-annotation-id]");
    marks?.forEach((el) => {
      const id = (el as HTMLElement).dataset.annotationId;
      if (id && !annotationIds.has(id)) {
        removeHighlight(id);
      }
    });

    // Small delay to let react-markdown finish rendering before we walk the DOM
    const timer = setTimeout(() => applyAnnotations(annotations), 50);
    return () => clearTimeout(timer);
  }, [annotations, applyAnnotations, removeHighlight, containerRef, contentKey]);

  useEffect(() => {
    if (!containerRef.current) return;

    // Clear all focused state
    containerRef.current
      .querySelectorAll(".plan-annotation-highlight.focused")
      .forEach((el) => el.classList.remove("focused"));

    if (!selectedAnnotationId) return;

    const marks = containerRef.current.querySelectorAll(
      `[data-annotation-id="${selectedAnnotationId}"]`
    );
    if (marks.length === 0) return;

    marks.forEach((el) => el.classList.add("focused"));
    marks[0].scrollIntoView({ behavior: "smooth", block: "center" });

    const timer = setTimeout(() => {
      marks.forEach((el) => el.classList.remove("focused"));
    }, 2000);
    return () => clearTimeout(timer);
  }, [selectedAnnotationId, containerRef]);

  const handleCommentSubmit = useCallback(
    (): { originalText: string; highlightSource: string | null } | null => {
      if (!commentPopover?.source) return null;

      const source = commentPopover.source;
      const highlighter = highlighterRef.current;

      if (highlighter) {
        try {
          highlighter.addClass("comment", source.id);
          const doms = highlighter.getDoms(source.id);
          doms?.forEach((dom: HTMLElement) => {
            dom.dataset.annotationId = source.id;
          });
        } catch (e) {
          console.warn("Failed to apply highlight class:", e);
        }
      }

      const result = {
        originalText: source.text as string,
        highlightSource: JSON.stringify({
          id: source.id,
          text: source.text,
          startMeta: source.startMeta,
          endMeta: source.endMeta,
        }),
      };

      pendingSourceRef.current = null;
      setCommentPopover(null);
      window.getSelection()?.removeAllRanges();

      return result;
    },
    [commentPopover]
  );

  const handleCommentClose = useCallback(() => {
    if (commentPopover?.source && highlighterRef.current) {
      highlighterRef.current.remove(commentPopover.source.id);
    }
    pendingSourceRef.current = null;
    setCommentPopover(null);
    window.getSelection()?.removeAllRanges();
  }, [commentPopover]);

  return {
    commentPopover,
    handleCommentSubmit,
    handleCommentClose,
    removeHighlight,
    applyAnnotations,
  };
}
