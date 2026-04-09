use serde::{Deserialize, Serialize};

/// User overrides keyed by HotkeyId. Values are either a custom binding string
/// or null (explicitly unassigned).
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct HotkeyOverrides {
    #[serde(flatten)]
    pub overrides: std::collections::HashMap<String, Option<String>>,
}

use crate::settings;
use crate::DbState;

#[tauri::command]
pub fn read_hotkey_overrides(state: tauri::State<'_, DbState>) -> Result<HotkeyOverrides, String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    match settings::get_setting(&conn, "hotkeyOverrides", "global")? {
        Some(json) => serde_json::from_str(&json)
            .map_err(|e| format!("Failed to parse hotkey overrides: {}", e)),
        None => Ok(HotkeyOverrides::default()),
    }
}

#[tauri::command]
pub fn write_hotkey_overrides(
    state: tauri::State<'_, DbState>,
    overrides: HotkeyOverrides,
) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| format!("DB lock error: {}", e))?;
    let json = serde_json::to_string(&overrides)
        .map_err(|e| format!("Failed to serialize hotkey overrides: {}", e))?;
    settings::set_setting(&conn, "hotkeyOverrides", "global", &json)
}
