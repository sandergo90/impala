export const SHELL_OWNED_OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="tooltip"]',
  "[data-browser-native-occlusion]",
].join(", ");

type QueryRoot = {
  querySelector: (selector: string) => unknown;
};

export function hasShellOwnedOverlay(root: QueryRoot): boolean {
  return Boolean(root.querySelector(SHELL_OWNED_OVERLAY_SELECTOR));
}

/**
 * Shell UI that floats over browser panes without occluding them (toasts).
 * Their rectangles are published to the native hit-test router so their
 * clicks stay in the shell instead of falling through to the page below.
 */
export const SHELL_HIT_REGION_SELECTOR = "[data-sonner-toast]";

export interface ShellHitRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

type MeasurableRoot = {
  querySelectorAll: (selector: string) => Iterable<{
    getBoundingClientRect: () => {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  }>;
};

export function collectShellHitRegions(root: MeasurableRoot): ShellHitRegion[] {
  const regions: ShellHitRegion[] = [];
  for (const element of root.querySelectorAll(SHELL_HIT_REGION_SELECTOR)) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    regions.push({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  }
  return regions;
}

export function browserNativeVisible({
  isActive,
  underlayEnabled,
  shellOverlayActive,
}: {
  isActive: boolean;
  underlayEnabled: boolean;
  shellOverlayActive: boolean;
}): boolean {
  return isActive && (underlayEnabled || !shellOverlayActive);
}

export function browserPaneShowsUnderlay({
  underlayEnabled,
  hasUrl,
  nativeVisible,
  visible,
}: {
  underlayEnabled: boolean;
  hasUrl: boolean;
  nativeVisible: boolean;
  visible: boolean;
}): boolean {
  return underlayEnabled && hasUrl && nativeVisible && visible;
}

export function browserPaneNeedsHandoffCover({
  underlayEnabled,
  isBrowser,
  activePaneId,
  settledPaneId,
}: {
  underlayEnabled: boolean;
  isBrowser: boolean;
  activePaneId: string;
  settledPaneId: string | null;
}): boolean {
  return (
    underlayEnabled &&
    isBrowser &&
    activePaneId !== settledPaneId
  );
}
