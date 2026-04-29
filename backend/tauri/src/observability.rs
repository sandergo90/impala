//! Process-wide observability: tracing-subscriber + Sentry.
//!
//! Call [`init`] exactly once, FIRST THING in `run()`, before
//! `tauri::Builder::default()`. The returned `Guard` must be kept
//! alive for the entire program lifetime — drop it on shutdown to
//! flush pending Sentry events and close the file appender.

use std::path::PathBuf;

use sentry::integrations::tracing as sentry_tracing;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, EnvFilter};

const RUNTIME_TAG: &str = "tauri-host";
const RELEASE_NAME: &str = concat!("impala@", env!("CARGO_PKG_VERSION"));

/// DSN baked at compile time from the project `.env`. When absent (e.g.
/// a contributor builds without a DSN), Sentry init is skipped and the
/// file/stderr layers still work.
const SENTRY_DSN: Option<&str> = option_env!("SENTRY_DSN");

/// Holds the resources whose Drop flushes telemetry. Keep alive for
/// the full process lifetime (own it from `run()`).
pub struct Guard {
    pub sentry: Option<sentry::ClientInitGuard>,
    _file_appender: tracing_appender::non_blocking::WorkerGuard,
}

/// Initialise process-wide observability. Returns a guard that must
/// outlive everything else in the process.
pub fn init() -> Guard {
    let session_id = ensure_session_id();
    let log_dir = log_dir_for_bundle("be.kodeus.impala");
    std::fs::create_dir_all(&log_dir).ok();

    // Daily-rotated JSON file appender, non-blocking writer thread.
    let file_appender = tracing_appender::rolling::daily(&log_dir, "impala.log");
    let (file_writer, file_guard) = tracing_appender::non_blocking(file_appender);

    // Sentry: errors + Sentry Logs + tracing spans. Skip when no DSN.
    let sentry_guard = SENTRY_DSN
        .filter(|dsn| !dsn.is_empty())
        .map(|dsn| {
            let release_for_init = RELEASE_NAME.to_string();
            sentry::init((
                dsn,
                sentry::ClientOptions {
                    release: Some(release_for_init.into()),
                    environment: Some(environment().into()),
                    traces_sample_rate: traces_sample_rate(),
                    attach_stacktrace: true,
                    send_default_pii: false,
                    ..Default::default()
                },
            ))
        });

    if sentry_guard.is_some() {
        sentry::configure_scope(|scope| {
            scope.set_tag("runtime", RUNTIME_TAG);
            scope.set_tag("session_id", &session_id);
        });
    }

    // Compose the subscriber. Order matters: stderr last so it doesn't
    // swallow events the other layers want.
    let env_filter = EnvFilter::try_from_default_env()
        .or_else(|_| EnvFilter::try_new("info,impala=debug,impala_lib=debug"))
        .unwrap();

    let file_layer = fmt::layer()
        .with_writer(file_writer)
        .with_ansi(false)
        .json();

    let stderr_layer = fmt::layer()
        .with_writer(std::io::stderr)
        .with_target(true)
        .compact();

    let sentry_layer = sentry_tracing::layer().event_filter(|md| {
        // ERROR -> Sentry Event (issue), INFO/WARN -> Sentry Log,
        // DEBUG/TRACE -> breadcrumb only.
        match *md.level() {
            tracing::Level::ERROR => sentry_tracing::EventFilter::Event,
            tracing::Level::WARN | tracing::Level::INFO => sentry_tracing::EventFilter::Log,
            _ => sentry_tracing::EventFilter::Breadcrumb,
        }
    });

    tracing_subscriber::registry()
        .with(env_filter)
        .with(file_layer)
        .with(stderr_layer)
        .with(sentry_layer)
        .init();

    tracing::info!(
        runtime = RUNTIME_TAG,
        release = RELEASE_NAME,
        session_id = %session_id,
        log_dir = %log_dir.display(),
        "observability initialised"
    );

    Guard {
        sentry: sentry_guard,
        _file_appender: file_guard,
    }
}

/// Reads `IMPALA_SESSION_ID` if set (so spawned children inherit the
/// same session), otherwise mints a new UUID v4 and stores it back
/// into the env so the same value flows to children spawned later.
fn ensure_session_id() -> String {
    if let Ok(existing) = std::env::var("IMPALA_SESSION_ID") {
        if !existing.is_empty() {
            return existing;
        }
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    // SAFETY: setting env before any thread that reads it is created.
    // run() is on the main thread and this call precedes any spawn().
    std::env::set_var("IMPALA_SESSION_ID", &id);
    id
}

#[cfg(target_os = "macos")]
fn log_dir_for_bundle(bundle_id: &str) -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("Library")
        .join("Logs")
        .join(bundle_id)
}

#[cfg(not(target_os = "macos"))]
fn log_dir_for_bundle(bundle_id: &str) -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(bundle_id)
        .join("logs")
}

fn environment() -> &'static str {
    if cfg!(debug_assertions) { "dev" } else { "production" }
}

fn traces_sample_rate() -> f32 {
    if cfg!(debug_assertions) { 1.0 } else { 0.1 }
}
