import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import type { Theme } from "../../themes/types";
import { DEFAULT_DIFF_FONT_FAMILY, resolveTheme } from "../../themes/apply";

export function createCodeMirrorTheme(
  theme: Theme,
  fontSize: number,
  fontFamily: string | null,
  language?: string,
): Extension {
  const term = theme.terminal;
  const ui = resolveTheme(theme);
  const isDark = theme.type === "dark";
  const family = fontFamily ?? DEFAULT_DIFF_FONT_FAMILY;
  const lineHeight = `${Math.round(fontSize * 1.5)}px`;
  const isMarkdown = language === "markdown";
  const muted = isDark ? term.brightBlack : term.white;
  const codeAccent = isDark ? term.brightBlue : term.blue;
  // The "brand" color of a theme — orange in Absolutely, blue in light,
  // lime in monokai, etc. Some themes (default-dark) use primary === foreground
  // which would erase contrast on text accents; in that case fall back to
  // terminal blue so links and h1 are still distinguishable.
  const brandColor =
    ui.primary.toLowerCase() === ui.foreground.toLowerCase() ? codeAccent : ui.primary;
  const codeBg = ui.muted;
  const quoteColor = ui.mutedForeground;
  const ruleColor = ui.border;
  const accentBg = ui.accent;

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
      ".cm-content": isMarkdown
        ? {
            caretColor: term.foreground,
            padding: "1em 1.25em",
            maxWidth: "96ch",
            margin: "0 auto",
          }
        : { caretColor: term.foreground },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: term.foreground },
      "&.cm-focused .cm-selectionBackgroundCollapsed, ::selection, .cm-selectionBackground":
        { backgroundColor: term.selectionBackground },
      ".cm-gutters": {
        backgroundColor: term.background,
        color: muted,
        border: "none",
        ...(isMarkdown ? { display: "none" } : {}),
      },
      ".cm-activeLine": { backgroundColor: accentBg },
      ".cm-activeLineGutter": { backgroundColor: accentBg },
      ".cm-selectionMatch": { backgroundColor: accentBg },
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
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: muted, fontStyle: "italic" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: codeAccent },
    { tag: [t.typeName, t.className, t.namespace], color: isDark ? term.brightCyan : term.cyan },
    { tag: [t.propertyName, t.attributeName], color: isDark ? term.brightCyan : term.cyan },
    { tag: [t.tagName], color: isDark ? term.brightRed : term.red },
    { tag: [t.variableName], color: term.foreground },
    { tag: [t.invalid], color: isDark ? term.brightRed : term.red },

    // Markdown — inert on non-markdown languages because these tags never fire there.
    { tag: t.heading1, fontSize: "1.6em", fontWeight: "700", color: brandColor },
    { tag: t.heading2, fontSize: "1.35em", fontWeight: "700", color: term.foreground },
    { tag: t.heading3, fontSize: "1.2em", fontWeight: "700", color: term.foreground },
    { tag: [t.heading4, t.heading5, t.heading6], fontSize: "1.05em", fontWeight: "700", color: term.foreground },
    { tag: t.strong, fontWeight: "700", color: term.foreground },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: [t.link, t.url], color: brandColor, textDecoration: "underline" },
    {
      tag: t.monospace,
      color: brandColor,
      backgroundColor: codeBg,
      padding: "1px 4px",
      borderRadius: "4px",
    },
    { tag: t.quote, color: quoteColor, fontStyle: "italic" },
    { tag: t.contentSeparator, color: ruleColor },
    // Dim the markdown markers (`#`, `*`, `>`, list bullets, link brackets)
    // so the prose itself reads as the focus.
    { tag: t.processingInstruction, color: quoteColor },
  ]);

  return [view, syntaxHighlighting(highlight)];
}
