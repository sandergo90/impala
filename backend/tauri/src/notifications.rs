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
