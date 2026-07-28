import { describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";

const scriptPath = resolve(
  import.meta.dir,
  "../../../../backend/tauri/src/browser_target_blank.js",
);

async function loadShim() {
  const source = await Bun.file(scriptPath).text();
  let clickHandler;
  const document = {
    addEventListener(type, handler, capture) {
      if (type === "click" && capture === true) clickHandler = handler;
    },
  };
  const location = { assign: mock(() => {}) };
  const window = {};
  class Element {
    constructor(anchor) {
      this.anchor = anchor;
    }

    closest() {
      return this.anchor;
    }
  }

  Function("window", "document", "location", "Element", source)(
    window,
    document,
    location,
    Element,
  );

  return { clickHandler, location, Element };
}

function anchor(overrides = {}) {
  return {
    target: "_blank",
    href: "https://example.com/source",
    hasAttribute: () => false,
    ...overrides,
  };
}

function click(Element, targetAnchor, overrides = {}) {
  return {
    target: new Element(targetAnchor),
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: mock(() => {}),
    ...overrides,
  };
}

describe("browser target=_blank shim", () => {
  test("routes a plain source-link click to a managed browser tab", async () => {
    const { clickHandler, location, Element } = await loadShim();
    const event = click(Element, anchor());

    clickHandler(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(location.assign).toHaveBeenCalledWith(
      "https://impala.invalid/open-new-tab?url=https%3A%2F%2Fexample.com%2Fsource",
    );
  });

  test("preserves modified clicks and download links", async () => {
    const { clickHandler, location, Element } = await loadShim();

    clickHandler(click(Element, anchor(), { metaKey: true }));
    clickHandler(
      click(
        Element,
        anchor({
          hasAttribute: (name) => name === "download",
        }),
      ),
    );

    expect(location.assign).not.toHaveBeenCalled();
  });
});
