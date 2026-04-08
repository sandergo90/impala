import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
  onAction,
} from "@tauri-apps/plugin-notification";
import { invoke } from "@tauri-apps/api/core";
import { useUIStore, useDataStore } from "../store";
import { selectWorktree } from "./useWorktreeActions";

export const NOTIFICATION_SOUNDS = [
  { id: "chime", name: "Chime" },
  { id: "bell", name: "Bell" },
  { id: "ping", name: "Ping" },
  { id: "tone", name: "Tone" },
] as const;

export function playNotificationSound(soundId: string) {
  invoke("play_notification_sound", { soundId }).catch((err) =>
    console.warn("Failed to play notification sound:", err)
  );
}

export function useAgentNotifications() {
  const windowFocusedRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    const window = getCurrentWindow();

    window.isFocused().then((focused) => {
      if (!cancelled) windowFocusedRef.current = focused;
    });

    const unlisten = window.onFocusChanged(({ payload: focused }) => {
      windowFocusedRef.current = focused;
    });

    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    isPermissionGranted().then((granted) => {
      if (!granted) requestPermission();
    }).catch(() => {
      // Plugin may not be available in dev mode
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unregister: (() => void) | null = null;

    onAction((notification) => {
      const worktreePath = notification.extra?.worktree_path as string | undefined;
      if (!worktreePath) return;

      getCurrentWindow().setFocus();

      const worktree = useDataStore.getState().worktrees.find((wt) => wt.path === worktreePath);
      if (worktree) selectWorktree(worktree);
    }).then((listener) => {
      if (cancelled) {
        listener.unregister();
      } else {
        unregister = () => listener.unregister();
      }
    }).catch(() => {
      // Plugin may not be available in dev mode
    });

    return () => {
      cancelled = true;
      unregister?.();
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<{ worktree_path: string; status: string }>(
      "agent-status",
      async (event) => {
        const { worktree_path, status } = event.payload;
        if (status !== "idle" && status !== "permission") return;

        const selectedWorktree = useUIStore.getState().selectedWorktree;
        if (windowFocusedRef.current && selectedWorktree?.path === worktree_path) {
          return; // Suppress — user is already looking at this worktree
        }

        const worktreeName = worktree_path.split("/").pop() ?? worktree_path;
        const projectName = useUIStore.getState().selectedProject?.name ?? "Canopy";

        const isPermission = status === "permission";
        const title = isPermission
          ? `Input Needed — ${projectName}`
          : `Agent Complete — ${projectName}`;
        const body = isPermission
          ? `"${worktreeName}" needs your attention`
          : `"${worktreeName}" has finished its task`;

        const granted = await isPermissionGranted();
        if (granted) {
          sendNotification({ title, body, extra: { worktree_path } });
        }

        const { notificationSoundMuted, selectedSoundId } = useUIStore.getState();
        if (!notificationSoundMuted) {
          playNotificationSound(selectedSoundId);
        }
      }
    );

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);
}
