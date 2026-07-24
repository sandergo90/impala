import { invoke } from "@/lib/invoke";

export type NotificationAuthorizationStatus =
  | "not_determined"
  | "denied"
  | "authorized"
  | "provisional"
  | "ephemeral"
  | "unsupported";

export interface NotificationPermissionStatus {
  authorization: NotificationAuthorizationStatus;
  alerts_enabled: boolean;
}

export function getNotificationPermissionStatus() {
  return invoke<NotificationPermissionStatus>(
    "get_notification_permission_status",
  );
}

export function requestNotificationPermission() {
  return invoke<NotificationPermissionStatus>(
    "request_notification_permission",
  );
}

export function openNotificationSettings() {
  return invoke<void>("open_notification_settings");
}

export function canSendNotifications(
  status: NotificationPermissionStatus,
): boolean {
  return (
    status.alerts_enabled &&
    (status.authorization === "authorized" ||
      status.authorization === "provisional" ||
      status.authorization === "ephemeral")
  );
}
