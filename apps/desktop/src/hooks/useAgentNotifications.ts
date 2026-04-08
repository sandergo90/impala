import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { invoke } from "@tauri-apps/api/core";
import { useUIStore } from "../store";

export const NOTIFICATION_SOUNDS = [
  { id: "chime", name: "Chime" },
  { id: "bell", name: "Bell" },
  { id: "ping", name: "Ping" },
  { id: "tone", name: "Tone" },
] as const;

export function useAgentNotifications() {
  const windowFocusedRef = useRef(true);

  // Track window focus state
  useEffect(() => {
    let cancelled = false;

    getCurrentWindow().isFocused().then((focused) => {
      if (!cancelled) windowFocusedRef.current = focused;
    });

    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      windowFocusedRef.current = focused;
    });

    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, []);

  // Request notification permission on mount
  useEffect(() => {
    isPermissionGranted().then((granted) => {
      if (!granted) requestPermission();
    });
  }, []);

  // Listen for agent completion
  useEffect(() => {
    const unlisten = listen<{ worktree_path: string; status: string }>(
      "agent-status",
      async (event) => {
        const { worktree_path, status } = event.payload;
        if (status !== "idle") return;

        // Check suppression: window focused AND this worktree is active
        const selectedWorktree = useUIStore.getState().selectedWorktree;
        if (windowFocusedRef.current && selectedWorktree?.path === worktree_path) {
          return; // Suppress — user is already looking at this worktree
        }

        // Extract worktree name from path (last segment)
        const worktreeName = worktree_path.split("/").pop() ?? worktree_path;

        // Send native notification
        const granted = await isPermissionGranted();
        if (granted) {
          sendNotification({
            title: "Agent Complete",
            body: `${worktreeName} has finished`,
          });
        }

        // Play sound
        const { notificationSoundMuted, selectedSoundId } = useUIStore.getState();
        if (!notificationSoundMuted) {
          invoke("play_notification_sound", { soundId: selectedSoundId }).catch(
            (err) => console.warn("Failed to play notification sound:", err)
          );
        }
      }
    );

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);
}
