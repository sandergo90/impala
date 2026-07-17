/**
 * Element-picker scripts injected into the browser tab's native webview via
 * the `browser_eval` command. Remote pages have no Tauri IPC, so picks land
 * in `window.__IMPALA_PICK__` and BrowserPane polls for them.
 *
 * The picker self-disarms on pick/Escape; PICKER_DISARM covers Impala-side
 * exits (toggle off, tab unmount, navigation).
 */

export interface BrowserPick {
  url: string;
  selector: string;
  element: string;
  rect: { x: number; y: number; width: number; height: number };
  cancelled?: boolean;
}

export const PICKER_ARM = `
(function () {
  if (window.__IMPALA_PICKER__) return "armed";
  var overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;z-index:2147483647;pointer-events:none;display:none;" +
    "border:2px solid #6366f1;background:rgba(99,102,241,0.08);border-radius:2px;";
  document.documentElement.appendChild(overlay);

  function cssPath(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    var tid = el.getAttribute && el.getAttribute("data-testid");
    if (tid) return '[data-testid="' + tid + '"]';
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      if (node.id) { parts.unshift("#" + CSS.escape(node.id)); break; }
      var part = node.tagName.toLowerCase();
      var cls =
        node.className && typeof node.className === "string"
          ? node.className.trim().split(/\\s+/).slice(0, 2)
          : [];
      if (cls.length) {
        part += "." + cls.map(function (c) { return CSS.escape(c); }).join(".");
      }
      var parent = node.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === node.tagName;
        });
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }

  function onMove(e) {
    var el = e.target;
    if (!(el instanceof Element)) return;
    var r = el.getBoundingClientRect();
    overlay.style.display = "block";
    overlay.style.left = r.left + "px";
    overlay.style.top = r.top + "px";
    overlay.style.width = r.width + "px";
    overlay.style.height = r.height + "px";
  }
  function onSuppress(e) {
    e.preventDefault();
    e.stopPropagation();
  }
  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    if (!(el instanceof Element)) return;
    var r = el.getBoundingClientRect();
    window.__IMPALA_PICK__ = {
      url: location.href,
      selector: cssPath(el),
      element: (el.outerHTML || "").slice(0, 300),
      rect: { x: r.left, y: r.top, width: r.width, height: r.height }
    };
    disarm();
  }
  function onKey(e) {
    if (e.key === "Escape") {
      window.__IMPALA_PICK__ = { cancelled: true };
      disarm();
    }
  }
  function disarm() {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("pointerdown", onSuppress, true);
    document.removeEventListener("mousedown", onSuppress, true);
    document.removeEventListener("mouseup", onSuppress, true);
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    delete window.__IMPALA_PICKER__;
    delete window.__IMPALA_PICKER_DISARM__;
  }
  window.__IMPALA_PICKER__ = true;
  window.__IMPALA_PICKER_DISARM__ = disarm;
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("pointerdown", onSuppress, true);
  document.addEventListener("mousedown", onSuppress, true);
  document.addEventListener("mouseup", onSuppress, true);
  document.addEventListener("keydown", onKey, true);
  return "armed";
})()
`;

export const PICKER_POLL = `
JSON.stringify((function () {
  var p = window.__IMPALA_PICK__ || null;
  window.__IMPALA_PICK__ = null;
  return p;
})())
`;

export const PICKER_DISARM = `
(function () {
  if (window.__IMPALA_PICKER_DISARM__) window.__IMPALA_PICKER_DISARM__();
  window.__IMPALA_PICK__ = null;
  return "ok";
})()
`;

/**
 * Crop a full-pane screenshot (base64 PNG) to an element rect (viewport CSS
 * px, from the picker) plus padding. The snapshot's pixel width vs the pane's
 * CSS width gives the device-pixel scale — measured, not assumed.
 */
export async function cropScreenshot(
  pngBase64: string,
  rect: { x: number; y: number; width: number; height: number },
  viewportCssWidth: number,
): Promise<string> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("could not decode screenshot"));
    img.src = `data:image/png;base64,${pngBase64}`;
  });
  const scale = viewportCssWidth > 0 ? img.width / viewportCssWidth : 1;
  const pad = 8;
  const sx = Math.max(0, (rect.x - pad) * scale);
  const sy = Math.max(0, (rect.y - pad) * scale);
  const sw = Math.min(img.width - sx, (rect.width + pad * 2) * scale);
  const sh = Math.min(img.height - sy, (rect.height + pad * 2) * scale);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw));
  canvas.height = Math.max(1, Math.round(sh));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png").split(",")[1];
}
