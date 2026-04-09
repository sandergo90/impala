// ---------------------------------------------------------------------------
// Hotkey types
// ---------------------------------------------------------------------------

export type HotkeyCategory = "Navigation" | "Layout" | "Terminal" | "Worktree";

export interface HotkeyDefinition {
  label: string;
  description?: string;
  default: string | null;
  category: HotkeyCategory;
}

export type HotkeyId = keyof typeof HOTKEYS;

// ---------------------------------------------------------------------------
// Registry — all shortcuttable actions with their defaults
// ---------------------------------------------------------------------------

export const HOTKEYS = {
  // -- Navigation --
  OPEN_COMMAND_PALETTE: {
    label: "Command Palette",
    description: "Open the command palette to search worktrees, projects, and actions",
    default: "meta+p",
    category: "Navigation",
  },
  OPEN_SETTINGS: {
    label: "Settings",
    description: "Open the settings page",
    default: "meta+comma",
    category: "Navigation",
  },
  SHOW_KEYBOARD_SHORTCUTS: {
    label: "Keyboard Shortcuts",
    description: "Open the keyboard shortcuts settings page",
    default: "meta+slash",
    category: "Navigation",
  },

  // -- Layout --
  TOGGLE_SIDEBAR: {
    label: "Toggle Sidebar",
    description: "Show or hide the left sidebar",
    default: "meta+b",
    category: "Layout",
  },
  TOGGLE_RIGHT_SIDEBAR: {
    label: "Toggle Right Sidebar",
    description: "Show or hide the right sidebar (changes/annotations)",
    default: "meta+shift+b",
    category: "Layout",
  },
  // -- Terminal --
  SPLIT_VERTICAL: {
    label: "Split Vertical",
    description: "Add a new terminal pane to the right",
    default: "meta+d",
    category: "Terminal",
  },
  SPLIT_HORIZONTAL: {
    label: "Split Horizontal",
    description: "Add a new terminal pane below",
    default: "meta+shift+d",
    category: "Terminal",
  },
  NEXT_PANE: {
    label: "Next Pane",
    description: "Focus the next terminal pane",
    default: "meta+]",
    category: "Terminal",
  },
  PREV_PANE: {
    label: "Previous Pane",
    description: "Focus the previous terminal pane",
    default: "meta+[",
    category: "Terminal",
  },
  CLOSE_PANE: {
    label: "Close Pane",
    description: "Close the focused terminal pane (won't close the last pane or Claude panes)",
    default: "meta+w",
    category: "Terminal",
  },
  TOGGLE_TERMINAL: {
    label: "Toggle Terminal",
    description: "Switch between the general terminal and the last selected worktree",
    default: "meta+shift+2",
    category: "Terminal",
  },
  CLEAR_TERMINAL: {
    label: "Clear Terminal",
    description: "Clear the focused terminal",
    default: "meta+k",
    category: "Terminal",
  },
  FIND_IN_TERMINAL: {
    label: "Find in Terminal",
    description: "Open the terminal search bar",
    default: "meta+f",
    category: "Terminal",
  },
  RUN_SCRIPT: {
    label: "Run Script",
    description: "Run the project's configured run script",
    default: "meta+shift+r",
    category: "Terminal",
  },

  // -- Worktree --
  NEW_WORKTREE: {
    label: "New Worktree",
    description: "Open the new worktree dialog",
    default: "meta+n",
    category: "Worktree",
  },
  DELETE_WORKTREE: {
    label: "Delete Worktree",
    description: "Delete the currently selected worktree",
    default: "meta+backspace",
    category: "Worktree",
  },
  JUMP_TO_WORKTREE_1: { label: "Jump to Worktree 1", default: "meta+1", category: "Worktree" },
  JUMP_TO_WORKTREE_2: { label: "Jump to Worktree 2", default: "meta+2", category: "Worktree" },
  JUMP_TO_WORKTREE_3: { label: "Jump to Worktree 3", default: "meta+3", category: "Worktree" },
  JUMP_TO_WORKTREE_4: { label: "Jump to Worktree 4", default: "meta+4", category: "Worktree" },
  JUMP_TO_WORKTREE_5: { label: "Jump to Worktree 5", default: "meta+5", category: "Worktree" },
  JUMP_TO_WORKTREE_6: { label: "Jump to Worktree 6", default: "meta+6", category: "Worktree" },
  JUMP_TO_WORKTREE_7: { label: "Jump to Worktree 7", default: "meta+7", category: "Worktree" },
  JUMP_TO_WORKTREE_8: { label: "Jump to Worktree 8", default: "meta+8", category: "Worktree" },
  JUMP_TO_WORKTREE_9: { label: "Jump to Worktree 9", default: "meta+9", category: "Worktree" },
} as const satisfies Record<string, HotkeyDefinition>;

// ---------------------------------------------------------------------------
// Categories in display order
// ---------------------------------------------------------------------------

export const HOTKEY_CATEGORIES: HotkeyCategory[] = [
  "Navigation",
  "Layout",
  "Terminal",
  "Worktree",
];

// ---------------------------------------------------------------------------
// Parsing — convert canonical string ↔ structured form
// ---------------------------------------------------------------------------

const MODIFIER_ORDER = ["meta", "ctrl", "alt", "shift"] as const;

/** Aliases for normalizing user input */
const KEY_ALIASES: Record<string, string> = {
  cmd: "meta",
  command: "meta",
  opt: "alt",
  option: "alt",
  control: "ctrl",
  esc: "escape",
  ",": "comma",
  "/": "slash",
  " ": "space",
};

export interface ParsedHotkey {
  modifiers: Set<string>;
  key: string;
}

/**
 * Parse a canonical hotkey string like "meta+shift+d" into modifiers + key.
 * Returns null for invalid input.
 */
export function parseHotkey(raw: string): ParsedHotkey | null {
  const parts = raw.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const modifiers = new Set<string>();
  let key: string | null = null;

  for (const part of parts) {
    const normalized = KEY_ALIASES[part] ?? part;
    if (MODIFIER_ORDER.includes(normalized as (typeof MODIFIER_ORDER)[number])) {
      modifiers.add(normalized);
    } else if (key === null) {
      key = normalized;
    } else {
      return null; // more than one non-modifier key
    }
  }

  if (!key) return null;
  return { modifiers, key };
}

/**
 * Convert a ParsedHotkey back to canonical string form with sorted modifiers.
 */
export function toCanonical(parsed: ParsedHotkey): string {
  const mods = MODIFIER_ORDER.filter((m) => parsed.modifiers.has(m));
  return [...mods, parsed.key].join("+");
}

// ---------------------------------------------------------------------------
// Matching — does a KeyboardEvent match a hotkey string?
// ---------------------------------------------------------------------------

/**
 * Map from KeyboardEvent.code to canonical key name.
 * Used as fallback when event.key returns a layout-shifted character
 * (e.g., Cmd+1 producing "&" on AZERTY).
 */
const CODE_TO_KEY: Record<string, string> = {
  Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4", Digit5: "5",
  Digit6: "6", Digit7: "7", Digit8: "8", Digit9: "9", Digit0: "0",
  Minus: "-", Equal: "=",
  BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Semicolon: ";", Quote: "'",
  Comma: "comma", Period: ".", Slash: "slash",
  Backquote: "`", Space: "space",
};

/** Map KeyboardEvent.key values to canonical key names */
function eventKeyToCanonical(e: KeyboardEvent): string {
  const k = e.key.toLowerCase();
  const fromKey = KEY_ALIASES[k] ?? k;
  // When Cmd/Ctrl is held, macOS may report a shifted character for the key
  // (e.g., "&" instead of "1"). Fall back to event.code for reliable matching.
  if ((e.metaKey || e.ctrlKey) && e.code && CODE_TO_KEY[e.code]) {
    const fromCode = CODE_TO_KEY[e.code];
    // Prefer event.key if it's a simple alphanumeric, else use code mapping
    if (fromKey.length > 1 || !/^[a-z0-9]$/.test(fromKey)) {
      return fromCode;
    }
  }
  return fromKey;
}

const parseCache = new Map<string, ParsedHotkey | null>();

function parseCached(hotkey: string): ParsedHotkey | null {
  let result = parseCache.get(hotkey);
  if (result === undefined) {
    result = parseHotkey(hotkey) ?? null;
    parseCache.set(hotkey, result);
  }
  return result;
}

/**
 * Check whether a KeyboardEvent matches the given canonical hotkey string.
 */
export function matchesHotkeyEvent(event: KeyboardEvent, hotkey: string): boolean {
  const parsed = parseCached(hotkey);
  if (!parsed) return false;

  const key = eventKeyToCanonical(event);
  if (key !== parsed.key) return false;

  if (event.metaKey !== parsed.modifiers.has("meta")) return false;
  if (event.ctrlKey !== parsed.modifiers.has("ctrl")) return false;
  if (event.altKey !== parsed.modifiers.has("alt")) return false;
  if (event.shiftKey !== parsed.modifiers.has("shift")) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * A valid app hotkey must include Cmd or Ctrl modifier.
 * This prevents users from binding bare keys that break text input/terminal.
 */
export function isValidAppHotkey(hotkey: string): boolean {
  const parsed = parseHotkey(hotkey);
  if (!parsed) return false;
  return parsed.modifiers.has("meta") || parsed.modifiers.has("ctrl");
}

// ---------------------------------------------------------------------------
// Display formatting — canonical string → macOS symbols
// ---------------------------------------------------------------------------

const MODIFIER_SYMBOLS: Record<string, string> = {
  meta: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
};

const KEY_DISPLAY: Record<string, string> = {
  comma: ",",
  slash: "/",
  space: "Space",
  escape: "Esc",
  backspace: "⌫",
  enter: "↵",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  "[": "[",
  "]": "]",
};

/**
 * Format a canonical hotkey string for display.
 * Returns an array of symbol strings, e.g. ["⌘", "⇧", "D"]
 */
export function formatHotkeyParts(hotkey: string): string[] {
  const parsed = parseHotkey(hotkey);
  if (!parsed) return [];

  const parts: string[] = [];
  for (const mod of MODIFIER_ORDER) {
    if (parsed.modifiers.has(mod)) {
      parts.push(MODIFIER_SYMBOLS[mod] ?? mod);
    }
  }
  const displayKey = KEY_DISPLAY[parsed.key] ?? parsed.key.toUpperCase();
  parts.push(displayKey);
  return parts;
}

/**
 * Format a canonical hotkey string as a single display string.
 * e.g. "meta+shift+d" → "⌘⇧D"
 */
// ---------------------------------------------------------------------------
// Capture — convert a KeyboardEvent (from recording) to canonical string
// ---------------------------------------------------------------------------

/**
 * Capture a KeyboardEvent as a canonical hotkey string during recording.
 * Returns null if no non-modifier key was pressed.
 */
export function captureHotkeyFromEvent(event: KeyboardEvent): string | null {
  const key = eventKeyToCanonical(event);
  // Ignore modifier-only presses
  if (["meta", "ctrl", "alt", "shift", "control"].includes(key)) return null;

  const modifiers = new Set<string>();
  if (event.metaKey) modifiers.add("meta");
  if (event.ctrlKey) modifiers.add("ctrl");
  if (event.altKey) modifiers.add("alt");
  if (event.shiftKey) modifiers.add("shift");

  return toCanonical({ modifiers, key });
}
