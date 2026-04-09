import { useState } from "react";
import { useUIStore } from "../../store";
import { useSystemFonts } from "../../hooks/useSystemFonts";
import { FontFamilyCombobox } from "./FontFamilyCombobox";
import { FontPreview } from "./FontPreview";

export const DEFAULT_EDITOR_FONT_FAMILY =
  "ui-monospace, Menlo, Consolas, Liberation Mono, monospace";
export const DEFAULT_EDITOR_FONT_SIZE = 14;

export const DEFAULT_TERMINAL_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";
export const DEFAULT_TERMINAL_FONT_SIZE = 14;

const VARIANT_CONFIG = {
  editor: {
    title: "Editor Font",
    description: "Font used in diff views and file editors.",
    defaultFamily: DEFAULT_EDITOR_FONT_FAMILY,
    defaultSize: DEFAULT_EDITOR_FONT_SIZE,
    familyKey: "editorFontFamily" as const,
    sizeKey: "editorFontSize" as const,
  },
  terminal: {
    title: "Terminal Font",
    description: "Font used in terminal panels.",
    defaultFamily: DEFAULT_TERMINAL_FONT_FAMILY,
    defaultSize: DEFAULT_TERMINAL_FONT_SIZE,
    familyKey: "terminalFontFamily" as const,
    sizeKey: "terminalFontSize" as const,
  },
};

interface FontSettingSectionProps {
  variant: "editor" | "terminal";
}

export function FontSettingSection({ variant }: FontSettingSectionProps) {
  const config = VARIANT_CONFIG[variant];

  const currentFamily = useUIStore((s) => s[config.familyKey]);
  const currentSize = useUIStore((s) => s[config.sizeKey]);
  const setEditorFontFamily = useUIStore((s) => s.setEditorFontFamily);
  const setEditorFontSize = useUIStore((s) => s.setEditorFontSize);
  const setTerminalFontFamily = useUIStore((s) => s.setTerminalFontFamily);
  const setTerminalFontSize = useUIStore((s) => s.setTerminalFontSize);

  const setFamily = variant === "editor" ? setEditorFontFamily : setTerminalFontFamily;
  const setSize = variant === "editor" ? setEditorFontSize : setTerminalFontSize;

  const { fonts: systemFonts, isLoading: fontsLoading } = useSystemFonts();

  const [fontSizeDraft, setFontSizeDraft] = useState<string | null>(null);

  const previewFamily = currentFamily ?? config.defaultFamily;
  const previewSize =
    (fontSizeDraft != null ? parseInt(fontSizeDraft, 10) : undefined) ||
    currentSize ||
    config.defaultSize;

  const hasCustom = currentFamily !== null || currentSize !== null;

  return (
    <div>
      <div className="text-md font-medium">{config.title}</div>
      <div className="text-md text-muted-foreground mt-0.5 mb-3">
        {config.description}
        {variant === "terminal" && (
          <>
            {" "}
            <a
              href="https://www.nerdfonts.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Nerd Fonts
            </a>{" "}
            recommended for shell theme icons.
          </>
        )}
      </div>
      <div className="flex items-center gap-2 max-w-lg">
        <FontFamilyCombobox
          value={currentFamily}
          defaultValue={config.defaultFamily}
          onValueChange={setFamily}
          variant={variant}
          fonts={systemFonts}
          fontsLoading={fontsLoading}
        />
        <div className="flex items-center gap-1 rounded-md border border-border bg-background p-0.5 shrink-0">
          <button
            onClick={() => {
              const current = currentSize ?? config.defaultSize;
              const next = Math.max(10, current - 1);
              setSize(next === config.defaultSize ? null : next);
            }}
            disabled={(currentSize ?? config.defaultSize) <= 10}
            className="flex items-center justify-center w-7 h-7 rounded text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14"/></svg>
          </button>
          <span className="text-sm text-foreground tabular-nums w-10 text-center font-medium">
            {fontSizeDraft ?? (currentSize ?? config.defaultSize)}px
          </span>
          <button
            onClick={() => {
              const current = currentSize ?? config.defaultSize;
              const next = Math.min(24, current + 1);
              setSize(next === config.defaultSize ? null : next);
            }}
            disabled={(currentSize ?? config.defaultSize) >= 24}
            className="flex items-center justify-center w-7 h-7 rounded text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14M12 5v14"/></svg>
          </button>
        </div>
        {hasCustom && (
          <button
            onClick={() => {
              setFamily(null);
              setSize(null);
              setFontSizeDraft(null);
            }}
            className="text-md text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            Reset
          </button>
        )}
      </div>
      <div className="mt-3 max-w-lg">
        <FontPreview
          fontFamily={previewFamily}
          fontSize={previewSize}
          variant={variant}
          isCustomFont={currentFamily !== null}
        />
      </div>
    </div>
  );
}
