import { invoke } from "@/lib/invoke";
import {
  collectShellHitRegions,
  hasShellOwnedOverlay,
} from "@/lib/browser-underlay";
import { useUIStore } from "@/store";
import { resolveThemeById } from "@/themes/apply";
import { useMountEffect } from "./useMountEffect";

function resolveOpaqueRgb(color: string): {
  red: number;
  green: number;
  blue: number;
} {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || !CSS.supports("color", color)) {
    return { red: 38, green: 38, blue: 36 };
  }
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  return { red, green, blue };
}

/**
 * Connects portalled shell UI, theme state, and drag state to the native
 * hit-test router. One bridge owns the window-level state; individual browser
 * panes only publish their bounds and visibility.
 */
export function useBrowserUnderlayBridge() {
  useMountEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    const initialState = useUIStore.getState();
    const initialTheme = resolveThemeById(
      initialState.activeThemeId,
      initialState.customThemes,
    );
    const initialBackdrop = resolveOpaqueRgb(initialTheme.ui.background);

    const connect = (enabled: boolean) => {
        if (disposed) return;
        useUIStore.getState().setBrowserUnderlayEnabled(enabled);

        if (enabled) {
          document.documentElement.dataset.browserUnderlay = "true";
        }
        const syncBackdrop = () => {
          if (!enabled) return;
          const state = useUIStore.getState();
          const theme = resolveThemeById(
            state.activeThemeId,
            state.customThemes,
          );
          const color = resolveOpaqueRgb(theme.ui.background);
          invoke("browser_set_underlay_backdrop", {
            ...color,
          }).catch((error) => {
            console.warn(
              "[impala] failed to update browser underlay backdrop",
              error,
            );
          });
        };
        const syncOverlayOwnership = () => {
          const state = useUIStore.getState();
          const active =
            state.commandPaletteOpen ||
            state.fileFinderOpen ||
            state.terminalMenuOpen ||
            state.panelDragActive ||
            hasShellOwnedOverlay(document);
          state.setBrowserShellOverlayActive(active);
          if (enabled) {
            invoke("browser_set_overlay_active", { active }).catch(() => {});
          }
        };

        // Toasts float over browser panes without occluding them, so instead
        // of hiding the native view their rectangles are published to the
        // hit-test router. Sent only on change; the interval catches
        // animation/stack-expansion moves that mutate no observed attribute.
        let lastShellRegions = "";
        const syncShellRegions = () => {
          if (!enabled) return;
          const regions = collectShellHitRegions(document);
          const serialized = JSON.stringify(regions);
          if (serialized === lastShellRegions) return;
          lastShellRegions = serialized;
          invoke("browser_set_shell_regions", { regions }).catch(() => {});
        };
        const shellRegionInterval = enabled
          ? setInterval(syncShellRegions, 500)
          : undefined;

        const observer = new MutationObserver(() => {
          syncOverlayOwnership();
          syncShellRegions();
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["role", "data-state"],
        });
        const unsubscribe = useUIStore.subscribe((state, previous) => {
          if (
            state.commandPaletteOpen !== previous.commandPaletteOpen ||
            state.fileFinderOpen !== previous.fileFinderOpen ||
            state.terminalMenuOpen !== previous.terminalMenuOpen ||
            state.panelDragActive !== previous.panelDragActive
          ) {
            syncOverlayOwnership();
          }
          if (
            state.activeThemeId !== previous.activeThemeId ||
            state.customThemes !== previous.customThemes
          ) {
            syncBackdrop();
          }
        });
        syncBackdrop();
        syncOverlayOwnership();
        syncShellRegions();

        cleanup = () => {
          observer.disconnect();
          unsubscribe();
          if (shellRegionInterval !== undefined) {
            clearInterval(shellRegionInterval);
          }
          if (enabled) {
            invoke("browser_set_overlay_active", { active: false }).catch(
              () => {},
            );
            invoke("browser_set_shell_regions", { regions: [] }).catch(
              () => {},
            );
          }
          delete document.documentElement.dataset.browserUnderlay;
          const state = useUIStore.getState();
          state.setBrowserUnderlayEnabled(false);
          state.setBrowserShellOverlayActive(false);
        };
    };

    invoke<boolean>("browser_underlay_enabled", initialBackdrop)
      .then(connect)
      .catch((error) => {
        console.warn("[impala] failed to configure browser underlay", error);
        connect(false);
      });

    return () => {
      disposed = true;
      cleanup();
    };
  });
}
