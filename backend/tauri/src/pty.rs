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
    _child: Box<dyn portable_pty::Child + Send + Sync>,
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

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn command: {}", e))?;

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

    let session = PtySession {
        master: pair.master,
        writer,
        _child: child,
        buffer,
    };

    {
        let mut sessions = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        sessions.insert(session_id.clone(), session);
    }

    let safe_id = sanitize_event_id(&session_id);

    // Background thread to read PTY output, buffer it, and emit events
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // Append to scrollback buffer
                    if let Ok(mut scrollback) = buffer_for_thread.lock() {
                        scrollback.extend_from_slice(&buf[..n]);
                        // Trim to max size (keep the tail)
                        if scrollback.len() > MAX_BUFFER_SIZE {
                            let start = scrollback.len() - MAX_BUFFER_SIZE;
                            *scrollback = scrollback[start..].to_vec();
                        }
                    }

                    let encoded = STANDARD.encode(&buf[..n]);
                    let event_name = format!("pty-output-{}", safe_id);
                    let _ = app_handle.emit(&event_name, encoded);
                }
                Err(_) => break,
            }
        }
        let exit_event = format!("pty-exit-{}", safe_id);
        let _ = app_handle.emit(&exit_event, 0i32);
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
    if let Some(mut session) = sessions.remove(&session_id) {
        // Kill child and drop session in background to avoid blocking on process exit
        std::thread::spawn(move || {
            let _ = session._child.kill();
            drop(session);
        });
    }
    Ok(())
}
