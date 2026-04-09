use std::path::PathBuf;
use tauri::Manager;

const VALID_SOUND_IDS: &[&str] = &["chime", "bell", "ping", "tone"];

fn resolve_sound_path(app_handle: &tauri::AppHandle, sound_id: &str) -> Result<PathBuf, String> {
    if !VALID_SOUND_IDS.contains(&sound_id) {
        return Err(format!("Invalid sound ID: {}", sound_id));
    }
    let filename = format!("{}.mp3", sound_id);
    app_handle
        .path()
        .resolve(format!("sounds/{}", filename), tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("Failed to resolve sound path: {}", e))
}

/// Register a minimal .app bundle with Launch Services so macOS can resolve
/// our bundle identifier to an icon for notifications in dev mode.
#[cfg(target_os = "macos")]
pub fn register_notification_icon(app: &tauri::App) {
    if !cfg!(debug_assertions) {
        return;
    }

    let app_dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(_) => return,
    };

    let bundle_dir = app_dir.join("Impala.app").join("Contents");
    let resources_dir = bundle_dir.join("Resources");
    let _ = std::fs::create_dir_all(&resources_dir);

    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>{}</string>
    <key>CFBundleName</key>
    <string>Impala</string>
    <key>CFBundleIconFile</key>
    <string>icon</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
</dict>
</plist>"#,
        app.config().identifier
    );

    let _ = std::fs::write(bundle_dir.join("Info.plist"), plist);
    let _ = std::fs::write(resources_dir.join("icon.icns"), include_bytes!("../icons/icon.icns"));

    // Register with Launch Services so set_application() can find our bundle
    let _ = std::process::Command::new(
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    )
    .arg("-f")
    .arg(app_dir.join("Impala.app"))
    .output();
}

#[tauri::command]
pub async fn send_notification(
    app_handle: tauri::AppHandle,
    title: String,
    body: String,
) -> Result<(), String> {
    let identifier = app_handle.config().identifier.clone();
    tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        let _ = notify_rust::set_application(&identifier);

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
