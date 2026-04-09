import { useMemo, useRef, useState } from "react";
import { parsePrimaryFamily } from "../../lib/font-utils";
import type { FontInfo } from "../../hooks/useSystemFonts";

interface FontFamilyComboboxProps {
  value: string | null;
  defaultValue: string;
  onValueChange: (v: string | null) => void;
  disabled?: boolean;
  variant: "editor" | "terminal";
  fonts: FontInfo[];
  fontsLoading: boolean;
}

const MAX_VISIBLE = 80;

export function FontFamilyCombobox({
  value,
  defaultValue,
  onValueChange,
  disabled,
  variant,
  fonts,
  fontsLoading,
}: FontFamilyComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const defaultLabel = useMemo(
    () => parsePrimaryFamily(defaultValue) ?? defaultValue,
    [defaultValue],
  );
  const displayLabel = value ?? defaultLabel;
  const selectedFamily = value ?? defaultValue;

  const { nerdFonts, monoFonts, otherFonts } = useMemo(() => {
    const nerd: FontInfo[] = [];
    const mono: FontInfo[] = [];
    const other: FontInfo[] = [];
    for (const font of fonts) {
      if (font.category === "nerd") nerd.push(font);
      else if (font.category === "mono") mono.push(font);
      else other.push(font);
    }
    return { nerdFonts: nerd, monoFonts: mono, otherFonts: other };
  }, [fonts]);

  const filteredFonts = useMemo(() => {
    const lower = search.toLowerCase().trim();
    if (!lower) return { nerdFonts, monoFonts, otherFonts };
    return {
      nerdFonts: nerdFonts.filter((f) => f.family.toLowerCase().includes(lower)),
      monoFonts: monoFonts.filter((f) => f.family.toLowerCase().includes(lower)),
      otherFonts: otherFonts.filter((f) => f.family.toLowerCase().includes(lower)),
    };
  }, [nerdFonts, monoFonts, otherFonts, search]);

  const hasExactMatch = useMemo(() => {
    if (!search.trim()) return true;
    const lower = search.toLowerCase().trim();
    return fonts.some((f) => f.family.toLowerCase() === lower);
  }, [fonts, search]);

  function selectFont(family: string) {
    onValueChange(family === defaultValue ? null : family);
    setOpen(false);
    setSearch("");
  }

  function handleBlur(e: React.FocusEvent) {
    if (!containerRef.current?.contains(e.relatedTarget as Node)) {
      setOpen(false);
      setSearch("");
    }
  }

  function renderGroup(heading: string, items: FontInfo[]) {
    if (items.length === 0) return null;
    const visible = search.trim() ? items : items.slice(0, MAX_VISIBLE);
    return (
      <>
        <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
          {heading}
        </div>
        {visible.map((font) => (
          <button
            key={font.family}
            type="button"
            className={`w-full text-left px-2 py-1.5 text-md rounded-sm truncate transition-colors hover:bg-accent/50 ${
              font.family === selectedFamily ? "bg-accent/30 text-foreground" : "text-foreground/80"
            }`}
            style={{ fontFamily: `"${font.family}"` }}
            onMouseDown={(e) => {
              e.preventDefault();
              selectFont(font.family);
            }}
          >
            {font.family}
          </button>
        ))}
      </>
    );
  }

  const totalFiltered =
    filteredFonts.nerdFonts.length +
    filteredFonts.monoFonts.length +
    filteredFonts.otherFonts.length;

  return (
    <div ref={containerRef} className="relative flex-1" onBlur={handleBlur}>
      <button
        type="button"
        className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md border border-border bg-background text-md text-foreground hover:bg-accent/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        disabled={disabled || fontsLoading}
        onClick={() => {
          setOpen(!open);
          if (!open) {
            requestAnimationFrame(() => inputRef.current?.focus());
          }
        }}
      >
        <span className="truncate" style={{ fontFamily: `"${displayLabel}"` }}>
          {fontsLoading ? "Loading fonts..." : displayLabel}
        </span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-50">
          <path d="m7 15 5 5 5-5" />
          <path d="m7 9 5-5 5 5" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-50 top-full left-0 mt-1 w-full max-h-64 overflow-auto rounded-md border border-border bg-popover shadow-lg">
          <div className="sticky top-0 bg-popover border-b border-border p-1">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search fonts..."
              className="w-full px-2 py-1 text-md bg-transparent text-foreground outline-none placeholder:text-muted-foreground/50"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setOpen(false);
                  setSearch("");
                } else if (e.key === "Enter" && search.trim() && !hasExactMatch) {
                  selectFont(search.trim());
                }
              }}
            />
          </div>
          <div className="p-1">
            {!hasExactMatch && search.trim() && (
              <button
                type="button"
                className="w-full text-left px-2 py-1.5 text-md rounded-sm text-foreground/80 hover:bg-accent/50 transition-colors"
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectFont(search.trim());
                }}
              >
                Use &ldquo;{search.trim()}&rdquo;
              </button>
            )}
            {variant === "terminal" && renderGroup("Nerd Fonts", filteredFonts.nerdFonts)}
            {renderGroup("Monospace", filteredFonts.monoFonts)}
            {renderGroup("Other", filteredFonts.otherFonts)}
            {totalFiltered === 0 && hasExactMatch && (
              <div className="px-2 py-3 text-md text-muted-foreground text-center">
                No fonts found.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
