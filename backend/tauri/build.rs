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

    tauri_build::build();
}
