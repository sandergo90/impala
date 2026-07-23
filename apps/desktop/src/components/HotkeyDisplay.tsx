import { formatHotkeyParts } from "../lib/hotkeys";
import { HOTKEYS, type HotkeyId } from "../lib/hotkeys";
import { useHotkeysStore } from "../stores/hotkeys";

/** Selector that returns the effective binding for a hotkey (override ?? default) */
function useEffectiveHotkey(id: HotkeyId): string | null {
  return useHotkeysStore((s) => {
    const o = s.overrides[id];
    return o !== undefined ? o : HOTKEYS[id].default;
  });
}

export function HotkeyDisplay({
  id,
  className = "",
}: {
  id: HotkeyId;
  className?: string;
}) {
  const effective = useEffectiveHotkey(id);

  if (!effective) return null;

  const parts = formatHotkeyParts(effective);

  return (
    <span className={`font-mono text-xs ${className}`}>
      {parts.map((part, i) => (
        <kbd key={i} className="min-w-[0.75rem] text-center inline-block">
          {part}
        </kbd>
      ))}
    </span>
  );
}

export function useHotkeyTooltip(id: HotkeyId, label: string): string {
  const effective = useEffectiveHotkey(id);
  if (!effective) return label;
  const parts = formatHotkeyParts(effective);
  return `${label} (${parts.join("")})`;
}
