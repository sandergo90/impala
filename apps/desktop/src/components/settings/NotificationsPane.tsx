import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Bell,
  BellOff,
  CheckCircle2,
  ExternalLink,
  LoaderCircle,
} from "lucide-react";
import { invoke } from "@/lib/invoke";
import {
  canSendNotifications,
  getNotificationPermissionStatus,
  openNotificationSettings,
  requestNotificationPermission,
  type NotificationPermissionStatus,
} from "@/lib/notification-permissions";
import { useUIStore } from "../../store";
import {
  NOTIFICATION_SOUNDS,
  playNotificationSound,
} from "../../hooks/useAgentNotifications";
import { useMountEffect } from "../../hooks/useMountEffect";
import { Button } from "../ui/button";

type PendingAction = "permission" | "test" | null;

function permissionDescription(
  permission: NotificationPermissionStatus | null,
): string {
  if (!permission) return "Checking macOS notification settings…";
  if (canSendNotifications(permission)) {
    return permission.authorization === "provisional"
      ? "Notifications are delivered quietly by macOS."
      : "Banners are enabled for agent and automation updates.";
  }
  if (permission.authorization === "not_determined") {
    return "Enable notifications to be alerted when Impala needs your attention.";
  }
  if (permission.authorization === "unsupported") {
    return "Impala could not read the current macOS notification setting.";
  }
  return "Notifications are disabled in macOS System Settings.";
}

export function NotificationsPane() {
  const soundMuted = useUIStore((s) => s.notificationSoundMuted);
  const setSoundMuted = useUIStore((s) => s.setNotificationSoundMuted);
  const selectedSoundId = useUIStore((s) => s.selectedSoundId);
  const setSelectedSoundId = useUIStore((s) => s.setSelectedSoundId);
  const [permission, setPermission] =
    useState<NotificationPermissionStatus | null>(null);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);

  const notificationsEnabled =
    permission !== null && canSendNotifications(permission);
  const permissionNotDetermined =
    permission?.authorization === "not_determined";
  const permissionUnavailable =
    permission?.authorization === "unsupported";

  useMountEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const nextPermission = await getNotificationPermissionStatus();
        if (!cancelled) {
          setPermission(nextPermission);
          setPermissionError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setPermission({
            authorization: "unsupported",
            alerts_enabled: false,
          });
          setPermissionError(String(error));
        }
      }
    };

    void refresh();
    const unlisten = getCurrentWindow().onFocusChanged(({ payload }) => {
      if (payload) void refresh();
    });

    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  });

  async function handlePermissionAction() {
    setPendingAction("permission");
    setPermissionError(null);
    try {
      if (permissionUnavailable) {
        setPermission(await getNotificationPermissionStatus());
      } else if (permissionNotDetermined) {
        setPermission(await requestNotificationPermission());
      } else {
        await openNotificationSettings();
      }
    } catch (error) {
      setPermissionError(String(error));
    } finally {
      setPendingAction(null);
    }
  }

  async function handleTestNotification() {
    setPendingAction("test");
    setPermissionError(null);
    try {
      await invoke("send_notification", {
        title: "Notifications are working",
        body: "Impala will let you know when an agent needs your attention.",
      });
    } catch (error) {
      setPermissionError(String(error));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="max-w-lg">
      <h2 className="text-base font-semibold text-foreground">Notifications</h2>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Choose how Impala gets your attention when an agent finishes or needs
        input.
      </p>

      <section aria-labelledby="desktop-notifications-heading">
        <h3
          id="desktop-notifications-heading"
          className="mb-3 text-sm font-medium"
        >
          Desktop notifications
        </h3>
        <div className="flex items-center gap-3 border-y border-border/70 py-3">
          <div
            className={`flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/50 ${
              notificationsEnabled
                ? "text-success"
                : permissionNotDetermined
                  ? "text-muted-foreground"
                  : "text-destructive"
            }`}
            aria-hidden="true"
          >
            {permission === null ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : notificationsEnabled ? (
              <CheckCircle2 className="size-4" />
            ) : permissionNotDetermined ? (
              <Bell className="size-4" />
            ) : (
              <BellOff className="size-4" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">
              {permission === null
                ? "Checking notification status"
                : notificationsEnabled
                  ? "Notifications are on"
                  : permissionNotDetermined
                    ? "Notifications are not enabled"
                    : "Notifications are off"}
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {permissionDescription(permission)}
            </p>
          </div>

          {permission === null ? null : notificationsEnabled ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestNotification}
                disabled={pendingAction !== null}
              >
                {pendingAction === "test" ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : null}
                Test
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handlePermissionAction}
                disabled={pendingAction !== null}
                aria-label="Open notification settings in macOS System Settings"
                title="Open System Settings"
              >
                <ExternalLink aria-hidden="true" />
              </Button>
            </div>
          ) : (
            <Button
              variant={permissionNotDetermined ? "default" : "outline"}
              size="sm"
              onClick={handlePermissionAction}
              disabled={permission === null || pendingAction !== null}
            >
              {pendingAction === "permission" ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : !permissionNotDetermined && !permissionUnavailable ? (
                <ExternalLink aria-hidden="true" />
              ) : null}
              {permissionNotDetermined
                ? "Enable"
                : permissionUnavailable
                  ? "Retry"
                  : "System Settings"}
            </Button>
          )}
        </div>
        {permissionError ? (
          <p
            className="mt-2 text-sm text-destructive"
            role="status"
            aria-live="polite"
          >
            {permissionError}
          </p>
        ) : null}
      </section>

      <section
        aria-labelledby="notification-sounds-heading"
        className="mt-7"
      >
        <div className="flex items-center justify-between">
          <div>
            <h3
              id="notification-sounds-heading"
              className="text-sm font-medium"
            >
              Notification sounds
            </h3>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Play an Impala sound for agent updates
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={!soundMuted}
            aria-label="Notification sounds"
            onClick={() => setSoundMuted(!soundMuted)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
              !soundMuted ? "bg-primary" : "bg-muted-foreground/30"
            }`}
          >
            <span
              className={`inline-block size-3.5 rounded-full bg-background transition-transform ${
                !soundMuted ? "translate-x-[18px]" : "translate-x-[3px]"
              }`}
            />
          </button>
        </div>

        <fieldset className={`mt-5 ${soundMuted ? "opacity-50" : ""}`}>
          <legend className="mb-3 text-sm font-medium">
            Notification sound
          </legend>
          <div className="space-y-1">
            {NOTIFICATION_SOUNDS.map((sound) => (
              <div
                key={sound.id}
                className={`flex items-center justify-between rounded-md px-3 py-2 transition-colors ${
                  selectedSoundId === sound.id
                    ? "bg-primary/15 text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                <label className="flex flex-1 cursor-pointer items-center gap-3">
                  <input
                    type="radio"
                    name="notification-sound"
                    className="sr-only"
                    checked={selectedSoundId === sound.id}
                    disabled={soundMuted}
                    onChange={() => setSelectedSoundId(sound.id)}
                  />
                  <span
                    className={`flex size-3 items-center justify-center rounded-full border-2 ${
                      selectedSoundId === sound.id
                        ? "border-primary"
                        : "border-muted-foreground/40"
                    }`}
                    aria-hidden="true"
                  >
                    {selectedSoundId === sound.id ? (
                      <span className="size-1.5 rounded-full bg-primary" />
                    ) : null}
                  </span>
                  <span className="text-sm">{sound.name}</span>
                </label>
                <button
                  type="button"
                  onClick={() => playNotificationSound(sound.id)}
                  disabled={soundMuted}
                  className="rounded px-2 py-0.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:pointer-events-none"
                >
                  Preview
                </button>
              </div>
            ))}
          </div>
        </fieldset>
      </section>
    </div>
  );
}
