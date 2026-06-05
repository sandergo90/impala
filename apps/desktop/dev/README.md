# Browser dev harness — profile the real app in Chrome

Impala renders in Tauri's native webview (WKWebView on macOS). That keeps the
bundle small and cold start fast, but it means the **React DevTools extension
and the Chrome performance profiler cannot attach** — the one tool that points
straight at a re-render bottleneck is the one you can't run.

The frontend is just a Vite SPA, though. The only thing that needs the native
shell is `invoke()` (the bridge to the Rust core), which every call site already
routes through [`src/lib/invoke.ts`](../src/lib/invoke.ts). So if we stand in for
that bridge, the **exact same client boots in plain Chrome**, where both
profilers work.

This folder is that stand-in:

- **`dev-browser.html`** — a Vite entry that installs a fake `__TAURI_INTERNALS__`
  before the app boots, so `invoke()`, `getCurrentWindow()`, `listen()`, etc. all
  resolve instead of throwing. `invoke` is forwarded to the mock backend.
- **`mock-backend.ts`** — a tiny HTTP server that answers `POST /<command>` with
  canned JSON (a demo project, a worktree, commits, N changed files).

## Usage

```sh
cd apps/desktop

# terminal 1 — canned backend (logs each command the app calls)
bun run mock-backend           # or: FILES=2000 bun run mock-backend

# terminal 2 — Vite dev server
bun run dev
```

Open **http://localhost:1420/dev/dev-browser.html** in Chrome, then:

- **React DevTools → Profiler** to record component renders (what re-rendered and
  why), or
- **Chrome DevTools → Performance** for flame charts / dropped frames.

### Knobs (env vars on `mock-backend`)

| Var        | Default | Effect                                                        |
| ---------- | ------- | ------------------------------------------------------------ |
| `FILES`    | `600`   | Number of changed files — crank it to stress virtualization. |
| `POPULATE` | `1`     | `0` boots the empty "no projects" state.                     |
| `PORT`     | `8787`  | Backend port (also update `MOCK` in `dev-browser.html`).     |

## How it works

`src/lib/invoke.ts` calls the native bridge when `window.__TAURI_INTERNALS__`
exists. `dev-browser.html` defines a fake one whose `invoke` does a `fetch` to
the mock backend, so both the central shim and any direct `@tauri-apps/api` calls
flow through it. Unknown commands return `[]` for list-shaped names and `null`
otherwise, so the UI never crashes on a missing mock.

## Caveats

This harness is for **rendering / re-render / scroll profiling**, not functional
end-to-end testing. Tauri events are stubbed, so there's no live streaming, no
PTY/terminal, no real git or file IO — data is canned and static. Treat it as a
profiling rig for the React layer, not a working app.
