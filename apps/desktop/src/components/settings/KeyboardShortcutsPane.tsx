import { useCallback, useEffect, useRef, useState } from "react";
import { useHotkeysStore } from "../../stores/hotkeys";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  HOTKEYS,
  HOTKEY_CATEGORIES,
  type HotkeyId,
  formatHotkeyParts,
  captureHotkeyFromEvent,
  isValidAppHotkey,
} from "../../lib/hotkeys";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConflictDialog {
  /** The hotkey we're trying to assign */
  targetId: HotkeyId;
  /** The new key combo */
  keys: string;
  /** The hotkey that already uses this combo */
  conflictId: HotkeyId;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const hotkeyEntries = Object.entries(HOTKEYS) as [HotkeyId, (typeof HOTKEYS)[HotkeyId]][];

function matchesSearch(entry: (typeof HOTKEYS)[HotkeyId], query: string): boolean {
  const q = query.toLowerCase();
  if (entry.label.toLowerCase().includes(q)) return true;
  if (("description" in entry) && (entry as { description: string }).description.toLowerCase().includes(q)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// KeyCombo display component
// ---------------------------------------------------------------------------

function KeyCombo({ hotkey }: { hotkey: string }) {
  const parts = formatHotkeyParts(hotkey);
  return (
    <span className="inline-flex items-center gap-0.5">
      {parts.map((part, i) => (
        <kbd
          key={i}
          className="min-w-[20px] h-5 flex items-center justify-center rounded bg-muted/60 border border-border/50 text-[11px] font-medium text-foreground px-1"
        >
          {part}
        </kbd>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function KeyboardShortcutsPane() {
  const [search, setSearch] = useState("");
  const [recordingId, setRecordingId] = useState<HotkeyId | null>(null);
  const [conflictDialog, setConflictDialog] = useState<ConflictDialog | null>(null);

  // Subscribe to overrides so we re-render on changes
  const overrides = useHotkeysStore((s) => s.overrides);
  const store = useHotkeysStore;

  const recordingRef = useRef<HotkeyId | null>(null);
  recordingRef.current = recordingId;

  // -------------------------------------------------------------------------
  // Recording keydown handler
  // -------------------------------------------------------------------------

  const handleRecordingKeydown = useCallback(
    (e: KeyboardEvent) => {
      const currentRecording = recordingRef.current;
      if (!currentRecording) return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      // Escape → cancel
      if (e.key === "Escape") {
        setRecordingId(null);
        return;
      }

      // Backspace/Delete → unassign
      if (e.key === "Backspace" || e.key === "Delete") {
        store.getState().setHotkey(currentRecording, null);
        setRecordingId(null);
        return;
      }

      // Attempt to capture
      const captured = captureHotkeyFromEvent(e);
      if (!captured) return; // modifier-only, keep recording

      // Validate: must have Cmd or Ctrl
      if (!isValidAppHotkey(captured)) return;

      // Check for conflicts
      const conflictId = store.getState().getConflict(captured, currentRecording);
      if (conflictId) {
        setRecordingId(null);
        setConflictDialog({
          targetId: currentRecording,
          keys: captured,
          conflictId,
        });
        return;
      }

      // No conflict — save
      store.getState().setHotkey(currentRecording, captured);
      setRecordingId(null);
    },
    [store],
  );

  // -------------------------------------------------------------------------
  // Click-outside → cancel recording
  // -------------------------------------------------------------------------

  const handleClickOutside = useCallback(() => {
    if (recordingRef.current) {
      setRecordingId(null);
    }
  }, []);

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (recordingId) {
      document.addEventListener("keydown", handleRecordingKeydown, true);
      // Delay adding mousedown to avoid the click that started recording
      const timer = setTimeout(() => {
        document.addEventListener("mousedown", handleClickOutside, true);
      }, 0);
      return () => {
        document.removeEventListener("keydown", handleRecordingKeydown, true);
        document.removeEventListener("mousedown", handleClickOutside, true);
        clearTimeout(timer);
      };
    }
  }, [recordingId, handleRecordingKeydown, handleClickOutside]);

  // -------------------------------------------------------------------------
  // Conflict dialog actions
  // -------------------------------------------------------------------------

  const handleConflictReassign = () => {
    if (!conflictDialog) return;
    store.getState().setHotkeysBatch({
      [conflictDialog.conflictId]: null,
      [conflictDialog.targetId]: conflictDialog.keys,
    });
    setConflictDialog(null);
  };

  const handleConflictCancel = () => {
    setConflictDialog(null);
  };

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------

  const isOverridden = (id: HotkeyId) => id in overrides;

  const getEffective = (id: HotkeyId) => store.getState().getEffective(id);

  // Filter entries by search
  const filteredEntries = search
    ? hotkeyEntries.filter(([, def]) => matchesSearch(def, search))
    : hotkeyEntries;

  // Group by category
  const groupedByCategory = HOTKEY_CATEGORIES.map((cat) => ({
    category: cat,
    entries: filteredEntries.filter(([, def]) => def.category === cat),
  })).filter((group) => group.entries.length > 0);

  const hasResults = groupedByCategory.length > 0;
  const hasOverrides = Object.keys(overrides).length > 0;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-base font-semibold text-foreground">
          Keyboard Shortcuts
        </h2>
        {hasOverrides && (
          <button
            onClick={() => store.getState().resetAll()}
            className="text-md text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted/50 transition-colors"
          >
            Reset All
          </button>
        )}
      </div>
      <p className="text-md text-muted-foreground mb-6">
        Customize keyboard shortcuts. Click a binding to record a new one.
      </p>

      {/* Search */}
      <div className="relative mb-6 max-w-md">
        <svg
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60"
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
        >
          <circle
            cx="7"
            cy="7"
            r="4.5"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M10.5 10.5L14 14"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search shortcuts..."
          className="w-full pl-8 pr-3 py-1.5 text-md rounded-md border border-border/50 bg-background text-foreground placeholder:text-muted-foreground/90 focus:outline-none focus:ring-1 focus:ring-primary/50"
        />
      </div>

      {/* Shortcut list */}
      {hasResults ? (
        <div className="space-y-6">
          {groupedByCategory.map(({ category, entries }) => (
            <div key={category}>
              <h3 className="text-md font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                {category}
              </h3>
              <div className="space-y-0.5">
                {entries.map(([id, def]) => {
                  const effective = getEffective(id);
                  const isRecording = recordingId === id;
                  const overridden = isOverridden(id);

                  const description = "description" in def ? (def as { description: string }).description : undefined;

                  return (
                    <div
                      key={id}
                      className="flex items-center justify-between px-3 py-2 rounded-md group hover:bg-muted/30 transition-colors"
                    >
                      {/* Label + description */}
                      <div className="flex-1 min-w-0 mr-4">
                        <div className="text-md font-medium text-foreground">
                          {def.label}
                        </div>
                        {description && (
                          <div className="text-md text-muted-foreground mt-0.5 truncate">
                            {description}
                          </div>
                        )}
                      </div>

                      {/* Keybinding button + reset */}
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setRecordingId(isRecording ? null : id);
                          }}
                          className={`min-w-[100px] h-7 flex items-center justify-center rounded-md border text-md px-2 transition-colors ${
                            isRecording
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border/50 bg-muted/30 text-foreground hover:border-border hover:bg-muted/50"
                          }`}
                        >
                          {isRecording ? (
                            <span className="text-md text-primary animate-pulse">
                              Recording...
                            </span>
                          ) : effective ? (
                            <KeyCombo hotkey={effective} />
                          ) : (
                            <span className="text-muted-foreground/60">
                              Unassigned
                            </span>
                          )}
                        </button>

                        {/* Reset button — only shown if overridden */}
                        {overridden ? (
                          <button
                            onClick={() => store.getState().resetHotkey(id)}
                            className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/50 transition-colors"
                            title="Reset to default"
                          >
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 16 16"
                              fill="none"
                            >
                              <path
                                d="M2 2v5h5"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                              <path
                                d="M3 8.5a5.5 5.5 0 1 0 1.3-3.6L2 7"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </button>
                        ) : (
                          // Invisible spacer so columns align
                          <div className="w-[24px]" />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-md text-muted-foreground/60 text-center py-8">
          No shortcuts match "{search}"
        </div>
      )}

      {/* Conflict dialog */}
      <AlertDialog open={!!conflictDialog} onOpenChange={(open) => { if (!open) handleConflictCancel(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Shortcut Conflict</AlertDialogTitle>
            <AlertDialogDescription>
              {conflictDialog && (
                <>
                  <KeyCombo hotkey={conflictDialog.keys} /> is already assigned to{" "}
                  <span className="font-medium text-foreground">
                    {HOTKEYS[conflictDialog.conflictId].label}
                  </span>
                  . Reassign it to{" "}
                  <span className="font-medium text-foreground">
                    {HOTKEYS[conflictDialog.targetId].label}
                  </span>
                  ?
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConflictReassign}>
              Reassign
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
