import { useCallback, useEffect, useRef, type RefCallback } from "react";
import { EditorView, drawSelection, keymap } from "@codemirror/view";
import { EditorState, Prec } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags } from "@lezer/highlight";
import { GFM } from "@lezer/markdown";
import {
  prosemarkBasicSetup,
  prosemarkBaseThemeSetup,
  prosemarkMarkdownSyntaxExtensions,
} from "@prosemark/core";
import { tableDecorations } from "./table-decorations";
import { mermaidDecorations } from "./mermaid-decorations";
import { htmlBlockDecorations, htmlBlockParserExtension } from "./html-block-decorations";
import { imageSrcResolver } from "./image-src-resolver";
import { linearAttachmentWidget } from "./linear-attachment-widget";
import { linkNavigation } from "./link-navigation";
import { formattingKeymap } from "./markdown-formatting";

interface UseProsemarkEditorOptions {
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  filePath: string;
  worktreePath: string;
  getScrollContainer?: () => HTMLElement | null;
  autoFocus?: boolean;
}

export function useProsemarkEditor({
  value,
  onChange,
  onSave,
  filePath,
  worktreePath,
  autoFocus = false,
}: UseProsemarkEditorOptions): RefCallback<HTMLDivElement> {
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const isExternalUpdateRef = useRef(false);
  const autoFocusRef = useRef(autoFocus);
  // Refs for path props so the extensions read the *current* values without
  // forcing the EditorView to be torn down and rebuilt when the props change.
  const filePathRef = useRef(filePath);
  const worktreePathRef = useRef(worktreePath);

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  autoFocusRef.current = autoFocus;
  filePathRef.current = filePath;
  worktreePathRef.current = worktreePath;

  // Stable ref callback — only handles mount/unmount.
  const mountRef = useCallback<RefCallback<HTMLDivElement>>((el) => {
    if (!el) {
      const view = viewRef.current;
      if (view) view.destroy();
      viewRef.current = null;
      return;
    }

    if (viewRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      if (isExternalUpdateRef.current) return;
      onChangeRef.current(update.state.doc.toString());
    });

    const saveKeymap = keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          onSaveRef.current();
          return true;
        },
      },
    ]);

    const state = EditorState.create({
      doc: value,
      extensions: [
        markdown({
          base: markdownLanguage,
          codeLanguages: languages,
          addKeymap: true,
          extensions: [GFM, prosemarkMarkdownSyntaxExtensions, htmlBlockParserExtension],
        }),
        prosemarkBasicSetup(),
        drawSelection(),
        prosemarkBaseThemeSetup(),
        Prec.highest(
          syntaxHighlighting(
            HighlightStyle.define([
              { tag: tags.strong, fontWeight: "600" },
              { tag: tags.heading, fontWeight: "600" },
              { tag: tags.heading1, fontWeight: "600" },
              { tag: tags.heading2, fontWeight: "600" },
              { tag: tags.heading3, fontWeight: "600" },
              { tag: tags.heading4, fontWeight: "600" },
              { tag: tags.heading5, fontWeight: "600" },
              { tag: tags.heading6, fontWeight: "600" },
            ]),
          ),
        ),
        tableDecorations(),
        mermaidDecorations(),
        htmlBlockDecorations(),
        // Order matters: imageSrcResolver runs first so http(s) URLs (incl.
        // Linear) pass through unchanged, then linearAttachmentWidget catches
        // the Linear ones and replaces them with placeholders + fetched data.
        imageSrcResolver({
          getFilePath: () => filePathRef.current,
          getWorktreePath: () => worktreePathRef.current,
        }),
        linearAttachmentWidget(),
        linkNavigation({
          getFilePath: () => filePathRef.current,
          getWorktreePath: () => worktreePathRef.current,
        }),
        keymap.of(formattingKeymap),
        saveKeymap,
        updateListener,
      ],
    });

    const view = new EditorView({ state, parent: el });
    viewRef.current = view;

    if (autoFocusRef.current) view.focus();
  }, []);

  // Sync external `value` changes into the editor (e.g. disk reload, prop swap).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    isExternalUpdateRef.current = true;
    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    } finally {
      isExternalUpdateRef.current = false;
    }
  }, [value]);

  return mountRef;
}
