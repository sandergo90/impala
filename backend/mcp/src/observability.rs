//! tracing + Sentry init for impala-mcp.
//! STDOUT is reserved for JSON-RPC. fmt layer writes to STDERR.

use std::path::PathBuf;

use sentry::integrations::tracing as sentry_tracing;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, EnvFilter};

const RUNTIME_TAG: &str = "mcp-sidecar";
const RELEASE_NAME: &str = concat!("impala@", env!("CARGO_PKG_VERSION"));
const SENTRY_DSN: Option<&str> = option_env!("SENTRY_DSN");

pub struct Guard {
    _sentry: Option<sentry::ClientInitGuard>,
    _file_appender: tracing_appender::non_blocking::WorkerGuard,
}

pub fn init() -> Guard {
    let session_id = uuid::Uuid::new_v4().simple().to_string();
    let log_dir = log_dir();
    std::fs::create_dir_all(&log_dir).ok();

    let file_appender = tracing_appender::rolling::daily(&log_dir, "impala-mcp.log");
    let (file_writer, file_guard) = tracing_appender::non_blocking(file_appender);

    let sentry_guard = SENTRY_DSN
        .filter(|dsn| !dsn.is_empty())
        .map(|dsn| {
            sentry::init((
                dsn,
                sentry::ClientOptions {
                    release: Some(RELEASE_NAME.into()),
                    environment: Some(environment().into()),
                    traces_sample_rate: traces_sample_rate(),
                    attach_stacktrace: true,
                    send_default_pii: false,
                    enable_logs: true,
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

    let env_filter = EnvFilter::try_from_default_env()
        .or_else(|_| EnvFilter::try_new("info,impala_mcp=debug"))
        .unwrap();

    // CRITICAL: stderr, not stdout. MCP protocol uses stdout.
    let stderr_layer = fmt::layer()
        .with_writer(std::io::stderr)
        .with_target(true)
        .compact();

    let file_layer = fmt::layer()
        .with_writer(file_writer)
        .with_ansi(false)
        .json();

    let sentry_layer = sentry_tracing::layer().event_filter(|md| match *md.level() {
        tracing::Level::ERROR => sentry_tracing::EventFilter::Event,
        tracing::Level::WARN | tracing::Level::INFO => sentry_tracing::EventFilter::Log,
        _ => sentry_tracing::EventFilter::Breadcrumb,
    });

    tracing_subscriber::registry()
        .with(env_filter)
        .with(stderr_layer)
        .with(file_layer)
        .with(sentry_layer)
        .init();

    tracing::info!(
        runtime = RUNTIME_TAG,
        release = RELEASE_NAME,
        session_id = %session_id,
        log_dir = %log_dir.display(),
        sentry_enabled = sentry_guard.is_some(),
        "mcp observability initialised"
    );

    Guard {
        _sentry: sentry_guard,
        _file_appender: file_guard,
    }
}

#[cfg(target_os = "macos")]
fn log_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("Library")
        .join("Logs")
        .join("be.kodeus.impala")
}

#[cfg(not(target_os = "macos"))]
fn log_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("be.kodeus.impala")
        .join("logs")
}

fn environment() -> &'static str {
    if cfg!(debug_assertions) { "dev" } else { "production" }
}

fn traces_sample_rate() -> f32 {
    if cfg!(debug_assertions) { 1.0 } else { 0.1 }
}
