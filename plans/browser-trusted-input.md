# Browser: Codex-style trusted input (real events + virtual cursor)

Handoff plan — written 2026-07-22, intended to be executed by a fresh session. Read `plans/builtin-browser-phase-{1,2,3}.md` and `backend/tauri/src/browser.rs` first for the existing architecture.

## Goal

Replace the synthesized-DOM-event interaction path (`isTrusted: false`, ignored by native controls) with **real platform input events** delivered to the child WKWebView, the way the Codex app drives its browser — plus the visible **virtual cursor** that makes agent actions legible. Selector-driven where possible (we can compute coordinates from the DOM — no vision loop required), with a coordinate tool for vision-style workflows.

## Why this approach (decided)

- Codex injects input at the OS layer via private SkyLight APIs. We do NOT need that: the webview lives **inside our own window**, so we can synthesize `NSEvent`s and deliver them with public API — `NSWindow.sendEvent(_:)` — no accessibility permission, no private APIs, never moves the user's real cursor.
- WebKit treats events arriving through the normal NSView pipeline as user input → `isTrusted: true`, user-gesture gates satisfied (popups, file pickers, clipboard), native controls respond.
- We keep selector addressing: resolve selector → `getBoundingClientRect()` center via the existing eval bridge → convert to window coordinates → post real events. Deterministic, no screenshot round-trip. `browser_click_at(x, y)` is added for canvas/vision cases.

## Current architecture pointers

- `backend/tauri/src/browser.rs` — `native` module (cfg macos): `eval_js` (objc2, block2, main-thread-safe pattern), `take_screenshot`. `CLICK_JS`/`TYPE_JS` + `click_selector`/`type_into_selector` are the synthetic path to be superseded (keep as non-macOS fallback). `PlatformWebview::inner()` gives the `WKWebView`; its frame within the window is set by `browser_set_bounds` (logical points, top-left origin, from the frontend placeholder).
- `backend/tauri/src/hook_server.rs` — `/browser/*` endpoints (per-request threads), `handle_browser_request` (also emits agent-activity events).
- `backend/mcp/src/main.rs` — tool definitions + dispatch, `browser_get` transport.
- `apps/desktop/src/components/BrowserPane.tsx` — occlusion model: webview PARKED at −20000 when hidden (never `setHidden`). Bounds follow the placeholder div.
- objc2 crates pinned to wry's versions (objc2-app-kit 0.3.2 etc.) — reuse existing deps; NSEvent APIs are in objc2-app-kit.

## Phase 1 — native event core (Rust, macOS)

1. `native::post_mouse_click(wv, x, y)` — synthesize the sequence `mouseMoved → leftMouseDown → leftMouseUp` as `NSEvent`s and deliver via `window.sendEvent(...)` **on the main thread** (`run_on_main_thread`, same pattern as eval_js but no completion needed — add a done-channel anyway for errors).
   - Coordinates in: webview-local CSS points (what `getBoundingClientRect` returns; WKWebView is 1:1 CSS-px ↔ logical points).
   - Convert: webview frame origin within window (+ x, + y) → **flip Y**: AppKit window coords are bottom-left origin; `locationInWindow = (frame.origin.x + x, windowHeight − (frame.origin.y + y))`. Get the window via `wv.window()`.
   - NSEvent construction: `NSEvent.mouseEvent(with:location:modifierFlags:timestamp:windowNumber:context:eventNumber:clickCount:pressure:)` — type `.leftMouseDown` etc., `clickCount: 1`, timestamp `ProcessInfo.systemUptime`-equivalent.
2. `native::post_scroll(wv, x, y, dx, dy)` — `scrollWheel` NSEvent (CGEvent-backed scroll wheel event wrapped in NSEvent is easier for pixel deltas: `CGEventCreateScrollWheelEvent` → `NSEvent(cgEvent:)`, then set location + sendEvent).
3. `native::post_key_text(wv, text)` — trusted typing: per character, `NSEvent.keyEvent(...)` keyDown/keyUp with `characters: <char>`, `keyCode: 0` (WebKit inserts from `characters`; exact keyCodes unnecessary for text). Special-case `\n` → keyCode 36 (Return). Before typing: `window.makeFirstResponder(wv)` so keys route to the webview.
4. Rewire `click_selector`: eval a small JS that resolves the selector → `{x, y}` center (viewport coords) + scrollIntoView if needed (`el.scrollIntoView({block:'center'})`, then re-measure) → `post_mouse_click`. Return the same `{clicked: {tag, text}}` shape by reading the element in the resolve step (before the click). Keep the current synthetic dispatch as the non-macOS stub.
5. Rewire `type_into_selector`: resolve + real click to focus → select-all (`Cmd+A` key event or eval `el.select()`) → `post_key_text`. Fall back to the native-setter path if the element rejects focus.
6. New commands/helpers: `click_at(wv, x, y)` (raw coords, for the MCP tool), keep everything worktree-resolved as today.

**Verify (gate before Phase 2):** test page served locally with (a) `document.addEventListener('click', e => console.log('trusted:', e.isTrusted))` — must log `true` via `browser_console`; (b) an `<input type=file>` — clicking it must open the native picker; (c) `window.open` on click must pass the popup blocker. Check a Retina display (coordinates must not be doubled) and a moved/resized pane (bounds math).

## Phase 2 — hook server + MCP surface

- Endpoints: extend `/browser/click` and `/browser/type` to the new path (same params — transparent upgrade for agents), add `/browser/click_at` (x, y) and `/browser/scroll` (dx, dy — dy required, dx default 0).
- MCP tools: update `browser_click`/`browser_type` descriptions (drop the isTrusted caveat — say events are real platform input; file pickers open, so warn the agent a native dialog may appear and it cannot drive those), add `browser_click_at` + `browser_scroll`.
- Update both skills (`IMPALA_BROWSER_SKILL`, `IMPALA_REVIEW_SKILL` in hook_server.rs) and Codex command mirrors (agent_config.rs): interaction is now trusted; `browser_click_at` pairs with `browser_screenshot` for canvas/vision targets. Remind: stale pinned dev MCP binary hides new tools — copy `backend/mcp/target/debug/impala-mcp` → `backend/tauri/target/debug/impala-mcp` after building.

## Phase 3 — virtual cursor

- Injected overlay (add to the initialization script alongside CONSOLE_SHIM): a `pointer-events: none`, max-z-index element styled as a cursor (SVG arrow + subtle shadow), hidden until first agent action.
- Before each click/type/scroll: eval an `animate(x, y)` helper — glide from last position over ~350ms (ease-out), then a click ripple. The Rust side sequences: animate (eval) → await duration → post real events. Keep last cursor position in `BrowserRegistry` per tab so continuity survives navigations (init script recreates the overlay; Rust re-seeds position on next action).
- Fade the cursor out after ~2s idle. Tie into the existing agent-activity event so the pane ring and cursor agree.

## Constraints & risks (read before implementing)

- **Visibility:** parked webview (−20000) still sits in the window's view hierarchy at that frame, so sendEvent with parked-frame coords may actually work — TEST background clicking while the pane is hidden; if it misbehaves, gate: return "browser pane not visible" (frontend knows via `browser_set_visible` state; expose in registry).
- **Keyboard focus:** `makeFirstResponder` steals focus from the app's terminal/editor while typing. Acceptable for v1 (action is brief); restore first responder afterwards.
- **Native dialogs:** a real click can open OS UI (file picker) the agent cannot control — that's correct behavior, document it in tool descriptions.
- **Window minimized / other Space:** sendEvent likely still delivers (no z-order dependency), but screenshots of occluded webviews already work — verify once, note the result.
- **Don't touch** the offscreen-parking model, occlusion logic, or bounds-sync — coordinates must always be read from the CURRENT webview frame at event time.

## Out of scope

- Private SkyLight APIs / background OS-level input (Codex's actual transport) — rejected, fragile.
- CEF/CDP embed — the fallback if WKWebView event delivery hits a wall; decision point only after Phase 1 verification fails.
- Vision loop automation (model picks coordinates from screenshots) — enabled by `browser_click_at` but no new orchestration.
