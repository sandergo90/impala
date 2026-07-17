use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl};
use tracing::{debug, info, warn};

/// tabId -> worktreePath for every live browser webview. Lets worktree-scoped
/// callers (hook-server endpoints, MCP tools) find "the browser pane of this
/// worktree" without knowing frontend tab state.
#[derive(Default)]
pub struct BrowserRegistry(pub Mutex<HashMap<String, String>>);

/// Console capture: shims console.*, window.onerror, and unhandledrejection
/// into a capped window.__IMPALA_LOGS__ ring buffer. Runs per navigation
/// (fresh window each time), so logs are per-page. The captured `logs` var is
/// the same array as window.__IMPALA_LOGS__ and is never reassigned — drains
/// must clear via length = 0, not by replacing the array.
const CONSOLE_SHIM: &str = r#"
(function () {
  if (window.__IMPALA_CONSOLE_SHIM__) return;
  window.__IMPALA_CONSOLE_SHIM__ = true;
  var logs = (window.__IMPALA_LOGS__ = []);
  var MAX = 500;
  function push(level, args) {
    var msg = Array.prototype.map.call(args, function (a) {
      if (typeof a === "string") return a;
      try { return JSON.stringify(a); } catch (e) { return String(a); }
    }).join(" ");
    logs.push({ level: level, msg: msg, ts: Date.now() });
    if (logs.length > MAX) logs.shift();
  }
  ["log", "info", "warn", "error", "debug"].forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      push(level, arguments);
      return orig.apply(console, arguments);
    };
  });
  window.addEventListener("error", function (e) {
    push("error", [e.message + " (" + (e.filename || "") + ":" + (e.lineno || 0) + ")"]);
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    push("error", ["Unhandled rejection: " + (r && r.stack ? r.stack : String(r))]);
  });
})();
"#;

// Webview labels must stay within tauri's allowed charset; tab ids are
// frontend-generated (`browser-{slot}-{timestamp}`) but sanitize anyway.
fn label_for(id: &str) -> String {
    let safe: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    format!("browser-{safe}")
}

fn get_webview(app: &AppHandle, id: &str) -> Result<Webview, String> {
    app.webviews()
        .get(&label_for(id))
        .cloned()
        .ok_or_else(|| format!("no browser webview for id {id}"))
}

/// Create the child webview for a browser tab, or re-show an existing one at
/// the given bounds. Bounds are logical (CSS px), relative to the main window.
#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    id: String,
    worktree_path: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    app.state::<BrowserRegistry>()
        .0
        .lock()
        .unwrap()
        .insert(id.clone(), worktree_path);

    if let Ok(wv) = get_webview(&app, &id) {
        info!(id = %id, x, y, width, height, "browser_open: reshow existing webview");
        wv.set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        wv.set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        wv.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    info!(id = %id, url = %url, x, y, width, height, "browser_open: creating webview");
    let parsed = Url::parse(&url).map_err(|e| e.to_string())?;
    let window = app.get_window("main").ok_or("main window not found")?;
    let nav_app = app.clone();
    let nav_id = id.clone();
    let load_app = app.clone();
    let load_id = id.clone();
    let builder = WebviewBuilder::new(label_for(&id), WebviewUrl::External(parsed))
        .initialization_script(CONSOLE_SHIM)
        .on_navigation(move |url| {
            debug!(id = %nav_id, url = %url, "browser on_navigation");
            let _ = nav_app.emit_to("main", &format!("browser-nav-{nav_id}"), url.to_string());
            true
        })
        .on_page_load(move |_wv, payload| {
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            debug!(id = %load_id, url = %payload.url(), loading, "browser on_page_load");
            let _ = load_app.emit_to("main", &format!("browser-loading-{load_id}"), loading);
        });
    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| {
            warn!(id = %id, error = %e, "browser_open: add_child failed");
            e.to_string()
        })?;
    Ok(())
}

#[tauri::command]
pub fn browser_set_bounds(
    app: AppHandle,
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let wv = get_webview(&app, &id)?;
    wv.set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    wv.set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())
}

// "Hiding" is implemented by parking the view far offscreen: WKWebView comes
// back BLACK from a setHidden(true)/setHidden(false) cycle (the layer's
// contents are dropped and not repainted), so hide()/show() are unusable for
// tab switching. The real position is restored by the frontend's next
// browser_set_bounds / browser_open call, which always follows a show.
const PARK_OFFSET: f64 = -20000.0;

#[tauri::command]
pub fn browser_set_visible(app: AppHandle, id: String, visible: bool) -> Result<(), String> {
    debug!(id = %id, visible, "browser_set_visible");
    let wv = get_webview(&app, &id)?;
    if visible {
        // Defensive: un-hide webviews that a previous build's hide() left
        // hidden. Position is restored by the caller's bounds sync.
        wv.show().map_err(|e| e.to_string())
    } else {
        wv.set_position(LogicalPosition::new(PARK_OFFSET, PARK_OFFSET))
            .map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, id: String, url: String) -> Result<(), String> {
    info!(id = %id, url = %url, "browser_navigate");
    let wv = get_webview(&app, &id).map_err(|e| {
        warn!(id = %id, error = %e, "browser_navigate: webview missing");
        e
    })?;
    let parsed = Url::parse(&url).map_err(|e| e.to_string())?;
    wv.navigate(parsed).map_err(|e| {
        warn!(id = %id, error = %e, "browser_navigate: navigate failed");
        e.to_string()
    })
}

/// Back/forward via JS — the multiwebview surface has no native history API
/// (tauri#13957).
#[tauri::command]
pub fn browser_history(app: AppHandle, id: String, direction: String) -> Result<(), String> {
    let wv = get_webview(&app, &id)?;
    let js = if direction == "back" {
        "history.back()"
    } else {
        "history.forward()"
    };
    wv.eval(js).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_reload(app: AppHandle, id: String) -> Result<(), String> {
    let wv = get_webview(&app, &id)?;
    wv.reload().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_close(app: AppHandle, id: String) -> Result<(), String> {
    app.state::<BrowserRegistry>().0.lock().unwrap().remove(&id);
    if let Ok(wv) = get_webview(&app, &id) {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Agent hooks: JS-with-result + screenshot via the native WKWebView, exposed
// as commands (and, via hook-server endpoints, to impala-mcp).
// ---------------------------------------------------------------------------

/// Resolve a worktree to its (first) browser webview via the registry.
pub fn webview_for_worktree(app: &AppHandle, worktree_path: &str) -> Result<Webview, String> {
    let registry = app.state::<BrowserRegistry>();
    let map = registry.0.lock().unwrap();
    let mut ids: Vec<&String> = map
        .iter()
        .filter(|(_, wt)| wt.as_str() == worktree_path)
        .map(|(id, _)| id)
        .collect();
    ids.sort();
    let id = ids
        .first()
        .ok_or_else(|| "no browser tab open for this worktree".to_string())?;
    get_webview(app, id)
}

pub fn screenshot_png_base64(wv: &Webview) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let png = native::take_screenshot(wv, Duration::from_secs(5))?;
    debug!(bytes = png.len(), "browser screenshot captured");
    Ok(STANDARD.encode(png))
}

pub fn console_logs(wv: &Webview, clear: bool) -> Result<serde_json::Value, String> {
    // The shim pushes into the same array forever; draining must clear with
    // length = 0 (see CONSOLE_SHIM), and stringify before clearing.
    let js = if clear {
        "(function(){var l=window.__IMPALA_LOGS__||[];var s=JSON.stringify(l);l.length=0;return s;})()"
    } else {
        "JSON.stringify(window.__IMPALA_LOGS__||[])"
    };
    let raw = native::eval_js(wv, js, Duration::from_secs(3))?;
    let logs: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("bad console payload: {e}"))?;
    Ok(serde_json::json!({ "logs": logs }))
}

pub fn page_info(wv: &Webview) -> Result<serde_json::Value, String> {
    let raw = native::eval_js(
        wv,
        "JSON.stringify({url:location.href,title:document.title,readyState:document.readyState})",
        Duration::from_secs(3),
    )?;
    serde_json::from_str(&raw).map_err(|e| format!("bad page info payload: {e}"))
}

/// Navigate the worktree's browser pane; if none exists, ask the frontend to
/// create the tab (the webview materializes when the pane first mounts).
pub fn navigate_worktree(
    app: &AppHandle,
    worktree_path: &str,
    url: &str,
) -> Result<serde_json::Value, String> {
    let parsed = Url::parse(url).map_err(|e| e.to_string())?;
    match webview_for_worktree(app, worktree_path) {
        Ok(wv) => {
            info!(worktree_path = %worktree_path, url = %url, "browser navigate (worktree)");
            wv.navigate(parsed).map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "created": false }))
        }
        Err(_) => {
            info!(worktree_path = %worktree_path, url = %url, "browser navigate: requesting new tab");
            let _ = app.emit_to(
                "main",
                "browser-request-open",
                serde_json::json!({ "worktreePath": worktree_path, "url": url }),
            );
            Ok(serde_json::json!({ "created": true }))
        }
    }
}

#[tauri::command]
pub async fn browser_screenshot(app: AppHandle, id: String) -> Result<String, String> {
    let wv = get_webview(&app, &id)?;
    screenshot_png_base64(&wv)
}

#[tauri::command]
pub async fn browser_console_logs(
    app: AppHandle,
    id: String,
    clear: Option<bool>,
) -> Result<serde_json::Value, String> {
    let wv = get_webview(&app, &id)?;
    console_logs(&wv, clear.unwrap_or(false))
}

#[tauri::command]
pub async fn browser_page_info(app: AppHandle, id: String) -> Result<serde_json::Value, String> {
    let wv = get_webview(&app, &id)?;
    page_info(&wv)
}

#[cfg(target_os = "macos")]
mod native {
    use std::sync::{mpsc, Mutex};
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2::rc::Retained;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSImage,
    };
    use objc2_foundation::{NSDictionary, NSError, NSString};
    use objc2_web_kit::WKWebView;
    use tauri::Webview;

    /// Run JS in the page's main frame and return its result. Always send
    /// JSON.stringify(...)-shaped JS so the result is a string.
    ///
    /// `with_webview` dispatches to the main thread and the completion block
    /// answers over a channel — never call this ON the main thread (async
    /// commands and the hook-server thread are fine; both run elsewhere).
    pub fn eval_js(webview: &Webview, js: &str, timeout: Duration) -> Result<String, String> {
        let (tx, rx) = mpsc::channel::<Result<String, String>>();
        let tx = Mutex::new(Some(tx));
        let js = js.to_string();
        webview
            .with_webview(move |pw| {
                let wk = unsafe { &*(pw.inner() as *const WKWebView) };
                let block = RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
                    let Some(tx) = tx.lock().unwrap().take() else {
                        return;
                    };
                    if !error.is_null() {
                        let desc = unsafe { (*error).localizedDescription() };
                        let _ = tx.send(Err(desc.to_string()));
                        return;
                    }
                    if result.is_null() {
                        let _ = tx.send(Ok(String::new()));
                        return;
                    }
                    let obj = unsafe { &*result };
                    let text = match obj.downcast_ref::<NSString>() {
                        Some(s) => s.to_string(),
                        None => format!("{obj:?}"),
                    };
                    let _ = tx.send(Ok(text));
                });
                unsafe {
                    wk.evaluateJavaScript_completionHandler(
                        &NSString::from_str(&js),
                        Some(&block),
                    );
                }
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(timeout)
            .map_err(|_| "timed out waiting for the page to respond".to_string())?
    }

    pub fn take_screenshot(webview: &Webview, timeout: Duration) -> Result<Vec<u8>, String> {
        let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
        let tx = Mutex::new(Some(tx));
        webview
            .with_webview(move |pw| {
                let wk = unsafe { &*(pw.inner() as *const WKWebView) };
                let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                    let Some(tx) = tx.lock().unwrap().take() else {
                        return;
                    };
                    if !error.is_null() {
                        let desc = unsafe { (*error).localizedDescription() };
                        let _ = tx.send(Err(desc.to_string()));
                        return;
                    }
                    if image.is_null() {
                        let _ = tx.send(Err("snapshot returned no image".to_string()));
                        return;
                    }
                    let image = unsafe { &*image };
                    let _ = tx.send(encode_png(image));
                });
                unsafe {
                    wk.takeSnapshotWithConfiguration_completionHandler(None, &block);
                }
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(timeout)
            .map_err(|_| "timed out waiting for the snapshot".to_string())?
    }

    fn encode_png(image: &NSImage) -> Result<Vec<u8>, String> {
        let tiff = image
            .TIFFRepresentation()
            .ok_or("no TIFF representation")?;
        let rep =
            NSBitmapImageRep::imageRepWithData(&tiff).ok_or("could not read bitmap data")?;
        let props: Retained<NSDictionary<NSBitmapImageRepPropertyKey, AnyObject>> =
            NSDictionary::new();
        let png = unsafe {
            rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props)
        }
        .ok_or("PNG encoding failed")?;
        Ok(png.to_vec())
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    use std::time::Duration;
    use tauri::Webview;

    pub fn eval_js(_wv: &Webview, _js: &str, _t: Duration) -> Result<String, String> {
        Err("browser agent hooks are only supported on macOS".to_string())
    }

    pub fn take_screenshot(_wv: &Webview, _t: Duration) -> Result<Vec<u8>, String> {
        Err("browser agent hooks are only supported on macOS".to_string())
    }
}
