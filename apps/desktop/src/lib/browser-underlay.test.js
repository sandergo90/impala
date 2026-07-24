import { describe, expect, test } from "bun:test";
import {
  browserPaneNeedsHandoffCover,
  browserPaneShowsUnderlay,
  browserNativeVisible,
  hasShellOwnedOverlay,
} from "./browser-underlay";

describe("browser underlay visibility", () => {
  test("keeps an active underlay browser visible beneath shell overlays", () => {
    expect(
      browserNativeVisible({
        isActive: true,
        underlayEnabled: true,
        shellOverlayActive: true,
      }),
    ).toBe(true);
  });

  test("preserves legacy occlusion when underlay mode is disabled", () => {
    expect(
      browserNativeVisible({
        isActive: true,
        underlayEnabled: false,
        shellOverlayActive: true,
      }),
    ).toBe(false);
  });

  test("never exposes a browser from an inactive tab", () => {
    expect(
      browserNativeVisible({
        isActive: false,
        underlayEnabled: true,
        shellOverlayActive: false,
      }),
    ).toBe(false);
  });

  test("keeps an empty browser pane opaque until a native view exists", () => {
    expect(
      browserPaneShowsUnderlay({
        underlayEnabled: true,
        hasUrl: false,
        nativeVisible: false,
        visible: true,
      }),
    ).toBe(false);
    expect(
      browserPaneShowsUnderlay({
        underlayEnabled: true,
        hasUrl: true,
        nativeVisible: true,
        visible: true,
      }),
    ).toBe(true);
    expect(
      browserPaneShowsUnderlay({
        underlayEnabled: true,
        hasUrl: true,
        nativeVisible: false,
        visible: true,
      }),
    ).toBe(false);
    expect(
      browserPaneShowsUnderlay({
        underlayEnabled: true,
        hasUrl: true,
        nativeVisible: true,
        visible: false,
      }),
    ).toBe(false);
  });

  test("covers a keyed browser handoff until the incoming native view settles", () => {
    expect(
      browserPaneNeedsHandoffCover({
        underlayEnabled: true,
        isBrowser: true,
        activePaneId: "browser-b",
        settledPaneId: "browser-a",
      }),
    ).toBe(true);
    expect(
      browserPaneNeedsHandoffCover({
        underlayEnabled: true,
        isBrowser: true,
        activePaneId: "browser-b",
        settledPaneId: "browser-b",
      }),
    ).toBe(false);
  });

  test("covers empty browser handoffs but not non-browser or legacy panes", () => {
    const base = {
      underlayEnabled: true,
      isBrowser: true,
      activePaneId: "browser-b",
      settledPaneId: null,
    };

    expect(browserPaneNeedsHandoffCover(base)).toBe(true);
    expect(browserPaneNeedsHandoffCover({ ...base, isBrowser: false })).toBe(false);
    expect(
      browserPaneNeedsHandoffCover({ ...base, underlayEnabled: false }),
    ).toBe(false);
  });
});

describe("shell overlay ownership", () => {
  test("recognizes interactive portalled surfaces", () => {
    const selectors = [];
    const root = {
      querySelector(selector) {
        selectors.push(selector);
        return selector.includes('[role="dialog"]') ? {} : null;
      },
    };

    expect(hasShellOwnedOverlay(root)).toBe(true);
    expect(selectors.some((selector) => selector.includes('[role="dialog"]'))).toBe(true);
  });

  test("returns false when no shell overlay is mounted", () => {
    const root = { querySelector: () => null };

    expect(hasShellOwnedOverlay(root)).toBe(false);
  });
});
