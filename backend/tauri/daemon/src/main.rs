mod observability;

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use impala_daemon_shared::paths::DaemonPaths;
use impala_daemon_shared::shell_ready_scanner::{shell_supports_marker, ShellReadyScanState};
use impala_daemon_shared::wire::{
    ClientFrame, Event, EventFrame, Request, Response, ResponseFrame, SessionInfo, KIND_EVENT,
    KIND_RESPONSE,
};
use impala_daemon_shared::PROTOCOL_VERSION;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::env;
use std::io::{Read, Write as IoWrite};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[allow(unused_imports)]
use std::convert::TryFrom;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::fs;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{unix::OwnedWriteHalf, UnixListener, UnixStream};
use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::mpsc;

const DAEMON_VERSION: &str = env!("CARGO_PKG_VERSION");
const FLUSH_CHUNK: usize = 128 * 1024;
const FLUSH_INTERVAL_MS: u64 = 16;
const BACKPRESSURE_HIGH: usize = 1024 * 1024;
const BACKPRESSURE_LOW: usize = 256 * 1024;

struct Args {
    data_dir: PathBuf,
}

fn parse_args() -> Result<Args> {
    let mut data_dir = None;
    let mut it = env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--data-dir" => data_dir = it.next().map(PathBuf::from),
            other => bail!("unknown argument: {other}"),
        }
    }
    Ok(Args {
        data_dir: data_dir.ok_or_else(|| anyhow!("missing --data-dir"))?,
    })
}

// --------------------------------------------------------------------
// Registry
// --------------------------------------------------------------------

/// Per-session state owned by the flush thread and the request handlers.
/// All PTY output is fed through `parser` as it flows past — the parser
/// maintains an in-memory terminal grid (cursor position, cell attributes,
/// alt-screen state). On reattach we ask the parser to serialize its
/// current screen as a replay-safe byte stream via `contents_formatted`,
/// which is what lets the frontend paint a clean picture regardless of
/// whatever cursor-positioning escape sequences the TUI emitted to get
/// to that state.
struct SessionState {
    parser: vt100::Parser,
    /// Total bytes ever processed for this session. Monotonic, drives
    /// the per-client `seq_from`/`seq_upto` watermark.
    total_bytes: u64,
}

struct Session {
    cwd: String,
    started_at: String,
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    writer: Box<dyn IoWrite + Send>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    state: Arc<Mutex<SessionState>>,
    /// Shell readiness scanning. `None` once we've decided the marker is
    /// no longer relevant (matched, timed out, or unsupported shell).
    /// Wrapped in Mutex because the read and timeout threads both touch it.
    /// Owned by the session so future requests (e.g. Kill) can inspect or
    /// clear it; current threads access it via cloned Arc handles.
    #[allow(dead_code)]
    shell_ready_scan: Arc<Mutex<Option<ShellReadyScanState>>>,
}

struct Registry {
    sessions: Mutex<HashMap<String, Session>>,
    subscribers: Mutex<HashMap<u64, mpsc::UnboundedSender<Event>>>,
    next_client_id: AtomicU64,
}

impl Registry {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
            subscribers: Mutex::new(HashMap::new()),
            next_client_id: AtomicU64::new(1),
        })
    }

    fn subscribe(&self) -> (u64, mpsc::UnboundedReceiver<Event>) {
        let id = self.next_client_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::unbounded_channel();
        self.subscribers.lock().unwrap().insert(id, tx);
        (id, rx)
    }

    fn unsubscribe(&self, id: u64) {
        self.subscribers.lock().unwrap().remove(&id);
    }

    fn broadcast(&self, event: Event) {
        let subs = self.subscribers.lock().unwrap();
        for tx in subs.values() {
            let _ = tx.send(event.clone());
        }
    }
}

// --------------------------------------------------------------------
// PTY session spawn
// --------------------------------------------------------------------

fn spawn_session(
    registry: &Arc<Registry>,
    session_id: String,
    cwd: String,
    command: Option<Vec<String>>,
    shell_path: Option<String>,
    shell_args: Option<Vec<String>>,
    env_vars: Vec<(String, String)>,
    cols: u16,
    rows: u16,
) -> Response {
    {
        let sessions = registry.sessions.lock().unwrap();
        if let Some(existing) = sessions.get(&session_id) {
            let state = existing.state.lock().unwrap();
            let screen_bytes = state.parser.screen().contents_formatted();
            return Response::Spawned {
                session_id: session_id.clone(),
                already_existed: true,
                scrollback_b64: STANDARD.encode(&screen_bytes),
                seq_upto: state.total_bytes,
            };
        }
    }

    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(p) => p,
        Err(e) => return Response::Error { message: format!("openpty: {e}") },
    };

    let shell = shell_path.unwrap_or_else(||
        env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
    );
    let default_args = ["-l".to_string()];
    let launch_args: &[String] = shell_args.as_deref().unwrap_or(&default_args);
    let mut cmd = match &command {
        Some(args) if !args.is_empty() => {
            let mut c = CommandBuilder::new(&shell);
            for a in launch_args {
                c.arg(a);
            }
            c.arg("-c");
            c.arg(args.join(" "));
            c
        }
        // Login shell so PATH picks up ~/.zprofile (Homebrew shellenv etc.)
        // when the bundled .app is launched from Finder with the empty
        // launchctl PATH.
        _ => {
            let mut c = CommandBuilder::new(&shell);
            for a in launch_args {
                c.arg(a);
            }
            c
        }
    };
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Prevent macOS Terminal's session-restore zshrc hook from cd-ing to a
    // previously saved directory.
    cmd.env_remove("TERM_SESSION_ID");
    cmd.env("TERM_PROGRAM", "Impala");
    for (k, v) in env_vars {
        cmd.env(k, v);
    }

    let child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            registry.broadcast(Event::SpawnError {
                session_id: session_id.clone(),
                message: e.to_string(),
            });
            return Response::Error { message: format!("spawn: {e}") };
        }
    };

    let reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => return Response::Error { message: format!("reader: {e}") },
    };
    let writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => return Response::Error { message: format!("writer: {e}") },
    };

    let state: Arc<Mutex<SessionState>> = Arc::new(Mutex::new(SessionState {
        parser: vt100::Parser::new(rows, cols, 0),
        total_bytes: 0,
    }));
    let child = Arc::new(Mutex::new(child));
    let master = Arc::new(Mutex::new(pair.master));

    // Decide if this shell supports OSC 133;A. We use the basename of the
    // path that we actually launched.
    let shell_basename = std::path::Path::new(&shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("sh")
        .to_string();
    let supports_marker = shell_supports_marker(&shell_basename);

    let shell_ready_scan = Arc::new(Mutex::new(if supports_marker {
        Some(ShellReadyScanState::new())
    } else {
        None
    }));

    let session = Session {
        cwd: cwd.clone(),
        started_at: timestamp(),
        master: Arc::clone(&master),
        writer,
        child: Arc::clone(&child),
        state: Arc::clone(&state),
        shell_ready_scan: Arc::clone(&shell_ready_scan),
    };
    registry.sessions.lock().unwrap().insert(session_id.clone(), session);

    if !supports_marker {
        registry.broadcast(Event::ShellReady {
            session_id: session_id.clone(),
            reason: "unsupported".into(),
        });
    }

    start_pty_io_threads(
        session_id.clone(),
        reader,
        state,
        child,
        Arc::clone(registry),
        Arc::clone(&shell_ready_scan),
    );

    if supports_marker {
        let registry = Arc::clone(registry);
        let session_id_for_timeout = session_id.clone();
        let scan_handle = Arc::clone(&shell_ready_scan);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(15));
            // If the scanner is already None, the read thread already
            // observed the marker and broadcast ShellReady — no-op.
            let mut guard = scan_handle.lock().unwrap();
            if guard.is_some() {
                // Drop any partial-match bytes still held by the scanner.
                // Partial markers are at most 7 bytes (the OSC 133;A
                // prefix), only present on the timeout path, and never
                // went through the vt100 parser. Re-injecting them would
                // require fabricating a seq_from that doesn't match the
                // parser bookkeeping; the simpler choice is to drop them.
                let _ = guard.as_mut().unwrap().take_held();
                *guard = None;
                drop(guard);
                registry.broadcast(Event::ShellReady {
                    session_id: session_id_for_timeout,
                    reason: "timed_out".into(),
                });
            }
        });
    }

    Response::Spawned {
        session_id,
        already_existed: false,
        scrollback_b64: String::new(),
        seq_upto: 0,
    }
}

fn start_pty_io_threads(
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    state: Arc<Mutex<SessionState>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    registry: Arc<Registry>,
    shell_ready_scan: Arc<Mutex<Option<ShellReadyScanState>>>,
) {
    let pending: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let backpressured = Arc::new(AtomicBool::new(false));
    let running = Arc::new(AtomicBool::new(true));

    // Flush thread — feeds drained chunks into the vt100 parser and
    // broadcasts them as Output events. Parser update and total_bytes
    // bump happen under the same lock so the watermark invariant still
    // holds: `seq_from == sb.total_bytes` at broadcast time.
    {
        let pending = Arc::clone(&pending);
        let state = Arc::clone(&state);
        let backpressured = Arc::clone(&backpressured);
        let running = Arc::clone(&running);
        let registry = Arc::clone(&registry);
        let session_id = session_id.clone();
        std::thread::spawn(move || {
            while running.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(FLUSH_INTERVAL_MS));
                let chunk = {
                    let mut p = pending.lock().unwrap();
                    if p.is_empty() {
                        continue;
                    }
                    if p.len() <= FLUSH_CHUNK {
                        backpressured.store(false, Ordering::Relaxed);
                        std::mem::take(&mut *p)
                    } else {
                        let chunk: Vec<u8> = p.drain(..FLUSH_CHUNK).collect();
                        if p.len() > BACKPRESSURE_HIGH {
                            backpressured.store(true, Ordering::Relaxed);
                        } else if p.len() <= BACKPRESSURE_LOW {
                            backpressured.store(false, Ordering::Relaxed);
                        }
                        chunk
                    }
                };
                let seq_from = {
                    let mut st = state.lock().unwrap();
                    let seq_from = st.total_bytes;
                    st.parser.process(&chunk);
                    st.total_bytes += chunk.len() as u64;
                    seq_from
                };
                registry.broadcast(Event::Output {
                    session_id: session_id.clone(),
                    data_b64: STANDARD.encode(&chunk),
                    seq_from,
                });
            }
        });
    }

    // Read thread — pulls PTY bytes into `pending`. Parser ownership
    // stays with the flush thread.
    {
        let pending = Arc::clone(&pending);
        let state = Arc::clone(&state);
        let backpressured = Arc::clone(&backpressured);
        let running = Arc::clone(&running);
        let registry = Arc::clone(&registry);
        let session_id_for_thread = session_id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                if backpressured.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(FLUSH_INTERVAL_MS));
                    continue;
                }
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let mut chunk: Vec<u8> = buf[..n].to_vec();
                        let mut matched_now = false;
                        {
                            let mut guard = shell_ready_scan.lock().unwrap();
                            if let Some(scanner) = guard.as_mut() {
                                let result = scanner.scan(&chunk);
                                chunk = result.output;
                                matched_now = result.matched;
                            }
                        }
                        if matched_now {
                            // Scanner is consumed once a marker is observed.
                            *shell_ready_scan.lock().unwrap() = None;
                            registry.broadcast(Event::ShellReady {
                                session_id: session_id_for_thread.clone(),
                                reason: "ready".into(),
                            });
                        }
                        if !chunk.is_empty() {
                            pending.lock().unwrap().extend_from_slice(&chunk);
                        }
                    }
                    Err(_) => break,
                }
            }

            running.store(false, Ordering::Relaxed);
            let tail = std::mem::take(&mut *pending.lock().unwrap());
            if !tail.is_empty() {
                let seq_from = {
                    let mut st = state.lock().unwrap();
                    let seq_from = st.total_bytes;
                    st.parser.process(&tail);
                    st.total_bytes += tail.len() as u64;
                    seq_from
                };
                registry.broadcast(Event::Output {
                    session_id: session_id_for_thread.clone(),
                    data_b64: STANDARD.encode(&tail),
                    seq_from,
                });
            }

            let exit_code = child
                .lock()
                .ok()
                .and_then(|mut c| c.wait().ok())
                .map(|s| s.exit_code() as i32)
                .unwrap_or(-1);
            registry.broadcast(Event::Exit {
                session_id: session_id_for_thread.clone(),
                code: exit_code,
            });
            registry
                .sessions
                .lock()
                .unwrap()
                .remove(&session_id_for_thread);
        });
    }
}

fn timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    secs.to_string()
}

// --------------------------------------------------------------------
// Request dispatch
// --------------------------------------------------------------------

fn handle_request(registry: &Arc<Registry>, req: Request) -> Response {
    match req {
        Request::Hello { .. } => Response::Error {
            message: "already authenticated".into(),
        },
        Request::List => {
            let sessions = registry.sessions.lock().unwrap();
            let list = sessions
                .iter()
                .map(|(id, s)| {
                    let alive = s
                        .child
                        .lock()
                        .ok()
                        .and_then(|mut c| c.try_wait().ok())
                        .map(|o| o.is_none())
                        .unwrap_or(false);
                    SessionInfo {
                        session_id: id.clone(),
                        cwd: s.cwd.clone(),
                        started_at: s.started_at.clone(),
                        alive,
                    }
                })
                .collect();
            Response::Sessions { sessions: list }
        }
        Request::Spawn {
            session_id,
            cwd,
            command,
            shell_path,
            shell_args,
            env,
            cols,
            rows,
        } => spawn_session(
            registry,
            session_id,
            cwd,
            command,
            shell_path,
            shell_args,
            env,
            cols,
            rows,
        ),
        Request::Write { session_id, data_b64 } => {
            let data = match STANDARD.decode(&data_b64) {
                Ok(d) => d,
                Err(e) => return Response::Error { message: format!("b64: {e}") },
            };
            let mut sessions = registry.sessions.lock().unwrap();
            match sessions.get_mut(&session_id) {
                None => Response::Error {
                    message: format!("no session {session_id}"),
                },
                Some(s) => match s.writer.write_all(&data) {
                    Ok(_) => Response::Wrote,
                    Err(e) => Response::Error { message: format!("write: {e}") },
                },
            }
        }
        Request::Resize {
            session_id,
            cols,
            rows,
        } => {
            let sessions = registry.sessions.lock().unwrap();
            match sessions.get(&session_id) {
                None => Response::Error {
                    message: format!("no session {session_id}"),
                },
                Some(s) => {
                    // Resize the parser first so subsequent snapshots
                    // reflect the new grid; vt100 rewraps the current
                    // screen under the hood.
                    s.state.lock().unwrap().parser.set_size(rows, cols);
                    let master = s.master.lock().unwrap();
                    match master.resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    }) {
                        Ok(_) => Response::Resized,
                        Err(e) => Response::Error {
                            message: format!("resize: {e}"),
                        },
                    }
                }
            }
        }
        Request::Kill { session_id } => {
            let session = registry.sessions.lock().unwrap().remove(&session_id);
            if let Some(s) = session {
                std::thread::spawn(move || {
                    if let Ok(mut c) = s.child.lock() {
                        let _ = c.kill();
                    }
                    drop(s);
                });
            }
            Response::Killed
        }
        Request::IsAlive { session_id } => {
            let sessions = registry.sessions.lock().unwrap();
            let alive = sessions
                .get(&session_id)
                .and_then(|s| s.child.lock().ok())
                .and_then(|mut c| c.try_wait().ok())
                .map(|o| o.is_none())
                .unwrap_or(false);
            Response::Alive { alive }
        }
        Request::GetBuffer { session_id } => {
            let sessions = registry.sessions.lock().unwrap();
            match sessions.get(&session_id) {
                None => Response::Error {
                    message: format!("no session {session_id}"),
                },
                Some(s) => {
                    let state = s.state.lock().unwrap();
                    Response::Buffer {
                        session_id: session_id.clone(),
                        data_b64: STANDARD.encode(&state.parser.screen().contents_formatted()),
                        seq_upto: state.total_bytes,
                    }
                }
            }
        }
        Request::Shutdown => Response::ShutdownAck,
    }
}

// --------------------------------------------------------------------
// Per-client connection handler
// --------------------------------------------------------------------

async fn handle_client(
    stream: UnixStream,
    expected_token: String,
    registry: Arc<Registry>,
    shutdown_tx: mpsc::Sender<()>,
) -> Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut lines = BufReader::new(reader).lines();

    // Authentication: one Hello frame then we're live.
    let first = lines
        .next_line()
        .await?
        .ok_or_else(|| anyhow!("eof before hello"))?;
    let hello: ClientFrame = serde_json::from_str(&first)?;
    match &hello.req {
        Request::Hello {
            token,
            protocol_version,
            ..
        } => {
            if token != &expected_token {
                write_response(&mut writer, hello.id, Response::Error { message: "bad token".into() }).await?;
                return Ok(());
            }
            if *protocol_version != PROTOCOL_VERSION {
                write_response(
                    &mut writer,
                    hello.id,
                    Response::Error {
                        message: format!(
                            "protocol mismatch: client {} daemon {}",
                            protocol_version, PROTOCOL_VERSION
                        ),
                    },
                )
                .await?;
                return Ok(());
            }
            write_response(
                &mut writer,
                hello.id,
                Response::HelloOk {
                    daemon_version: DAEMON_VERSION.into(),
                    protocol_version: PROTOCOL_VERSION,
                    pid: process::id(),
                },
            )
            .await?;
        }
        _ => {
            write_response(
                &mut writer,
                hello.id,
                Response::Error { message: "unauthenticated".into() },
            )
            .await?;
            return Ok(());
        }
    }

    let (client_id, mut event_rx) = registry.subscribe();

    // Main client loop: select between incoming requests and outgoing events.
    let result: Result<()> = async {
        loop {
            tokio::select! {
                maybe_line = lines.next_line() => {
                    let line = match maybe_line? {
                        Some(l) if l.is_empty() => continue,
                        Some(l) => l,
                        None => break,
                    };
                    let frame: ClientFrame = match serde_json::from_str(&line) {
                        Ok(f) => f,
                        Err(e) => {
                            write_response(&mut writer, 0, Response::Error { message: format!("parse: {e}") }).await?;
                            continue;
                        }
                    };
                    let is_shutdown = matches!(frame.req, Request::Shutdown);
                    let resp = handle_request(&registry, frame.req);
                    write_response(&mut writer, frame.id, resp).await?;
                    if is_shutdown {
                        let _ = shutdown_tx.send(()).await;
                        break;
                    }
                }
                maybe_ev = event_rx.recv() => {
                    match maybe_ev {
                        Some(ev) => write_event(&mut writer, ev).await?,
                        None => break,
                    }
                }
            }
        }
        Ok(())
    }
    .await;

    registry.unsubscribe(client_id);
    result
}

async fn write_response(w: &mut OwnedWriteHalf, id: u64, resp: Response) -> Result<()> {
    let frame = ResponseFrame {
        kind: KIND_RESPONSE.into(),
        id,
        resp,
    };
    let mut buf = serde_json::to_vec(&frame)?;
    buf.push(b'\n');
    w.write_all(&buf).await?;
    w.flush().await?;
    Ok(())
}

async fn write_event(w: &mut OwnedWriteHalf, event: Event) -> Result<()> {
    let frame = EventFrame {
        kind: KIND_EVENT.into(),
        event,
    };
    let mut buf = serde_json::to_vec(&frame)?;
    buf.push(b'\n');
    w.write_all(&buf).await?;
    w.flush().await?;
    Ok(())
}

// --------------------------------------------------------------------
// Main
// --------------------------------------------------------------------

#[tokio::main]
async fn main() -> Result<()> {
    let _observability = observability::init();

    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        sentry::integrations::panic::panic_handler(info);
        tracing::error!(panic = %info, "pty-daemon panicked");
        prev(info);
    }));

    let args = parse_args()?;
    let paths = DaemonPaths::under(&args.data_dir);
    fs::create_dir_all(&paths.root).await?;

    let token = fs::read_to_string(&paths.token)
        .await
        .context("token file missing — app must provision it before spawn")?
        .trim()
        .to_owned();

    fs::write(&paths.pid, process::id().to_string()).await?;

    let _ = fs::remove_file(&paths.sock).await;
    let listener = UnixListener::bind(&paths.sock)?;
    std::fs::set_permissions(&paths.sock, std::fs::Permissions::from_mode(0o600))?;

    eprintln!(
        "[impala-pty-daemon] v{} pid={} listening on {}",
        DAEMON_VERSION,
        process::id(),
        paths.sock.display()
    );

    let registry = Registry::new();
    let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);
    let mut sigterm = signal(SignalKind::terminate())?;
    let mut sigint = signal(SignalKind::interrupt())?;

    loop {
        tokio::select! {
            accept = listener.accept() => {
                match accept {
                    Ok((stream, _)) => {
                        let token = token.clone();
                        let registry = Arc::clone(&registry);
                        let shutdown_tx = shutdown_tx.clone();
                        tokio::spawn(async move {
                            if let Err(e) = handle_client(stream, token, registry, shutdown_tx).await {
                                eprintln!("[impala-pty-daemon] client error: {e:#}");
                            }
                        });
                    }
                    Err(e) => eprintln!("[impala-pty-daemon] accept error: {e}"),
                }
            }
            _ = sigterm.recv() => break,
            _ = sigint.recv() => break,
            _ = shutdown_rx.recv() => break,
        }
    }

    eprintln!("[impala-pty-daemon] shutting down");
    let _ = fs::remove_file(&paths.sock).await;
    let _ = fs::remove_file(&paths.pid).await;
    Ok(())
}
