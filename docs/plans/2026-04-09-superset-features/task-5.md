# Task 5: Terminal Stability — Spawn Failure Cleanup + Basic Backpressure

**Plan:** Superset Feature Adoption
**Goal:** Handle PTY spawn failures gracefully, add a `pty_is_alive` command for dead session detection, and add basic backpressure to prevent high-output processes from overwhelming the frontend.
**Depends on:** none

**Files:**

- Modify: `backend/tauri/src/pty.rs` (spawn cleanup, backpressure, pty_is_alive)
- Modify: `backend/tauri/src/lib.rs` (register new command in invoke_handler)
- Modify: `apps/desktop/src/components/XtermTerminal.tsx:239-251` (frontend output guard)

**Context:**

- `pty.rs` is the entire PTY management module (274 lines). `pty_spawn` (lines 38-189) spawns a PTY, starts a read thread and a 16ms flush thread.
- The current spawn flow: open PTY → build command → spawn → get reader/writer → insert session → start threads. If spawn fails at line 87-90, the function returns `Err` — but the PTY pair (opened at lines 57-64) is leaked. This is the zombie scenario.
- The flush thread runs a tight 16ms loop emitting all pending data. There's no size cap per flush and no backpressure if the frontend falls behind.
- The read thread reads 8KB chunks into the pending buffer with no cap on pending buffer size.

**Steps:**

1. Fix spawn failure cleanup. The PTY is opened before spawn is attempted (lines 57-64), and if spawn fails (lines 87-90), the pair is dropped but the session is never inserted. This is actually OK for cleanup — the pair is dropped on error. But we should also emit an error event so the frontend can show the error.

After the spawn error (line 90), emit a `pty-error` event before returning:

```rust
    let child = match pair.slave.spawn_command(cmd) {
        Ok(child) => child,
        Err(e) => {
            let safe_id = sanitize_event_id(&session_id);
            let error_event = format!("pty-error-{}", safe_id);
            let _ = app_handle.emit(&error_event, format!("Failed to spawn: {}", e));
            return Err(format!("Failed to spawn command: {}", e));
        }
    };
```

2. Add error handling in the read thread. Currently if the read thread encounters an error (line 163 `Err(_) => break`), the flush thread is stopped but the session remains in the HashMap forever. After the read loop ends, clean up the session:

After the read loop (after line 185 where `pty-exit` is emitted), add session cleanup. But the read thread doesn't have access to the `PtyState`. We need to pass it in.

Change the approach: instead of cleaning up in the thread, the frontend should detect dead sessions. This is what `pty_is_alive` is for (see step 3). The read thread already emits `pty-exit` which the frontend listens to.

3. Add the `pty_is_alive` command to `pty.rs`:

```rust
#[tauri::command]
pub fn pty_is_alive(
    state: tauri::State<'_, PtyState>,
    session_id: String,
) -> Result<bool, String> {
    let sessions = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    match sessions.get(&session_id) {
        None => Ok(false),
        Some(session) => {
            if let Ok(mut child) = session.child.lock() {
                // try_wait returns Ok(Some(status)) if exited, Ok(None) if still running
                match child.try_wait() {
                    Ok(Some(_status)) => Ok(false), // exited
                    Ok(None) => Ok(true),            // still running
                    Err(_) => Ok(false),             // error = assume dead
                }
            } else {
                Ok(false) // can't lock = assume dead
            }
        }
    }
}
```

Note: `portable_pty::Child` exposes `try_wait()` which checks if the process has exited without blocking. Verify this is available:

Run: `grep -r "try_wait" backend/tauri/`

If `try_wait` isn't available on the `Child` trait, use an alternative: store the PID and check `/proc/{pid}` or use `kill(pid, 0)` via libc. But `portable_pty::Child` should have it — check the trait definition.

Register `pty_is_alive` in the invoke_handler in `backend/tauri/src/lib.rs`. Find the `tauri::generate_handler!` macro and add `pty_is_alive` to the list.

4. Add backpressure to the flush/read system. Modify `pty_spawn` in `pty.rs`:

**a) Size cap per flush (128KB max):**

Replace the flush thread body (lines 133-144) with:

```rust
    const MAX_FLUSH_BYTES: usize = 128 * 1024; // 128KB per flush
    const BACKPRESSURE_HIGH: usize = 1024 * 1024; // 1MB
    const BACKPRESSURE_LOW: usize = 256 * 1024; // 256KB

    let backpressured = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let backpressured_for_read = Arc::clone(&backpressured);

    // Flush thread: emits pending data every 16ms, capped at 128KB per flush
    let flush_running = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let flush_running_clone = Arc::clone(&flush_running);
    std::thread::spawn(move || {
        while flush_running_clone.load(std::sync::atomic::Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(16));
            let data = {
                let mut p = pending_for_flush.lock().unwrap();
                if p.is_empty() { continue; }
                if p.len() <= MAX_FLUSH_BYTES {
                    // Update backpressure state
                    backpressured.store(false, std::sync::atomic::Ordering::Relaxed);
                    std::mem::take(&mut *p)
                } else {
                    // Flush up to MAX_FLUSH_BYTES, leave rest for next tick
                    let chunk = p[..MAX_FLUSH_BYTES].to_vec();
                    *p = p[MAX_FLUSH_BYTES..].to_vec();
                    // Check if remaining exceeds high watermark
                    if p.len() >= BACKPRESSURE_HIGH {
                        backpressured.store(true, std::sync::atomic::Ordering::Relaxed);
                    } else if p.len() <= BACKPRESSURE_LOW {
                        backpressured.store(false, std::sync::atomic::Ordering::Relaxed);
                    }
                    chunk
                }
            };
            let encoded = STANDARD.encode(&data);
            let _ = app_for_flush.emit(&event_name_flush, encoded);
        }
    });
```

**b) Read thread backpressure — pause reads when buffer is too large:**

Replace the read loop (lines 147-166) with:

```rust
    // Read thread: reads PTY output with backpressure
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            // Backpressure: sleep briefly if pending buffer is too large
            if backpressured_for_read.load(std::sync::atomic::Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(16));
                continue;
            }

            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if let Ok(mut scrollback) = buffer_for_thread.lock() {
                        scrollback.extend_from_slice(&buf[..n]);
                        if scrollback.len() > MAX_BUFFER_SIZE {
                            let start = scrollback.len() - MAX_BUFFER_SIZE;
                            *scrollback = scrollback[start..].to_vec();
                        }
                    }
                    if let Ok(mut p) = pending.lock() {
                        p.extend_from_slice(&buf[..n]);
                    }
                }
                Err(_) => break,
            }
        }
        // ... rest of cleanup unchanged
```

5. Add a frontend output guard in `XtermTerminal.tsx`. In the `pty-output` listener (lines 239-251), add a simple write queue that uses `requestAnimationFrame` to avoid overwhelming xterm:

Replace the output listener:

```typescript
      let writeQueue: Uint8Array[] = [];
      let writeScheduled = false;

      function flushWriteQueue() {
        writeScheduled = false;
        if (!terminal || cancelled) return;

        let wasAtBottom = true;
        let savedScrollTop = 0;
        if (viewport) {
          savedScrollTop = viewport.scrollTop;
          wasAtBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 5;
        }

        // Write all queued chunks
        for (const chunk of writeQueue) {
          terminal.write(chunk);
        }
        writeQueue = [];

        if (!wasAtBottom && viewport) {
          viewport.scrollTop = savedScrollTop;
        }
      }

      unlistenOutput = await listen<string>(`pty-output-${safeId}`, (event) => {
        if (cancelled || !terminal) return;
        writeQueue.push(decodeBase64(event.payload));
        if (!writeScheduled) {
          writeScheduled = true;
          requestAnimationFrame(flushWriteQueue);
        }
      });
```

6. Verify the Rust build:

Run: `cd /Users/sander/Projects/canopy && cargo check -p canopy-desktop 2>&1 | tail -20`
Expected: no errors

Run: `cd /Users/sander/Projects/canopy && bun run --filter desktop typecheck 2>&1 | tail -20`
Expected: no TypeScript errors

7. Manual test:
- Run a high-output command: `yes | head -100000` in a terminal pane — should render without crashing or freezing
- Kill a terminal session and switch away, then switch back — should detect dead session
- Try spawning with a bad command — should show error, not hang

8. Commit:

```bash
git add backend/tauri/src/pty.rs backend/tauri/src/lib.rs apps/desktop/src/components/XtermTerminal.tsx
git commit -m "fix: terminal stability — spawn cleanup and backpressure

Emit pty-error events on spawn failure. Add pty_is_alive for
dead session detection. Cap flush at 128KB per tick. Pause
PTY reads when pending buffer exceeds 1MB (resume at 256KB).
Add frontend write queue to batch xterm writes per frame."
```

**Done When:**

- [ ] Spawn failures emit `pty-error-{id}` event with error message
- [ ] `pty_is_alive` correctly reports whether a session's process is still running
- [ ] Flush is capped at 128KB per tick (rest deferred to next tick)
- [ ] Read thread pauses when pending buffer exceeds 1MB, resumes at 256KB
- [ ] Frontend batches xterm writes via requestAnimationFrame
- [ ] High-output commands (e.g. `yes | head -100000`) don't freeze the UI
- [ ] Rust and TypeScript builds pass
- [ ] Committed
