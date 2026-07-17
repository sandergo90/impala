# Built-in Browser: Phase 1 — Native Browser Tab

## Goal

A new inner-tab kind `"browser"` in the terminals pane: a native child webview (Tauri `add_child`, WKWebView on macOS) docked into the tab body, with a URL toolbar (back/forward/reload/open-in-system), per-worktree URL persistence, and automatic dev-server URL detection from the Run tab's PTY output ("Open in browser" affordance).

Context and rationale: `docs/plans/builtin-browser-research.md` (gitignored). Codex-app capability is the long-term bar; Phase 1 is rendering + chrome + detection only. **Out of scope:** agent/MCP hooks (Phase 2), element annotation mode (Phase 3), page-title capture, history/autocomplete, canGoBack/canGoForward state.

## Architecture

- **Rendering:** one native child webview per browser tab, created via `Window::add_child` (requires the `unstable` cargo feature on the `tauri` dependency). The React component renders only a **placeholder div**; a ResizeObserver mirrors the placeholder's `getBoundingClientRect()` to Rust (`set_position`/`set_size`, logical = CSS px). Never `auto_resize` (buggy upstream: tauri#10131, #11170).
- **Z-order constraint (accepted):** the child webview composites above the entire DOM. Anything that must draw over the pane region (command palette, file finder, panel-drag ghosting) instead **hides** the webview while open. Tooltips/dropdowns near the pane will clip — known Phase 1 limitation.
- **Lifecycle:** webview outlives the React component. Tab switch / worktree switch / diff mode ⇒ `hide`. Only `closeUserTab` destroys it. On app restart nothing survives; `BrowserPane` recreates from the persisted `tab.url`.
- **Security posture:** child webviews load remote/localhost URLs and get **no** Tauri IPC (capabilities stay scoped to the `main` webview — do not add the `browser-*` labels to `backend/tauri/capabilities/*`).
- **Dev-server detection:** a per-worktree hook subscribes to the Run session's existing `pty-output-*` event, strips ANSI, regex-scans for localhost URLs, and parks the result on `WorktreeNavState.detectedDevServerUrl` (in-memory only).

**Rust API caveat:** `add_child`, `Manager::get_window`, `Manager::webviews`, and `Webview::{set_position,set_size,show,hide,navigate,reload,eval,close}` are from the unstable multiwebview surface (tauri 2.11.x). Signatures below are from research, not a compile — verify against docs.rs for the locked tauri version at implementation time and adapt mechanically.

## Tech Stack

Tauri 2.11 (`unstable` feature), wry 0.55/WKWebView, React 19, Zustand (persisted `useUIStore`), existing PTY event plumbing (`daemon_client.rs` → `pty-output-*`).

## Tasks

| # | Name | Dependencies | Files |
|---|------|--------------|-------|
| 1 | Rust: browser webview module + commands | none | `backend/tauri/Cargo.toml`, `backend/tauri/src/browser.rs` (new), `backend/tauri/src/lib.rs` |
| 2 | Frontend: `"browser"` tab kind + `BrowserPane` | Task 1 | `apps/desktop/src/types.ts`, `apps/desktop/src/lib/tab-actions.ts`, `apps/desktop/src/components/BrowserPane.tsx` (new), `apps/desktop/src/components/TabbedTerminals.tsx` |
| 3 | Occlusion: palette/finder/drag/diff-mode hiding | Task 2 | `apps/desktop/src/store.ts`, `apps/desktop/src/App.tsx`, `apps/desktop/src/components/ResizablePanel.tsx`, `apps/desktop/src/components/ui/resizable.tsx`, `apps/desktop/src/components/BrowserPane.tsx` |
| 4 | Dev-server URL detection + open affordance | Task 2 | `apps/desktop/src/hooks/useDevServerDetection.ts` (new), `apps/desktop/src/types.ts`, `apps/desktop/src/store.ts`, `apps/desktop/src/components/TabbedTerminals.tsx` |

---

## Task 1 — Rust: browser webview module + commands

**Goal:** Enable `unstable`, add `browser.rs` exposing create/bounds/show/hide/navigate/back/forward/reload/close commands over a `tabId → webview label` registry, and emit navigation/loading events to the frontend.

### Steps

**1. Enable the unstable feature** in `backend/tauri/Cargo.toml:24`:

```toml
tauri = { version = "2", features = ["macos-private-api", "protocol-asset", "image-png", "unstable"] }
```

**2. Create `backend/tauri/src/browser.rs`:**

Webview label convention: `browser-{tabId}` (tab ids are `[a-z0-9-]` + timestamp; sanitize to be safe — reuse the event-id sanitizer approach from `daemon_client.rs` if labels reject characters).

```rust
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager};
use tauri::webview::WebviewBuilder;
use tauri::WebviewUrl;

fn label_for(id: &str) -> String {
    format!("browser-{id}")
}

fn get_webview(app: &AppHandle, id: &str) -> Option<tauri::Webview> {
    app.webviews().get(&label_for(id)).cloned()
}

#[tauri::command]
pub fn browser_open(
    app: AppHandle,
    id: String,
    url: String,
    x: f64, y: f64, width: f64, height: f64,
) -> Result<(), String> {
    if let Some(wv) = get_webview(&app, &id) {
        wv.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        wv.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
        wv.show().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let parsed: tauri::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    // Config-defined window has the default label "main". get_window (not
    // get_webview_window) — add_child lives on Window.
    let window = app.get_window("main").ok_or("main window not found")?;
    let nav_app = app.clone();
    let nav_id = id.clone();
    let load_app = app.clone();
    let load_id = id.clone();
    let builder = WebviewBuilder::new(label_for(&id), WebviewUrl::External(parsed))
        .on_navigation(move |url| {
            let _ = nav_app.emit(&format!("browser-nav-{nav_id}"), url.to_string());
            true
        })
        .on_page_load(move |_wv, payload| {
            let loading = matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
            let _ = load_app.emit(&format!("browser-loading-{load_id}"), loading);
        });
    window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn browser_set_bounds(app: AppHandle, id: String, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    let wv = get_webview(&app, &id).ok_or("no such browser webview")?;
    wv.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    wv.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_set_visible(app: AppHandle, id: String, visible: bool) -> Result<(), String> {
    let wv = get_webview(&app, &id).ok_or("no such browser webview")?;
    if visible { wv.show().map_err(|e| e.to_string()) } else { wv.hide().map_err(|e| e.to_string()) }
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, id: String, url: String) -> Result<(), String> {
    let mut wv = get_webview(&app, &id).ok_or("no such browser webview")?;
    let parsed: tauri::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    wv.navigate(parsed).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_history(app: AppHandle, id: String, direction: String) -> Result<(), String> {
    // No native back/forward on the unstable surface (tauri#13957); JS is the
    // accepted workaround.
    let wv = get_webview(&app, &id).ok_or("no such browser webview")?;
    let js = if direction == "back" { "history.back()" } else { "history.forward()" };
    wv.eval(js).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_reload(app: AppHandle, id: String) -> Result<(), String> {
    let wv = get_webview(&app, &id).ok_or("no such browser webview")?;
    wv.reload().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_close(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(wv) = get_webview(&app, &id) {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}
```

Notes:
- If `Webview::hide`/`show` turn out not to exist on the locked version, fall back to superset-style parking: `set_position(LogicalPosition::new(-20000.0, 0.0))` to hide, restore bounds to show. Keep the `browser_set_visible` command signature either way.
- If `navigate` requires `&mut self`, the `mut` binding above covers it; adjust if it's `&self`.
- `on_navigation` fires on main-frame navigations only; SPA `pushState` changes won't update the URL bar. Accepted for Phase 1.

**3. Register in `backend/tauri/src/lib.rs`:** add `mod browser;` to the module list (lib.rs:1-25) and the seven commands to `generate_handler![...]` (lib.rs:1751).

**4. Verify compile:**

```bash
cd backend/tauri && cargo check
```

Expected: clean. Compile errors here are almost certainly unstable-API signature drift — fix against docs.rs for the locked version, keeping the command contracts identical.

**5. Smoke-test the raw commands** (before any UI exists): run `bun run dev`, open devtools on the main webview, and:

```js
const { invoke } = window.__TAURI__.core;
await invoke("browser_open", { id: "smoke", url: "http://localhost:1420", x: 300, y: 200, width: 600, height: 400 });
await invoke("browser_set_bounds", { id: "smoke", x: 350, y: 250, width: 500, height: 300 });
await invoke("browser_set_visible", { id: "smoke", visible: false });
await invoke("browser_set_visible", { id: "smoke", visible: true });
await invoke("browser_close", { id: "smoke" });
```

(If `window.__TAURI__` isn't exposed, temporarily call these from any component instead.) Watch for the known white-on-create upstream bug (tauri#10011) — if hit, note whether a `set_bounds` nudge after create repaints, and bake that workaround into `browser_open`.

**6. Commit:**

```bash
git add backend/tauri/Cargo.toml backend/tauri/Cargo.lock backend/tauri/src/browser.rs backend/tauri/src/lib.rs
git commit -m "feat(browser): native child-webview module behind unstable flag

Adds browser.rs with open/bounds/visibility/navigate/history/reload/
close commands over add_child webviews (label browser-{tabId}), plus
browser-nav-* / browser-loading-* events. Phase 1 of the built-in
browser (see docs/plans/builtin-browser-research.md)."
```

**Done When:**

- [ ] `cargo check` passes with `unstable` enabled
- [ ] Manual invoke sequence creates, moves, hides, shows, and closes a live webview over the running app
- [ ] Navigating inside the smoke webview logs `browser-nav-smoke` events (verify with a temporary `listen`)

---

## Task 2 — Frontend: `"browser"` tab kind + `BrowserPane`

**Goal:** `UserTab.kind` gains `"browser"` with a persisted `url`. New-tab menu gets "New browser tab". `BrowserPane` renders the toolbar + placeholder, drives bounds, and hides itself when not the active mounted tab.

### Steps

**1. `types.ts` — extend the tab union (`types.ts:73`):**

```ts
kind: "terminal" | "agent" | "file" | "browser";
```

Add below `pinned` (`types.ts:81`):

```ts
/** Current URL; only set when kind === "browser". Persisted so the tab restores. */
url?: string;
```

Like `"file"`, browser tabs never set `splitTree`/`focusedPaneId`. No store migration is needed: the new field is optional and old persisted states can't contain the new kind.

**2. `tab-actions.ts` — `createBrowserTab`:**

Mirror `createUserTab` (`tab-actions.ts:60-101`) minus the split tree, reusing `smallestUnused`/`parseLabelNumber` with prefix `"Browser"`, start 1:

```ts
export function createBrowserTab(worktreePath: string, url?: string): UserTab {
  const uiState = useUIStore.getState();
  const nav = uiState.getWorktreeNavState(worktreePath);
  const used = new Set<number>();
  for (const t of nav.userTabs) {
    if (t.kind !== "browser") continue;
    const n = parseLabelNumber(t.label, "Browser");
    if (n !== null) used.add(n);
  }
  const slot = smallestUnused(used, 1);
  const tabId = `browser-${slot}-${Date.now()}`;
  const newTab: UserTab = {
    id: tabId,
    kind: "browser",
    label: `Browser ${slot}`,
    createdAt: Date.now(),
    url,
  };
  uiState.updateWorktreeNavState(worktreePath, {
    userTabs: [...nav.userTabs, newTab],
    activeTerminalsTab: newTab.id,
  });
  return newTab;
}
```

In `closeUserTab` (`tab-actions.ts:103+`), next to the existing `kind === "file"` branch, add:

```ts
if (tab.kind === "browser") {
  invoke("browser_close", { id: tab.id }).catch(() => {});
}
```

**3. New `apps/desktop/src/components/BrowserPane.tsx`:**

Props: `{ tab: UserTab; worktreePath: string; isActive: boolean }`.

Structure — toolbar row + flex-1 placeholder:

- **Toolbar:** back / forward / reload buttons (`invoke("browser_history", { id, direction })`, `invoke("browser_reload", { id })`), a URL `<input>` (local state seeded from `tab.url`, Enter → `invoke("browser_navigate", { id: tab.id, url: sanitizeUrl(input) })`), and an open-in-system-browser button (`open(url)` from `@tauri-apps/plugin-shell`, same as `MarkdownPreview.tsx` link handling).
- **`sanitizeUrl` helper** (in the same file; superset semantics): passthrough `http(s)://` and `about:`; bare `localhost[:port]`, `127.0.0.1[:port]`, `0.0.0.0[:port]` → `http://` (rewrite `0.0.0.0` host to `localhost`); anything containing a dot → `https://` prefix; otherwise leave as typed (no search-engine fallback — this is a dev-preview pane, not a browser).
- **Placeholder + bounds sync:**

```tsx
const placeholderRef = useRef<HTMLDivElement | null>(null);
const createdRef = useRef(false);

const syncBounds = useCallback(() => {
  const el = placeholderRef.current;
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return;
  // getBoundingClientRect is viewport-relative; the main webview fills the
  // window (titleBarStyle Overlay), so viewport coords ARE window-logical coords.
  invoke("browser_set_bounds", { id: tab.id, x: r.x, y: r.y, width: r.width, height: r.height }).catch(() => {});
}, [tab.id]);

useLayoutEffect(() => {
  const el = placeholderRef.current;
  if (!el) return;
  const r = el.getBoundingClientRect();
  invoke("browser_open", {
    id: tab.id,
    url: tab.url ?? "about:blank",
    x: r.x, y: r.y, width: Math.max(r.width, 1), height: Math.max(r.height, 1),
  }).then(() => { createdRef.current = true; }).catch(console.error);

  let raf = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(syncBounds);
  });
  ro.observe(el);
  window.addEventListener("resize", syncBounds);
  return () => {
    ro.disconnect();
    window.removeEventListener("resize", syncBounds);
    cancelAnimationFrame(raf);
    // Hide, never close — the webview survives tab switches; closeUserTab owns destruction.
    invoke("browser_set_visible", { id: tab.id, visible: false }).catch(() => {});
  };
}, [tab.id]);
```

- **Nav event → persist URL:** `listen<string>(`browser-nav-${tab.id}`, ...)` updates the URL input state and writes the tab's `url` back via `updateWorktreeNavState` (map `userTabs`, replace the entry). Also `listen<boolean>(`browser-loading-${tab.id}`)` → spinner state on the reload button.
- **Visibility effect** (extended in Task 3):

```ts
useEffect(() => {
  if (!createdRef.current) return;
  invoke("browser_set_visible", { id: tab.id, visible: isActive }).catch(() => {});
  if (isActive) syncBounds();
}, [isActive, tab.id, syncBounds]);
```

**4. `TabbedTerminals.tsx` wiring:**

- Menu (after the "New Agent tab" button, `TabbedTerminals.tsx:476-481`): `New browser tab` → a `handleNewBrowser` mirroring `handleNewTerminal` but calling `createBrowserTab(worktreePath)`.
- Render branch (`TabbedTerminals.tsx:503-505`):

```tsx
{userTab && userTab.kind === "file" ? (
  <FileViewer />
) : userTab && userTab.kind === "browser" ? (
  <BrowserPane tab={userTab} worktreePath={worktreePath} isActive={isActive} />
) : userTab ? (
```

Note the existing body mounts **only the active tab** (`TabbedTerminals.tsx:488-497`), so `BrowserPane` unmounts on tab switch — the unmount-hide + remount-show/`browser_open`-idempotency path is the one that runs, and `isActive` here reflects the whole terminals pane's visibility (diff mode / worktree switch), which Task 3 refines.
- Tab strip: browser tabs flow through the existing user-tab rendering (label, close button, rename). If file tabs get a kind-specific icon in the strip, add a globe equivalent for `"browser"` in the same spot; otherwise skip.

**5. Verify:**

```bash
bun run typecheck
```

Then `bun run dev`, manual checks below.

**6. Commit** (`feat(browser): browser tab kind with native webview pane`).

**Done When:**

- [ ] `bun run typecheck` passes
- [ ] New browser tab opens, loads `localhost:1420` (the app's own dev server) when typed bare into the URL bar
- [ ] Webview tracks the pane during sidebar resize and window resize with no visible drift
- [ ] Switching to a terminal tab hides the webview; switching back shows it at correct bounds with page state intact (no reload)
- [ ] Back/forward/reload buttons work; URL bar reflects link-click navigations (`browser-nav-*`)
- [ ] Closing the tab destroys the webview; reopening the app restores the tab and its last URL
- [ ] Switching worktrees hides the webview (terminals pane of the other worktree)

---

## Task 3 — Occlusion: palette / finder / drag / diff-mode hiding

**Goal:** The native pane never sits on top of UI that should cover it. One derived `browserOccluded` signal, OR-ing every known overlay, consumed by `BrowserPane`'s visibility effect.

### Steps

**1. Lift command-palette open state into the store.** `App.tsx:32` keeps `commandPaletteOpen` in local React state; `fileFinderOpen` already lives in `useUIStore` (`store.ts:255-256`) and is stripped from persistence (`store.ts:327`). Add `commandPaletteOpen` + setter to the store the same way (initial `false`, add to the `partialize` strip list), and replace the `useState` in `App.tsx` (lines 32, 87, 276-278) with the store hook. No behavior change intended.

**2. Add a `panelDragActive` flag** (store, in-memory, stripped like the above):

- `apps/desktop/src/components/ResizablePanel.tsx` (custom sidebar resizer): set `true` on drag start, `false` on drag end (find the existing mouse handlers; they already track a dragging state for the cursor/hit area).
- `apps/desktop/src/components/ui/resizable.tsx` (shadcn wrapper over react-resizable-panels): `ResizableHandle` accepts `onDragging={(isDragging) => ...}` — wire it to the same store flag. This covers the split-view handle (`MainView.tsx:322-330`).

**3. Consume in `BrowserPane`:**

```ts
const activeTab = useUIStore((s) => s.getWorktreeNavState(worktreePath).activeTab);
const paletteOpen = useUIStore((s) => s.commandPaletteOpen);
const finderOpen = useUIStore((s) => s.fileFinderOpen);
const dragActive = useUIStore((s) => s.panelDragActive);

const visible =
  isActive && activeTab === "terminal" && !paletteOpen && !finderOpen && !dragActive;
```

Feed `visible` into the Task 2 visibility effect (replace the bare `isActive`). The `activeTab === "terminal"` gate covers diff mode's z-index toggling (`MainView.tsx:332-349`, where the terminals pane stays mounted but `visibility:hidden` — `getBoundingClientRect` still reports full size there, so a rect-based check would NOT catch it; the store gate is the correct mechanism). In split mode the terminals pane is agent-only (`MainView.tsx:322-330`), so browser tabs are unreachable there anyway — the gate is consistent with that.

**4. Verify** (`bun run typecheck`, then manual list below).

**5. Commit** (`feat(browser): hide native pane under overlays and drags`).

**Done When:**

- [ ] `bun run typecheck` passes
- [ ] Cmd+K palette and Cmd+P file finder open **over** the browser region (webview hidden while open, restored on close)
- [ ] Dragging the left/right sidebar edges and the split-view handle never gets stuck when the cursor crosses the browser region (webview hidden during drag, correct bounds on release)
- [ ] Switching to Diff mode hides the webview; back to Terminal restores it
- [ ] No visibility flapping while typing in the URL bar (state changes only on the listed signals)

---

## Task 4 — Dev-server URL detection + open affordance

**Goal:** When the Run tab's script prints a localhost URL, surface a one-click "Open in browser" that opens/reuses a browser tab at that URL.

### Steps

**1. Nav-state field** (`types.ts`, after `hasUnreadRunFailure`):

```ts
/** Last localhost URL seen in the Run tab's output. In-memory only. */
detectedDevServerUrl?: string | null;
```

Strip it in `partialize` alongside `lastUsedActionId` (`store.ts:334-338`), and make sure `getWorktreeNavState`'s default includes `detectedDevServerUrl: null`.

**2. New `apps/desktop/src/hooks/useDevServerDetection.ts`:**

A hook mounted once per worktree (from `TabbedTerminals`, which already knows `worktreePath` and mounts exactly once per worktree via `WorktreeTerminals`):

- Subscribe to `pty-output-${sanitizeEventId(runPtySessionId(worktreePath))}` — reuse the exact event-id sanitizer the terminal uses (see `safeId` in `XtermTerminal.tsx:311-313`; if it's inline there, extract it to `lib/` and import from both).
- Decode the base64 payload (same `atob` approach as `XtermTerminal.tsx:106`), append to a rolling tail buffer (keep the last ~256 chars to survive URLs split across PTY chunks), strip ANSI (`/\x1b\[[0-9;]*[A-Za-z]/g`), then match:

```ts
const DEV_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s"')\]]*)?/;
```

- Normalize (`0.0.0.0`/`[::]` host → `localhost`, drop trailing punctuation) and write to `detectedDevServerUrl` only when the value changes. Clear it when the Run PTY exits (`pty-exit-*` for the same session, or observe `runStatus` returning to `"idle"`).
- Scope: Run session only. Dev servers launched in ad-hoc terminal tabs are not sniffed in Phase 1 — the URL bar covers those.

**3. Affordance in `TabbedTerminals`:** when `detectedDevServerUrl` is set, render a small globe/"Open in browser" button at the right end of the tab strip (next to the `+` cluster, `TabbedTerminals.tsx:448-484`). On click:

```ts
const nav = useUIStore.getState().getWorktreeNavState(worktreePath);
const existing = nav.userTabs.find((t) => t.kind === "browser");
if (existing) {
  invoke("browser_navigate", { id: existing.id, url }).catch(() => {});
  updateWorktreeNavState(worktreePath, { activeTerminalsTab: existing.id });
} else {
  createBrowserTab(worktreePath, url);
}
```

Tooltip: the detected URL.

**4. Verify** (`bun run typecheck`, manual list below).

**5. Commit** (`feat(browser): detect dev-server URLs in Run output`).

**Done When:**

- [ ] `bun run typecheck` passes
- [ ] Running a Vite/Next dev script via the Run tab surfaces the button with the printed URL (test with this repo's own `bun run dev` inside a worktree, or any project printing `http://localhost:PORT`)
- [ ] Clicking it opens a browser tab at that URL; clicking again reuses the existing browser tab
- [ ] URL split across output chunks is still detected (hard to force manually — rely on the tail-buffer unit being straightforward; if a test harness exists for hooks, cover `extractDevUrl` with a chunked-input unit test, otherwise keep the pure extraction function exported for a quick console check)
- [ ] Button disappears when the Run script exits
