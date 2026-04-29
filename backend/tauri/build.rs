use std::fs;
use std::path::Path;

fn main() {
    // Embed the bundled pty-daemon's version so the host can detect a
    // stale daemon (older app version still running) at startup and
    // respawn the new binary. Read from the workspace member's manifest.
    let daemon_manifest = Path::new("daemon/Cargo.toml");
    let raw = fs::read_to_string(daemon_manifest)
        .expect("read backend/tauri/daemon/Cargo.toml");
    let parsed: toml::Value = toml::from_str(&raw)
        .expect("parse backend/tauri/daemon/Cargo.toml");
    let version = parsed
        .get("package")
        .and_then(|p| p.get("version"))
        .and_then(|v| v.as_str())
        .expect("package.version in daemon/Cargo.toml");
    println!("cargo:rustc-env=BUNDLED_DAEMON_VERSION={version}");
    println!("cargo:rerun-if-changed=daemon/Cargo.toml");

    // Forward SENTRY_DSN from the project `.env` to the compiler so
    // option_env!("SENTRY_DSN") resolves correctly even when the shell
    // running cargo (e.g. tauri dev) has not sourced .env. Without this,
    // Sentry init silently disables itself in dev because the macro
    // evaluates to None at compile time.
    forward_env_var("../../.env", "SENTRY_DSN");
    println!("cargo:rerun-if-changed=../../.env");

    tauri_build::build();
}

fn forward_env_var(env_path: &str, key: &str) {
    let Ok(contents) = fs::read_to_string(env_path) else { return };
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        if k.trim() == key {
            let value = v.trim().trim_matches('"').trim_matches('\'');
            println!("cargo:rustc-env={key}={value}");
            return;
        }
    }
}
