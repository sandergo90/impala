use std::collections::BTreeSet;
use std::process::Command;

/// List all font family names installed on the system.
///
/// On macOS, uses NSFontManager via osascript (JXA) which returns the exact
/// CSS-compatible family names that WebKit recognises. Falls back to fc-list
/// then to scanning font directories.
#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(|| {
        // Primary: NSFontManager.availableFontFamilies via JXA — gives CSS-compatible names
        if let Some(fonts) = enumerate_via_appkit() {
            if !fonts.is_empty() {
                return Ok(fonts);
            }
        }

        // Fallback: fc-list
        let mut families = BTreeSet::new();
        if let Ok(output) = Command::new("fc-list")
            .args(["--format=%{family[0]}\n"])
            .output()
        {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                for line in text.lines() {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() && !is_hidden_font(trimmed) {
                        families.insert(trimmed.to_string());
                    }
                }
                if !families.is_empty() {
                    return Ok(families.into_iter().collect());
                }
            }
        }

        // Last resort: scan font directories
        let font_dirs = [
            "/System/Library/Fonts".to_string(),
            "/Library/Fonts".to_string(),
            dirs::home_dir()
                .map(|h| h.join("Library/Fonts").to_string_lossy().to_string())
                .unwrap_or_default(),
        ];
        for dir in &font_dirs {
            if !dir.is_empty() {
                scan_font_dir(dir, &mut families);
            }
        }
        Ok(families.into_iter().collect())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Use NSFontManager.availableFontFamilies via osascript (JXA).
/// Returns the exact family names that macOS / WebKit uses for CSS font-family.
fn enumerate_via_appkit() -> Option<Vec<String>> {
    let script = r#"
ObjC.import("AppKit");
const mgr = $.NSFontManager.sharedFontManager;
const arr = mgr.availableFontFamilies;
const result = [];
for (let i = 0; i < arr.count; i++) result.push(arr.objectAtIndex(i).js);
result.join("\n")
"#;

    let output = Command::new("osascript")
        .args(["-l", "JavaScript", "-e", script])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let families: Vec<String> = text
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && !is_hidden_font(l))
        .collect();

    Some(families)
}

fn is_hidden_font(name: &str) -> bool {
    name.starts_with('.') || name == "System Font"
}

fn scan_font_dir(dir: &str, families: &mut BTreeSet<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(sub) = path.to_str() {
                scan_font_dir(sub, families);
            }
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !matches!(ext.as_str(), "ttf" | "otf" | "ttc" | "dfont") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if stem.starts_with('.') {
            continue;
        }
        let family = stem.replace('-', " ").replace('_', " ");
        let family = strip_style_suffix(&family);
        if !family.is_empty() {
            families.insert(family.to_string());
        }
    }
}

fn strip_style_suffix(name: &str) -> &str {
    let suffixes = [
        " Regular",
        " Bold",
        " Italic",
        " BoldItalic",
        " Light",
        " Medium",
        " Thin",
        " Black",
        " ExtraBold",
        " SemiBold",
        " ExtraLight",
        " UltraLight",
        " Heavy",
        " Condensed",
        " Oblique",
    ];
    let mut result = name.trim();
    loop {
        let prev = result;
        for suffix in &suffixes {
            result = result.trim_end_matches(suffix);
        }
        if result == prev {
            break;
        }
    }
    result
}
