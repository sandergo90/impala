import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { attachConsole } from "@tauri-apps/plugin-log";
import { router } from "./router";
import { initSentry, SentryErrorBoundary } from "./lib/sentry";
import { preloadSystemFonts } from "./hooks/useSystemFonts";
import "./index.css";

initSentry(router);
attachConsole().catch(() => {});

// Start loading system fonts in the background so Settings doesn't freeze on open.
preloadSystemFonts();

// Suppress benign ResizeObserver warning that fires when xterm fit() triggers
// a layout change within the observer callback.
const ro = window.ResizeObserver;
window.ResizeObserver = class extends ro {
  constructor(cb: ResizeObserverCallback) {
    super((entries, observer) => {
      requestAnimationFrame(() => cb(entries, observer));
    });
  }
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SentryErrorBoundary
      fallback={({ error, resetError }) => (
        <div style={{ padding: 24, fontFamily: "system-ui" }}>
          <h2>Something broke.</h2>
          <p>The error has been reported. You can try to recover:</p>
          <button onClick={resetError}>Reset</button>
          <pre style={{ marginTop: 16, whiteSpace: "pre-wrap", opacity: 0.7 }}>
            {String(error)}
          </pre>
        </div>
      )}
      showDialog={false}
    >
      <RouterProvider router={router} />
    </SentryErrorBoundary>
  </React.StrictMode>,
);
