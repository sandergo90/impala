use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

const MAX_BUFFER_SIZE: usize = 512 * 1024; // 512KB scrollback buffer per session

struct PtySession {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    buffer: Arc<Mutex<Vec<u8>>>,
}

pub struct PtyState(Mutex<HashMap<String, PtySession>>);

impl PtyState {
    pub fn new() -> Self {
        PtyState(Mutex::new(HashMap::new()))
    }
}

fn sanitize_event_id(id: &str) -> String {
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

#[tauri::command]
pub fn pty_spawn(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, PtyState>,
    session_id: String,
    cwd: String,
    command: Option<Vec<String>>,
    env_vars: Option<HashMap<String, String>>,
) -> Result<bool, String> {
    // Don't spawn if session already exists
    {
        let sessions = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        if sessions.contains_key(&session_id) {
            return Ok(false);
        }
    }

    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let mut cmd = match &command {
        Some(args) if !args.is_empty() => {
            // Spawn through login shell so PATH includes user-installed binaries
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
            let mut c = CommandBuilder::new(&shell);
            c.arg("-l");
            c.arg("-c");
            c.arg(args.join(" "));
            c
        }
        _ => CommandBuilder::new_default_prog(),
    };
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(vars) = &env_vars {
        for (key, value) in vars {
            cmd.env(key, value);
        }
    }

    let child = match pair.slave.spawn_command(cmd) {
        Ok(child) => child,
        Err(e) => {
            let safe_id = sanitize_event_id(&session_id);
            let error_event = format!("pty-error-{}", safe_id);
            let _ = app_handle.emit(&error_event, format!("Failed to spawn: {}", e));
            return Err(format!("Failed to spawn command: {}", e));
        }
    };

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to get PTY reader: {}", e))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {}", e))?;

    let buffer: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let buffer_for_thread = Arc::clone(&buffer);

    let child = Arc::new(Mutex::new(child));
    let child_for_thread = Arc::clone(&child);

    let session = PtySession {
        master: pair.master,
        writer,
        child,
        buffer,
    };

    {
        let mut sessions = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        sessions.insert(session_id.clone(), session);
    }

    let safe_id = sanitize_event_id(&session_id);

    // Background thread to read PTY output, buffer it, and emit batched events.
    // Batching prevents rapid output (e.g. bun dev rebuilds) from flooding the UI thread.
    let pending: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let pending_for_flush = Arc::clone(&pending);
    let app_for_flush = app_handle.clone();
    let event_name = format!("pty-output-{}", safe_id);
    let event_name_flush = event_name.clone();

    // Backpressure: pause reads when pending buffer is too large
    const MAX_FLUSH_BYTES: usize = 128 * 1024;
    const BACKPRESSURE_HIGH: usize = 1024 * 1024;
    const BACKPRESSURE_LOW: usize = 256 * 1024;

    let backpressured = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let backpressured_for_read = Arc::clone(&backpressured);

    // Flush thread: emits pending data every 16ms (~60fps), capped at 128KB per tick
    let flush_running = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let flush_running_clone = Arc::clone(&flush_running);
    std::thread::spawn(move || {
        while flush_running_clone.load(std::sync::atomic::Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(16));
            let data = {
                let mut p = pending_for_flush.lock().unwrap();
                if p.is_empty() { continue; }
                if p.len() <= MAX_FLUSH_BYTES {
                    // Flush all, clear backpressure
                    backpressured.store(false, std::sync::atomic::Ordering::Relaxed);
                    std::mem::take(&mut *p)
                } else {
                    // Flush only MAX_FLUSH_BYTES, keep the rest
                    let chunk = p[..MAX_FLUSH_BYTES].to_vec();
                    *p = p[MAX_FLUSH_BYTES..].to_vec();
                    // Set backpressure if remaining > high watermark
                    if p.len() > BACKPRESSURE_HIGH {
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

    // Read thread: reads PTY output and appends to pending buffer
    // Pauses when backpressured to prevent unbounded memory growth
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            // Pause reads when backpressured
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
        // Stop flush thread and emit any remaining data
        flush_running.store(false, std::sync::atomic::Ordering::Relaxed);
        if let Ok(mut p) = pending.lock() {
            if !p.is_empty() {
                let encoded = STANDARD.encode(&*p);
                let _ = app_handle.emit(&event_name, encoded);
                p.clear();
            }
        }
        // Wait for child to exit and get the real exit code
        let exit_code = if let Ok(mut child) = child_for_thread.lock() {
            child.wait()
                .map(|status| status.exit_code() as i32)
                .unwrap_or(-1)
        } else {
            -1
        };
        let exit_event = format!("pty-exit-{}", safe_id);
        let _ = app_handle.emit(&exit_event, exit_code);
    });

    Ok(true)
}

#[tauri::command]
pub fn pty_get_buffer(
    state: tauri::State<'_, PtyState>,
    session_id: String,
) -> Result<String, String> {
    let sessions = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    let scrollback = session
        .buffer
        .lock()
        .map_err(|e| format!("Buffer lock error: {}", e))?;

    Ok(STANDARD.encode(&*scrollback))
}

#[tauri::command]
pub fn pty_write(
    state: tauri::State<'_, PtyState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let decoded = STANDARD
        .decode(&data)
        .map_err(|e| format!("Base64 decode error: {}", e))?;

    let mut sessions = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    session
        .writer
        .write_all(&decoded)
        .map_err(|e| format!("Write error: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, PtyState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Resize error: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn pty_kill(
    state: tauri::State<'_, PtyState>,
    session_id: String,
) -> Result<(), String> {
    let mut sessions = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    if let Some(session) = sessions.remove(&session_id) {
        // Kill child and drop session in background to avoid blocking on process exit
        std::thread::spawn(move || {
            if let Ok(mut child) = session.child.lock() {
                let _ = child.kill();
            }
            drop(session);
        });
    }
    Ok(())
}

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
                match child.try_wait() {
                    Ok(Some(_status)) => Ok(false),
                    Ok(None) => Ok(true),
                    Err(_) => Ok(false),
                }
            } else {
                Ok(false)
            }
        }
    }
}
