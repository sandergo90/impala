import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";

// Central chokepoint for every call into the Rust core.
//
// In the packaged app this is just Tauri's `invoke()`. But the frontend is a
// plain Vite SPA — nothing about rendering a diff or a file tree needs the
// native shell — so routing every command through this one function lets us
// boot the exact same client in Chrome, where the Chrome performance profiler
// AND the React DevTools profiler both work. (WKWebView, the macOS webview
// Tauri uses, can't load the React DevTools extension, so it's the one tool
// that would point straight at a re-render bottleneck but can't run there.)
//
// To profile in Chrome: run `vite`, open it in Chrome, and set
// `VITE_BACKEND_SHIM_URL` to a dev server that answers `POST /<cmd>` with the
// command's JSON result (or canned data for the surface you're profiling).
export function invoke<T>(
  cmd: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
): Promise<T> {
  // Packaged app: use the native bridge.
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    return tauriInvoke<T>(cmd, args, options);
  }

  // Dev in a real browser: stand in for the Rust backend.
  const shimUrl = (import.meta.env as Record<string, string | undefined>)
    .VITE_BACKEND_SHIM_URL;
  if (shimUrl) {
    return fetch(`${shimUrl}/${cmd}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args ?? {}),
    }).then((r) => r.json() as Promise<T>);
  }

  return Promise.reject(
    new Error(
      `invoke("${cmd}") was called outside the Tauri runtime. ` +
        `Set VITE_BACKEND_SHIM_URL to run the UI in a browser for profiling.`,
    ),
  );
}
