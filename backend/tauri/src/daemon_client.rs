use anyhow::{anyhow, bail, Context, Result};
use impala_daemon_shared::paths::DaemonPaths;
use impala_daemon_shared::wire::{
    ClientFrame, Event, EventFrame, Request, Response, ResponseFrame, KIND_EVENT, KIND_RESPONSE,
};
use impala_daemon_shared::PROTOCOL_VERSION;
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write as _;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot};

const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const BUNDLED_DAEMON_VERSION: &str = env!("BUNDLED_DAEMON_VERSION");
const SOCKET_TIMEOUT: Duration = Duration::from_secs(3);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

pub struct DaemonState(pub OnceLock<DaemonClient>);

impl DaemonState {
    pub fn new() -> Self {
        Self(OnceLock::new())
    }

    pub fn client(&self) -> Result<&DaemonClient, String> {
        self.0
            .get()
            .ok_or_else(|| "pty daemon not ready".to_string())
    }
}

pub struct DaemonClient {
    pub paths: DaemonPaths,
    pub daemon_version: String,
    pub daemon_pid: u32,
    next_id: AtomicU64,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>>,
    request_tx: mpsc::UnboundedSender<(u64, Request)>,
    /// Per-session high-water mark — `Event::Output` chunks strictly
    /// below the cursor are already present in the last Spawned/Buffer
    /// snapshot the frontend applied, and get dropped before we emit
    /// them to Tauri.
    session_cursors: Arc<Mutex<HashMap<String, u64>>>,
}

impl DaemonClient {
    pub async fn ensure(app: &AppHandle) -> Result<Self> {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .context("app_data_dir unavailable")?;
        let paths = DaemonPaths::under(&app_data_dir);
        std::fs::create_dir_all(&paths.root)?;
        ensure_token(&paths.token)?;

        let (stream, daemon_version, daemon_pid) =
            connect_or_spawn(&paths, &app_data_dir).await?;
        let (reader, writer) = stream.into_split();

        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let session_cursors: Arc<Mutex<HashMap<String, u64>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let (request_tx, request_rx) = mpsc::unbounded_channel::<(u64, Request)>();

        tokio::spawn(writer_task(request_rx, writer));
        tokio::spawn(reader_task(
            reader,
            Arc::clone(&pending),
            Arc::clone(&session_cursors),
            app.clone(),
        ));

        Ok(Self {
            paths,
            daemon_version,
            daemon_pid,
            next_id: AtomicU64::new(1),
            pending,
            request_tx,
            session_cursors,
        })
    }

    pub fn forget_session(&self, session_id: &str) {
        self.session_cursors.lock().unwrap().remove(session_id);
    }

    pub async fn request(&self, req: Request) -> Result<Response, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        if self.request_tx.send((id, req)).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err("daemon disconnected".into());
        }
        rx.await.map_err(|_| "daemon disconnected".to_string())
    }
}

// --------------------------------------------------------------------
// Connection bring-up
// --------------------------------------------------------------------

async fn connect_or_spawn(
    paths: &DaemonPaths,
    data_dir: &Path,
) -> Result<(UnixStream, String, u32)> {
    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 0..3 {
        match try_hello(paths).await {
            Ok((stream, daemon_version, pid)) => {
                if daemon_version == BUNDLED_DAEMON_VERSION {
                    return Ok((stream, daemon_version, pid));
                }
                eprintln!(
                    "[impala] retiring stale pty daemon v{daemon_version} (bundled v{BUNDLED_DAEMON_VERSION}, pid={pid})"
                );
                if let Err(e) = request_shutdown(stream).await {
                    eprintln!("[impala] daemon refused shutdown: {e:#}");
                }
                wait_for_socket_gone(&paths.sock, SHUTDOWN_TIMEOUT).await.ok();
            }
            Err(e) => last_err = Some(e),
        }
        if attempt == 2 {
            break;
        }
        spawn_daemon(paths, data_dir)?;
        wait_for_socket(&paths.sock, SOCKET_TIMEOUT).await?;
    }
    Err(last_err.unwrap_or_else(|| anyhow!("daemon never came up")))
}

async fn try_hello(paths: &DaemonPaths) -> Result<(UnixStream, String, u32)> {
    let token = std::fs::read_to_string(&paths.token)?.trim().to_owned();
    let mut stream = UnixStream::connect(&paths.sock).await?;

    let resp = {
        let (r, mut w) = stream.split();
        let mut lines = BufReader::new(r).lines();

        let frame = ClientFrame {
            id: 0,
            req: Request::Hello {
                token,
                client_version: CLIENT_VERSION.into(),
                protocol_version: PROTOCOL_VERSION,
            },
        };
        let mut buf = serde_json::to_vec(&frame)?;
        buf.push(b'\n');
        w.write_all(&buf).await?;
        w.flush().await?;

        let line = lines
            .next_line()
            .await?
            .ok_or_else(|| anyhow!("eof before hello response"))?;
        parse_response(&line)?
    };

    match resp {
        Response::HelloOk {
            daemon_version,
            pid,
            ..
        } => Ok((stream, daemon_version, pid)),
        Response::Error { message } => bail!("handshake rejected: {message}"),
        other => bail!("unexpected handshake response: {other:?}"),
    }
}

async fn request_shutdown(mut stream: UnixStream) -> Result<()> {
    let frame = ClientFrame {
        id: 1,
        req: Request::Shutdown,
    };
    let (r, mut w) = stream.split();
    let mut buf = serde_json::to_vec(&frame)?;
    buf.push(b'\n');
    w.write_all(&buf).await?;
    w.flush().await?;

    let mut lines = BufReader::new(r).lines();
    let line = lines
        .next_line()
        .await?
        .ok_or_else(|| anyhow!("eof before shutdown ack"))?;
    match parse_response(&line)? {
        Response::ShutdownAck => Ok(()),
        Response::Error { message } => bail!("daemon rejected shutdown: {message}"),
        other => bail!("unexpected shutdown response: {other:?}"),
    }
}

fn ensure_token(path: &Path) -> Result<()> {
    if path.exists() {
        return Ok(());
    }
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut f = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(token.as_bytes())?;
    Ok(())
}

fn spawn_daemon(paths: &DaemonPaths, data_dir: &Path) -> Result<()> {
    let binary = resolve_daemon_binary()?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.log)?;

    let mut cmd = Command::new(&binary);
    cmd.arg("--data-dir")
        .arg(data_dir)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);

    // setsid() puts the daemon in its own session, detached from the
    // Tauri app's process group so SIGHUP on GUI quit doesn't take it.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    cmd.spawn().context("spawning daemon")?;
    Ok(())
}

async fn wait_for_socket(path: &Path, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if path.exists() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    bail!("socket {} did not appear within {:?}", path.display(), timeout)
}

async fn wait_for_socket_gone(path: &Path, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !path.exists() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    bail!(
        "socket {} did not disappear within {:?}",
        path.display(),
        timeout
    )
}

fn resolve_daemon_binary() -> Result<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let bundled = parent.join("impala-pty-daemon");
            if bundled.exists() {
                return Ok(bundled);
            }
        }
    }
    let triple = target_triple();
    let candidates = [
        PathBuf::from("backend/tauri/binaries").join(format!("impala-pty-daemon-{triple}")),
        PathBuf::from("binaries").join(format!("impala-pty-daemon-{triple}")),
    ];
    for c in &candidates {
        if c.exists() {
            return Ok(c.clone());
        }
    }
    Err(anyhow!(
        "impala-pty-daemon binary not found — run scripts/build-pty-daemon-sidecar.sh"
    ))
}

const fn target_triple() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "aarch64-apple-darwin"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "x86_64-apple-darwin"
    }
}

// --------------------------------------------------------------------
// I/O tasks
// --------------------------------------------------------------------

async fn writer_task(
    mut rx: mpsc::UnboundedReceiver<(u64, Request)>,
    mut writer: OwnedWriteHalf,
) {
    while let Some((id, req)) = rx.recv().await {
        let frame = ClientFrame { id, req };
        let mut buf = match serde_json::to_vec(&frame) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("[daemon-client] serialize error: {e}");
                continue;
            }
        };
        buf.push(b'\n');
        if writer.write_all(&buf).await.is_err() {
            break;
        }
        if writer.flush().await.is_err() {
            break;
        }
    }
}

async fn reader_task(
    reader: OwnedReadHalf,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>>,
    session_cursors: Arc<Mutex<HashMap<String, u64>>>,
    app: AppHandle,
) {
    let mut lines = BufReader::new(reader).lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(l)) => l,
            _ => break,
        };
        if line.is_empty() {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[daemon-client] parse error: {e}: {line}");
                continue;
            }
        };
        match value.get("kind").and_then(|k| k.as_str()) {
            Some(KIND_RESPONSE) => match serde_json::from_value::<ResponseFrame>(value) {
                Ok(frame) => {
                    // Bump the per-session cursor BEFORE resolving the
                    // oneshot so any Output events processed after this
                    // frame on the same reader task see the new value.
                    match &frame.resp {
                        Response::Spawned {
                            session_id,
                            seq_upto,
                            ..
                        }
                        | Response::Buffer {
                            session_id,
                            seq_upto,
                            ..
                        } => {
                            let mut cursors = session_cursors.lock().unwrap();
                            let entry = cursors.entry(session_id.clone()).or_insert(0);
                            if *seq_upto > *entry {
                                *entry = *seq_upto;
                            }
                        }
                        _ => {}
                    }
                    if let Some(tx) = pending.lock().unwrap().remove(&frame.id) {
                        let _ = tx.send(frame.resp);
                    }
                }
                Err(e) => eprintln!("[daemon-client] bad response frame: {e}: {line}"),
            },
            Some(KIND_EVENT) => match serde_json::from_value::<EventFrame>(value) {
                Ok(frame) => dispatch_event(&app, &session_cursors, frame.event),
                Err(e) => eprintln!("[daemon-client] bad event frame: {e}: {line}"),
            },
            other => eprintln!("[daemon-client] unknown frame kind {other:?}: {line}"),
        }
    }
    // Connection dropped — fail all pending requests.
    pending.lock().unwrap().clear();
}

fn dispatch_event(
    app: &AppHandle,
    session_cursors: &Arc<Mutex<HashMap<String, u64>>>,
    event: Event,
) {
    match event {
        Event::Output {
            session_id,
            data_b64,
            seq_from,
        } => {
            // Drop chunks entirely below the cursor — their bytes are
            // already in the last scrollback snapshot the frontend
            // applied. Chunks are atomic, so a chunk is either fully
            // before or fully at/after the cursor (no partial overlap).
            let cursor = session_cursors
                .lock()
                .unwrap()
                .get(&session_id)
                .copied()
                .unwrap_or(0);
            if seq_from < cursor {
                return;
            }
            let name = format!("pty-output-{}", sanitize_event_id(&session_id));
            let _ = app.emit(&name, data_b64);
        }
        Event::Exit { session_id, code } => {
            session_cursors.lock().unwrap().remove(&session_id);
            let name = format!("pty-exit-{}", sanitize_event_id(&session_id));
            let _ = app.emit(&name, code);
        }
        Event::SpawnError {
            session_id,
            message,
        } => {
            let name = format!("pty-error-{}", sanitize_event_id(&session_id));
            let _ = app.emit(&name, message);
        }
    }
}

fn parse_response(line: &str) -> Result<Response> {
    let value: serde_json::Value = serde_json::from_str(line)?;
    match value.get("kind").and_then(|k| k.as_str()) {
        Some(KIND_RESPONSE) => {
            let frame: ResponseFrame = serde_json::from_value(value)?;
            Ok(frame.resp)
        }
        Some(KIND_EVENT) => bail!("expected response, got event"),
        other => bail!("unknown frame kind {other:?}"),
    }
}

pub fn sanitize_event_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect()
}
