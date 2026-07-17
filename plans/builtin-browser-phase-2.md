# Built-in Browser: Phase 2 — Agent Hooks via impala-mcp

## Goal

Give agents a verify loop against the browser pane: `browser_screenshot`, `browser_console`, `browser_page_info`, and `browser_navigate` as impala-mcp tools, scoped per worktree. An agent working in a worktree can navigate the pane to its dev server, read console errors, and *see* the rendered page — the Codex-style loop, minus annotation mode (Phase 3).

Phase 1 context: `plans/builtin-browser-phase-1.md` (shipped; native `add_child` webview, offscreen parking). **Out of scope:** element annotation mode (Phase 3), network capture, input synthesis (click/type), auto-opening the browser pane UI when an agent navigates a worktree whose pane isn't mounted.

## Architecture

- **Transport — reuse the hook server.** The webview lives in the app process; impala-mcp is a separate stdio binary that today only reads SQLite. The app already runs a localhost tiny_http server whose port is written to `~/.impala/hook-port` on boot (`hook_server.rs:57-59`), and PTY hooks curl it. New `/browser/*` routes on that server become the app↔MCP bridge; impala-mcp discovers the port from the same file. Localhost-only, unauthenticated — the existing hook-server trust posture (any local process can call it; same today for `/hook`).
- **Worktree → webview resolution.** Rust doesn't know which browser tab belongs to which worktree (tabs are frontend Zustand state). `browser_open` gains a `worktreePath` arg and records `tabId → worktreePath` in a managed `BrowserRegistry` (Mutex<HashMap>); `browser_close` removes it. Endpoints resolve worktree → tab id(s) → webview label, using the first (usually only) browser tab of the worktree.
- **Native bridge, not CDP.** WKWebView has no CDP. Screenshot = `WKWebView.takeSnapshot` and JS-with-result = `evaluateJavaScript:completionHandler:` via tauri's `with_webview` escape hatch (runs its closure on the main thread) + objc2. Results come back over a channel with a hard timeout (a dead webview must produce an error, not a hang — cf. the Phase 1 silent-failure lesson).
- **Console capture = init-script ring buffer.** `WebviewBuilder::initialization_script` (runs on every page load, main frame) shims `console.*`, `window.onerror`, and `unhandledrejection` into a capped `window.__IMPALA_LOGS__` array. The console tool drains it via the eval bridge. Remote pages get no Tauri IPC (unchanged) — polling via eval is the only channel, and that's fine.
- **Version discipline:** objc2 crates must match what wry already pins in `backend/tauri/Cargo.lock` — `objc2-web-kit 0.3.2`, `block2 0.6.2`, `objc2 0.6`, `objc2-app-kit 0.3`/`objc2-foundation 0.3` (already direct deps) — so we add zero duplicate native stacks.

**API caveat (same rule as Phase 1):** exact objc2 signatures (`takeSnapshotWithConfiguration_completionHandler`, `NSBitmapImageRep` PNG encoding, `PlatformWebview::inner()`'s return type on macOS) are sketched from research — verify against the vendored crates at implementation time; the command contracts below are the fixed part.

## Tech Stack

tauri `with_webview` + objc2-web-kit (WKWebView, WKSnapshotConfiguration), block2 completion blocks, objc2-app-kit (NSImage → NSBitmapImageRep → PNG), tiny_http (existing hook server), reqwest blocking (impala-mcp, mirroring `backend/tauri`'s usage), MCP image content blocks.

## Tasks

| # | Name | Dependencies | Files |
|---|------|--------------|-------|
| 1 | Native bridge: registry, eval-with-result, screenshot, console shim | none | `backend/tauri/Cargo.toml`, `backend/tauri/src/browser.rs`, `backend/tauri/src/lib.rs`, `apps/desktop/src/components/BrowserPane.tsx` |
| 2 | Hook-server `/browser/*` endpoints + navigate/open event | Task 1 | `backend/tauri/src/hook_server.rs`, `backend/tauri/src/browser.rs`, `apps/desktop/src/App.tsx` |
| 3 | impala-mcp browser tools | Task 2 | `backend/mcp/Cargo.toml`, `backend/mcp/src/main.rs` |

---

## Task 1 — Native bridge: registry, eval-with-result, screenshot, console shim

**Goal:** browser.rs can resolve a worktree to its webview, run JS with a returned value, and capture a PNG — exposed as tauri commands (`browser_screenshot`, `browser_console_logs`, `browser_page_info`) so the whole layer is verifiable from devtools before any HTTP/MCP exists.

### Steps

**1. Dependencies** (`backend/tauri/Cargo.toml`, macOS target section — versions matching the lock):

```toml
block2 = "0.6"
objc2-web-kit = { version = "0.3", default-features = false, features = ["WKWebView", "WKSnapshotConfiguration"] }
```

Extend the existing `objc2-app-kit` features with `"NSBitmapImageRep"` (and whatever the PNG `representationUsingType` API needs — likely `"NSGraphics"`; follow compile errors). `objc2-foundation` already has `NSData`.

**2. Worktree registry** in browser.rs:

```rust
#[derive(Default)]
pub struct BrowserRegistry(pub std::sync::Mutex<std::collections::HashMap<String, String>>); // tabId -> worktreePath
```

- `app.manage(BrowserRegistry::default())` in the setup hook (`lib.rs`, next to the other `.manage(...)` calls).
- `browser_open` gains `worktree_path: String`; insert on create (not on reshow). `browser_close` removes. Helper `pub fn webview_for_worktree(app, worktree_path) -> Result<(String /*tab id*/, Webview), String>` — first registered tab for the worktree, error `"no browser tab open for this worktree"` otherwise.
- **Frontend:** `BrowserPane.tsx`'s `browser_open` invoke adds `worktreePath` (the prop is already there).

**3. Eval-with-result helper** — the core primitive:

```rust
/// Run JS in the webview's main frame, returning the JSON-stringified result.
/// `with_webview` executes on the main thread; the completion block sends the
/// result back over a channel. Times out rather than hanging on a dead page.
pub fn eval_js(webview: &Webview, js: &str, timeout: Duration) -> Result<String, String>
```

Implementation sketch (verify signatures): `webview.with_webview(move |pw| { ... })` → `pw.inner()` cast to `&WKWebView` → `evaluateJavaScript_completionHandler(ns_string, Some(&RcBlock::new(...)))`; the block extracts the id (expect NSString — always wrap the JS as `JSON.stringify(...)` so the result is a string), sends through a `std::sync::mpsc` Sender held in a `Mutex<Option<...>>` (blocks are `Fn`). Caller does `rx.recv_timeout(timeout)`. Command wrappers run on the async runtime, so blocking recv is safe (never call this ON the main thread — commands don't).

**4. Screenshot helper:**

```rust
pub fn take_screenshot(webview: &Webview, timeout: Duration) -> Result<Vec<u8>, String> // PNG bytes
```

Same channel pattern: `WKSnapshotConfiguration::new()` → `takeSnapshotWithConfiguration_completionHandler` → block receives `NSImage` → `TIFFRepresentation` → `NSBitmapImageRep::imageRepWithData` → `representationUsingType(PNG)` → `NSData` → `Vec<u8>`. Do the conversion inside the block (main thread) and send bytes. Cap with the same `recv_timeout`.

**5. Console shim** — add to the `WebviewBuilder` chain in `browser_open`:

```rust
.initialization_script(CONSOLE_SHIM)
```

`CONSOLE_SHIM` (a `const &str`): wraps `console.log/info/warn/error/debug`, `window.onerror`, and `unhandledrejection`; pushes `{level, msg, ts}` (args stringified, non-serializable values via `String(v)`) into `window.__IMPALA_LOGS__`, capped at 500 entries (shift on overflow). Must be idempotent (guard on a marker) since init scripts run per-navigation.

**6. Tauri commands** (register in `lib.rs` generate_handler):

- `browser_screenshot(app, id) -> Result<String, String>` — base64 PNG (`base64` crate already a dep).
- `browser_console_logs(app, id, clear: bool) -> Result<serde_json::Value, String>` — eval `JSON.stringify({logs: window.__IMPALA_LOGS__ || [], ...})`, optionally resetting the array; parse before returning.
- `browser_page_info(app, id) -> Result<serde_json::Value, String>` — eval `JSON.stringify({url: location.href, title: document.title, readyState: document.readyState})`.

Timeout: 3s for eval, 5s for screenshot. Tracing on all (`impala_lib=debug` already flows to the log file).

**7. Verify** — `cargo check`, then `bun run dev`, open a browser tab on any page, and from the main webview's devtools:

```js
const { invoke } = window.__TAURI__.core;
const png = await invoke("browser_screenshot", { id: "<tabId from store>" });  // → long base64 string; check it decodes as a PNG
await invoke("browser_page_info", { id: "<tabId>" });                          // → {url, title, readyState}
// after the page logs something:
await invoke("browser_console_logs", { id: "<tabId>", clear: false });         // → {logs: [...]}
```

(Get the tab id via `useUIStore` from the devtools console, or log it from BrowserPane temporarily.)

**8. Commit** (`feat(browser): native eval/screenshot bridge + console capture`).

**Done When:**

- [ ] `cargo check` + `bun run typecheck` pass
- [ ] Screenshot invoke returns a decodable PNG of the visible page
- [ ] Console tool captures `console.error` from the loaded page and survives navigation (init script re-runs)
- [ ] A dead/never-loaded page returns a timeout error, not a hang

---

## Task 2 — Hook-server `/browser/*` endpoints

**Goal:** the four operations reachable over `http://127.0.0.1:{hook-port}` with worktree scoping, so any local process (impala-mcp next task) can drive the pane.

### Steps

**1. Path routing** in `hook_server.rs`'s request loop (`start`, ~line 230-316): today the handler assumes `/hook` and matches on `event_type`. Split on the path first (`request.url()` before `?`); keep `/hook` behavior byte-identical; add:

- `GET /browser/page_info?worktree_path=…` → `{ok: true, ...page_info}` or `{ok: false, error}`
- `GET /browser/console?worktree_path=…&clear=true|false` → `{ok: true, logs: [...]}`
- `GET /browser/screenshot?worktree_path=…` → `{ok: true, png_base64: "..."}`
- `GET /browser/navigate?worktree_path=…&url=…` → `{ok: true}` (see step 2)

All JSON responses with proper content-type; reuse the existing query-param parsing (`hook_server.rs:251-262`). Resolve via `browser::webview_for_worktree`. Requests are handled on the hook-server thread — a 5s screenshot blocks `/hook` calls for that long; spawn a thread per `/browser/*` request (hooks stay latency-critical, screenshots aren't).

**2. Navigate + auto-open.** If the worktree has a browser tab: navigate its webview (existing `Webview::navigate`) — the `on_navigation` handler already syncs the frontend URL bar/persisted URL. If it has none: emit `browser-request-open` to `"main"` with `{worktreePath, url}`, and add a global listener in `App.tsx` (next to the other app-level `listen` calls) that calls `createBrowserTab(worktreePath, url)`. Response then is `{ok: true, created: true}`. Limitation to document in the tool description: the webview materializes when the pane first mounts, so a screenshot immediately after a `created: true` navigate can fail with "no browser tab open" until the user's terminals pane shows the tab — agents should surface that, not retry blindly.

**3. Verify** with the app running and a browser tab open on a page:

```bash
PORT=$(cat ~/.impala/hook-port)
curl -s "http://127.0.0.1:$PORT/browser/page_info?worktree_path=$(pwd)" | jq
curl -s "http://127.0.0.1:$PORT/browser/screenshot?worktree_path=$(pwd)" | jq -r .png_base64 | base64 -d > /tmp/shot.png && open /tmp/shot.png
curl -s "http://127.0.0.1:$PORT/browser/navigate?worktree_path=$(pwd)&url=http%3A%2F%2Flocalhost%3A3000" | jq
curl -s "http://127.0.0.1:$PORT/browser/console?worktree_path=$(pwd)" | jq
# and from a worktree with no browser tab: expect {ok:false,...} / {ok:true, created:true}
```

Also confirm `/hook` still works (run an agent turn; agent status updates).

**4. Commit** (`feat(browser): /browser endpoints on the hook server`).

**Done When:**

- [ ] All four endpoints work via curl, including the no-tab error path and navigate's auto-create
- [ ] `/hook` behavior unchanged; a slow screenshot doesn't delay hook events

---

## Task 3 — impala-mcp browser tools

**Goal:** `browser_screenshot`, `browser_console`, `browser_page_info`, `browser_navigate` in the MCP server, worktree defaulting to cwd (the existing `param_or_cwd` convention — Claude Code runs inside the worktree).

### Steps

**1. Dependency:** `reqwest = { version = "0.13", features = ["json", "blocking"] }` in `backend/mcp/Cargo.toml` (mirrors `backend/tauri`; sentry already pulls reqwest, so tree impact is minimal).

**2. Port discovery + client helper** in `main.rs`:

```rust
fn hook_port() -> Result<u16, String>  // reads ~/.impala/hook-port; error: "Impala isn't running (no hook port)"
fn browser_get(path: &str, params: &[(&str, &str)]) -> Result<serde_json::Value, String>  // blocking GET, 10s timeout, parses {ok, ...}; maps ok:false to Err(error)
```

**3. Tool definitions** (extend `tool_definitions()`, `main.rs:192-240` region) — schemas all take optional `worktree_path` (defaults to cwd):

- `browser_screenshot` — "Capture a PNG screenshot of this worktree's browser pane in Impala." Returns an MCP **image content block**: `{"type": "image", "data": <base64>, "mimeType": "image/png"}` — check how existing tools build the `content` array (`handle_request` / tools-call arm, ~line 326) and add the image variant.
- `browser_console` — optional `clear` bool; returns the log entries as text (JSON).
- `browser_page_info` — returns `{url, title, readyState}` as text.
- `browser_navigate` — required `url`; description documents the auto-create limitation from Task 2.

**4. Dispatch** — extend the `tools/call` match with the four names → `browser_get(...)` → wrap results.

**5. Verify** — first headless against a running app:

```bash
cargo build --manifest-path backend/mcp/Cargo.toml
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_page_info","arguments":{"worktree_path":"<worktree>"}}}' \
 | ./backend/mcp/target/debug/impala-mcp
```

Then live: rebuild the sidecar (`bash scripts/build-mcp-sidecar.sh debug`), restart the app, and from a Claude Code session inside a worktree with the browser pane open: ask it to check the page — it should call `browser_page_info`/`browser_screenshot` and describe the actual rendered page. That end-to-end moment is the Phase 2 exit criterion.

**6. Commit** (`feat(mcp): browser tools — screenshot, console, page info, navigate`).

**Done When:**

- [ ] Manual JSON-RPC round-trip works for all four tools (app running)
- [ ] Clean errors when the app isn't running / no browser tab is open
- [ ] A live Claude Code session sees the tools and a screenshot renders in its context
- [ ] `plans/builtin-browser-phase-2.md` checked off / execution log updated if used
