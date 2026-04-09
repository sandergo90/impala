use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct ProjectConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run: Option<String>,
}

fn config_path(project_path: &str) -> std::path::PathBuf {
    Path::new(project_path).join(".impala").join("config.json")
}

#[tauri::command]
pub fn read_project_config(project_path: String) -> Result<ProjectConfig, String> {
    let path = config_path(&project_path);
    if !path.exists() {
        return Ok(ProjectConfig::default());
    }
    let contents = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read config: {}", e))?;
    serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse config: {}", e))
}

#[tauri::command]
pub fn write_project_config(project_path: String, config: ProjectConfig) -> Result<(), String> {
    let path = config_path(&project_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create .impala directory: {}", e))?;
    }
    let contents = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&path, contents)
        .map_err(|e| format!("Failed to write config: {}", e))
}
