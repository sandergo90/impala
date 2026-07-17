use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl};
use tracing::{debug, info, warn};

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
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
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

#[tauri::command]
pub fn browser_set_visible(app: AppHandle, id: String, visible: bool) -> Result<(), String> {
    debug!(id = %id, visible, "browser_set_visible");
    let wv = get_webview(&app, &id)?;
    if visible {
        wv.show().map_err(|e| e.to_string())
    } else {
        wv.hide().map_err(|e| e.to_string())
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
    if let Ok(wv) = get_webview(&app, &id) {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}
