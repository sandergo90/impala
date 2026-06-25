import {
  defaultKeymap, deleteLine, history, historyKeymap, indentWithTab,
} from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, openSearchPanel, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import {
  Decoration, type DecorationSet, drawSelection, dropCursor, EditorView,
  highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers,
  ViewPlugin, type ViewUpdate,
} from "@codemirror/view";
import { type MutableRefObject, useEffect, useRef } from "react";
import { useUIStore } from "../../store";
import { resolveThemeById } from "../../themes/apply";
import { createCodeMirrorTheme } from "./createCodeMirrorTheme";
import { loadLanguageSupport } from "./loadLanguageSupport";

// Like CodeMirror's built-in highlightActiveLine, but suppresses while a
// non-empty selection is on the line — the activeLine bg stacks on top of
// the selectionLayer (which paints below .cm-content) and would otherwise
// make the cursor's line look different from the rest of the selection.
const activeLineDeco = Decoration.line({ class: "cm-activeLine" });
const highlightActiveLineWhenCollapsed = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet) {
        this.decorations = this.build(update.view);
      }
    }
    build(view: EditorView): DecorationSet {
      const main = view.state.selection.main;
      if (!main.empty) return Decoration.none;
      const line = view.state.doc.lineAt(main.head);
      return Decoration.set([activeLineDeco.range(line.from)]);
    }
  },
  { decorations: (v) => v.decorations },
);

export interface CodeEditorHandle {
  focus(): void;
  getValue(): string;
  openFind(): void;
  goto(line: number, col?: number): void;
}

interface CodeEditorProps {
  value: string;
  language: string;
  readOnly?: boolean;
  /** Render markdown as a raw source editor (no live-preview prose styling). */
  plain?: boolean;
  className?: string;
  editorRef?: MutableRefObject<CodeEditorHandle | null>;
  onChange?: (value: string) => void;
  onSave?: () => void;
}

export function CodeEditor({
  value, language, readOnly = false, plain = false, className, editorRef, onChange, onSave,
}: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment()).current;
  const themeCompartment = useRef(new Compartment()).current;
  const editableCompartment = useRef(new Compartment()).current;
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const isExternalUpdateRef = useRef(false);

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  const activeThemeId = useUIStore((s) => s.activeThemeId);
  const customThemes = useUIStore((s) => s.customThemes);
  const editorFontSize = useUIStore((s) => s.editorFontSize);
  const editorFontFamily = useUIStore((s) => s.editorFontFamily);
  const globalFontSize = useUIStore((s) => s.fontSize);
  const fontSize = editorFontSize ?? globalFontSize;
  const fontFamily = editorFontFamily;
  const activeTheme = resolveThemeById(activeThemeId, customThemes);

  // biome-ignore lint/correctness/useExhaustiveDependencies: editor instance built once; live config flows through compartments below
  useEffect(() => {
    if (!containerRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      if (isExternalUpdateRef.current) return;
      onChangeRef.current?.(update.state.doc.toString());
    });

    const saveKeymap = keymap.of([
      { key: "Mod-s", preventDefault: true, run: () => { onSaveRef.current?.(); return true; } },
      { key: "Mod-e", preventDefault: true, run: deleteLine },
    ]);

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLineWhenCollapsed,
        highlightSelectionMatches(),
        EditorView.lineWrapping,
        editableCompartment.of([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        saveKeymap,
        themeCompartment.of(createCodeMirrorTheme(activeTheme, fontSize, fontFamily, language, plain)),
        languageCompartment.of([]),
        updateListener,
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    if (editorRef) {
      editorRef.current = {
        focus: () => view.focus(),
        getValue: () => view.state.doc.toString(),
        openFind: () => openSearchPanel(view),
        goto: (line, col) => {
          const lineCount = view.state.doc.lines;
          const safeLine = Math.max(1, Math.min(line, lineCount));
          const lineInfo = view.state.doc.line(safeLine);
          const safeCol =
            col !== undefined
              ? Math.max(0, Math.min(col, lineInfo.length))
              : 0;
          const pos = lineInfo.from + safeCol;
          view.dispatch({
            selection: { anchor: pos, head: pos },
            effects: EditorView.scrollIntoView(pos, { y: "center" }),
          });
          view.focus();
        },
      };
    }

    return () => {
      if (editorRef) editorRef.current = null;
      view.destroy();
      viewRef.current = null;
    };
  }, []);

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

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.reconfigure(
        createCodeMirrorTheme(activeTheme, fontSize, fontFamily, language, plain),
      ),
    });
  }, [activeTheme, fontSize, fontFamily, language, plain, themeCompartment]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editableCompartment.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [editableCompartment, readOnly]);

  useEffect(() => {
    let cancelled = false;
    void loadLanguageSupport(language)
      .then((ext) => {
        if (cancelled) return;
        viewRef.current?.dispatch({ effects: languageCompartment.reconfigure(ext ?? []) });
      })
      .catch(() => {
        viewRef.current?.dispatch({ effects: languageCompartment.reconfigure([]) });
      });
    return () => { cancelled = true; };
  }, [language, languageCompartment]);

  return <div ref={containerRef} className={className} />;
}
