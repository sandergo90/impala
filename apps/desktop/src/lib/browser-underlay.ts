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
