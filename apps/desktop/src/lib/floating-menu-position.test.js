import { describe, expect, test } from "bun:test";
import { positionFloatingMenu } from "./floating-menu-position";

describe("positionFloatingMenu", () => {
  test("opens below the caret when it fits", () => {
    expect(
      positionFloatingMenu(
        { left: 320, right: 340, top: 80, bottom: 112 },
        { width: 800, height: 600 },
        { width: 160, height: 104 },
      ),
    ).toEqual({ left: 320, top: 112 });
  });

  test("stays within the right and bottom viewport edges", () => {
    expect(
      positionFloatingMenu(
        { left: 760, right: 780, top: 560, bottom: 592 },
        { width: 800, height: 600 },
        { width: 160, height: 104 },
      ),
    ).toEqual({ left: 632, top: 456 });
  });
});
