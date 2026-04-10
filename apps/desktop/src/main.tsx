import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { preloadSystemFonts } from "./hooks/useSystemFonts";
import "./index.css";

// Start loading system fonts in the background so Settings doesn't freeze on open
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
    <RouterProvider router={router} />
  </React.StrictMode>,
);
