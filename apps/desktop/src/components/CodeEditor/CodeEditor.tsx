import {
  defaultKeymap, history, historyKeymap, indentWithTab,
} from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, openSearchPanel, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import {
  drawSelection, dropCursor, EditorView, highlightActiveLine,
  highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers,
} from "@codemirror/view";
import { type MutableRefObject, useEffect, useRef } from "react";
import { useUIStore } from "../../store";
import { resolveThemeById } from "../../themes/apply";
import { createCodeMirrorTheme } from "./createCodeMirrorTheme";
import { loadLanguageSupport } from "./loadLanguageSupport";

export interface CodeEditorHandle {
  focus(): void;
  getValue(): string;
  openFind(): void;
}

interface CodeEditorProps {
  value: string;
  language: string;
  readOnly?: boolean;
  className?: string;
  editorRef?: MutableRefObject<CodeEditorHandle | null>;
  onChange?: (value: string) => void;
  onSave?: () => void;
}

export function CodeEditor({
  value, language, readOnly = false, className, editorRef, onChange, onSave,
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
        highlightActiveLine(),
        highlightSelectionMatches(),
        EditorView.lineWrapping,
        editableCompartment.of([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        saveKeymap,
        themeCompartment.of(createCodeMirrorTheme(activeTheme, fontSize, fontFamily, language)),
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
        createCodeMirrorTheme(activeTheme, fontSize, fontFamily, language),
      ),
    });
  }, [activeTheme, fontSize, fontFamily, language, themeCompartment]);

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
