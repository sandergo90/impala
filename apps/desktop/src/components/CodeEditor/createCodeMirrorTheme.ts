import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import type { Theme } from "../../themes/types";
import { DEFAULT_DIFF_FONT_FAMILY } from "../../themes/apply";

export function createCodeMirrorTheme(
  theme: Theme,
  fontSize: number,
  fontFamily: string | null,
): Extension {
  const term = theme.terminal;
  const isDark = theme.type === "dark";
  const family = fontFamily ?? DEFAULT_DIFF_FONT_FAMILY;
  const lineHeight = `${Math.round(fontSize * 1.5)}px`;

  const view = EditorView.theme(
    {
      "&": {
        color: term.foreground,
        backgroundColor: term.background,
        height: "100%",
        fontSize: `${fontSize}px`,
        fontFamily: family,
      },
      ".cm-scroller": { fontFamily: family, lineHeight, overflow: "auto" },
      ".cm-content": { caretColor: term.foreground },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: term.foreground },
      "&.cm-focused .cm-selectionBackgroundCollapsed, ::selection, .cm-selectionBackground":
        { backgroundColor: term.selectionBackground },
      ".cm-gutters": {
        backgroundColor: term.background,
        color: isDark ? term.brightBlack : term.white,
        border: "none",
      },
      ".cm-activeLine": { backgroundColor: "transparent" },
      ".cm-activeLineGutter": { backgroundColor: "transparent" },
      ".cm-selectionMatch": { backgroundColor: term.selectionBackground },
      ".cm-searchMatch": {
        backgroundColor: term.selectionBackground,
        outline: `1px solid ${term.foreground}`,
      },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: term.selectionBackground },
    },
    { dark: isDark },
  );

  const highlight = HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.operatorKeyword], color: isDark ? term.brightMagenta : term.magenta },
    { tag: [t.string, t.special(t.string)], color: isDark ? term.brightGreen : term.green },
    { tag: [t.number, t.bool, t.null], color: isDark ? term.brightYellow : term.yellow },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: isDark ? term.brightBlack : term.white, fontStyle: "italic" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: isDark ? term.brightBlue : term.blue },
    { tag: [t.typeName, t.className, t.namespace], color: isDark ? term.brightCyan : term.cyan },
    { tag: [t.propertyName, t.attributeName], color: isDark ? term.brightCyan : term.cyan },
    { tag: [t.tagName], color: isDark ? term.brightRed : term.red },
    { tag: [t.variableName], color: term.foreground },
    { tag: [t.invalid], color: isDark ? term.brightRed : term.red },
  ]);

  return [view, syntaxHighlighting(highlight)];
}
