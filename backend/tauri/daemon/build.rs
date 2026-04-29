use std::fs;

fn main() {
    // Forward SENTRY_DSN from the project `.env` to the compiler so
    // option_env!("SENTRY_DSN") in observability.rs resolves correctly
    // even when cargo is invoked from a shell that has not sourced .env
    // (e.g. tauri dev's BeforeDevCommand chains through to a cargo run
    // for the host that may rebuild this workspace member without the
    // env). Same pattern as backend/tauri/build.rs.
    forward_env_var("../../../.env", "SENTRY_DSN");
    println!("cargo:rerun-if-changed=../../../.env");
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
