import { describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";

const scriptPath = resolve(
  import.meta.dir,
  "../../../../backend/tauri/src/browser_hotkeys.js",
);

async function loadShim() {
  const source = await Bun.file(scriptPath).text();
  let keydownHandler;
  const window = {
    addEventListener(type, handler, capture) {
      if (type === "keydown" && capture === true) keydownHandler = handler;
    },
  };
  const location = { assign: mock(() => {}) };

  Function("window", "location", source)(window, location);

  return { keydownHandler, location };
}

function keydown(overrides = {}) {
  return {
    key: "r",
    code: "KeyR",
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    isTrusted: true,
    target: { tagName: "BODY", isContentEditable: false },
    preventDefault: mock(() => {}),
    stopPropagation: mock(() => {}),
    ...overrides,
  };
}

const editable = { tagName: "INPUT", isContentEditable: false };

describe("browser hotkey shim", () => {
  test("cmd+r signals a reload and consumes the event", async () => {
    const { keydownHandler, location } = await loadShim();
    const event = keydown();

    keydownHandler(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(location.assign).toHaveBeenCalledWith(
      "https://impala.invalid/hotkey?action=reload",
    );
  });

  test("cmd+l and cmd+w map to their actions", async () => {
    const { keydownHandler, location } = await loadShim();

    keydownHandler(keydown({ key: "l", code: "KeyL" }));
    keydownHandler(keydown({ key: "W", code: "KeyW" }));

    expect(location.assign).toHaveBeenNthCalledWith(
      1,
      "https://impala.invalid/hotkey?action=focus-address",
    );
    expect(location.assign).toHaveBeenNthCalledWith(
      2,
      "https://impala.invalid/hotkey?action=close-pane",
    );
  });

  test("other chords are forwarded to the shell without being consumed", async () => {
    const { keydownHandler, location } = await loadShim();
    const event = keydown({ key: "P", code: "KeyP", shiftKey: true });

    keydownHandler(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(location.assign).toHaveBeenCalledWith(
      "https://impala.invalid/hotkey?action=forward&key=P&code=KeyP&meta=1&ctrl=0&alt=0&shift=1",
    );
  });

  test("reserved keys with extra modifiers forward instead of acting", async () => {
    const { keydownHandler, location } = await loadShim();

    keydownHandler(keydown({ key: "r", code: "KeyR", shiftKey: true }));

    expect(location.assign).toHaveBeenCalledWith(
      "https://impala.invalid/hotkey?action=forward&key=r&code=KeyR&meta=1&ctrl=0&alt=0&shift=1",
    );
  });

  test("editing chords in an editable target stay with the page", async () => {
    const { keydownHandler, location } = await loadShim();

    keydownHandler(keydown({ key: "Backspace", code: "Backspace", target: editable }));
    keydownHandler(keydown({ key: "ArrowLeft", code: "ArrowLeft", target: editable }));
    keydownHandler(keydown({ key: "a", code: "KeyA", target: editable }));

    expect(location.assign).not.toHaveBeenCalled();
  });

  test("non-editing chords forward even from an editable target", async () => {
    const { keydownHandler, location } = await loadShim();

    keydownHandler(keydown({ key: "P", code: "KeyP", shiftKey: true, target: editable }));

    expect(location.assign).toHaveBeenCalledTimes(1);
  });

  test("unmodified, repeated, untrusted, and modifier-only keys pass through", async () => {
    const { keydownHandler, location } = await loadShim();

    const untouched = [
      keydown({ metaKey: false }),
      keydown({ repeat: true }),
      keydown({ isTrusted: false }),
      keydown({ key: "Meta", code: "MetaLeft" }),
      keydown({ key: "Shift", code: "ShiftLeft", shiftKey: true }),
    ];
    for (const event of untouched) keydownHandler(event);

    expect(location.assign).not.toHaveBeenCalled();
    for (const event of untouched) {
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
  });
});
