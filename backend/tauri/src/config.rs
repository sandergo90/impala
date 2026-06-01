use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Action {
    pub id: String,
    pub name: String,
    pub script: String,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct ProjectConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub teardown: Option<String>,
    #[serde(default)]
    pub actions: Vec<Action>,
}

/// Pre-Actions config shape. Used only at read time to detect and migrate the
/// legacy `run` field.
#[derive(Debug, Deserialize)]
struct LegacyProjectConfig {
    #[serde(default)]
    setup: Option<String>,
    #[serde(default)]
    teardown: Option<String>,
    #[serde(default)]
    run: Option<String>,
    #[serde(default)]
    actions: Option<Vec<Action>>,
}

fn config_path(project_path: &str) -> std::path::PathBuf {
    Path::new(project_path).join(".impala").join("config.json")
}

fn new_action_id() -> String {
    format!("act_{}", Uuid::new_v4().simple())
}

fn write_config_to_disk(path: &Path, config: &ProjectConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create .impala directory: {}", e))?;
    }
    let contents = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(path, contents).map_err(|e| format!("Failed to write config: {}", e))
}

#[tauri::command]
pub fn read_project_config(project_path: String) -> Result<ProjectConfig, String> {
    let path = config_path(&project_path);
    if !path.exists() {
        return Ok(ProjectConfig::default());
    }
    let contents =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read config: {}", e))?;

    let legacy: LegacyProjectConfig =
        serde_json::from_str(&contents).map_err(|e| format!("Failed to parse config: {}", e))?;

    // If the file already has actions[], use it directly. Otherwise convert a
    // legacy `run` field into actions[0] and rewrite to disk so the legacy
    // shape disappears forever after this read.
    let mut migrated = false;
    let actions = match legacy.actions {
        Some(existing) => existing,
        None => {
            let mut acts = Vec::new();
            if let Some(run) = legacy.run.as_ref() {
                let trimmed = run.trim();
                if !trimmed.is_empty() {
                    acts.push(Action {
                        id: new_action_id(),
                        name: "Run".to_string(),
                        script: run.clone(),
                    });
                    migrated = true;
                }
            }
            acts
        }
    };

    let config = ProjectConfig {
        setup: legacy.setup,
        teardown: legacy.teardown,
        actions,
    };

    if migrated {
        // Best-effort migration write. If it fails (read-only fs, etc.) we
        // still return the migrated value to the caller — the next write
        // from the settings page will persist the new shape.
        let _ = write_config_to_disk(&path, &config);
    }

    Ok(config)
}

#[tauri::command]
pub fn write_project_config(project_path: String, config: ProjectConfig) -> Result<(), String> {
    let path = config_path(&project_path);
    write_config_to_disk(&path, &config)
}
