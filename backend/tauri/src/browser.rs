use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl};
use tracing::{debug, info, warn};

/// Per-tab state for every live browser webview, keyed by tab id. Lets
/// worktree-scoped callers (hook-server endpoints, MCP tools) find "the
/// browser pane of this worktree" without knowing frontend tab state, and
/// carries the virtual cursor's last position so glides stay continuous
/// across navigations (each page re-creates the overlay from scratch).
pub struct TabState {
    pub worktree_path: String,
    pub cursor: Option<(f64, f64)>,
}

#[derive(Default)]
pub struct BrowserRegistry(pub Mutex<HashMap<String, TabState>>);

static BROWSER_UNDERLAY_READY: AtomicBool = AtomicBool::new(false);

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

/// Virtual cursor overlay: makes agent-driven input visible in the pane. A
/// pointer-events:none arrow that glides to each interaction point (350ms,
/// matching the Rust-side wait in animate_cursor) and fades out after 2s
/// idle. Unregistered custom element names keep page CSS from styling it.
/// Runs per navigation; Rust re-seeds the position via moveTo's seed args.
const CURSOR_JS: &str = r##"
(function () {
  if (window.__IMPALA_CURSOR__) return;
  var GLIDE = "transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)";
  var FADE = "opacity 0.25s ease";
  var el = null, fadeTimer = null, pos = null;
  function ensure() {
    if (el && el.isConnected) return el;
    el = document.createElement("impala-cursor");
    el.style.cssText =
      "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;display:block;" +
      "opacity:0;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.45));transition:" + GLIDE + "," + FADE + ";";
    el.innerHTML =
      '<svg width="17" height="22" viewBox="0 0 17 22" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M1 1 L1 16.6 L5.4 12.9 L8 19.4 L11.2 18.1 L8.6 11.8 L14.6 11.3 Z" ' +
      'fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    (document.body || document.documentElement).appendChild(el);
    return el;
  }
  function place(x, y) {
    ensure().style.transform = "translate(" + x + "px, " + y + "px)";
    pos = { x: x, y: y };
  }
  function wake() {
    ensure().style.opacity = "1";
    if (fadeTimer) clearTimeout(fadeTimer);
    fadeTimer = setTimeout(function () { if (el) el.style.opacity = "0"; }, 2000);
  }
  window.__IMPALA_CURSOR__ = {
    moveTo: function (x, y, seedX, seedY) {
      var c = ensure();
      if (!pos) {
        // Fresh overlay (first action, or first after a navigation): start
        // from the seed — the pre-navigation position — without animating.
        c.style.transition = FADE;
        place(seedX == null ? x : seedX, seedY == null ? y : seedY);
        void c.getBoundingClientRect().width;
        c.style.transition = GLIDE + "," + FADE;
      }
      place(x, y);
      wake();
    },
    ripple: function () {
      if (!pos) return;
      var r = document.createElement("impala-cursor-ripple");
      r.style.cssText =
        "position:fixed;z-index:2147483646;pointer-events:none;display:block;" +
        "left:" + (pos.x - 12) + "px;top:" + (pos.y - 12) + "px;width:24px;height:24px;" +
        "border-radius:50%;border:2px solid rgba(59,130,246,0.9);background:rgba(59,130,246,0.3);" +
        "transform:scale(0.35);opacity:1;transition:transform 0.4s ease-out, opacity 0.45s ease-out;";
      (document.body || document.documentElement).appendChild(r);
      void r.getBoundingClientRect().width;
      r.style.transform = "scale(1.7)";
      r.style.opacity = "0";
      setTimeout(function () { if (r.parentNode) r.parentNode.removeChild(r); }, 500);
      wake();
    }
  };
})();
"##;

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

fn underlay_enabled_from_override(override_value: Option<&str>) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }

    !override_value.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "off"
        )
    })
}

fn underlay_enabled() -> bool {
    // The underlay is the supported macOS compositor path. Keep an environment
    // escape hatch so a packaged build can fall back to the legacy overlay
    // path without requiring a new binary.
    underlay_enabled_from_override(std::env::var("IMPALA_BROWSER_UNDERLAY").ok().as_deref())
}

fn underlay_ready() -> bool {
    BROWSER_UNDERLAY_READY.load(Ordering::Acquire)
}

#[tauri::command]
pub async fn browser_underlay_enabled(
    app: AppHandle,
    red: u8,
    green: u8,
    blue: u8,
) -> Result<bool, String> {
    if !underlay_enabled() {
        BROWSER_UNDERLAY_READY.store(false, Ordering::Release);
        return Ok(false);
    }
    #[cfg(target_os = "macos")]
    {
        if let Err(error) = native::configure_main_underlay(&app, red, green, blue) {
            BROWSER_UNDERLAY_READY.store(false, Ordering::Release);
            return Err(error);
        }
        BROWSER_UNDERLAY_READY.store(true, Ordering::Release);
        return Ok(true);
    }
    #[cfg(not(target_os = "macos"))]
    Ok(false)
}

#[tauri::command]
pub fn browser_set_overlay_active(active: bool) {
    if !underlay_ready() {
        return;
    }
    #[cfg(target_os = "macos")]
    native::set_overlay_active(active);
}

#[tauri::command]
pub fn browser_set_underlay_backdrop(
    app: AppHandle,
    red: u8,
    green: u8,
    blue: u8,
) -> Result<(), String> {
    if !underlay_ready() {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    return native::set_underlay_backdrop(&app, red, green, blue);
    #[cfg(not(target_os = "macos"))]
    Ok(())
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
        .entry(id.clone())
        .and_modify(|tab| tab.worktree_path = worktree_path.clone())
        .or_insert_with(|| TabState {
            worktree_path: worktree_path.clone(),
            cursor: None,
        });

    if let Ok(wv) = get_webview(&app, &id) {
        info!(id = %id, x, y, width, height, "browser_open: reshow existing webview");
        #[cfg(target_os = "macos")]
        let visibility_generation = if underlay_ready() {
            Some(native::begin_browser_visibility(&id, true))
        } else {
            None
        };
        let activation = (|| -> Result<(), String> {
            wv.set_position(LogicalPosition::new(x, y))
                .map_err(|e| e.to_string())?;
            wv.set_size(LogicalSize::new(width, height))
                .map_err(|e| e.to_string())?;
            wv.show().map_err(|e| e.to_string())?;
            if underlay_ready() {
                #[cfg(target_os = "macos")]
                {
                    native::set_browser_bounds(&id, x, y, width, height);
                    // Inactive underlay views remain composited behind the shell.
                    // Prepare this one at its final geometry, then promote it
                    // directly below the shell only after WebKit has a frame.
                    // The outgoing browser therefore remains the visible backing
                    // layer throughout the handoff.
                    native::wait_for_paint(&wv)?;
                    native::order_browser_below_main(
                        &app,
                        &id,
                        &wv,
                        visibility_generation.unwrap(),
                        true,
                    )?;
                }
            }
            Ok(())
        })();
        if let Err(error) = activation {
            #[cfg(target_os = "macos")]
            if let Some(generation) = visibility_generation {
                native::fail_browser_visibility(&id, generation);
            }
            let _ = wv.set_position(LogicalPosition::new(PARK_OFFSET, PARK_OFFSET));
            return Err(error);
        }
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
        // WKWebView's default UA lacks the "Version/… Safari/…" suffix, so
        // UA-sniffing sites (Google among them) serve their legacy fallback
        // pages. Present as current macOS Safari.
        .user_agent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
             (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
        )
        .initialization_script(CONSOLE_SHIM)
        .initialization_script(CURSOR_JS)
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
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| {
            warn!(id = %id, error = %e, "browser_open: add_child failed");
            e.to_string()
        })?;
    if underlay_ready() {
        #[cfg(target_os = "macos")]
        {
            let visibility_generation = native::begin_browser_visibility(&id, true);
            native::set_browser_bounds(&id, x, y, width, height);
            // A newly added child may initially sit above the main webview.
            // Put it under the shell immediately so the DOM handoff cover
            // owns the pane while WebKit produces its first frame.
            let activation = (|| -> Result<(), String> {
                native::order_browser_below_main(
                    &app,
                    &id,
                    &webview,
                    visibility_generation,
                    false,
                )?;
                native::wait_for_paint(&webview)?;
                // Re-promote after readiness in case another browser occupied
                // the slot directly beneath the shell during the wait.
                native::order_browser_below_main(&app, &id, &webview, visibility_generation, true)
            })();
            if let Err(error) = activation {
                native::fail_browser_visibility(&id, visibility_generation);
                native::remove_browser(&id);
                app.state::<BrowserRegistry>().0.lock().unwrap().remove(&id);
                let _ = webview.close();
                return Err(error);
            }
        }
    }
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
        .map_err(|e| e.to_string())?;
    if underlay_ready() {
        #[cfg(target_os = "macos")]
        native::set_browser_bounds(&id, x, y, width, height);
    }
    Ok(())
}

// Legacy overlay-mode "hiding" parks the view far offscreen: WKWebView comes
// back BLACK from a setHidden(true)/setHidden(false) cycle (the layer's
// contents are dropped and not repainted), so hide()/show() are unusable for
// tab switching. Underlay mode instead keeps inactive compositor surfaces
// warm behind the opaque shell and switches them by sibling ordering.
const PARK_OFFSET: f64 = -20000.0;

#[tauri::command]
pub async fn browser_set_visible(app: AppHandle, id: String, visible: bool) -> Result<(), String> {
    debug!(id = %id, visible, "browser_set_visible");
    let wv = get_webview(&app, &id)?;
    if underlay_ready() {
        #[cfg(target_os = "macos")]
        let visibility_generation = native::begin_browser_visibility(&id, visible);
        if !visible {
            // Keep inactive views at their last onscreen geometry and below
            // the native backdrop. Their compositor surfaces stay warm for
            // an atomic sibling-order swap on reactivation; hit testing is
            // disabled by the native routing state above.
            #[cfg(target_os = "macos")]
            native::order_browser_below_backdrop(&wv, &id, visibility_generation)?;
            return Ok(());
        }
        let activation = (|| -> Result<(), String> {
            wv.show().map_err(|e| e.to_string())?;
            #[cfg(target_os = "macos")]
            {
                // Worktrees remain mounted while inactive, so returning to one
                // reaches this command rather than browser_open. Promote the warm
                // view back above the backdrop through the same readiness
                // boundary used by a browser-tab activation.
                native::wait_for_paint(&wv)?;
                native::order_browser_below_main(&app, &id, &wv, visibility_generation, true)?;
            }
            Ok(())
        })();
        if let Err(error) = activation {
            #[cfg(target_os = "macos")]
            native::fail_browser_visibility(&id, visibility_generation);
            let _ = wv.set_position(LogicalPosition::new(PARK_OFFSET, PARK_OFFSET));
            return Err(error);
        }
        return Ok(());
    }
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
    if underlay_ready() {
        #[cfg(target_os = "macos")]
        native::remove_browser(&id);
    }
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
        .filter(|(_, tab)| tab.worktree_path == worktree_path)
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
        "JSON.stringify({url:location.href,title:document.title,readyState:document.readyState,viewport:{width:innerWidth,height:innerHeight}})",
        Duration::from_secs(3),
    )?;
    serde_json::from_str(&raw).map_err(|e| format!("bad page info payload: {e}"))
}

// Selector resolution for agents (deliberately NOT arbitrary JS — that stays
// frontend-only via browser_eval): scroll the element into view and return
// its center in viewport CSS coordinates, clamped inside the viewport. The
// actual interaction is delivered as real platform events (native module).
const RESOLVE_JS: &str = r#"
(function () {
  var el = document.querySelector(__IMPALA_SELECTOR__);
  if (!el) return JSON.stringify({ ok: false, error: "no element matches selector" });
  el.scrollIntoView({ block: "center", inline: "center" });
  var r = el.getBoundingClientRect();
  var x = Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1);
  var y = Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight - 1);
  return JSON.stringify({
    ok: true, x: x, y: y,
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.value || "").trim().slice(0, 80)
  });
})()
"#;

struct ResolvedTarget {
    x: f64,
    y: f64,
    tag: String,
    text: String,
}

fn resolve_selector(wv: &Webview, selector: &str) -> Result<ResolvedTarget, String> {
    // JSON-encode the selector so it lands as a safe JS string literal.
    let sel_js = serde_json::to_string(selector).map_err(|e| e.to_string())?;
    let js = RESOLVE_JS.replace("__IMPALA_SELECTOR__", &sel_js);
    let raw = native::eval_js(wv, &js, Duration::from_secs(3))?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("bad resolve payload: {e}"))?;
    if v.get("ok").and_then(|b| b.as_bool()) != Some(true) {
        let err = v
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("could not resolve selector");
        return Err(format!("{err}: {selector}"));
    }
    Ok(ResolvedTarget {
        x: v.get("x")
            .and_then(|n| n.as_f64())
            .ok_or("resolve payload missing x")?,
        y: v.get("y")
            .and_then(|n| n.as_f64())
            .ok_or("resolve payload missing y")?,
        tag: v
            .get("tag")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
        text: v
            .get("text")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

/// Glide the virtual cursor to (x, y) and wait out the animation so the user
/// can see where the interaction lands before it happens. Best-effort: pages
/// that reject the eval must not break the interaction itself.
fn animate_cursor(app: &AppHandle, wv: &Webview, x: f64, y: f64) {
    let id = wv
        .label()
        .strip_prefix("browser-")
        .unwrap_or(wv.label())
        .to_string();
    let seed = app
        .state::<BrowserRegistry>()
        .0
        .lock()
        .unwrap()
        .get(&id)
        .and_then(|tab| tab.cursor);
    let (sx, sy) = match seed {
        Some((sx, sy)) => (sx.to_string(), sy.to_string()),
        None => ("null".to_string(), "null".to_string()),
    };
    let js =
        format!("window.__IMPALA_CURSOR__ && __IMPALA_CURSOR__.moveTo({x}, {y}, {sx}, {sy}); \"\"");
    if native::eval_js(wv, &js, Duration::from_secs(1)).is_ok() {
        // Matches the 350ms CSS glide in CURSOR_JS.
        std::thread::sleep(Duration::from_millis(400));
    }
    if let Some(tab) = app
        .state::<BrowserRegistry>()
        .0
        .lock()
        .unwrap()
        .get_mut(&id)
    {
        tab.cursor = Some((x, y));
    }
}

fn cursor_ripple(wv: &Webview) {
    let _ = native::eval_js(
        wv,
        "window.__IMPALA_CURSOR__ && __IMPALA_CURSOR__.ripple(); \"\"",
        Duration::from_secs(1),
    );
}

pub fn click_selector(
    app: &AppHandle,
    wv: &Webview,
    selector: &str,
) -> Result<serde_json::Value, String> {
    let target = resolve_selector(wv, selector)?;
    info!(selector = %selector, x = target.x, y = target.y, "browser click");
    animate_cursor(app, wv, target.x, target.y);
    native::post_mouse_click(wv, target.x, target.y)?;
    cursor_ripple(wv);
    Ok(serde_json::json!({
        "clicked": { "tag": target.tag, "text": target.text }
    }))
}

/// Click at raw viewport CSS coordinates — for canvas/vision targets where
/// no selector exists.
pub fn click_at(
    app: &AppHandle,
    wv: &Webview,
    x: f64,
    y: f64,
) -> Result<serde_json::Value, String> {
    info!(x, y, "browser click_at");
    animate_cursor(app, wv, x, y);
    native::post_mouse_click(wv, x, y)?;
    cursor_ripple(wv);
    Ok(serde_json::json!({ "clicked_at": { "x": x, "y": y } }))
}

/// Scroll with a real wheel event aimed at the viewport center. Positive dy
/// scrolls down, positive dx scrolls right (scrollBy semantics).
pub fn scroll(
    app: &AppHandle,
    wv: &Webview,
    dx: f64,
    dy: f64,
) -> Result<serde_json::Value, String> {
    info!(dx, dy, "browser scroll");
    if let Ok(raw) = native::eval_js(
        wv,
        "JSON.stringify({w:innerWidth,h:innerHeight})",
        Duration::from_secs(1),
    ) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let (Some(w), Some(h)) = (
                v.get("w").and_then(|n| n.as_f64()),
                v.get("h").and_then(|n| n.as_f64()),
            ) {
                animate_cursor(app, wv, w / 2.0, h / 2.0);
            }
        }
    }
    native::post_scroll(wv, dx, dy)?;
    Ok(serde_json::json!({ "scrolled": { "dx": dx, "dy": dy } }))
}

// After the real click focused the element, verify focus actually landed on
// it (or inside it — clicking a wrapper can focus an inner input) and select
// the current content so the upcoming keystrokes replace it.
const FOCUS_SELECT_JS: &str = r#"
(function () {
  var el = document.querySelector(__IMPALA_SELECTOR__);
  if (!el) return JSON.stringify({ ok: false, error: "no element matches selector" });
  var active = document.activeElement;
  var focused = active === el || el.contains(active);
  if (!focused) return JSON.stringify({ ok: true, focused: false });
  var target = active && active !== el ? active : el;
  try {
    if (target.select) target.select();
    else if (target.isContentEditable) {
      var range = document.createRange();
      range.selectNodeContents(target);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } catch (e) {}
  return JSON.stringify({ ok: true, focused: true });
})()
"#;

// Fallback for elements that refuse focus: value is set through the native
// prototype setter so framework value trackers (React/Vue controlled inputs)
// register the change — a direct `.value =` write is invisible to them.
// Replaces the whole value; no key events fire.
const TYPE_JS: &str = r#"
(function () {
  var el = document.querySelector(__IMPALA_SELECTOR__);
  if (!el) return JSON.stringify({ ok: false, error: "no element matches selector" });
  el.scrollIntoView({ block: "center", inline: "center" });
  try { el.focus(); } catch (e) {}
  var tag = (el.tagName || "").toLowerCase();
  var text = __IMPALA_TEXT__;
  if (tag === "input" || tag === "textarea") {
    var proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return JSON.stringify({ ok: true, tag: tag });
  }
  if (el.isContentEditable) {
    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    return JSON.stringify({ ok: true, tag: tag });
  }
  return JSON.stringify({ ok: false, error: "element is not an input, textarea, or contenteditable" });
})()
"#;

pub fn type_into_selector(
    app: &AppHandle,
    wv: &Webview,
    selector: &str,
    text: &str,
) -> Result<serde_json::Value, String> {
    let target = resolve_selector(wv, selector)?;
    info!(selector = %selector, chars = text.len(), "browser type");
    animate_cursor(app, wv, target.x, target.y);
    native::post_mouse_click(wv, target.x, target.y)?;
    cursor_ripple(wv);

    let sel_js = serde_json::to_string(selector).map_err(|e| e.to_string())?;
    let js = FOCUS_SELECT_JS.replace("__IMPALA_SELECTOR__", &sel_js);
    let raw = native::eval_js(wv, &js, Duration::from_secs(3))?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("bad focus payload: {e}"))?;
    if v.get("ok").and_then(|b| b.as_bool()) != Some(true) {
        let err = v
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("type failed");
        return Err(format!("{err}: {selector}"));
    }

    if v.get("focused").and_then(|b| b.as_bool()) == Some(true) {
        // The old value is selected; typing replaces it. Empty text deletes
        // the selection instead (there are no keystrokes to do it for us).
        if text.is_empty() {
            native::post_key_text(wv, "\u{7f}")?;
        } else {
            native::post_key_text(wv, text)?;
        }
        Ok(serde_json::json!({ "typed": { "tag": target.tag } }))
    } else {
        set_value_via_setter(wv, selector, text)
    }
}

fn set_value_via_setter(
    wv: &Webview,
    selector: &str,
    text: &str,
) -> Result<serde_json::Value, String> {
    let sel_js = serde_json::to_string(selector).map_err(|e| e.to_string())?;
    let text_js = serde_json::to_string(text).map_err(|e| e.to_string())?;
    let js = TYPE_JS
        .replace("__IMPALA_SELECTOR__", &sel_js)
        .replace("__IMPALA_TEXT__", &text_js);
    let raw = native::eval_js(wv, &js, Duration::from_secs(3))?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("bad type payload: {e}"))?;
    if v.get("ok").and_then(|b| b.as_bool()) == Some(true) {
        Ok(serde_json::json!({ "typed": { "tag": v.get("tag") } }))
    } else {
        let err = v
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("type failed");
        Err(format!("{err}: {selector}"))
    }
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

/// Frontend-only (deliberately NOT exposed through the hook server — agents
/// get the scoped tools, not arbitrary JS). Powers the element picker.
#[tauri::command]
pub async fn browser_eval(app: AppHandle, id: String, js: String) -> Result<String, String> {
    let wv = get_webview(&app, &id)?;
    native::eval_js(&wv, &js, Duration::from_secs(3))
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
    use std::collections::HashMap;
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
    use objc2::{msg_send, sel};
    use objc2::{MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSAutoresizingMaskOptions, NSBox, NSBoxType};
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSColor, NSEvent,
        NSEventModifierFlags, NSEventType, NSImage, NSScreen, NSView, NSWindow,
        NSWindowOrderingMode,
    };
    use objc2_core_graphics::{CGEvent, CGScrollEventUnit};
    use objc2_foundation::{NSArray, NSDictionary, NSError, NSPoint, NSProcessInfo, NSString};
    use objc2_web_kit::WKWebView;
    use tauri::{AppHandle, Manager, Webview};

    #[derive(Clone, Copy, Debug, Default)]
    struct BrowserRegion {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        requested_visible: bool,
        visible: bool,
        view_address: usize,
        visibility_generation: u64,
        activation_serial: u64,
    }

    impl BrowserRegion {
        fn contains(self, x: f64, y: f64) -> bool {
            self.visible
                && x >= self.x
                && y >= self.y
                && x < self.x + self.width
                && y < self.y + self.height
        }
    }

    #[derive(Default)]
    struct UnderlayRouting {
        overlay_active: bool,
        next_activation_serial: u64,
        regions: HashMap<String, BrowserRegion>,
    }

    impl UnderlayRouting {
        fn browser_view_at(&self, x: f64, y: f64) -> Option<usize> {
            if self.overlay_active {
                return None;
            }
            self.regions
                .values()
                .filter(|region| region.view_address != 0 && region.contains(x, y))
                .max_by_key(|region| region.activation_serial)
                .map(|region| region.view_address)
        }

        fn sibling_priority(
            &self,
            address: usize,
            main: usize,
            backdrop: usize,
            moved: usize,
            moved_priority: u8,
        ) -> u8 {
            if address == main {
                3
            } else if address == moved {
                moved_priority
            } else if address == backdrop {
                1
            } else if self
                .regions
                .values()
                .any(|region| region.visible && region.view_address == address)
            {
                2
            } else {
                0
            }
        }
    }

    static UNDERLAY_ROUTING: std::sync::OnceLock<Mutex<UnderlayRouting>> =
        std::sync::OnceLock::new();
    static UNDERLAY_BACKDROP: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    static UNDERLAY_MAIN: std::sync::OnceLock<usize> = std::sync::OnceLock::new();

    fn sort_underlay_siblings(
        parent: &NSView,
        moved: &NSView,
        moved_priority: u8,
    ) -> Result<(), String> {
        let main = *UNDERLAY_MAIN
            .get()
            .ok_or("browser underlay shell view is not configured")?;
        let backdrop = *UNDERLAY_BACKDROP
            .get()
            .ok_or("browser underlay backdrop is not configured")?;
        let moved = moved as *const NSView as usize;
        let routing = routing()
            .lock()
            .map_err(|_| "browser underlay routing lock is poisoned")?;
        let mut subviews = parent.subviews().to_vec();
        subviews.sort_by_key(|view| {
            let address = &**view as *const NSView as usize;
            routing.sibling_priority(address, main, backdrop, moved, moved_priority)
        });
        let reordered = NSArray::from_retained_slice(&subviews);
        // Apple's `subviews` setter reorders existing views without removing
        // them and marks affected window areas for display.
        parent.setSubviews(&reordered);
        Ok(())
    }

    fn routing() -> &'static Mutex<UnderlayRouting> {
        UNDERLAY_ROUTING.get_or_init(|| Mutex::new(UnderlayRouting::default()))
    }

    pub fn set_browser_bounds(id: &str, x: f64, y: f64, width: f64, height: f64) {
        let Ok(mut state) = routing().lock() else {
            return;
        };
        let region = state.regions.entry(id.to_string()).or_default();
        region.x = x;
        region.y = y;
        region.width = width;
        region.height = height;
    }

    pub fn begin_browser_visibility(id: &str, visible: bool) -> u64 {
        let Ok(mut state) = routing().lock() else {
            return 0;
        };
        let region = state.regions.entry(id.to_string()).or_default();
        region.visibility_generation = region.visibility_generation.wrapping_add(1);
        region.requested_visible = visible;
        region.visible = false;
        region.visibility_generation
    }

    fn visibility_request_is_current(id: &str, generation: u64, visible: bool) -> bool {
        routing()
            .lock()
            .ok()
            .and_then(|state| state.regions.get(id).copied())
            .map(|region| {
                region.visibility_generation == generation && region.requested_visible == visible
            })
            .unwrap_or(false)
    }

    fn commit_browser_visibility(
        id: &str,
        generation: u64,
        visible: bool,
        view_address: Option<usize>,
    ) {
        let Ok(mut state) = routing().lock() else {
            return;
        };
        let Some(region) = state.regions.get_mut(id) else {
            return;
        };
        if region.visibility_generation != generation || region.requested_visible != visible {
            return;
        }
        if visible {
            state.next_activation_serial = state.next_activation_serial.wrapping_add(1);
        }
        let activation_serial = state.next_activation_serial;
        let region = state.regions.get_mut(id).unwrap();
        region.visible = visible;
        if let Some(view_address) = view_address {
            region.view_address = view_address;
        }
        if visible {
            region.activation_serial = activation_serial;
        }
    }

    pub fn fail_browser_visibility(id: &str, generation: u64) {
        let Ok(mut state) = routing().lock() else {
            return;
        };
        let Some(region) = state.regions.get_mut(id) else {
            return;
        };
        if region.visibility_generation != generation {
            return;
        }
        region.requested_visible = false;
        region.visible = false;
    }

    pub fn remove_browser(id: &str) {
        if let Ok(mut state) = routing().lock() {
            state.regions.remove(id);
        }
    }

    pub fn set_overlay_active(active: bool) {
        if let Ok(mut state) = routing().lock() {
            state.overlay_active = active;
        }
    }

    unsafe extern "C-unwind" fn underlay_container_hit_test(
        this: &AnyObject,
        _cmd: Sel,
        point: NSPoint,
    ) -> *mut NSView {
        let view = unsafe { &*(this as *const AnyObject as *const NSView) };
        let route_point = if view.isFlipped() {
            point
        } else {
            NSPoint::new(point.x, view.bounds().size.height - point.y)
        };
        if let Some(view_address) = routing()
            .lock()
            .ok()
            .and_then(|state| state.browser_view_at(route_point.x, route_point.y))
        {
            return view_address as *mut NSView;
        }

        let superclass = this
            .class()
            .superclass()
            .expect("underlay shell webview must have a superclass");
        unsafe { msg_send![super(this, superclass), hitTest: point] }
    }

    fn install_container_hit_test_router(container: &NSView) -> Result<(), String> {
        let class_name = c"ImpalaUnderlayContainerView";
        let current_class = container.class();
        if current_class.name() == class_name {
            return Ok(());
        }
        let underlay_class = if let Some(class) = AnyClass::get(class_name) {
            class
        } else {
            let mut builder = ClassBuilder::new(class_name, current_class)
                .ok_or("could not create underlay shell webview class")?;
            unsafe {
                builder.add_method(
                    sel!(hitTest:),
                    underlay_container_hit_test as unsafe extern "C-unwind" fn(_, _, _) -> _,
                );
            }
            builder.register()
        };
        let object = unsafe { &*(container as *const NSView as *const AnyObject) };
        let previous = unsafe { AnyObject::set_class(object, underlay_class) };
        if previous != current_class {
            return Err(
                "native container class changed while installing hit-test router".to_string(),
            );
        }
        Ok(())
    }

    pub fn configure_main_underlay(
        app: &AppHandle,
        red: u8,
        green: u8,
        blue: u8,
    ) -> Result<(), String> {
        let main = app
            .get_webview("main")
            .ok_or("main webview not found for browser underlay")?;
        let (tx, rx) = mpsc::channel();
        main.with_webview(move |platform_webview| {
            let wk = unsafe { &*(platform_webview.inner() as *const WKWebView) };
            let result = unsafe { wk.superview() }
                .ok_or_else(|| "main webview has no native container".to_string())
                .and_then(|container| {
                    install_container_hit_test_router(&container)?;
                    let _ = UNDERLAY_MAIN.set(wk as *const WKWebView as usize);
                    let color = NSColor::colorWithSRGBRed_green_blue_alpha(
                        f64::from(red) / 255.0,
                        f64::from(green) / 255.0,
                        f64::from(blue) / 255.0,
                        1.0,
                    );
                    if UNDERLAY_BACKDROP.get().is_none() {
                        let mtm = MainThreadMarker::new().ok_or("not on the main thread")?;
                        let backdrop = NSBox::initWithFrame(NSBox::alloc(mtm), container.bounds());
                        backdrop.setBoxType(NSBoxType::Custom);
                        backdrop.setTransparent(false);
                        backdrop.setFillColor(&color);
                        backdrop.setBorderColor(&color);
                        backdrop.setAutoresizingMask(
                            NSAutoresizingMaskOptions::ViewWidthSizable
                                | NSAutoresizingMaskOptions::ViewHeightSizable,
                        );
                        container.addSubview_positioned_relativeTo(
                            &backdrop,
                            NSWindowOrderingMode::Below,
                            Some(wk),
                        );
                        let _ = UNDERLAY_BACKDROP.set(&*backdrop as *const NSBox as usize);
                    } else if let Some(backdrop_address) = UNDERLAY_BACKDROP.get() {
                        let backdrop = unsafe { &*(*backdrop_address as *const NSBox) };
                        backdrop.setFillColor(&color);
                        backdrop.setBorderColor(&color);
                    }
                    Ok(())
                });
            if result.is_ok() {
                unsafe {
                    wk.setUnderPageBackgroundColor(Some(&NSColor::clearColor()));
                }
            }
            let _ = tx.send(result);
        })
        .map_err(|error| error.to_string())?;
        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|_| "timed out configuring browser underlay".to_string())?
    }

    pub fn set_underlay_backdrop(
        app: &AppHandle,
        red: u8,
        green: u8,
        blue: u8,
    ) -> Result<(), String> {
        let backdrop_address = *UNDERLAY_BACKDROP
            .get()
            .ok_or("browser underlay backdrop is not configured")?;
        let main = app
            .get_webview("main")
            .ok_or("main webview not found for browser underlay")?;
        let (tx, rx) = mpsc::channel();
        main.with_webview(move |_| {
            let backdrop = unsafe { &*(backdrop_address as *const NSBox) };
            let color = NSColor::colorWithSRGBRed_green_blue_alpha(
                f64::from(red) / 255.0,
                f64::from(green) / 255.0,
                f64::from(blue) / 255.0,
                1.0,
            );
            backdrop.setFillColor(&color);
            backdrop.setBorderColor(&color);
            backdrop.setNeedsDisplay(true);
            let _ = tx.send(());
        })
        .map_err(|error| error.to_string())?;
        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|_| "timed out updating browser underlay backdrop".to_string())
    }

    pub fn order_browser_below_main(
        app: &AppHandle,
        id: &str,
        browser: &Webview,
        visibility_generation: u64,
        commit_visibility: bool,
    ) -> Result<(), String> {
        let main = app
            .get_webview("main")
            .ok_or("main webview not found for browser underlay")?;
        let browser = browser.clone();
        let id = id.to_string();
        let (tx, rx) = mpsc::channel();
        let tx = Arc::new(Mutex::new(Some(tx)));
        main.with_webview(move |main_platform_webview| {
            let main_address = main_platform_webview.inner() as usize;
            let inner_tx = tx.clone();
            if let Err(error) = browser.with_webview(move |browser_platform_webview| {
                let result = (|| {
                    if !visibility_request_is_current(&id, visibility_generation, true) {
                        return Ok(());
                    }
                    let main_view = unsafe { &*(main_address as *const NSView) };
                    let browser_view =
                        unsafe { &*(browser_platform_webview.inner() as *const NSView) };
                    let parent = unsafe { browser_view.superview() }
                        .ok_or("browser underlay webview has no superview")?;
                    let same_parent = unsafe { main_view.superview() }
                        .map(|main_parent| std::ptr::eq(&*parent, &*main_parent))
                        .unwrap_or(false);
                    if !same_parent {
                        return Err("browser and shell webviews are not sibling views".to_string());
                    }
                    sort_underlay_siblings(&parent, browser_view, 2)?;
                    if commit_visibility {
                        commit_browser_visibility(
                            &id,
                            visibility_generation,
                            true,
                            Some(browser_view as *const NSView as usize),
                        );
                    }
                    Ok(())
                })();
                if let Some(tx) = inner_tx.lock().unwrap().take() {
                    let _ = tx.send(result);
                }
            }) {
                if let Some(tx) = tx.lock().unwrap().take() {
                    let _ = tx.send(Err(error.to_string()));
                }
            }
        })
        .map_err(|error| error.to_string())?;
        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|_| "timed out ordering browser underlay".to_string())?
    }

    pub fn order_browser_below_backdrop(
        browser: &Webview,
        id: &str,
        visibility_generation: u64,
    ) -> Result<(), String> {
        let backdrop_address = *UNDERLAY_BACKDROP
            .get()
            .ok_or("browser underlay backdrop is not configured")?;
        let id = id.to_string();
        let (tx, rx) = mpsc::channel();
        browser
            .with_webview(move |browser_platform_webview| {
                let result = (|| {
                    if !visibility_request_is_current(&id, visibility_generation, false) {
                        return Ok(());
                    }
                    let browser_view =
                        unsafe { &*(browser_platform_webview.inner() as *const NSView) };
                    let backdrop = unsafe { &*(backdrop_address as *const NSView) };
                    let parent = unsafe { browser_view.superview() }
                        .ok_or("browser underlay webview has no superview")?;
                    let same_parent = unsafe { backdrop.superview() }
                        .map(|backdrop_parent| std::ptr::eq(&*parent, &*backdrop_parent))
                        .unwrap_or(false);
                    if !same_parent {
                        return Err(
                            "browser and underlay backdrop are not sibling views".to_string()
                        );
                    }
                    sort_underlay_siblings(&parent, browser_view, 0)?;
                    commit_browser_visibility(&id, visibility_generation, false, None);
                    Ok(())
                })();
                let _ = tx.send(result);
            })
            .map_err(|error| error.to_string())?;
        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|_| "timed out parking browser below underlay backdrop".to_string())?
    }

    /// Do not tell the transparent shell to expose this view until WebKit can
    /// asynchronously produce an image for its current onscreen geometry.
    /// AppKit ordering and `show()` complete before WKWebView's compositor has
    /// necessarily submitted its first frame; snapshot completion is the
    /// native readiness boundary for the underlay handoff.
    pub fn wait_for_paint(webview: &Webview) -> Result<(), String> {
        let (tx, rx) = mpsc::channel::<Result<(), String>>();
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
                    } else if image.is_null() {
                        let _ = tx.send(Err("paint snapshot returned no image".to_string()));
                    } else {
                        let _ = tx.send(Ok(()));
                    }
                });
                unsafe {
                    wk.takeSnapshotWithConfiguration_completionHandler(None, &block);
                }
            })
            .map_err(|error| error.to_string())?;
        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|_| "timed out waiting for browser paint".to_string())?
    }

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
                    wk.evaluateJavaScript_completionHandler(&NSString::from_str(&js), Some(&block));
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

    /// Convert webview-local CSS coordinates (top-left origin, what
    /// getBoundingClientRect returns; WKWebView is 1:1 CSS px ↔ logical
    /// points) to window coordinates, rejecting points outside the viewport.
    fn window_point(
        wk: &WKWebView,
        x: f64,
        y: f64,
    ) -> Result<(NSPoint, Retained<NSWindow>), String> {
        let window = wk
            .window()
            .ok_or("browser webview is not attached to a window")?;
        let bounds = wk.bounds();
        if x < 0.0 || y < 0.0 || x >= bounds.size.width || y >= bounds.size.height {
            return Err(format!(
                "point ({x:.0}, {y:.0}) is outside the browser viewport ({:.0}x{:.0})",
                bounds.size.width, bounds.size.height
            ));
        }
        // AppKit view coords are bottom-left origin unless the view is
        // flipped (WKWebView is); convertPoint handles frame offset + any
        // further flips up the hierarchy.
        let local = if wk.isFlipped() {
            NSPoint::new(x, y)
        } else {
            NSPoint::new(x, bounds.size.height - y)
        };
        Ok((wk.convertPoint_toView(local, None), window))
    }

    fn mouse_event(
        ty: NSEventType,
        location: NSPoint,
        window_number: isize,
        time: f64,
        clicks: isize,
        pressure: f32,
    ) -> Result<Retained<NSEvent>, String> {
        NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            ty,
            location,
            NSEventModifierFlags::empty(),
            time,
            window_number,
            None,
            0,
            clicks,
            pressure,
        )
        .ok_or_else(|| "could not create mouse event".to_string())
    }

    /// Deliver a real mouse click (move → down → up) to the webview. Events
    /// go directly to the view's NSResponder methods rather than through
    /// NSWindow::sendEvent: coordinates round-trip exactly (window coords
    /// are computed FROM the view's current frame), no hit-testing can
    /// misroute the click, and it keeps working while the pane is parked
    /// offscreen (background tab). WebKit treats them as user input, so the
    /// page sees isTrusted: true and user-gesture gates are satisfied.
    ///
    /// Same threading contract as eval_js: never call ON the main thread.
    pub fn post_mouse_click(webview: &Webview, x: f64, y: f64) -> Result<(), String> {
        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        webview
            .with_webview(move |pw| {
                let result = (|| {
                    let wk = unsafe { &*(pw.inner() as *const WKWebView) };
                    let (location, window) = window_point(wk, x, y)?;
                    let wnum = window.windowNumber();
                    let time = NSProcessInfo::processInfo().systemUptime();
                    // The move primes hover state so :hover styles and
                    // mouseover handlers see the pointer before the click.
                    let moved = mouse_event(NSEventType::MouseMoved, location, wnum, time, 0, 0.0)?;
                    wk.mouseMoved(&moved);
                    let down =
                        mouse_event(NSEventType::LeftMouseDown, location, wnum, time, 1, 1.0)?;
                    wk.mouseDown(&down);
                    let up = mouse_event(
                        NSEventType::LeftMouseUp,
                        location,
                        wnum,
                        time + 0.05,
                        1,
                        0.0,
                    )?;
                    wk.mouseUp(&up);
                    Ok(())
                })();
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|_| "timed out posting mouse events".to_string())?
    }

    /// Real wheel event at the viewport center. NSEvent has no public
    /// scroll constructor, so build a CGEvent and wrap it (the
    /// WebKitTestRunner pattern). An NSEvent wrapped from a window-less
    /// CGEvent reports its location flipped relative to the first screen
    /// (rdar://17180591), so the CGEvent location is pre-flipped to make
    /// locationInWindow come out at the target point. Positive dy scrolls
    /// down, positive dx scrolls right (scrollBy semantics); CGEvent wheel
    /// deltas point the other way, hence the negation.
    pub fn post_scroll(webview: &Webview, dx: f64, dy: f64) -> Result<(), String> {
        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        webview
            .with_webview(move |pw| {
                let result = (|| {
                    let mtm = MainThreadMarker::new().ok_or("not on the main thread")?;
                    let wk = unsafe { &*(pw.inner() as *const WKWebView) };
                    let bounds = wk.bounds();
                    let (location, _window) =
                        window_point(wk, bounds.size.width / 2.0, bounds.size.height / 2.0)?;
                    let cg = CGEvent::new_scroll_wheel_event2(
                        None,
                        CGScrollEventUnit::Pixel,
                        2,
                        (-dy) as i32,
                        (-dx) as i32,
                        0,
                    )
                    .ok_or("could not create scroll event")?;
                    let screen_height = NSScreen::screens(mtm)
                        .firstObject()
                        .map(|s| s.frame().size.height)
                        .unwrap_or(0.0);
                    CGEvent::set_location(
                        Some(&cg),
                        NSPoint::new(location.x, screen_height - location.y),
                    );
                    let event =
                        NSEvent::eventWithCGEvent(&cg).ok_or("could not wrap scroll event")?;
                    wk.scrollWheel(&event);
                    Ok(())
                })();
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|_| "timed out posting the scroll event".to_string())?
    }

    /// Trusted typing: per-character keyDown/keyUp pairs. WebKit inserts
    /// text from `characters`, so exact key codes are unnecessary except
    /// for the specials it maps by code (Return, Tab, Backspace). Keyboard
    /// focus moves to the webview for the duration — required for key
    /// routing — and is restored afterwards so the user's terminal/editor
    /// focus survives agent typing.
    pub fn post_key_text(webview: &Webview, text: &str) -> Result<(), String> {
        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        let text = text.to_string();
        webview
            .with_webview(move |pw| {
                let result = (|| {
                    let wk = unsafe { &*(pw.inner() as *const WKWebView) };
                    let window = wk
                        .window()
                        .ok_or("browser webview is not attached to a window")?;
                    let wnum = window.windowNumber();
                    let previous = window.firstResponder();
                    window.makeFirstResponder(Some(wk));
                    let location = NSPoint::new(0.0, 0.0);
                    let outcome = (|| {
                        for ch in text.chars() {
                            let (chars, code): (String, u16) = match ch {
                                '\r' | '\n' => ("\r".to_string(), 36),
                                '\t' => ("\t".to_string(), 48),
                                '\u{8}' | '\u{7f}' => ("\u{7f}".to_string(), 51),
                                c => (c.to_string(), 0),
                            };
                            let chars = NSString::from_str(&chars);
                            let time = NSProcessInfo::processInfo().systemUptime();
                            for ty in [NSEventType::KeyDown, NSEventType::KeyUp] {
                                let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
                                    ty,
                                    location,
                                    NSEventModifierFlags::empty(),
                                    time,
                                    wnum,
                                    None,
                                    &chars,
                                    &chars,
                                    false,
                                    code,
                                )
                                .ok_or_else(|| "could not create key event".to_string())?;
                                if ty == NSEventType::KeyDown {
                                    wk.keyDown(&event);
                                } else {
                                    wk.keyUp(&event);
                                }
                            }
                        }
                        Ok(())
                    })();
                    // Hand keyboard focus back even when typing failed.
                    if let Some(previous) = previous {
                        window.makeFirstResponder(Some(&previous));
                    }
                    outcome
                })();
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|_| "timed out posting key events".to_string())?
    }

    fn encode_png(image: &NSImage) -> Result<Vec<u8>, String> {
        let tiff = image.TIFFRepresentation().ok_or("no TIFF representation")?;
        let rep = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("could not read bitmap data")?;
        let props: Retained<NSDictionary<NSBitmapImageRepPropertyKey, AnyObject>> =
            NSDictionary::new();
        let png =
            unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props) }
                .ok_or("PNG encoding failed")?;
        Ok(png.to_vec())
    }

    #[cfg(test)]
    mod underlay_tests {
        use super::{BrowserRegion, UnderlayRouting};

        fn routing_with_visible_region() -> UnderlayRouting {
            let mut routing = UnderlayRouting::default();
            routing.regions.insert(
                "browser-one".to_string(),
                BrowserRegion {
                    x: 100.0,
                    y: 80.0,
                    width: 400.0,
                    height: 300.0,
                    requested_visible: true,
                    visible: true,
                    view_address: 42,
                    visibility_generation: 1,
                    activation_serial: 1,
                },
            );
            routing.next_activation_serial = 1;
            routing
        }

        #[test]
        fn routes_points_inside_visible_browser_to_the_underlay() {
            let routing = routing_with_visible_region();

            assert_eq!(routing.browser_view_at(100.0, 80.0), Some(42));
            assert_eq!(routing.browser_view_at(499.0, 379.0), Some(42));
            assert_eq!(routing.browser_view_at(500.0, 380.0), None);
        }

        #[test]
        fn shell_overlay_owns_the_complete_window() {
            let mut routing = routing_with_visible_region();
            routing.overlay_active = true;

            assert_eq!(routing.browser_view_at(200.0, 200.0), None);
        }

        #[test]
        fn hidden_browser_does_not_receive_hit_tests() {
            let mut routing = routing_with_visible_region();
            routing.regions.get_mut("browser-one").unwrap().visible = false;

            assert_eq!(routing.browser_view_at(200.0, 200.0), None);
        }

        #[test]
        fn overlapping_regions_route_only_to_the_committed_active_browser() {
            let mut routing = routing_with_visible_region();
            routing.regions.insert(
                "browser-two".to_string(),
                BrowserRegion {
                    x: 100.0,
                    y: 80.0,
                    width: 400.0,
                    height: 300.0,
                    requested_visible: true,
                    visible: true,
                    view_address: 84,
                    visibility_generation: 1,
                    activation_serial: 2,
                },
            );
            routing.next_activation_serial = 2;

            assert_eq!(routing.browser_view_at(200.0, 200.0), Some(84));
        }

        #[test]
        fn promoting_a_split_browser_keeps_other_visible_splits_above_backdrop() {
            let mut routing = routing_with_visible_region();
            routing.regions.insert(
                "browser-two".to_string(),
                BrowserRegion {
                    x: 500.0,
                    y: 80.0,
                    width: 400.0,
                    height: 300.0,
                    requested_visible: true,
                    visible: true,
                    view_address: 84,
                    visibility_generation: 1,
                    activation_serial: 2,
                },
            );

            assert_eq!(routing.sibling_priority(42, 1000, 2000, 84, 2), 2,);
        }
    }
}

#[cfg(test)]
mod underlay_feature_tests {
    use super::underlay_enabled_from_override;

    #[test]
    fn macos_underlay_defaults_on_and_has_an_explicit_fallback() {
        assert_eq!(
            underlay_enabled_from_override(None),
            cfg!(target_os = "macos")
        );
        assert!(!underlay_enabled_from_override(Some("0")));
        assert!(!underlay_enabled_from_override(Some("false")));
        assert!(!underlay_enabled_from_override(Some("OFF")));
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

    pub fn post_mouse_click(_wv: &Webview, _x: f64, _y: f64) -> Result<(), String> {
        Err("browser agent hooks are only supported on macOS".to_string())
    }

    pub fn post_scroll(_wv: &Webview, _dx: f64, _dy: f64) -> Result<(), String> {
        Err("browser agent hooks are only supported on macOS".to_string())
    }

    pub fn post_key_text(_wv: &Webview, _text: &str) -> Result<(), String> {
        Err("browser agent hooks are only supported on macOS".to_string())
    }
}
