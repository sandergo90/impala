import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  HOTKEYS,
  type HotkeyId,
} from "../lib/hotkeys";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** User overrides: hotkeyId → custom binding (string) or null (unassigned) */
type HotkeyOverrides = Partial<Record<HotkeyId, string | null>>;

interface HotkeysState {
  /** User overrides loaded from disk */
  overrides: HotkeyOverrides;
  /** Whether overrides have been loaded from Tauri */
  loaded: boolean;
}

interface HotkeysActions {
  /** Load overrides from Tauri file storage */
  load: () => Promise<void>;
  /** Set a single hotkey override and persist */
  setHotkey: (id: HotkeyId, keys: string | null) => Promise<void>;
  /** Set multiple overrides at once and persist (used for conflict reassignment) */
  setHotkeysBatch: (changes: Partial<Record<HotkeyId, string | null>>) => Promise<void>;
  /** Reset a single hotkey to its default (remove override) and persist */
  resetHotkey: (id: HotkeyId) => Promise<void>;
  /** Reset all hotkeys to defaults (clear all overrides) and persist */
  resetAll: () => Promise<void>;
  /** Get the effective binding for a hotkey (override ?? default) */
  getEffective: (id: HotkeyId) => string | null;
  /** Get all effective bindings as a map */
  getEffectiveMap: () => Record<HotkeyId, string | null>;
  /** Find which hotkey ID (if any) is bound to the given canonical key combo */
  getConflict: (keys: string, excludeId?: HotkeyId) => HotkeyId | null;
}

type HotkeysStore = HotkeysState & HotkeysActions;

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

async function persistOverrides(overrides: HotkeyOverrides): Promise<void> {
  try {
    await invoke("write_hotkey_overrides", { overrides });
  } catch (e) {
    console.error("Failed to persist hotkey overrides:", e);
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useHotkeysStore = create<HotkeysStore>()((set, get) => ({
  overrides: {},
  loaded: false,

  load: async () => {
    try {
      const result = await invoke<Record<string, string | null>>(
        "read_hotkey_overrides",
      );
      set({ overrides: result as HotkeyOverrides, loaded: true });
    } catch (e) {
      console.error("Failed to load hotkey overrides:", e);
      set({ loaded: true }); // proceed with defaults
    }
  },

  setHotkey: async (id, keys) => {
    const overrides = { ...get().overrides, [id]: keys };
    set({ overrides });
    await persistOverrides(overrides);
  },

  setHotkeysBatch: async (changes) => {
    const overrides = { ...get().overrides, ...changes };
    set({ overrides });
    await persistOverrides(overrides);
  },

  resetHotkey: async (id) => {
    const { [id]: _, ...rest } = get().overrides;
    set({ overrides: rest });
    await persistOverrides(rest);
  },

  resetAll: async () => {
    set({ overrides: {} });
    await persistOverrides({});
  },

  getEffective: (id) => {
    const userOverride = get().overrides[id];
    if (userOverride !== undefined) return userOverride;
    return HOTKEYS[id].default;
  },

  getEffectiveMap: () => {
    const map = {} as Record<HotkeyId, string | null>;
    for (const id of Object.keys(HOTKEYS) as HotkeyId[]) {
      map[id] = get().getEffective(id);
    }
    return map;
  },

  getConflict: (keys, excludeId) => {
    const canonical = keys.toLowerCase();
    for (const id of Object.keys(HOTKEYS) as HotkeyId[]) {
      if (id === excludeId) continue;
      const effective = get().getEffective(id);
      if (effective && effective.toLowerCase() === canonical) return id;
    }
    return null;
  },
}));
