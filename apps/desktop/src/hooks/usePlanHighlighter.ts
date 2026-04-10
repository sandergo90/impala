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
}

export function usePlanHighlighter({
  containerRef,
  annotations,
  selectedAnnotationId,
  onSelectAnnotation,
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

      // Try single text node first
      const walker = document.createTreeWalker(
        containerRef.current,
        NodeFilter.SHOW_TEXT,
        null
      );

      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        const text = node.textContent || "";
        const index = text.indexOf(searchText);
        if (index !== -1) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + searchText.length);
          return range;
        }
      }

      // Try across multiple text nodes
      const fullText = containerRef.current.textContent || "";
      const searchIndex = fullText.indexOf(searchText);
      if (searchIndex === -1) return null;

      const walker2 = document.createTreeWalker(
        containerRef.current,
        NodeFilter.SHOW_TEXT,
        null
      );

      let charCount = 0;
      let startNode: Text | null = null;
      let startOffset = 0;
      let endNode: Text | null = null;
      let endOffset = 0;

      while ((node = walker2.nextNode() as Text | null)) {
        const nodeLength = node.textContent?.length || 0;

        if (!startNode && charCount + nodeLength > searchIndex) {
          startNode = node;
          startOffset = searchIndex - charCount;
        }

        if (
          startNode &&
          charCount + nodeLength >= searchIndex + searchText.length
        ) {
          endNode = node;
          endOffset = searchIndex + searchText.length - charCount;
          break;
        }

        charCount += nodeLength;
      }

      if (startNode && endNode) {
        const range = document.createRange();
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, endOffset);
        return range;
      }

      return null;
    },
    [containerRef]
  );

  const applyAnnotations = useCallback(
    (anns: PlanAnnotation[]) => {
      if (!containerRef.current) return;

      anns.forEach((ann) => {
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
    [findTextInDOM, containerRef]
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
  }, [annotations, applyAnnotations, removeHighlight, containerRef]);

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
