use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

/// User overrides keyed by HotkeyId. Values are either a custom binding string
/// or null (explicitly unassigned).
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct HotkeyOverrides {
    #[serde(flatten)]
    pub overrides: std::collections::HashMap<String, Option<String>>,
}

fn hotkeys_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    Ok(dir.join("hotkeys.json"))
}

#[tauri::command]
pub fn read_hotkey_overrides(app: tauri::AppHandle) -> Result<HotkeyOverrides, String> {
    let path = hotkeys_path(&app)?;
    if !path.exists() {
        return Ok(HotkeyOverrides::default());
    }
    let contents =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read hotkeys: {}", e))?;
    serde_json::from_str(&contents).map_err(|e| format!("Failed to parse hotkeys: {}", e))
}

#[tauri::command]
pub fn write_hotkey_overrides(
    app: tauri::AppHandle,
    overrides: HotkeyOverrides,
) -> Result<(), String> {
    let path = hotkeys_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create app data dir: {}", e))?;
    }
    let contents = serde_json::to_string_pretty(&overrides)
        .map_err(|e| format!("Failed to serialize hotkeys: {}", e))?;
    fs::write(&path, contents).map_err(|e| format!("Failed to write hotkeys: {}", e))
}
