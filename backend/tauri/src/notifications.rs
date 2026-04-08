use std::path::PathBuf;
use tauri::Manager;

/// Resolve the path to a bundled sound file.
fn resolve_sound_path(app_handle: &tauri::AppHandle, sound_id: &str) -> Result<PathBuf, String> {
    let filename = format!("{}.mp3", sound_id);
    app_handle
        .path()
        .resolve(format!("sounds/{}", filename), tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("Failed to resolve sound path: {}", e))
}

#[tauri::command]
pub async fn play_notification_sound(
    app_handle: tauri::AppHandle,
    sound_id: String,
) -> Result<(), String> {
    let path = resolve_sound_path(&app_handle, &sound_id)?;
    if !path.exists() {
        return Err(format!("Sound file not found: {}", path.display()));
    }

    tokio::task::spawn_blocking(move || {
        std::process::Command::new("afplay")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to play sound: {}", e))?;
        // spawn() returns immediately — don't wait for playback to finish
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}
