import { useEffect, useRef, useCallback } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

export function UpdateChecker() {
  const checking = useRef(false);

  const checkForUpdate = useCallback(async (manual = false) => {
    if (checking.current) return;
    checking.current = true;
    try {
      const update = await check();
      if (!update) {
        if (manual) toast("You're on the latest version.");
        return;
      }

      toast(`Update ${update.version} available`, {
        description: update.body || "A new version of Canopy is ready.",
        duration: Infinity,
        action: {
          label: "Install & Restart",
          onClick: async () => {
            const installToast = toast.loading("Downloading update...");
            try {
              let contentLength = 0;
              let downloaded = 0;
              await update.downloadAndInstall((event) => {
                if (event.event === "Started") {
                  contentLength = event.data.contentLength ?? 0;
                } else if (event.event === "Progress" && contentLength > 0) {
                  downloaded += event.data.chunkLength;
                  const pct = Math.round((downloaded / contentLength) * 100);
                  toast.loading(`Downloading update... ${pct}%`, {
                    id: installToast,
                  });
                }
              });
              toast.loading("Restarting...", { id: installToast });
              await relaunch();
            } catch (e) {
              toast.error(`Update failed: ${e}`, { id: installToast });
            }
          },
        },
      });
    } catch (e) {
      if (manual) toast.error(`Update check failed: ${e}`);
    } finally {
      checking.current = false;
    }
  }, []);

  useEffect(() => {
    // Check after a short delay on startup
    const initialTimeout = setTimeout(() => checkForUpdate(false), 5000);
    const interval = setInterval(() => checkForUpdate(false), CHECK_INTERVAL_MS);

    // Listen for manual "Check for Updates" from menu
    const unlisten = listen("check-for-updates", () => checkForUpdate(true));

    return () => {
      clearTimeout(initialTimeout);
      clearInterval(interval);
      unlisten.then((fn) => fn());
    };
  }, [checkForUpdate]);

  return null;
}
