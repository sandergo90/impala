import { useEffect, useRef } from "react";
import { matchesHotkeyEvent, type HotkeyId } from "../lib/hotkeys";
import { useHotkeysStore } from "../stores/hotkeys";

interface UseAppHotkeyOptions {
  enabled?: boolean;
  preventDefault?: boolean;
}

export function useAppHotkey(
  id: HotkeyId,
  callback: () => void,
  options?: UseAppHotkeyOptions,
  deps: unknown[] = [],
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const enabled = options?.enabled ?? true;
  const preventDefault = options?.preventDefault ?? true;

  useEffect(() => {
    if (!enabled) return;

    const handler = (event: KeyboardEvent) => {
      const keys = useHotkeysStore.getState().getEffective(id);
      if (!keys) return;
      if (!matchesHotkeyEvent(event, keys)) return;

      if (preventDefault) event.preventDefault();
      event.stopPropagation();
      callbackRef.current();
    };

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, enabled, preventDefault, ...deps]);
}
