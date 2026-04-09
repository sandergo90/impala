# Task 4: Run/Stop Toggle Button

**Plan:** Superset Feature Adoption
**Goal:** Replace the static play button in the title bar with a Run/Stop toggle that sends Ctrl+C when running, auto-escalates to kill after 3 seconds, and adds a restart button to the floating terminal.
**Depends on:** none

**Files:**

- Modify: `apps/desktop/src/store.ts` (add "stopping" status to FloatingTerminalState)
- Modify: `apps/desktop/src/lib/run-script.ts` (add `stopRunScript` and `toggleRunScript` functions)
- Modify: `apps/desktop/src/views/MainView.tsx:141-149` (swap play/stop icon based on state)
- Modify: `apps/desktop/src/components/FloatingTerminal.tsx` (add restart button, show "Stopped" status)

**Context:**

- The play button is at `apps/desktop/src/views/MainView.tsx` lines 141-149. It calls `triggerRunScript()` from `apps/desktop/src/lib/run-script.ts`.
- The floating terminal state shape is in `apps/desktop/src/store.ts` around line 9-23. The `status` field is `'running' | 'succeeded' | 'failed'` — we need to add `'stopping'` and `'stopped'`.
- The `RUN_SCRIPT` hotkey is already bound via `useHotkeyTooltip("RUN_SCRIPT", "Run script")` at MainView line 39.
- `pty_write` sends data to the PTY. Ctrl+C is `\x03`.
- `pty_kill` kills the PTY session and removes it from state.

**Steps:**

1. Update the `FloatingTerminalState` type in `apps/desktop/src/store.ts`. Find the interface (around line 9-23) and add `'stopping'` and `'stopped'` to the status union:

```typescript
interface FloatingTerminalState {
  mode: 'hidden' | 'expanded' | 'pill';
  sessionId: string | null;
  label: string;
  type: 'setup' | 'run' | null;
  status: 'running' | 'stopping' | 'stopped' | 'succeeded' | 'failed';
}
```

Also update the `defaultFloatingTerminal` constant to confirm it still uses `'running'` as default.

2. Add `stopRunScript` and `toggleRunScript` functions to `apps/desktop/src/lib/run-script.ts`. Add after the existing `triggerRunScript` function:

```typescript
export async function stopRunScript() {
  const { selectedWorktree, getFloatingTerminal, setFloatingTerminal } = useUIStore.getState();
  if (!selectedWorktree) return;

  const ft = getFloatingTerminal(selectedWorktree.path);
  if (ft.type !== "run" || !ft.sessionId) return;
  if (ft.status !== "running") return;

  // Set status to stopping
  setFloatingTerminal(selectedWorktree.path, { status: "stopping", label: "Stopping..." });

  // Send Ctrl+C
  const encoded = btoa(
    Array.from(new TextEncoder().encode("\x03"), (b) =>
      String.fromCharCode(b)
    ).join("")
  );
  await invoke("pty_write", { sessionId: ft.sessionId, data: encoded }).catch(() => {});

  // Escalate to kill after 3 seconds if still alive
  const sessionId = ft.sessionId;
  const worktreePath = selectedWorktree.path;
  setTimeout(async () => {
    const current = useUIStore.getState().getFloatingTerminal(worktreePath);
    if (current.sessionId === sessionId && current.status === "stopping") {
      await invoke("pty_kill", { sessionId }).catch(() => {});
      setFloatingTerminal(worktreePath, {
        status: "stopped",
        label: "Force stopped",
      });
    }
  }, 3000);
}

export function toggleRunScript() {
  const { selectedWorktree, getFloatingTerminal } = useUIStore.getState();
  if (!selectedWorktree) return;

  const ft = getFloatingTerminal(selectedWorktree.path);
  if (ft.type === "run" && ft.status === "running") {
    stopRunScript();
  } else {
    triggerRunScript();
  }
}
```

3. Update the `FloatingTerminal.tsx` exit listener (around lines 49-86) to handle the "stopping" → "stopped" transition. When exit happens during "stopping" status, set to "stopped" instead of "succeeded":

In the `listen<number>` callback, add handling for the stopping state:

```typescript
unlistenPromise = listen<number>(`pty-exit-${safeId}`, (event) => {
  if (cancelled) return;
  const exitCode = event.payload;
  const current = useUIStore.getState().getFloatingTerminal(wtPath);

  // If user initiated stop, show "stopped" regardless of exit code
  if (current.status === "stopping") {
    setFloatingTerminal(wtPath, {
      label: "Stopped",
      status: "stopped",
      mode: "pill",
    });
    return;
  }

  const failed = exitCode !== 0;
  // ... rest of existing logic unchanged
```

4. Add a restart button to the floating terminal pill. In `FloatingTerminal.tsx`, when status is `"stopped"` or `"failed"`, show a restart button.

Add import at the top:

```typescript
import { triggerRunScript } from "../lib/run-script";
```

In the pill mode rendering (around lines 149-176), add a restart button between the label and the dismiss button, conditional on status:

```typescript
{(status === "stopped" || status === "failed") && ft?.type === "run" && (
  <button
    onClick={(e) => {
      e.stopPropagation();
      triggerRunScript();
    }}
    className="text-muted-foreground hover:text-foreground text-xs px-1"
    title="Restart"
  >
    &#8635;
  </button>
)}
```

5. Update the `StatusDot` component in `FloatingTerminal.tsx` (line 16-24) to handle the new statuses:

```typescript
function StatusDot({ status }: { status: "running" | "stopping" | "stopped" | "succeeded" | "failed" }) {
  const color =
    status === "running"
      ? "bg-green-500"
      : status === "stopping"
        ? "bg-yellow-500"
        : status === "failed"
          ? "bg-red-500"
          : "bg-muted-foreground";
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${color}`} />;
}
```

6. Update the play button in `MainView.tsx` (lines 141-149) to become a Run/Stop toggle:

Add imports at the top:

```typescript
import { toggleRunScript } from "../lib/run-script";
```

Replace the static play button. You need to read the floating terminal status from the store:

```typescript
const wtPath = useUIStore((s) => s.selectedWorktree?.path);
const ftStatus = useUIStore((s) =>
  wtPath ? s.floatingTerminals[wtPath]?.status : undefined
);
const ftType = useUIStore((s) =>
  wtPath ? s.floatingTerminals[wtPath]?.type : undefined
);
const isRunning = ftType === "run" && (ftStatus === "running" || ftStatus === "stopping");
```

Replace the button (lines 141-149):

```typescript
<button
  onClick={() => toggleRunScript()}
  className={`relative text-muted-foreground hover:text-foreground p-1.5 rounded hover:bg-accent ${
    ftStatus === "stopping" ? "opacity-50 pointer-events-none" : ""
  }`}
  title={isRunning ? "Stop script" : runScriptTooltip}
>
  {isRunning ? (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
      <rect x="3" y="3" width="10" height="10" rx="1" />
    </svg>
  ) : (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
      <path d="M4 2l10 6-10 6V2z" />
    </svg>
  )}
</button>
```

7. Verify the build:

Run: `cd /Users/sander/Projects/canopy && bun run --filter desktop typecheck 2>&1 | tail -20`
Expected: no TypeScript errors

8. Manual test:
- Configure a run script in project settings (e.g. `sleep 30`)
- Click play → floating terminal shows, button swaps to stop icon
- Click stop → Ctrl+C sent, label shows "Stopping...", process exits, button swaps back to play
- If process doesn't exit in 3s → force killed
- Click restart on the pill → re-runs

9. Commit:

```bash
git add apps/desktop/src/store.ts apps/desktop/src/lib/run-script.ts apps/desktop/src/views/MainView.tsx apps/desktop/src/components/FloatingTerminal.tsx
git commit -m "feat: run/stop toggle button with auto-escalation

Play button swaps to stop icon while running. Stop sends
Ctrl+C, escalates to kill after 3s. Adds restart button
to floating terminal pill when stopped or failed."
```

**Done When:**

- [ ] Play button swaps to stop icon when a run script is active
- [ ] Clicking stop sends Ctrl+C and shows "Stopping..." status
- [ ] If process doesn't exit in 3 seconds, it's force-killed
- [ ] Restart button appears on the pill for stopped/failed runs
- [ ] Cmd+Shift+R toggles between run and stop
- [ ] Button is disabled during the "stopping" transition
- [ ] TypeScript build passes
- [ ] Committed
