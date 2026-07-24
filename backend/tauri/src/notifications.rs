use std::path::PathBuf;
use tauri::Manager;

const VALID_SOUND_IDS: &[&str] = &["chime", "bell", "ping", "tone"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationAuthorizationStatus {
    NotDetermined,
    Denied,
    Authorized,
    Provisional,
    Ephemeral,
    Unsupported,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub struct NotificationPermissionStatus {
    authorization: NotificationAuthorizationStatus,
    alerts_enabled: bool,
}

#[cfg(target_os = "macos")]
fn macos_notification_permission_status(
    settings: mac_usernotifications::NotificationSettings,
) -> NotificationPermissionStatus {
    use mac_usernotifications::{AuthorizationStatus, NotificationSettingStatus};

    let authorization = match settings.authorization_status {
        AuthorizationStatus::NotDetermined => NotificationAuthorizationStatus::NotDetermined,
        AuthorizationStatus::Denied => NotificationAuthorizationStatus::Denied,
        AuthorizationStatus::Authorized => NotificationAuthorizationStatus::Authorized,
        AuthorizationStatus::Provisional => NotificationAuthorizationStatus::Provisional,
        AuthorizationStatus::Ephemeral => NotificationAuthorizationStatus::Ephemeral,
        AuthorizationStatus::Unknown => NotificationAuthorizationStatus::Unsupported,
    };

    NotificationPermissionStatus {
        authorization,
        alerts_enabled: settings.alert_enabled == NotificationSettingStatus::Enabled,
    }
}

fn resolve_sound_path(app_handle: &tauri::AppHandle, sound_id: &str) -> Result<PathBuf, String> {
    if !VALID_SOUND_IDS.contains(&sound_id) {
        return Err(format!("Invalid sound ID: {}", sound_id));
    }
    let filename = format!("{}.mp3", sound_id);
    app_handle
        .path()
        .resolve(
            format!("sounds/{}", filename),
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| format!("Failed to resolve sound path: {}", e))
}

#[tauri::command]
pub async fn get_notification_permission_status() -> Result<NotificationPermissionStatus, String> {
    #[cfg(target_os = "macos")]
    {
        let settings = mac_usernotifications::get_notification_settings()
            .await
            .map_err(|error| format!("Failed to read notification settings: {error}"))?;
        return Ok(macos_notification_permission_status(settings));
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(NotificationPermissionStatus {
            authorization: NotificationAuthorizationStatus::Authorized,
            alerts_enabled: true,
        })
    }
}

#[tauri::command]
pub async fn request_notification_permission() -> Result<NotificationPermissionStatus, String> {
    #[cfg(target_os = "macos")]
    {
        mac_usernotifications::request_auth()
            .await
            .map_err(|error| format!("Failed to request notification permission: {error}"))?;
        return get_notification_permission_status().await;
    }

    #[cfg(not(target_os = "macos"))]
    {
        get_notification_permission_status().await
    }
}

#[tauri::command]
pub async fn open_notification_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.Notifications-Settings.extension")
            .status()
            .map_err(|error| format!("Failed to open System Settings: {error}"))?;
        if !status.success() {
            return Err(format!("System Settings exited with status {status}"));
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn send_notification(title: String, body: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        notify_rust::Notification::new()
            .summary(&title)
            .body(&body)
            .show()
            .map_err(|e| format!("Failed to show notification: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn play_notification_sound(
    app_handle: tauri::AppHandle,
    sound_id: String,
) -> Result<(), String> {
    let path = resolve_sound_path(&app_handle, &sound_id)?;

    // spawn_blocking because wait() blocks until playback finishes
    tokio::task::spawn_blocking(move || {
        std::process::Command::new("afplay")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to play sound: {}", e))?
            .wait()
            .map_err(|e| format!("Sound playback error: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use mac_usernotifications::{
        AuthorizationStatus, NotificationSettingStatus, NotificationSettings,
    };

    fn settings(
        authorization_status: AuthorizationStatus,
        alert_enabled: NotificationSettingStatus,
    ) -> NotificationSettings {
        NotificationSettings {
            authorization_status,
            alert_enabled,
            badge_enabled: NotificationSettingStatus::NotSupported,
            sound_enabled: NotificationSettingStatus::NotSupported,
            lock_screen_enabled: NotificationSettingStatus::NotSupported,
            notification_center_enabled: NotificationSettingStatus::NotSupported,
        }
    }

    #[test]
    fn maps_authorized_alerts_to_enabled_status() {
        let status = macos_notification_permission_status(settings(
            AuthorizationStatus::Authorized,
            NotificationSettingStatus::Enabled,
        ));

        assert_eq!(
            status,
            NotificationPermissionStatus {
                authorization: NotificationAuthorizationStatus::Authorized,
                alerts_enabled: true,
            }
        );
    }

    #[test]
    fn keeps_authorization_separate_from_disabled_alerts() {
        let status = macos_notification_permission_status(settings(
            AuthorizationStatus::Authorized,
            NotificationSettingStatus::Disabled,
        ));

        assert_eq!(
            status,
            NotificationPermissionStatus {
                authorization: NotificationAuthorizationStatus::Authorized,
                alerts_enabled: false,
            }
        );
    }
}
