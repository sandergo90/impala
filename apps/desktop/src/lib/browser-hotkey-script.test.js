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
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    preventDefault: mock(() => {}),
    stopPropagation: mock(() => {}),
    ...overrides,
  };
}

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

    keydownHandler(keydown({ key: "l" }));
    keydownHandler(keydown({ key: "W" }));

    expect(location.assign).toHaveBeenNthCalledWith(
      1,
      "https://impala.invalid/hotkey?action=focus-address",
    );
    expect(location.assign).toHaveBeenNthCalledWith(
      2,
      "https://impala.invalid/hotkey?action=close-pane",
    );
  });

  test("other keys and modifier variants pass through", async () => {
    const { keydownHandler, location } = await loadShim();

    const untouched = [
      keydown({ key: "k" }),
      keydown({ metaKey: false }),
      keydown({ ctrlKey: true }),
      keydown({ shiftKey: true }),
      keydown({ altKey: true }),
      keydown({ repeat: true }),
    ];
    for (const event of untouched) keydownHandler(event);

    expect(location.assign).not.toHaveBeenCalled();
    for (const event of untouched) {
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
  });
});
