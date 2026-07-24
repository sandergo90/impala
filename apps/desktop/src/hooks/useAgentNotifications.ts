import { useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@/lib/invoke";
import {
  canSendNotifications,
  getNotificationPermissionStatus,
} from "@/lib/notification-permissions";
import { useUIStore } from "../store";
import { useMountEffect } from "./useMountEffect";

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
  // worktree_path → automation name, set by automation-run-completed just
  // before the same Stop event's agent-status idle arrives. Lets the idle
  // notification say which automation finished instead of the generic copy.
  const automationCompletionsRef = useRef(new Map<string, string>());

  useMountEffect(() => {
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
  });

  useMountEffect(() => {
    const unlisten = listen<{
      worktree_path: string;
      automation_name: string;
    }>("automation-run-completed", (event) => {
      automationCompletionsRef.current.set(
        event.payload.worktree_path,
        event.payload.automation_name,
      );
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  });

  useMountEffect(() => {
    const unlisten = listen<{ worktree_path: string; status: string }>(
      "agent-status",
      async (event) => {
        const { worktree_path, status } = event.payload;
        if (status !== "idle" && status !== "permission") return;

        const automationName =
          status === "idle"
            ? automationCompletionsRef.current.get(worktree_path)
            : undefined;
        automationCompletionsRef.current.delete(worktree_path);

        const selectedWorktree = useUIStore.getState().selectedWorktree;
        if (windowFocusedRef.current && selectedWorktree?.path === worktree_path) {
          return; // Suppress — user is already looking at this worktree
        }

        const worktreeName = worktree_path.split("/").pop() ?? worktree_path;
        const projectName = useUIStore.getState().selectedProject?.name ?? "Impala";

        const isPermission = status === "permission";
        const title = isPermission
          ? `Input Needed — ${projectName}`
          : automationName
            ? `Automation Complete — ${projectName}`
            : `Agent Complete — ${projectName}`;
        const body = isPermission
          ? `"${worktreeName}" needs your attention`
          : automationName
            ? `"${automationName}" finished — diff ready to review`
            : `"${worktreeName}" has finished its task`;

        try {
          const permission = await getNotificationPermissionStatus();
          if (canSendNotifications(permission)) {
            await invoke("send_notification", { title, body });
          }
        } catch (error) {
          console.warn("Failed to send notification:", error);
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
  });
}
