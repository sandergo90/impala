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

  const c = isDark ? term : { ...term };
  const highlight = HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.operatorKeyword], color: isDark ? c.brightMagenta : c.magenta },
    { tag: [t.string, t.special(t.string)], color: isDark ? c.brightGreen : c.green },
    { tag: [t.number, t.bool, t.null], color: isDark ? c.brightYellow : c.yellow },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: isDark ? c.brightBlack : c.white, fontStyle: "italic" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: isDark ? c.brightBlue : c.blue },
    { tag: [t.typeName, t.className, t.namespace], color: isDark ? c.brightCyan : c.cyan },
    { tag: [t.propertyName, t.attributeName], color: isDark ? c.brightCyan : c.cyan },
    { tag: [t.tagName], color: isDark ? c.brightRed : c.red },
    { tag: [t.variableName], color: c.foreground },
    { tag: [t.invalid], color: isDark ? c.brightRed : c.red },
  ]);

  return [view, syntaxHighlighting(highlight)];
}
