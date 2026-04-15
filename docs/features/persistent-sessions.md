# Persistent Sessions

Terminal sessions in Impala keep running when you quit the app, so Claude Code (or any shell inside a terminal tab) picks up exactly where you left off the next time you launch. No re-run, no lost context, no wiped scrollback.

This doc explains how it works end-to-end — the moving parts, the wire protocol, the invariants that keep the reattach experience clean, and where to look in the code when something breaks.

---

## What you see as a user

1. Open Impala, spawn a terminal tab, run `claude` (or `zsh`, or `vim`, or anything else).
2. Quit Impala. The Dock icon disappears. Activity Monitor still shows a process called `impala-pty-daemon`.
3. Relaunch Impala. Open the same worktree. The terminal tab reappears with Claude's UI exactly as you left it — same prompt, same context, same TUI state.

The daemon keeps running regardless of whether Impala is open. Killing the daemon (via `kill` or reboot) is the only way to lose a session.

---

## Why a daemon?

Impala is a Tauri app. When you quit Tauri, every child process inherited from the GUI gets a `SIGHUP` and dies. A PTY spawned as a direct child of the Tauri process dies with it. That's why every previous iteration of Impala's terminal reset on restart.

The fix is to take PTY ownership *out* of the Tauri process entirely. `impala-pty-daemon` is a second binary that gets spawned once, **detaches itself from the Tauri process group** via `setsid()`, and from that point on it's adopted by launchd. Quitting Tauri has no effect on it.

The GUI then talks to the daemon over a Unix socket. It's a thin client now — all the PTY machinery (spawn, read, write, resize, kill, scrollback) lives in the daemon.

---

## High-level architecture

```
┌──────────────────────────────────────┐
│               Tauri GUI              │
│                                      │
│  ┌────────────┐    ┌──────────────┐  │
│  │ xterm.js   │◄──►│  pty.rs      │  │
│  │ (React)    │    │  forwarders  │  │
│  └────────────┘    └──────┬───────┘  │
│        ▲                  │          │
│        │ pty-output-<id>  │          │
│        │ Tauri events     │          │
│        │                  ▼          │
│  ┌────────────────────────────────┐  │
│  │   daemon_client.rs             │  │
│  │   • persistent Unix socket     │  │
│  │   • request multiplexer        │  │
│  │   • event fan-out              │  │
│  │   • per-session seq cursor     │  │
│  └───────────────┬────────────────┘  │
└──────────────────┼───────────────────┘
                   │ framed NDJSON
                   │ (Unix socket)
                   │
┌──────────────────┼───────────────────┐
│                  ▼                   │
│           impala-pty-daemon          │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  Registry<SessionId, Session>  │  │
│  └───────────────┬────────────────┘  │
│                  │                   │
│        ┌─────────┴──────────┐        │
│        ▼                    ▼        │
│  ┌───────────┐        ┌───────────┐  │
│  │ Session A │        │ Session B │  │
│  │           │        │           │  │
│  │ • Master  │        │ • Master  │  │
│  │   PTY     │        │   PTY     │  │
│  │ • child   │        │ • child   │  │
│  │ • vt100   │        │ • vt100   │  │
│  │   parser  │        │   parser  │  │
│  │ • flush   │        │ • flush   │  │
│  │   thread  │        │   thread  │  │
│  └─────┬─────┘        └─────┬─────┘  │
│        │                    │        │
│        ▼                    ▼        │
│     ┌──────┐             ┌──────┐    │
│     │ bash │             │claude│    │
│     └──────┘             └──────┘    │
└──────────────────────────────────────┘
```

Survives GUI quit because launchd reparents the daemon. Three crates in the Cargo workspace:

- **`backend/tauri/`** — the Tauri app itself. Contains `daemon_client.rs` and `pty.rs`.
- **`backend/tauri/daemon/`** — the `impala-pty-daemon` binary. Built by `scripts/build-pty-daemon-sidecar.sh` and shipped as a Tauri `externalBin` sidecar.
- **`backend/tauri/shared/`** — protocol types (`Request`, `Response`, `Event`, frame envelopes, `DaemonPaths`). Both sides depend on this so they can't drift.

---

## The daemon

Source: `backend/tauri/daemon/src/main.rs`.

### Startup

```
impala-pty-daemon --data-dir ~/Library/Application Support/be.kodeus.impala
```

- Reads the token file the GUI already created (`<data-dir>/daemon/pty.token`, 0600).
- Writes its PID to `<data-dir>/daemon/pty.pid`.
- Binds a Unix socket at `<data-dir>/daemon/pty.sock`, chmod 0600.
- Spawns a tokio multi-thread runtime and an accept loop.
- Listens for SIGTERM, SIGINT, and a `Shutdown` RPC — on any of them, drops the socket file and exits cleanly.

### Registry

```rust
struct Registry {
    sessions: Mutex<HashMap<String, Session>>,
    subscribers: Mutex<HashMap<u64, UnboundedSender<Event>>>,
    next_client_id: AtomicU64,
}
```

One `Session` per PTY. Each connected GUI client gets registered as a subscriber via `subscribe()` and receives every `Event` any session emits. Simple pub/sub; good enough until there's reason to add per-session filtering.

### Session

```rust
struct Session {
    cwd: String,
    started_at: String,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Box<dyn Write + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    state: Arc<Mutex<SessionState>>,
}

struct SessionState {
    parser: vt100::Parser,
    total_bytes: u64,
}
```

- `master` / `writer` / `child` come from `portable_pty::openpty()` + `spawn_command()`.
- `parser` is a `vt100::Parser`, a headless terminal emulator. It maintains a proper grid (cursor, cell attributes, alt-screen state) for the session.
- `total_bytes` is a monotonic counter of every byte the daemon has processed for this session. It's the basis of the reattach watermark (see below).

### Flush thread

Per session, there's a dedicated std thread that drains output in 16 ms batches:

```rust
loop {
    sleep(16 ms);
    let chunk = drain_pending(up_to: 128 KB);
    let seq_from = {
        let mut st = state.lock();
        let seq_from = st.total_bytes;
        st.parser.process(&chunk);       // feed bytes into vt100
        st.total_bytes += chunk.len();   // bump under the same lock
        seq_from
    };
    registry.broadcast(Event::Output {
        session_id, data_b64: b64(chunk), seq_from,
    });
}
```

Two things matter here:

1. **Parser update and `total_bytes` bump happen under the same lock.** Whatever `seq_from` the broadcast carries matches exactly what's in the parser's grid at that moment. This is what the client-side cursor watermark relies on.
2. **Backpressure**: if `pending` exceeds 1 MB, the read thread pauses until it drops below 256 KB. PTY output from a runaway process doesn't blow out the daemon's memory.

### Read thread

A separate std thread per session just pulls bytes out of the PTY reader and appends them to `pending`. No parser contact — that's the flush thread's job. On EOF, it drains the final tail, broadcasts `Event::Exit { code }`, and removes the session from the registry.

---

## Wire protocol

Source: `backend/tauri/shared/src/wire.rs`. Protocol version 3. Newline-delimited JSON on both sides.

### Client → daemon

```rust
pub struct ClientFrame {
    pub id: u64,
    #[serde(flatten)]
    pub req: Request,
}

#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    Hello { token, client_version, protocol_version },
    Spawn { session_id, cwd, command, env, cols, rows },
    Write { session_id, data_b64 },
    Resize { session_id, cols, rows },
    Kill { session_id },
    IsAlive { session_id },
    GetBuffer { session_id },
    List,
    Shutdown,
}
```

`id` is a monotonic counter the client allocates. Responses carry the same `id` so the client can match them to a pending request.

### Daemon → client

Two frame shapes, discriminated by a top-level `kind` field (not an enum — `tag`-plus-`flatten` has a serde deserialization hole we hit once, never again):

```rust
pub struct ResponseFrame {
    pub kind: String,     // always "response"
    pub id: u64,
    #[serde(flatten)]
    pub resp: Response,
}

pub struct EventFrame {
    pub kind: String,     // always "event"
    #[serde(flatten)]
    pub event: Event,
}
```

`Response` variants include `HelloOk`, `Spawned`, `Buffer`, `Wrote`, `Resized`, `Killed`, `Alive`, `Sessions`, `ShutdownAck`, `Error`. `Event` variants are `Output`, `Exit`, `SpawnError`.

The client reads each line as a `serde_json::Value`, peeks at `kind`, then deserializes into the right struct.

### Handshake

First frame from a client must be `Request::Hello` with the token and the current `PROTOCOL_VERSION`. Mismatch on either field → `Response::Error`, connection closed. Once authenticated, the client stays registered as an event subscriber for the life of the connection.

---

## The Tauri client

Source: `backend/tauri/src/daemon_client.rs`.

### `DaemonClient::ensure()`

Runs once during the Tauri setup hook, off the main thread:

1. Resolve `DaemonPaths` under `app_data_dir()`.
2. Create the token file if missing (two chained v4 UUIDs → 64 hex chars, 0600).
3. **Try to connect three times.** Between attempts, spawn the daemon via `setsid()` and wait for the socket file to appear.
4. On successful connection, perform the handshake, then spawn two long-lived tasks:
   - `writer_task`: owns the socket's write half, serializes requests from an `mpsc::UnboundedSender<(u64, Request)>`.
   - `reader_task`: owns the read half, parses server frames, dispatches them.

The result is stashed in a `OnceLock<DaemonClient>` in Tauri state. Until it lands, the `pty_*` commands return `"pty daemon not ready"`.

### Request multiplexer

```rust
pub async fn request(&self, req: Request) -> Result<Response, String> {
    let id = self.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    self.pending.lock().unwrap().insert(id, tx);
    self.request_tx.send((id, req)).map_err(|_| "daemon disconnected")?;
    rx.await.map_err(|_| "daemon disconnected".to_string())
}
```

Pending requests sit in `Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>>`. When `reader_task` sees a `ResponseFrame`, it looks up the `id` and sends the `Response` on the oneshot. If the socket dies, the reader task clears `pending` — all waiting requests fail with `"daemon disconnected"`.

### Event fan-out

When the reader sees an `EventFrame`:

```rust
Event::Output { session_id, data_b64, seq_from } => {
    let cursor = session_cursors.lock().get(&session_id).copied().unwrap_or(0);
    if seq_from < cursor { return; }         // drop stale bytes
    app.emit(&format!("pty-output-{safe_id}"), data_b64);
}

Event::Exit { session_id, code } => {
    session_cursors.lock().remove(&session_id);
    app.emit(&format!("pty-exit-{safe_id}"), code);
}
```

The frontend already listens to `pty-output-<id>` / `pty-exit-<id>` Tauri events — that contract is unchanged from the pre-daemon days. Everything past this point is the same xterm.js wiring Impala has always had.

---

## The reattach watermark

The subtle bit. When you reconnect to a live session, the daemon sends you a **scrollback snapshot** (the current screen) and then continues streaming **new output events**. Without care, this produces duplication at the seam: bytes that are already in the snapshot can also arrive as an `Output` event the daemon happened to broadcast right before your `Spawn` handler snapshotted.

The fix is a sequence-number watermark:

- `Spawned { seq_upto, … }` and `Buffer { seq_upto, … }` both carry `seq_upto = total_bytes` — the byte count up to and including everything in the snapshot.
- `Output { seq_from, … }` events carry the byte offset of the first byte in that chunk.
- The client maintains `session_cursors: HashMap<SessionId, u64>`. When a Spawned or Buffer response arrives, the reader task bumps the cursor **before** resolving the oneshot. When an Output event arrives, the reader checks `seq_from < cursor → drop`.

Because the flush thread updates `parser.process(&chunk)` and `total_bytes += chunk.len()` **under the same lock** as the `contents_formatted()` call inside `Request::Spawn`, we get a total order: every byte in the snapshot has `seq < seq_upto`, and every byte in a subsequent `Output` event has `seq >= seq_upto`. The cursor filter is sufficient — there's no partial-overlap case to trim.

The invariant is enforced in code and covered by an end-to-end Python smoke test (see `backend/tauri/shared/src/wire.rs` tests for the unit-level round-trip and the one-off smoke test in the commit history for the invariant proof).

---

## The vt100 snapshot

The other subtle bit. Early versions of persistent sessions stored raw PTY bytes (`Vec<u8>`) as the scrollback and replayed them verbatim on reattach. That fails catastrophically for any TUI:

- Cursor-positioning escapes (`\x1b[12;40H`) bake the width into the byte stream. Replay the bytes into a terminal of a different size and they land in the wrong place.
- TUIs like Claude Code write to the screen by *moving the cursor and overwriting cells*, not by printing lines sequentially. Each intermediate frame is a real screen state. Replaying every intermediate frame produces a visual mess of stacked redraws.
- Alt-buffer enter/exit sequences get truncated by the ring buffer cap, stranding the terminal in the wrong mode.

The fix is to parse the bytes into a proper terminal grid as they flow past. `vt100::Parser` does exactly that — given an input stream, it maintains a cursor, a grid of cells with attributes, alt-screen state, scrollback. When we ask for a snapshot, we call:

```rust
state.parser.screen().contents_formatted()
```

…which returns a byte sequence that reproduces the current screen on a fresh terminal. It starts with a cursor-home + clear-below, then draws cell by cell with the correct attributes. **Replayable on any fresh xterm regardless of how the state was built up.**

This is the same trick Superset's terminal daemon uses with xterm.js headlessly on the server side.

One consequence: historical bytes that scrolled off the top of the screen are lost. We initialize the parser with `scrollback_size = 0`, so only the visible grid is preserved. That matches how Claude's TUI is used in practice (you care about what's *on screen*, not what scrolled off), and it matches what Superset does. If we ever want persistent scroll history, we bump the scrollback size and serve `screen().contents_full()` on reattach.

---

## The frontend ordering fix

The thing that nearly killed the whole feature. `createCachedTerminal` used to fetch scrollback **inside** the factory, *before* the xterm wrapper was in the DOM and *before* `fitAddon.fit()` had sized the grid. At that moment xterm was at its default 80×24. The daemon's nicely-formatted snapshot (at the parser's real size, say 160×40) was being written into an 80×24 grid — cursor positions got clamped, lines wrapped at col 80, everything baked wrong. Then `fit()` resized the xterm and there was no way to un-mangle the cells.

The fix in `apps/desktop/src/components/XtermTerminal.tsx`:

```ts
const attach = async () => {
    let entry = /* ... */;
    host.appendChild(entry.wrapper);
    entry.fitAddon.fit();                // xterm is now at real cols/rows
    entry.terminal.refresh(0, ...);

    const cols = entry.terminal.cols;
    const rows = entry.terminal.rows;
    await invoke("pty_resize", { sessionId, cols, rows });  // daemon parser rewraps
    const buffered = await invoke<string>("pty_get_buffer", { sessionId });
    if (buffered) {
        const bytes = decodeBase64(buffered);
        if (bytes.length > 0) {
            entry.terminal.clear();
            entry.terminal.write(bytes);
        }
    }
    // then attach listeners, etc.
};
```

Order matters:

1. **Mount** the wrapper to the real DOM container.
2. **`fit()`** the xterm to the container's measured cols/rows.
3. **`pty_resize`** so the daemon's vt100 parser rewraps its grid to match.
4. **`pty_get_buffer`** to pull the snapshot at the now-correct size.
5. **Clear + write** into the matching xterm.

Event listeners are installed earlier in `createCachedTerminal`, so live `Output` events can race with this sequence. The watermark handles the race: events with `seq_from < cursor` are dropped, and the cursor is updated by both `Spawned` and `Buffer` responses taking the max, so by the time we write the snapshot the cursor is already at the right place.

---

## Disk layout

Everything lives under the Tauri app data dir. On macOS:

```
~/Library/Application Support/be.kodeus.impala/daemon/
├── pty.sock          Unix domain socket (chmod 0600)
├── pty.token         64-char hex token (chmod 0600)
├── pty.pid           Daemon PID
└── daemon.log        Daemon stdout/stderr (append-only)
```

No scrollback on disk — sessions only survive as long as the daemon process itself. If the daemon crashes or the machine reboots, sessions are gone. Disk persistence would need an explicit snapshot strategy and has awkward UX for dead children (a stale Claude TUI with no live process underneath it), so we deliberately punted on it. See *Known limitations* below.

To verify the daemon is alive after quitting Impala:

```sh
DIR=~/Library/Application\ Support/be.kodeus.impala/daemon
ps -p "$(cat "$DIR/pty.pid")" -o pid,ppid,stat,command
```

`PPID` should be `1` (launchd) and `STAT` should contain `s` (session leader) — confirms `setsid()` worked.

---

## Known limitations

- **Daemon crashes lose sessions.** No disk persistence. The daemon is designed to run indefinitely; if it falls over, you start fresh.
- **No auto-reconnect.** If the daemon dies while Impala is running, pending and future requests fail with `"daemon disconnected"`. Restart the app to re-establish the connection.
- **Historical scrollback is lost on reattach.** Only the current visible screen is serialized by `contents_formatted()`. If you want to see what scrolled off, you can't. Fix is a scrollback-enabled vt100 parser and `contents_full()` on reattach.
- **Spawn race lockfile is missing.** Two simultaneous `DaemonClient::ensure()` calls could both try to spawn; the loser dies on socket-bind. One-per-app-instance makes this not-a-problem in practice.
- **Codesigning is inherited.** The daemon is a Tauri `externalBin` sidecar and gets signed with the same Apple cert and entitlements as the main app. If we ever add sidecar-specific entitlements we need to make sure the daemon gets them too, or Gatekeeper will kill the orphaned child a few seconds after GUI quit.

---

## Troubleshooting

### Sessions don't survive quit

Check the daemon log:

```sh
tail -f ~/Library/Application\ Support/be.kodeus.impala/daemon/daemon.log
```

If you see the startup line but then nothing — and `ps -p "$(cat .../pty.pid)"` says no such process — Gatekeeper killed it. Open Console.app, filter for `impala-pty-daemon` or `taskgated`, look for a codesign rejection.

### Reattach shows garbled narrow content

Means the frontend wrote the snapshot into an xterm that wasn't sized correctly yet. Check that `attach()` in `XtermTerminal.tsx` is calling `fitAddon.fit()` + `pty_resize` **before** `pty_get_buffer`. The order is load-bearing.

### Reattach is at the wrong width

The daemon's parser is at one size, xterm is at another. Either:
- The frontend didn't call `pty_resize` with the real cols/rows before `pty_get_buffer`, or
- `pty_resize` hit an error and the resize didn't land.

Check the daemon log for parser resize errors and confirm the `Resize` request is being sent.

### Duplicate bytes at the reattach seam

The watermark isn't filtering. Check that:
- `Spawned` / `Buffer` responses include `session_id` and `seq_upto`.
- The reader task in `daemon_client.rs` is extracting them and updating `session_cursors`.
- `dispatch_event` in `daemon_client.rs` is comparing `seq_from < cursor`.

Unit tests in `backend/tauri/shared/src/wire.rs` exercise the round-trip. If those pass and duplication still happens, the flush thread's parser-update-and-bump-under-one-lock invariant was broken by a refactor.

---

## File reference

| Purpose | Path |
|---|---|
| Daemon binary | `backend/tauri/daemon/src/main.rs` |
| Wire protocol types | `backend/tauri/shared/src/wire.rs` |
| Disk paths | `backend/tauri/shared/src/paths.rs` |
| Tauri client | `backend/tauri/src/daemon_client.rs` |
| PTY command forwarders | `backend/tauri/src/pty.rs` |
| Frontend reattach order | `apps/desktop/src/components/XtermTerminal.tsx` |
| Sidecar build script | `scripts/build-pty-daemon-sidecar.sh` |
| Tauri external bin wiring | `backend/tauri/tauri.conf.json` (`bundle.externalBin`) |

---

## Further reading

- **Superset's terminal daemon deep-dive** (in `~/Projects/superset/apps/marketing/content/blog/terminal-daemon-deep-dive.mdx` if you have the repo) — the architectural reference this feature is modeled on.
- **`portable-pty` docs** — the crate that wraps native PTY primitives.
- **`vt100` crate docs** — the headless terminal emulator.
- **Tauri sidecar / externalBin docs** — how the daemon gets bundled and codesigned alongside the app.
