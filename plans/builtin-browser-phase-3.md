# Built-in Browser: Phase 3 — Element Annotation Mode

## Goal

Codex-style annotation mode grafted onto Impala's review loop: toggle annotate mode in the browser pane, hover-highlight elements, click one, write a comment — stored as a **browser annotation** (URL + selector + element snippet + screenshot crop + comment) that surfaces through `impala-mcp` beside code annotations and resolves the same way. The browser stops being a preview and becomes a review surface.

Builds on Phases 1–2 (`plans/builtin-browser-phase-{1,2}.md`, both shipped and live-verified). **Out of scope:** region drag-select (element click only), re-highlighting an annotated element when reopening the page, Codex's style-"Adjust" panel, editing annotation comments after creation (create/resolve only, matching the code-annotation MCP surface).

## Architecture

- **Separate `browser_annotations` table**, same SQLite DB (`annotations.rs::init_db` pattern — `CREATE TABLE IF NOT EXISTS`, ad-hoc `ALTER TABLE` migrations at `annotations.rs:36-60`). Columns: `id`, `repo_path` (worktree), `url`, `selector`, `element` (truncated outerHTML/label), `body`, `screenshot_path` (nullable), `resolved`, `created_at`, `updated_at`. Code annotations' schema and code paths stay untouched.
- **One agent-facing surface.** MCP `list_annotations` returns both kinds — code rows gain `"kind": "code"`, browser rows `"kind": "browser"` — and `resolve_annotation` resolves whichever table owns the id. Rationale: the impala-review loop is "list → fix → resolve"; two parallel tool families would make every agent prompt explain which list to check. A new `get_browser_annotation_screenshot` tool returns the stored crop as an MCP image block (embedding images in list output would bloat every listing).
- **Screenshot crops are files, not blobs**: `<app-data>/browser-annotation-screenshots/{id}.png`, path in the DB. Cropping happens in the frontend (canvas) from a full-pane `browser_screenshot` — no new Rust image dependencies.
- **Picker is eval-injected, results are polled.** Remote pages have no Tauri IPC (by design), so: toggling annotate mode `eval`s the picker script into the page (hover outline + click capture into `window.__IMPALA_PICK__`), and the frontend polls a new **frontend-only** `browser_eval` command (~200 ms while armed). Navigation disarms the mode (picker dies with the page — the existing `browser-nav` event is the signal).
- **Comment input lives in Impala's DOM, not the page**: a strip under the toolbar (same slot as the error strip) — the native webview can't be overlaid, but the toolbar region shrinks the placeholder, so a DOM strip there is z-order-safe.

## Tech Stack

Existing eval/screenshot bridge (Phase 2 `native` module), rusqlite (`DbState`), canvas cropping, `AnnotationsPanel.tsx` / `RightSidebar.tsx`, MCP tool surface in `backend/mcp/src/main.rs`, skill text in `hook_server.rs` (`IMPALA_REVIEW_SKILL`, ~line 64).

## Tasks

| # | Name | Dependencies | Files |
|---|------|--------------|-------|
| 1 | DB + Rust commands for browser annotations | none | `backend/tauri/src/annotations.rs` (or new `browser_annotations.rs`), `backend/tauri/src/lib.rs` |
| 2 | Picker script + annotate mode in BrowserPane | Task 1 | `backend/tauri/src/browser.rs`, `apps/desktop/src/components/BrowserPane.tsx`, `apps/desktop/src/lib/browser-picker.ts` (new) |
| 3 | Annotations panel integration | Task 1 | `apps/desktop/src/components/AnnotationsPanel.tsx`, `apps/desktop/src/lib/tab-actions.ts` (open-at-url helper) |
| 4 | MCP surface + impala-review skill update | Tasks 1–2 | `backend/mcp/src/main.rs`, `backend/tauri/src/hook_server.rs` |

---

## Task 1 — DB + Rust commands

**Goal:** `browser_annotations` table plus create/list/resolve commands and a change event, mirroring the code-annotation command shapes (`lib.rs:526+`).

### Steps

1. **Schema** — in `init_db` (`annotations.rs:36`), add:

```sql
CREATE TABLE IF NOT EXISTS browser_annotations (
    id TEXT PRIMARY KEY,
    repo_path TEXT NOT NULL,
    url TEXT NOT NULL,
    selector TEXT NOT NULL,
    element TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    screenshot_path TEXT,
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

Model structs (`BrowserAnnotation`, `NewBrowserAnnotation`) + `create/list/resolve` fns following the existing annotation fns' shapes (uuid v4 ids, chrono timestamps — same crates, same idioms). Decide placement by size: if `annotations.rs` stays readable, keep them there; else a sibling `browser_annotations.rs`.

2. **Screenshot persistence:** `create_browser_annotation` command takes an optional `screenshot_base64: Option<String>`; decode and write to `<app-data>/browser-annotation-screenshots/{id}.png` (resolve app-data the same way `init_db`'s caller does — see `DbState` setup in `lib.rs`), store the path. Delete the file on… nothing — annotations are never deleted today (only resolved); keep files.

3. **Commands** (register in `generate_handler`): `create_browser_annotation`, `list_browser_annotations(repo: String, include_resolved: Option<bool>)`, `resolve_browser_annotation(id: String)`. Emit `annotations-changed` after create/resolve — the existing frontend refresh listeners (`useAnnotationActions.ts:42`) then just work; check the payload shape they expect before reusing the event name.

4. **Verify:** `cargo check`; devtools invoke round-trip (create with a data-URL screenshot → row in `sqlite3 ~/Library/Application\ Support/be.kodeus.impala/impala.db "select id,url,selector from browser_annotations"` → PNG file exists → resolve → listed as resolved).

5. **Commit** (`feat(browser): browser_annotations table and commands`).

**Done When:** schema created on boot, create/list/resolve round-trip works, screenshot file written, `annotations-changed` fires.

---

## Task 2 — Picker script + annotate mode

**Goal:** the annotate loop in `BrowserPane`: arm → hover highlight → click → comment strip → save (crop + create) → disarm.

### Steps

1. **`browser_eval` command** (browser.rs): thin wrapper over `native::eval_js` — `browser_eval(app, id, js) -> Result<String, String>`, registered but **not** exposed through the hook server (frontend-only; agents already get scoped tools — don't hand every local process arbitrary JS eval beyond what Phase 2 shipped).

2. **Picker script** (`apps/desktop/src/lib/browser-picker.ts`, exported as template strings): `PICKER_ARM` installs (idempotently) a mouseover outline (2px accent, via a fixed-position box positioned from `getBoundingClientRect` — do NOT mutate the page's styles), a click handler with `preventDefault/stopPropagation` (capture phase) that writes `window.__IMPALA_PICK__ = {url, selector, element, rect: {x,y,width,height}, dpr: devicePixelRatio}`, and an Escape handler that disarms. `PICKER_POLL` returns-and-clears `__IMPALA_PICK__` (JSON). `PICKER_DISARM` removes listeners/overlay.
   - Selector generation (inside the script): prefer `#id`, then `[data-testid=…]`, else a ≤4-deep `tag.class:nth-of-type` path. Good-enough beats perfect — the selector is a hint for the agent, not a contract.
   - `element`: `outerHTML` truncated to ~300 chars.

3. **BrowserPane wiring:** toolbar crosshair toggle (`annotating` state) → arm via `browser_eval`; `setInterval` 200 ms polling `PICKER_POLL` while armed; on pick: keep the pane visible, show a comment strip under the toolbar (`Annotate <div.foo> — [input] [Save] [Cancel]`, autofocus); on Save:
   - `invoke("browser_screenshot", { id: tab.id })` → crop to `rect` (+8 px padding, × `dpr` — the snapshot is in device pixels; verify by comparing snapshot dimensions to the placeholder's CSS size) via canvas → base64 PNG;
   - `invoke("create_browser_annotation", { annotation: { repoPath: worktreePath, url, selector, element, body, screenshotBase64 } })`;
   - clear strip, disarm.
   - Disarm on: Cancel, Escape (poll returns a disarmed marker), `browser-nav` event, tab unmount.

4. **Verify** (manual, dev app): annotate a button on a real dev-server page → comment strip appears with the right element label → save → DB row + crop PNG showing that element (open the file). Escape and navigation disarm cleanly; the page's own click handlers don't fire while armed.

5. **Commit** (`feat(browser): element annotation mode in the browser pane`).

**Done When:** the full arm→pick→comment→save loop works on a real page; crops match the picked element; no stray listeners after disarm (picker is idempotent and removable).

---

## Task 3 — Annotations panel integration

**Goal:** browser annotations visible and resolvable where code annotations live, so the human loop matches.

### Steps

1. **`AnnotationsPanel.tsx`:** load `list_browser_annotations` alongside the existing annotation load (same `annotations-changed` refresh path); render a "Browser" group after the file groups: element label + comment + relative time, thumbnail if `screenshot_path` (`convertFileSrc` — the asset scope is already `**`), resolve button calling `resolve_browser_annotation`.
2. **Click → open in browser:** clicking a row opens/reuses the worktree's browser tab at the annotation's URL — reuse the exact open-or-navigate logic shape from the removed `handleOpenDetectedUrl` (see commit `664a9b3`) as a small `openBrowserTabAt(worktreePath, url)` helper in `tab-actions.ts`.
3. **Verify:** annotation from Task 2 shows with thumbnail; resolve removes it (or greys it, matching the panel's resolved-code-annotation behavior — mirror whatever the panel does today); click lands the browser tab on the URL.
4. **Commit** (`feat(browser): browser annotations in the annotations panel`).

**Done When:** browser annotations render, resolve, and click-through; code-annotation UI is visually unchanged.

---

## Task 4 — MCP surface + skill update

**Goal:** agents see browser annotations in the same list, can fetch the crop as an image, resolve them, and the impala-review skill tells them what to do with them.

### Steps

1. **`list_annotations`** (mcp `main.rs`): after the code-annotation query, query `browser_annotations` (unresolved, same `repo_path` scoping); tag rows `"kind": "code"` / `"kind": "browser"` and return a combined array. `list_files_with_annotations` stays code-only (it's about files) but gains a `browser_annotation_count` field so the overview mentions them.
2. **`resolve_annotation`:** try the code table first (existing), then `browser_annotations`; error only if neither matched.
3. **`get_browser_annotation_screenshot(id)`:** reads the row's `screenshot_path`, returns an MCP image block (reuse the Phase 2 image-response shape); text error if no screenshot.
4. **Skill text** (`IMPALA_REVIEW_SKILL`, `hook_server.rs:64`): add a browser-annotation section — for `kind: "browser"` entries: fetch the screenshot, locate the component from selector/classes/element snippet (grep the codebase), make the change, then **verify with `browser_navigate` + `browser_screenshot`** before resolving. Also add the browser tools + `get_browser_annotation_screenshot` to the skill's `allowed-tools` line.
5. **Verify:** JSON-RPC round-trip (list shows both kinds; resolve works on a browser id; screenshot tool returns an image block). Then the real exit criterion, live: annotate a visual nit on your dev app in Impala → run the agent (`/impala-review`) → it finds the browser annotation, fixes the code, screenshots the result, resolves. That's the loop Codex doesn't have — annotations and verification in one tool surface.
6. **Commit** (`feat(mcp): browser annotations in the review loop`).

**Done When:** combined listing, cross-table resolve, image fetch, updated skill — and one real annotate→fix→verify→resolve cycle completed by an agent.
