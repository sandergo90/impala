use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;
use tungstenite::{client, Message, WebSocket};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const WORKER_POLL_TIMEOUT: Duration = Duration::from_millis(100);
/// Bounded pagination prevents a malformed server cursor from blocking the UI.
/// Raise this cap only with protocol coverage for the larger catalog.
const DIAGNOSTICS_MAX_PAGES: usize = 20;
const MODEL_CATALOG_TTL: Duration = Duration::from_secs(5);
const DAEMON_SOCKET: &str = "app-server-control/app-server-control.sock";
static DAEMON_LAUNCH_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerSnapshot {
    pub connection: CodexAppServerConnectionSnapshot,
    pub threads: Vec<CodexAppServerThreadSnapshot>,
    /// Raw protocol envelopes are intentionally retained for forwards compatibility.
    pub recent_events: Vec<Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerConnectionSnapshot {
    pub status: String,
    pub version: Option<Value>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerThreadSnapshot {
    pub thread_id: String,
    pub status: Option<String>,
    pub active_turn: Option<String>,
    pub pending_server_requests: Vec<CodexAppServerServerRequest>,
    pub event_sequence: u64,
    pub last_error: Option<String>,
    pub last_event: Option<Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexDiagnostics {
    pub connection: CodexDiagnosticsConnection,
    pub account: DiagnosticsSection<DiagnosticsAccount>,
    pub rate_limits: DiagnosticsSection<DiagnosticsRateLimits>,
    pub models: DiagnosticsSection<DiagnosticsModels>,
    pub config: DiagnosticsSection<DiagnosticsConfig>,
    pub mcp: DiagnosticsSection<DiagnosticsMcp>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSection<T> {
    pub data: Option<T>,
    pub error: Option<String>,
    pub truncated: bool,
}

impl<T> DiagnosticsSection<T> {
    fn success(data: T, truncated: bool) -> Self {
        Self { data: Some(data), error: None, truncated }
    }

    fn failure(error: String) -> Self {
        Self { data: None, error: Some(error), truncated: false }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexDiagnosticsConnection {
    pub status: String,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsAccount {
    pub account_type: Option<String>,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub requires_openai_auth: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsRateLimits {
    pub primary_used_percent: Option<i64>,
    pub secondary_used_percent: Option<i64>,
    pub resets_at: Option<i64>,
    pub reached: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsModels {
    pub default_model: Option<String>,
    pub models: Vec<DiagnosticsModel>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsModel {
    pub id: String,
    pub efforts: Vec<String>,
    pub tiers: Vec<String>,
    pub modalities: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsConfig {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub service_tier: Option<String>,
    pub approval_policy: Option<String>,
    pub sandbox: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsMcp {
    pub impala_mcp_present: bool,
    pub impala_mcp_unhealthy_reason: Option<String>,
    pub servers: Vec<DiagnosticsMcpServer>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsMcpServer {
    pub name: String,
    pub auth_status: Option<String>,
    pub tool_count: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ModelCatalogEntry {
    pub id: String,
    pub is_default: bool,
    pub efforts: Vec<String>,
    pub tiers: Vec<String>,
    pub modalities: Vec<String>,
}

#[derive(Clone)]
struct CachedModelCatalog {
    fetched_at: Instant,
    catalog: Vec<ModelCatalogEntry>,
    truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerServerRequest {
    pub request_id: Value,
    pub method: String,
    pub params: Value,
    pub thread_id: Option<String>,
}

#[derive(Default)]
struct AppServerSnapshotState {
    connection: ConnectionState,
    threads: HashMap<String, ThreadState>,
    recent_events: Vec<Value>,
}

#[derive(Default)]
struct ConnectionState {
    status: String,
    version: Option<Value>,
    last_error: Option<String>,
}

#[derive(Default)]
struct ThreadState {
    status: Option<String>,
    active_turn: Option<String>,
    pending_server_requests: Vec<CodexAppServerServerRequest>,
    event_sequence: u64,
    last_error: Option<String>,
    last_event: Option<Value>,
}

impl AppServerSnapshotState {
    fn snapshot(&self) -> CodexAppServerSnapshot {
        let mut threads = self
            .threads
            .iter()
            .map(|(thread_id, state)| CodexAppServerThreadSnapshot {
                thread_id: thread_id.clone(),
                status: state.status.clone(),
                active_turn: state.active_turn.clone(),
                pending_server_requests: state.pending_server_requests.clone(),
                event_sequence: state.event_sequence,
                last_error: state.last_error.clone(),
                last_event: state.last_event.clone(),
            })
            .collect::<Vec<_>>();
        threads.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
        CodexAppServerSnapshot {
            connection: CodexAppServerConnectionSnapshot {
                status: self.connection.status.clone(),
                version: self.connection.version.clone(),
                last_error: self.connection.last_error.clone(),
            },
            threads,
            recent_events: self.recent_events.clone(),
        }
    }

    fn record_event(&mut self, event: Value, thread_id: Option<&str>) {
        // Bounded only in memory; persistent event history is a later-pane concern.
        if self.recent_events.len() == 100 {
            self.recent_events.remove(0);
        }
        self.recent_events.push(event.clone());
        if let Some(thread_id) = thread_id.filter(|id| self.threads.contains_key(*id)) {
            let thread = self.threads.get_mut(thread_id).expect("checked above");
            thread.event_sequence += 1;
            thread.last_event = Some(event);
        }
    }

    fn apply_thread_value(&mut self, value: &Value, fallback_thread_id: Option<&str>) {
        let thread = value.get("thread").unwrap_or(value);
        let thread_id = thread
            .get("id")
            .and_then(Value::as_str)
            .or(fallback_thread_id);
        let Some(thread_id) = thread_id.filter(|id| self.threads.contains_key(*id)) else {
            return;
        };
        let state = self.threads.get_mut(thread_id).expect("checked above");
        if let Some(status) = thread.get("status").and_then(Value::as_str) {
            state.status = Some(status.to_string());
        }
        if let Some(turn_id) = thread
            .get("activeTurn")
            .and_then(|turn| turn.get("id").or(Some(turn)))
            .and_then(Value::as_str)
        {
            state.active_turn = Some(turn_id.to_string());
        }
    }
}

#[derive(Clone)]
pub struct CodexAppServerState {
    sender: mpsc::Sender<WorkerCommand>,
    snapshot: Arc<Mutex<AppServerSnapshotState>>,
    model_catalog: Arc<Mutex<Option<CachedModelCatalog>>>,
}

#[allow(dead_code)] // Phase 1 calls these typed dispatch paths.
enum WorkerCommand {
    Request {
        method: String,
        params: Value,
        reply: mpsc::Sender<Result<Value, String>>,
    },
    RespondToServerRequest {
        request_id: Value,
        result: Option<Value>,
        error: Option<Value>,
        reply: mpsc::Sender<Result<(), String>>,
    },
}

struct PendingCall {
    method: String,
    params: Value,
    reply: mpsc::Sender<Result<Value, String>>,
}

#[allow(dead_code)] // Phase 1 calls these typed dispatch paths.
impl CodexAppServerState {
    pub fn new(app: tauri::AppHandle) -> Self {
        let (sender, receiver) = mpsc::channel();
        let snapshot = Arc::new(Mutex::new(AppServerSnapshotState {
            connection: ConnectionState {
                status: "offline".to_string(),
                ..ConnectionState::default()
            },
            ..AppServerSnapshotState::default()
        }));
        let worker_snapshot = snapshot.clone();
        std::thread::spawn(move || app_server_worker(receiver, worker_snapshot, app));
        Self { sender, snapshot, model_catalog: Arc::new(Mutex::new(None)) }
    }

    pub fn snapshot(&self) -> Result<CodexAppServerSnapshot, String> {
        self.snapshot
            .lock()
            .map(|state| state.snapshot())
            .map_err(|_| "Codex app-server state lock poisoned".to_string())
    }

    /// Restore only durable Impala ownership. This never subscribes to an
    /// arbitrary Codex thread; recovery callers must provide DB-owned ids.
    pub fn adopt_thread(&self, thread_id: &str) -> Result<(), String> {
        if thread_id.trim().is_empty() {
            return Err("Codex app-server thread id is empty".to_string());
        }
        self.snapshot
            .lock()
            .map_err(|_| "Codex app-server state lock poisoned".to_string())?
            .threads
            .entry(thread_id.to_string())
            .or_default();
        Ok(())
    }

    /// The generic protocol seam for later native-pane and automation phases.
    pub fn dispatch(&self, method: &str, params: Value) -> Result<Value, String> {
        let (reply_sender, reply_receiver) = mpsc::channel();
        self.sender
            .send(WorkerCommand::Request {
                method: method.to_string(),
                params,
                reply: reply_sender,
            })
            .map_err(|_| "Codex app-server worker stopped".to_string())?;
        reply_receiver
            .recv_timeout(REQUEST_TIMEOUT + REQUEST_TIMEOUT)
            .map_err(|_| "Codex app-server request timed out".to_string())?
    }

    pub fn thread_start(&self, params: Value) -> Result<Value, String> {
        self.dispatch("thread/start", params)
    }

    pub fn thread_read(&self, thread_id: &str) -> Result<Value, String> {
        self.ensure_owned_thread(thread_id)?;
        self.dispatch(
            "thread/read",
            json!({ "threadId": thread_id, "includeTurns": true }),
        )
    }

    pub fn thread_resume(&self, thread_id: &str) -> Result<Value, String> {
        self.ensure_owned_thread(thread_id)?;
        self.dispatch("thread/resume", json!({ "threadId": thread_id }))
    }

    pub fn turn_start(&self, thread_id: &str, params: Value) -> Result<Value, String> {
        self.ensure_owned_thread(thread_id)?;
        let mut params = params;
        params["threadId"] = Value::String(thread_id.to_string());
        self.dispatch("turn/start", params)
    }

    pub fn turn_interrupt(&self, thread_id: &str, turn_id: &str) -> Result<Value, String> {
        self.ensure_owned_thread(thread_id)?;
        self.dispatch(
            "turn/interrupt",
            json!({ "threadId": thread_id, "turnId": turn_id }),
        )
    }

    pub fn turn_steer(
        &self,
        thread_id: &str,
        expected_turn_id: &str,
        input: Value,
    ) -> Result<Value, String> {
        self.ensure_owned_thread(thread_id)?;
        if expected_turn_id.trim().is_empty() {
            return Err("Codex expected turn id is empty".to_string());
        }
        self.dispatch(
            "turn/steer",
            json!({ "threadId": thread_id, "expectedTurnId": expected_turn_id, "input": input }),
        )
    }

    pub fn thread_fork(&self, thread_id: &str, params: Value) -> Result<Value, String> {
        self.ensure_owned_thread(thread_id)?;
        let mut params = params;
        params["threadId"] = Value::String(thread_id.to_string());
        self.dispatch("thread/fork", params)
    }

    pub fn thread_archive(&self, thread_id: &str) -> Result<Value, String> {
        self.ensure_owned_thread(thread_id)?;
        self.dispatch("thread/archive", json!({ "threadId": thread_id }))
    }

    pub fn thread_unarchive(&self, thread_id: &str) -> Result<Value, String> {
        self.ensure_owned_thread(thread_id)?;
        self.dispatch("thread/unarchive", json!({ "threadId": thread_id }))
    }

    pub fn review_start(&self, thread_id: &str, target: Value) -> Result<Value, String> {
        self.ensure_owned_thread(thread_id)?;
        self.dispatch(
            "review/start",
            json!({ "threadId": thread_id, "target": target, "delivery": "inline" }),
        )
    }

    pub fn thread_unsubscribe(&self, thread_id: &str) -> Result<Value, String> {
        self.ensure_owned_thread(thread_id)?;
        self.dispatch("thread/unsubscribe", json!({ "threadId": thread_id }))
    }

    /// This is intentionally separate from unsubscribe so callers can make
    /// their durable transport switch before giving up native recovery.
    pub fn disown_thread_after_unsubscribe(&self, thread_id: &str) -> Result<(), String> {
        self.disown_thread(thread_id)
    }

    pub fn respond_to_server_request(
        &self,
        request_id: Value,
        result: Option<Value>,
        error: Option<Value>,
    ) -> Result<(), String> {
        if result.is_some() == error.is_some() {
            return Err(
                "provide exactly one app-server server-request result or error".to_string(),
            );
        }
        let (reply_sender, reply_receiver) = mpsc::channel();
        self.sender
            .send(WorkerCommand::RespondToServerRequest {
                request_id,
                result,
                error,
                reply: reply_sender,
            })
            .map_err(|_| "Codex app-server worker stopped".to_string())?;
        reply_receiver
            .recv_timeout(REQUEST_TIMEOUT)
            .map_err(|_| "Codex app-server server-request response timed out".to_string())?
    }

    pub fn native_settings_supported(&self, settings: &Value) -> Result<(), String> {
        let (catalog, truncated) = self.cached_or_model_catalog()?;
        if truncated {
            return Err("Codex model catalog exceeded Impala's safe page limit; use the terminal fallback".to_string());
        }
        validate_native_settings_catalog(settings, &catalog)
    }

    pub fn diagnostics(&self, cwd: &Path) -> CodexDiagnostics {
        let account = match self.dispatch("account/read", json!({ "refreshToken": false })) {
            Ok(value) => DiagnosticsSection::success(sanitize_account(&value), false),
            Err(error) => DiagnosticsSection::failure(error),
        };
        let rate_limits = match self.dispatch("account/rateLimits/read", Value::Null) {
            Ok(value) => DiagnosticsSection::success(sanitize_rate_limits(&value), false),
            Err(error) => DiagnosticsSection::failure(error),
        };
        let models = match self.model_catalog() {
            Ok((catalog, truncated)) => DiagnosticsSection::success(
                DiagnosticsModels {
                    default_model: catalog.iter().find(|model| model.is_default).map(|model| model.id.clone()),
                    models: catalog.into_iter().map(|model| DiagnosticsModel {
                        id: model.id, efforts: model.efforts, tiers: model.tiers, modalities: model.modalities,
                    }).collect(),
                },
                truncated,
            ),
            Err(error) => DiagnosticsSection::failure(error),
        };
        let config = match self.dispatch("config/read", json!({ "cwd": cwd, "includeLayers": false })) {
            Ok(value) => DiagnosticsSection::success(sanitize_config(&value), false),
            Err(error) => DiagnosticsSection::failure(error),
        };
        let mcp = match self.mcp_status() {
            Ok((data, truncated)) => DiagnosticsSection::success(data, truncated),
            Err(error) => DiagnosticsSection::failure(error),
        };

        let connection = self.snapshot().map(|snapshot| CodexDiagnosticsConnection {
            status: snapshot.connection.status,
            version: safe_version(snapshot.connection.version.as_ref()),
            error: snapshot.connection.last_error,
        }).unwrap_or_else(|error| CodexDiagnosticsConnection {
            status: "unknown".to_string(), version: None, error: Some(error),
        });
        CodexDiagnostics { connection, account, rate_limits, models, config, mcp }
    }

    fn model_catalog(&self) -> Result<(Vec<ModelCatalogEntry>, bool), String> {
        let (items, truncated) = self.all_pages("model/list", json!({ "includeHidden": false }), |value| {
            value.get("data").and_then(Value::as_array).cloned().ok_or_else(|| "Codex model/list returned no data array".to_string())
        })?;
        let catalog: Vec<ModelCatalogEntry> =
            items.into_iter().filter_map(model_catalog_entry).collect();
        self.model_catalog.lock().map_err(|_| "Codex model catalog lock poisoned".to_string())?
            .replace(CachedModelCatalog { fetched_at: Instant::now(), catalog: catalog.clone(), truncated });
        Ok((catalog, truncated))
    }

    fn cached_or_model_catalog(&self) -> Result<(Vec<ModelCatalogEntry>, bool), String> {
        if let Some(cached) = self.model_catalog.lock().map_err(|_| "Codex model catalog lock poisoned".to_string())?.as_ref()
            .filter(|cached| catalog_is_fresh(cached, Instant::now())) {
            return Ok((cached.catalog.clone(), cached.truncated));
        }
        self.model_catalog()
    }

    fn mcp_status(&self) -> Result<(DiagnosticsMcp, bool), String> {
        let (items, truncated) = self.all_pages("mcpServerStatus/list", json!({ "detail": "toolsAndAuthOnly" }), |value| {
            value.get("data").and_then(Value::as_array).cloned().ok_or_else(|| "Codex mcpServerStatus/list returned no data array".to_string())
        })?;
        let servers = items.into_iter().filter_map(sanitize_mcp_server).collect::<Vec<_>>();
        let impala = servers.iter().find(|server| server.name == "impala-mcp");
        let impala_mcp_unhealthy_reason = match impala {
            None => Some("impala-mcp is not configured or did not report a status".to_string()),
            Some(server) => match server.auth_status.as_deref() {
                Some("notLoggedIn") | Some("unknown") => Some(format!("authentication status: {}", server.auth_status.as_deref().unwrap_or_default())),
                _ if server.tool_count == 0 => Some("no tools were reported".to_string()),
                _ => None,
            },
        };
        Ok((DiagnosticsMcp { impala_mcp_present: impala.is_some(), impala_mcp_unhealthy_reason, servers }, truncated))
    }

    fn all_pages<F>(&self, method: &str, mut params: Value, items: F) -> Result<(Vec<Value>, bool), String>
    where
        F: Fn(&Value) -> Result<Vec<Value>, String>,
    {
        let mut all = Vec::new();
        for page in 0..DIAGNOSTICS_MAX_PAGES {
            let result = self.dispatch(method, params.clone())?;
            all.extend(items(&result)?);
            let next = result.get("nextCursor").and_then(Value::as_str).filter(|cursor| !cursor.is_empty());
            let Some(cursor) = next else { return Ok((all, false)); };
            if diagnostics_page_limit_reached(page) { return Ok((all, true)); }
            params["cursor"] = Value::String(cursor.to_string());
        }
        Ok((all, true))
    }

    fn ensure_owned_thread(&self, thread_id: &str) -> Result<(), String> {
        if thread_id.trim().is_empty() {
            return Err("Codex app-server thread id is empty".to_string());
        }
        let owned = self
            .snapshot
            .lock()
            .map_err(|_| "Codex app-server state lock poisoned".to_string())?
            .threads
            .contains_key(thread_id);
        if owned {
            Ok(())
        } else {
            Err(format!("Codex thread {thread_id} is not Impala-owned"))
        }
    }

    fn disown_thread(&self, thread_id: &str) -> Result<(), String> {
        let removed = self
            .snapshot
            .lock()
            .map_err(|_| "Codex app-server state lock poisoned".to_string())?
            .threads
            .remove(thread_id)
            .is_some();
        if removed {
            Ok(())
        } else {
            Err(format!("Codex thread {thread_id} is not Impala-owned"))
        }
    }
}

fn diagnostics_page_limit_reached(page: usize) -> bool {
    page + 1 >= DIAGNOSTICS_MAX_PAGES
}

fn catalog_is_fresh(cached: &CachedModelCatalog, now: Instant) -> bool {
    now.duration_since(cached.fetched_at) < MODEL_CATALOG_TTL
}

fn safe_version(value: Option<&Value>) -> Option<String> {
    value.and_then(|value| {
        value.pointer("/serverInfo/version")
            .or_else(|| value.get("version"))
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

fn model_catalog_entry(value: Value) -> Option<ModelCatalogEntry> {
    // `model` is the request identifier; `id` is display/catalog identity.
    let id = value.get("model").or_else(|| value.get("id"))?.as_str()?.to_string();
    let efforts = value.get("supportedReasoningEfforts").and_then(Value::as_array).into_iter().flatten().filter_map(|effort| effort.get("reasoningEffort").and_then(Value::as_str)).map(str::to_string).collect();
    let mut tiers = value.get("serviceTiers").and_then(Value::as_array).into_iter().flatten().filter_map(|tier| tier.get("id").and_then(Value::as_str)).map(str::to_string).collect::<Vec<_>>();
    if let Some(tier) = value.get("defaultServiceTier").and_then(Value::as_str) {
        if !tiers.iter().any(|candidate| candidate == tier) { tiers.push(tier.to_string()); }
    }
    for tier in strings(value.get("additionalSpeedTiers")) {
        if !tiers.iter().any(|candidate| candidate == &tier) { tiers.push(tier); }
    }
    Some(ModelCatalogEntry {
        id,
        is_default: value.get("isDefault").and_then(Value::as_bool).unwrap_or(false),
        efforts,
        tiers,
        modalities: strings(value.get("inputModalities")),
    })
}

pub(crate) fn validate_native_settings_catalog(settings: &Value, catalog: &[ModelCatalogEntry]) -> Result<(), String> {
    let settings = settings.as_object().ok_or_else(|| "native Codex settings must be an object".to_string())?;
    let requested_model = settings.get("model").and_then(Value::as_str);
    let model = match requested_model {
        Some(id) => catalog.iter().find(|model| model.id == id),
        None => catalog.iter().find(|model| model.is_default),
    }.ok_or_else(|| match requested_model {
        Some(id) => format!("Codex model {id} is unavailable"),
        None => "Codex model catalog has no default model".to_string(),
    })?;
    if let Some(effort) = settings.get("effort").and_then(Value::as_str) {
        if !model.efforts.iter().any(|candidate| candidate == effort) {
            return Err(format!("Codex model {} does not support reasoning effort {effort}", model.id));
        }
    }
    if let Some(tier) = settings.get("serviceTier").and_then(Value::as_str) {
        if !model.tiers.iter().any(|candidate| candidate == tier) {
            return Err(format!("Codex model {} does not support service tier {tier}", model.id));
        }
    }
    Ok(())
}

fn sanitize_account(value: &Value) -> DiagnosticsAccount {
    let account = value.get("account");
    DiagnosticsAccount {
        account_type: account.and_then(|account| account.get("type")).and_then(Value::as_str).map(str::to_string),
        email: account.and_then(|account| account.get("email")).and_then(Value::as_str).map(str::to_string),
        plan: account.and_then(|account| account.get("planType")).and_then(Value::as_str).map(str::to_string),
        requires_openai_auth: value.get("requiresOpenaiAuth").and_then(Value::as_bool).unwrap_or(false),
    }
}

fn sanitize_rate_limits(value: &Value) -> DiagnosticsRateLimits {
    let limits = value.get("rateLimits").unwrap_or(value);
    let primary = limits.get("primary");
    let secondary = limits.get("secondary");
    DiagnosticsRateLimits {
        primary_used_percent: primary.and_then(|window| window.get("usedPercent")).and_then(Value::as_i64),
        secondary_used_percent: secondary.and_then(|window| window.get("usedPercent")).and_then(Value::as_i64),
        resets_at: primary.and_then(|window| window.get("resetsAt")).and_then(Value::as_i64).or_else(|| secondary.and_then(|window| window.get("resetsAt")).and_then(Value::as_i64)),
        reached: limits.get("rateLimitReachedType").and_then(Value::as_str).map(str::to_string),
    }
}

fn sanitize_config(value: &Value) -> DiagnosticsConfig {
    let config = value.get("config").unwrap_or(value);
    DiagnosticsConfig {
        model: config.get("model").and_then(Value::as_str).map(str::to_string),
        effort: config.get("model_reasoning_effort").and_then(Value::as_str).map(str::to_string),
        service_tier: config.get("service_tier").and_then(Value::as_str).map(str::to_string),
        approval_policy: config.get("approval_policy").and_then(Value::as_str).map(str::to_string),
        sandbox: config.get("sandbox_mode").and_then(Value::as_str).map(str::to_string),
    }
}

fn sanitize_mcp_server(value: Value) -> Option<DiagnosticsMcpServer> {
    let name = value.get("name")?.as_str()?.to_string();
    Some(DiagnosticsMcpServer {
        name,
        auth_status: value.get("authStatus").and_then(Value::as_str).map(str::to_string),
        tool_count: value.get("tools").and_then(Value::as_object).map_or(0, |tools| tools.len()),
    })
}

fn app_server_worker(
    receiver: mpsc::Receiver<WorkerCommand>,
    snapshot: Arc<Mutex<AppServerSnapshotState>>,
    app: tauri::AppHandle,
) {
    let mut socket = None;
    let mut pending = HashMap::new();
    let mut next_request_id = 1_u64;

    loop {
        while let Ok(command) = receiver.try_recv() {
            handle_worker_command(
                command,
                &mut socket,
                &mut pending,
                &mut next_request_id,
                &snapshot,
                &app,
            );
        }

        let Some(active_socket) = socket.as_mut() else {
            match receiver.recv() {
                Ok(command) => handle_worker_command(
                    command,
                    &mut socket,
                    &mut pending,
                    &mut next_request_id,
                    &snapshot,
                    &app,
                ),
                Err(_) => break,
            }
            continue;
        };

        match active_socket.read() {
            Ok(Message::Text(text)) => match serde_json::from_str(text.as_str()) {
                Ok(envelope) => {
                    handle_envelope(envelope, active_socket, &mut pending, &snapshot, &app)
                }
                Err(error) => record_connection_error(
                    &snapshot,
                    &app,
                    format!("parse Codex app-server message: {error}"),
                ),
            },
            Ok(Message::Close(_)) => disconnect(
                &mut socket,
                &mut pending,
                &snapshot,
                &app,
                "Codex app-server disconnected".to_string(),
            ),
            Ok(_) => {}
            Err(error) if is_poll_timeout(&error) => {}
            Err(error) => disconnect(
                &mut socket,
                &mut pending,
                &snapshot,
                &app,
                format!("read Codex app-server message: {error}"),
            ),
        }
    }
}

fn handle_worker_command(
    command: WorkerCommand,
    socket: &mut Option<WebSocket<UnixStream>>,
    pending: &mut HashMap<String, PendingCall>,
    next_request_id: &mut u64,
    snapshot: &Arc<Mutex<AppServerSnapshotState>>,
    app: &tauri::AppHandle,
) {
    match command {
        WorkerCommand::Request {
            method,
            params,
            reply,
        } => {
            if matches!(
                method.as_str(),
                "thread/resume"
                    | "thread/read"
                    | "thread/fork"
                    | "thread/archive"
                    | "thread/unarchive"
                    | "thread/unsubscribe"
                    | "turn/start"
                    | "turn/steer"
                    | "turn/interrupt"
                    | "review/start"
            ) {
                let thread_id = params.get("threadId").and_then(Value::as_str);
                if !thread_id.map(|id| is_owned(snapshot, id)).unwrap_or(false) {
                    let _ = reply.send(Err("Codex thread is not Impala-owned".to_string()));
                    return;
                }
            }
            if let Err(error) = ensure_connection(socket, pending, snapshot, app, next_request_id) {
                record_connection_error(snapshot, app, error.clone());
                let _ = reply.send(Err(error));
                return;
            }
            let id = Value::from(*next_request_id);
            *next_request_id += 1;
            let key = match request_id_key(&id) {
                Ok(key) => key,
                Err(error) => {
                    let _ = reply.send(Err(error));
                    return;
                }
            };
            if let Some(active_socket) = socket.as_mut() {
                if let Err(error) = send_json(
                    active_socket,
                    json!({ "id": id, "method": method, "params": params }),
                ) {
                    disconnect(socket, pending, snapshot, app, error.clone());
                    let _ = reply.send(Err(error));
                } else {
                    pending.insert(
                        key,
                        PendingCall {
                            method,
                            params,
                            reply,
                        },
                    );
                }
            }
        }
        WorkerCommand::RespondToServerRequest {
            request_id,
            result,
            error,
            reply,
        } => {
            let Some(request) = find_server_request(snapshot, &request_id) else {
                let _ = reply.send(Err("unknown Codex app-server server request".to_string()));
                return;
            };
            if let Err(error) = validate_server_request_response(&request, &result, &error) {
                let _ = reply.send(Err(error));
                return;
            }
            let outcome = match socket.as_mut() {
                Some(active_socket) => {
                    let mut response = json!({ "id": request_id });
                    if let Some(result) = result {
                        response["result"] = result;
                    } else if let Some(error) = error {
                        response["error"] = error;
                    }
                    send_json(active_socket, response)
                }
                None => Err("Codex app-server is disconnected".to_string()),
            };
            let _ = reply.send(consume_server_request_after_write(snapshot, &request_id, outcome));
        }
    }
}

fn ensure_connection(
    socket: &mut Option<WebSocket<UnixStream>>,
    pending: &mut HashMap<String, PendingCall>,
    snapshot: &Arc<Mutex<AppServerSnapshotState>>,
    app: &tauri::AppHandle,
    next_request_id: &mut u64,
) -> Result<(), String> {
    if socket.is_some() {
        return Ok(());
    }
    let codex_home =
        crate::agent_config::codex_home_path().ok_or_else(|| "no Codex home".to_string())?;
    // This worker is the single launch gate for the managed CODEX_HOME.
    launch_environment(&codex_home)?;
    let remote = managed_remote(&codex_home);
    let mut connected = connect_with_poll_timeout(&remote)?;
    let initialize_id = Value::from(*next_request_id);
    *next_request_id += 1;
    send_json(
        &mut connected,
        json!({
            "id": initialize_id,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "impala",
                    "title": "Impala",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "capabilities": { "experimentalApi": true },
            },
        }),
    )?;
    let initialized = wait_for_response(&mut connected, &initialize_id, pending, snapshot, app)?;
    send_json(&mut connected, json!({ "method": "initialized" }))?;
    {
        let mut state = snapshot
            .lock()
            .map_err(|_| "Codex app-server state lock poisoned".to_string())?;
        state.connection.status = "connected".to_string();
        state.connection.version = Some(initialized);
        state.connection.last_error = None;
    }
    let _ = app.emit("codex-app-server-event", json!({ "type": "connected" }));
    *socket = Some(connected);
    reconnect_owned_threads(socket, pending, snapshot, app, next_request_id);
    Ok(())
}

fn reconnect_owned_threads(
    socket: &mut Option<WebSocket<UnixStream>>,
    pending: &mut HashMap<String, PendingCall>,
    snapshot: &Arc<Mutex<AppServerSnapshotState>>,
    app: &tauri::AppHandle,
    next_request_id: &mut u64,
) {
    for (method, params) in reconnect_requests(owned_thread_ids(snapshot)) {
        let Some(active_socket) = socket.as_mut() else {
            return;
        };
        let thread_id = thread_id_from(&params).unwrap_or_default();
        let id = Value::from(*next_request_id);
        *next_request_id += 1;
        if send_json(
            active_socket,
            json!({ "id": id, "method": method, "params": params }),
        )
        .is_err()
        {
            return;
        }
        match wait_for_response(active_socket, &id, pending, snapshot, app) {
            Ok(result) => apply_response(method, &params, &result, snapshot),
            Err(error) => set_thread_error(snapshot, &thread_id, error),
        }
    }
}

fn wait_for_response(
    socket: &mut WebSocket<UnixStream>,
    expected_id: &Value,
    pending: &mut HashMap<String, PendingCall>,
    snapshot: &Arc<Mutex<AppServerSnapshotState>>,
    app: &tauri::AppHandle,
) -> Result<Value, String> {
    loop {
        match socket.read() {
            Ok(Message::Text(text)) => {
                let envelope: Value = serde_json::from_str(text.as_str())
                    .map_err(|error| format!("parse Codex app-server message: {error}"))?;
                if envelope.get("id") == Some(expected_id) && envelope.get("method").is_none() {
                    return response_result(&envelope);
                }
                handle_envelope(envelope, socket, pending, snapshot, app);
            }
            Ok(Message::Close(_)) => return Err("Codex app-server disconnected".to_string()),
            Ok(_) => {}
            Err(error) if is_poll_timeout(&error) => continue,
            Err(error) => return Err(format!("read Codex app-server response: {error}")),
        }
    }
}

fn handle_envelope(
    envelope: Value,
    socket: &mut WebSocket<UnixStream>,
    pending: &mut HashMap<String, PendingCall>,
    snapshot: &Arc<Mutex<AppServerSnapshotState>>,
    app: &tauri::AppHandle,
) {
    if envelope.get("method").is_some() && envelope.get("id").is_some() {
        handle_server_request(envelope, socket, snapshot, app);
        return;
    }
    if envelope.get("method").is_some() {
        handle_notification(envelope, snapshot, app);
        return;
    }
    let Some(id) = envelope.get("id") else {
        record_connection_error(
            snapshot,
            app,
            "Codex app-server message has no id or method".to_string(),
        );
        return;
    };
    let Ok(key) = request_id_key(id) else {
        record_connection_error(
            snapshot,
            app,
            "Codex app-server response has unsupported id".to_string(),
        );
        return;
    };
    if !handle_response_envelope(&envelope, &key, pending, snapshot) {
        handle_notification(envelope, snapshot, app);
    }
}

fn handle_response_envelope(
    envelope: &Value,
    key: &str,
    pending: &mut HashMap<String, PendingCall>,
    snapshot: &Arc<Mutex<AppServerSnapshotState>>,
) -> bool {
    if let Some(call) = pending.remove(key) {
        let result = response_result(&envelope);
        if let Ok(value) = &result {
            apply_response(&call.method, &call.params, value, snapshot);
        } else if let Err(error) = &result {
            if let Some(thread_id) = thread_id_from(&call.params) {
                set_thread_error(snapshot, &thread_id, error.clone());
            }
        }
        let _ = call.reply.send(result);
        true
    } else {
        false
    }
}

fn handle_notification(
    envelope: Value,
    snapshot: &Arc<Mutex<AppServerSnapshotState>>,
    app: &tauri::AppHandle,
) {
    apply_notification(&envelope, snapshot);
    crate::automations::apply_native_codex_notification(app, &envelope);
    crate::codex_panes::apply_native_codex_notification(app, &envelope);
    let _ = app.emit("codex-app-server-event", envelope);
}

fn apply_notification(envelope: &Value, snapshot: &Arc<Mutex<AppServerSnapshotState>>) {
    let method = envelope
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = envelope.get("params").unwrap_or(&Value::Null);
    let thread_id = thread_id_from(params);
    if let Ok(mut state) = snapshot.lock() {
        state.record_event(envelope.clone(), thread_id.as_deref());
        state.apply_thread_value(params, thread_id.as_deref());
        if let Some(thread_id) = thread_id
            .as_deref()
            .filter(|id| state.threads.contains_key(*id))
        {
            let thread = state.threads.get_mut(thread_id).expect("checked above");
            if method.contains("turn/started") || method == "turn/started" {
                apply_turn_snapshot(thread, params.get("turn"), false);
            }
            if method.contains("turn/completed")
                || method.contains("turn/failed")
                || method.contains("turn/interrupted")
            {
                apply_turn_snapshot(thread, params.get("turn"), true);
            }
        }
    }
}

fn apply_turn_snapshot(thread: &mut ThreadState, turn: Option<&Value>, terminal: bool) {
    let Some(turn) = turn else {
        return;
    };
    if let Some(status) = turn.get("status").and_then(Value::as_str) {
        thread.status = Some(status.to_string());
    }
    thread.last_error = turn_error(turn);
    if terminal {
        thread.active_turn = None;
    } else {
        thread.active_turn = turn.get("id").and_then(Value::as_str).map(str::to_string);
    }
}

fn turn_error(turn: &Value) -> Option<String> {
    let error = turn.get("error")?;
    error
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| error.as_str().map(str::to_string))
        .or_else(|| serde_json::to_string(error).ok())
}

fn handle_server_request(
    envelope: Value,
    socket: &mut WebSocket<UnixStream>,
    snapshot: &Arc<Mutex<AppServerSnapshotState>>,
    app: &tauri::AppHandle,
) {
    let method = envelope
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let request_id = envelope.get("id").cloned().unwrap_or(Value::Null);
    let params = envelope.get("params").cloned().unwrap_or(Value::Null);
    let thread_id = thread_id_from(&params);
    let supported = server_request_is_supported(method, thread_id.as_deref(), snapshot);
    if supported {
        let request = CodexAppServerServerRequest {
            request_id,
            method: method.to_string(),
            params,
            thread_id: thread_id.clone(),
        };
        if let Ok(mut state) = snapshot.lock() {
            if let Some(thread) = thread_id
                .as_deref()
                .and_then(|id| state.threads.get_mut(id))
            {
                thread.pending_server_requests.push(request.clone());
            }
            state.record_event(envelope.clone(), thread_id.as_deref());
        }
        let _ = app.emit("codex-app-server-event", envelope);
    } else {
        // Acknowledge every unsupported request; dropping it can deadlock a turn.
        let error = method_not_supported_error();
        let _ = app.emit(
            "codex-app-server-event",
            json!({
                "type": "unsupported-server-request",
                "request": envelope,
                "response": { "id": request_id, "error": error },
            }),
        );
        let _ = send_json(socket, json!({ "id": request_id, "error": error }));
        if let Ok(mut state) = snapshot.lock() {
            state.record_event(
                json!({ "id": request_id, "error": error }),
                thread_id.as_deref(),
            );
        }
    }
}

fn is_supported_server_request(method: &str) -> bool {
    matches!(
        method,
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
            | "item/tool/requestUserInput"
            | "mcpServer/elicitation/request"
    )
}

fn server_request_is_supported(
    method: &str,
    thread_id: Option<&str>,
    snapshot: &Arc<Mutex<AppServerSnapshotState>>,
) -> bool {
    is_supported_server_request(method)
        && thread_id.map(|id| is_owned(snapshot, id)).unwrap_or(false)
}

fn method_not_supported_error() -> Value {
    json!({ "code": -32601, "message": "Impala does not support this Codex app-server request" })
}

fn response_result(envelope: &Value) -> Result<Value, String> {
    if let Some(error) = envelope.get("error") {
        return Err(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown Codex app-server error")
            .to_string());
    }
    envelope
        .get("result")
        .cloned()
        .ok_or_else(|| "Codex app-server response has no result".to_string())
}

fn apply_response(
    method: &str,
    params: &Value,
    result: &Value,
    snapshot: &Arc<Mutex<AppServerSnapshotState>>,
) {
    let thread_id = thread_id_from(result).or_else(|| thread_id_from(params));
    if method == "thread/start" {
        if let Some(thread_id) = thread_id.as_deref() {
            if let Ok(mut state) = snapshot.lock() {
                state.threads.entry(thread_id.to_string()).or_default();
                state.apply_thread_value(result, Some(thread_id));
                state.record_event(
                    json!({ "method": method, "result": result }),
                    Some(thread_id),
                );
            }
        }
        return;
    }
    if let Ok(mut state) = snapshot.lock() {
        state.apply_thread_value(result, thread_id.as_deref());
        if let Some(thread_id) = thread_id.as_deref() {
            if let Some(thread) = state.threads.get_mut(thread_id) {
                if method == "turn/start" || method == "turn/steer" {
                    thread.active_turn = result
                        .get("turn")
                        .and_then(|turn| turn.get("id"))
                        .or_else(|| result.get("turnId"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
                if method == "turn/interrupt" {
                    thread.active_turn = None;
                }
            }
            state.record_event(
                json!({ "method": method, "result": result }),
                Some(thread_id),
            );
        }
    }
}

fn disconnect(
    socket: &mut Option<WebSocket<UnixStream>>,
    pending: &mut HashMap<String, PendingCall>,
    snapshot: &Arc<Mutex<AppServerSnapshotState>>,
    app: &tauri::AppHandle,
    error: String,
) {
    *socket = None;
    fail_pending_calls(pending, &error);
    if let Ok(mut state) = snapshot.lock() {
        state.connection.status = "disconnected".to_string();
        state.connection.last_error = Some(error.clone());
        for thread in state.threads.values_mut() {
            thread.last_error = Some(error.clone());
        }
    }
    let _ = app.emit(
        "codex-app-server-event",
        json!({ "type": "disconnected", "error": error }),
    );
}

fn fail_pending_calls(pending: &mut HashMap<String, PendingCall>, error: &str) {
    for (_, call) in pending.drain() {
        let _ = call.reply.send(Err(error.to_string()));
    }
}

fn record_connection_error(
    snapshot: &Arc<Mutex<AppServerSnapshotState>>,
    app: &tauri::AppHandle,
    error: String,
) {
    if let Ok(mut state) = snapshot.lock() {
        state.connection.last_error = Some(error.clone());
    }
    let _ = app.emit(
        "codex-app-server-event",
        json!({ "type": "error", "error": error }),
    );
}

fn request_id_key(id: &Value) -> Result<String, String> {
    match id {
        Value::Number(value) => Ok(format!("n:{value}")),
        Value::String(value) => Ok(format!("s:{value}")),
        _ => Err("Codex app-server request id must be a number or string".to_string()),
    }
}

fn thread_id_from(value: &Value) -> Option<String> {
    value
        .get("threadId")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .get("thread")
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            value
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| id.starts_with("thread_"))
        })
        .map(str::to_string)
}

fn is_owned(snapshot: &Arc<Mutex<AppServerSnapshotState>>, thread_id: &str) -> bool {
    snapshot
        .lock()
        .map(|state| state.threads.contains_key(thread_id))
        .unwrap_or(false)
}

fn owned_thread_ids(snapshot: &Arc<Mutex<AppServerSnapshotState>>) -> Vec<String> {
    snapshot
        .lock()
        .map(|state| state.threads.keys().cloned().collect())
        .unwrap_or_default()
}

fn reconnect_requests(thread_ids: Vec<String>) -> Vec<(&'static str, Value)> {
    thread_ids
        .into_iter()
        .flat_map(|thread_id| {
            [
                ("thread/resume", json!({ "threadId": thread_id })),
                (
                    "thread/read",
                    json!({ "threadId": thread_id, "includeTurns": true }),
                ),
            ]
        })
        .collect()
}

fn set_thread_error(snapshot: &Arc<Mutex<AppServerSnapshotState>>, thread_id: &str, error: String) {
    if let Ok(mut state) = snapshot.lock() {
        if let Some(thread) = state.threads.get_mut(thread_id) {
            thread.last_error = Some(error);
        }
    }
}

fn find_server_request(
    snapshot: &Arc<Mutex<AppServerSnapshotState>>,
    request_id: &Value,
) -> Option<CodexAppServerServerRequest> {
    let key = request_id_key(request_id).ok()?;
    let state = snapshot.lock().ok()?;
    state.threads.values().flat_map(|thread| thread.pending_server_requests.iter())
        .find(|request| request_id_key(&request.request_id).ok().as_deref() == Some(&key))
        .cloned()
}

fn validate_server_request_response(
    request: &CodexAppServerServerRequest,
    result: &Option<Value>,
    error: &Option<Value>,
) -> Result<(), String> {
    if result.is_some() == error.is_some() {
        return Err("provide exactly one app-server server-request result or error".to_string());
    }
    if !matches!(
        request.method.as_str(),
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
            | "item/tool/requestUserInput"
            | "mcpServer/elicitation/request"
    ) {
        return Err("unsupported Codex app-server server request method".to_string());
    }
    if let Some(error) = error {
        return validate_json_rpc_error(error);
    }
    let result = result.as_ref().expect("checked response result");
    match request.method.as_str() {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            let result = exact_object(result, &["decision"])?;
            match result.get("decision").and_then(Value::as_str) {
                Some("accept" | "decline") => Ok(()),
                _ => Err("native Codex approval decision must be accept or decline".to_string()),
            }
        }
        "item/permissions/requestApproval" => Err(
            "native Codex permission grants are not supported; return a JSON-RPC error".to_string(),
        ),
        "item/tool/requestUserInput" => validate_tool_user_input_response(&request.params, result),
        "mcpServer/elicitation/request" => validate_mcp_elicitation_response(&request.params, result),
        _ => unreachable!("supported methods checked above"),
    }
}

fn exact_object<'a>(value: &'a Value, keys: &[&str]) -> Result<&'a serde_json::Map<String, Value>, String> {
    let object = value.as_object().ok_or_else(|| "Codex server-request response must be an object".to_string())?;
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        return Err("Codex server-request response has an unsupported shape".to_string());
    }
    Ok(object)
}

fn validate_json_rpc_error(error: &Value) -> Result<(), String> {
    let object = error.as_object().ok_or_else(|| "Codex server-request error must be an object".to_string())?;
    if object.keys().any(|key| key != "code" && key != "message" && key != "data")
        || !object.get("code").is_some_and(Value::is_number)
        || !object.get("message").and_then(Value::as_str).is_some_and(|message| !message.trim().is_empty()) {
        return Err("Codex server-request error must contain numeric code and message".to_string());
    }
    Ok(())
}

fn validate_tool_user_input_response(params: &Value, result: &Value) -> Result<(), String> {
    let result = exact_object(result, &["answers"])?;
    let answers = result.get("answers").and_then(Value::as_object)
        .ok_or_else(|| "Codex tool input response answers must be an object".to_string())?;
    let question_ids = params.get("questions").and_then(Value::as_array)
        .ok_or_else(|| "stored Codex tool request has no questions".to_string())?
        .iter()
        .map(|question| question.get("id").and_then(Value::as_str))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| "stored Codex tool request has invalid questions".to_string())?;
    if answers.len() != question_ids.len() || question_ids.iter().any(|id| !answers.contains_key(*id)) {
        return Err("Codex tool input response must answer exactly the requested questions".to_string());
    }
    for answer in answers.values() {
        let answer = exact_object(answer, &["answers"])?;
        if !answer.get("answers").and_then(Value::as_array).is_some_and(|values| values.iter().all(Value::is_string)) {
            return Err("Codex tool input answers must be string arrays".to_string());
        }
    }
    Ok(())
}

fn validate_mcp_elicitation_response(params: &Value, result: &Value) -> Result<(), String> {
    let result = result.as_object().ok_or_else(|| "Codex MCP elicitation response must be an object".to_string())?;
    let action = result.get("action").and_then(Value::as_str)
        .ok_or_else(|| "Codex MCP elicitation response requires an action".to_string())?;
    match action {
        "accept" => {
            if result.len() != 2 || !result.contains_key("content") || params.get("mode").and_then(Value::as_str) == Some("url") {
                return Err("Codex MCP acceptance requires form content".to_string());
            }
            let content = result.get("content").and_then(Value::as_object)
                .ok_or_else(|| "Codex MCP acceptance content must be an object".to_string())?;
            if content.values().any(|value| !value.is_string() && !value.is_number() && !value.is_boolean()) {
                return Err("Codex MCP acceptance content must use primitive values".to_string());
            }
            Ok(())
        }
        "decline" | "cancel" if result.len() == 1 => Ok(()),
        "decline" | "cancel" => Err("Codex MCP decline or cancel cannot include content".to_string()),
        _ => Err("Codex MCP elicitation action is invalid".to_string()),
    }
}

fn take_server_request(
    snapshot: &Arc<Mutex<AppServerSnapshotState>>,
    request_id: &Value,
) -> Option<CodexAppServerServerRequest> {
    let key = request_id_key(request_id).ok()?;
    let mut state = snapshot.lock().ok()?;
    for thread in state.threads.values_mut() {
        if let Some(index) = thread
            .pending_server_requests
            .iter()
            .position(|request| request_id_key(&request.request_id).ok().as_deref() == Some(&key))
        {
            return Some(thread.pending_server_requests.remove(index));
        }
    }
    None
}

fn has_server_request(snapshot: &Arc<Mutex<AppServerSnapshotState>>, request_id: &Value) -> bool {
    find_server_request(snapshot, request_id).is_some()
}

fn consume_server_request_after_write(snapshot: &Arc<Mutex<AppServerSnapshotState>>, request_id: &Value, outcome: Result<(), String>) -> Result<(), String> {
    if outcome.is_ok() { let _ = take_server_request(snapshot, request_id); }
    outcome
}

fn connect_with_poll_timeout(remote: &str) -> Result<WebSocket<UnixStream>, String> {
    let mut socket = connect(remote)?;
    socket
        .get_mut()
        .set_read_timeout(Some(WORKER_POLL_TIMEOUT))
        .map_err(|error| format!("set Codex app-server worker read timeout: {error}"))?;
    Ok(socket)
}

fn is_poll_timeout(error: &tungstenite::Error) -> bool {
    matches!(
        error,
        tungstenite::Error::Io(io_error)
            if matches!(io_error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut)
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteControlStatus {
    status: String,
    server_name: String,
    environment_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlClient {
    client_id: String,
    display_name: Option<String>,
    device_type: Option<String>,
    platform: Option<String>,
    os_version: Option<String>,
    device_model: Option<String>,
    app_version: Option<String>,
    last_seen_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteControlClients {
    data: Vec<RemoteControlClient>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlSnapshot {
    status: String,
    server_name: Option<String>,
    environment_id: Option<String>,
    clients: Vec<RemoteControlClient>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlPairing {
    pairing_code: String,
    manual_pairing_code: Option<String>,
    environment_id: String,
    expires_at: i64,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct RemoteControlPairingStatus {
    claimed: bool,
}

pub fn launch_environment(codex_home: &Path) -> Result<HashMap<String, String>, String> {
    let launch_lock = {
        let locks = DAEMON_LAUNCH_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
        let mut locks = locks
            .lock()
            .map_err(|_| "Codex app-server launch lock poisoned".to_string())?;
        locks
            .entry(codex_home.to_path_buf())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    // This covers both the persistent worker and legacy shell-environment calls.
    let _launch_guard = launch_lock
        .lock()
        .map_err(|_| "Codex app-server launch lock poisoned".to_string())?;
    let codex = codex_home.join("packages/standalone/current/codex");
    if !codex.is_file() {
        return Err(format!(
            "Codex Remote requires the managed standalone install at {}",
            codex.display()
        ));
    }
    let enabled = run_daemon_command(&codex, codex_home, "enable-remote-control")?;
    let started = run_daemon_command(&codex, codex_home, "start")?;
    environment_from_daemon_outputs(codex_home, &enabled, &started)
}

fn run_daemon_command(codex: &Path, codex_home: &Path, command: &str) -> Result<Vec<u8>, String> {
    let output = Command::new(codex)
        .args(["app-server", "daemon", command])
        .env("CODEX_HOME", codex_home)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("run Codex app-server daemon {command}: {error}"))?;
    if output.status.success() {
        return Ok(output.stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    Err(format!(
        "Codex app-server daemon {command} failed: {detail}"
    ))
}

fn environment_from_daemon_outputs(
    codex_home: &Path,
    enabled: &[u8],
    started: &[u8],
) -> Result<HashMap<String, String>, String> {
    let enabled: Value = serde_json::from_slice(enabled)
        .map_err(|error| format!("parse Codex enable-remote-control output: {error}"))?;
    if enabled.get("remoteControlEnabled").and_then(Value::as_bool) != Some(true) {
        return Err("Codex app-server did not enable Remote control".to_string());
    }
    validate_daemon_socket(codex_home, &enabled)?;
    let socket = validate_daemon_socket(
        codex_home,
        &serde_json::from_slice(started)
            .map_err(|error| format!("parse Codex daemon start output: {error}"))?,
    )?;
    Ok(HashMap::from([
        (
            "IMPALA_CODEX_APP_SERVER".to_string(),
            format!("unix://{}", socket.display()),
        ),
        (
            "IMPALA_CODEX_BIN".to_string(),
            codex_home
                .join("packages/standalone/current/codex")
                .to_string_lossy()
                .into_owned(),
        ),
    ]))
}

fn validate_daemon_socket(codex_home: &Path, output: &Value) -> Result<PathBuf, String> {
    let socket = output
        .get("socketPath")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| "Codex app-server daemon output has no socketPath".to_string())?;
    let expected = codex_home.join(DAEMON_SOCKET);
    if socket != expected {
        return Err(format!(
            "Codex app-server returned unexpected socket {}",
            socket.display()
        ));
    }
    Ok(socket)
}

fn socket_path(remote: &str) -> Result<PathBuf, String> {
    let raw = remote
        .strip_prefix("unix://")
        .filter(|value| value.starts_with('/'))
        .ok_or_else(|| "Impala callbacks require an absolute unix:// app-server URL".to_string())?;
    Ok(PathBuf::from(raw))
}

pub fn is_managed_remote(remote: &str) -> bool {
    let Some(codex_home) = crate::agent_config::codex_home_path() else {
        return false;
    };
    is_managed_remote_in(remote, &codex_home)
}

fn is_managed_remote_in(remote: &str, codex_home: &Path) -> bool {
    let Ok(path) = socket_path(remote) else {
        return false;
    };
    path == codex_home.join(DAEMON_SOCKET)
}

fn connect(remote: &str) -> Result<WebSocket<UnixStream>, String> {
    let path = socket_path(remote)?;
    let stream = UnixStream::connect(&path)
        .map_err(|error| format!("connect to {}: {error}", path.display()))?;
    stream
        .set_read_timeout(Some(REQUEST_TIMEOUT))
        .map_err(|error| format!("set Codex app-server read timeout: {error}"))?;
    stream
        .set_write_timeout(Some(REQUEST_TIMEOUT))
        .map_err(|error| format!("set Codex app-server write timeout: {error}"))?;
    client("ws://localhost/rpc", stream)
        .map(|(socket, _)| socket)
        .map_err(|error| format!("upgrade Codex app-server socket: {error}"))
}

fn send_json(socket: &mut WebSocket<UnixStream>, value: Value) -> Result<(), String> {
    socket
        .send(Message::Text(value.to_string().into()))
        .map_err(|error| format!("send Codex app-server request: {error}"))
}

fn request(
    socket: &mut WebSocket<UnixStream>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    send_json(
        socket,
        json!({
            "id": id,
            "method": method,
            "params": params,
        }),
    )?;

    loop {
        let message = socket
            .read()
            .map_err(|error| format!("read Codex app-server response: {error}"))?;
        let Message::Text(text) = message else {
            continue;
        };
        let value: Value = serde_json::from_str(text.as_str())
            .map_err(|error| format!("parse Codex app-server response: {error}"))?;
        if value.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown app-server error");
            return Err(message.to_string());
        }
        return value
            .get("result")
            .cloned()
            .ok_or_else(|| "Codex app-server response has no result".to_string());
    }
}

fn initialize_client(remote: &str) -> Result<WebSocket<UnixStream>, String> {
    let mut socket = connect(remote)?;
    request(
        &mut socket,
        1,
        "initialize",
        json!({
            "clientInfo": {
                "name": "impala",
                "title": "Impala",
                "version": env!("CARGO_PKG_VERSION"),
            },
            "capabilities": {
                "experimentalApi": true,
            },
        }),
    )?;
    send_json(&mut socket, json!({ "method": "initialized" }))?;
    Ok(socket)
}

fn managed_remote(codex_home: &Path) -> String {
    format!("unix://{}", codex_home.join(DAEMON_SOCKET).display())
}

pub fn remote_snapshot(codex_home: &Path) -> Result<RemoteControlSnapshot, String> {
    let remote = managed_remote(codex_home);
    if !socket_path(&remote)?.exists() {
        return Ok(RemoteControlSnapshot {
            status: "offline".to_string(),
            server_name: None,
            environment_id: None,
            clients: Vec::new(),
        });
    }

    let mut socket = initialize_client(&remote)?;
    let status: RemoteControlStatus = serde_json::from_value(request(
        &mut socket,
        2,
        "remoteControl/status/read",
        json!({}),
    )?)
    .map_err(|error| format!("parse Codex Remote status: {error}"))?;
    let clients = match status.environment_id.as_deref() {
        Some(environment_id) => {
            let response: RemoteControlClients = serde_json::from_value(request(
                &mut socket,
                3,
                "remoteControl/client/list",
                json!({
                    "environmentId": environment_id,
                    "limit": 100,
                    "order": "desc",
                }),
            )?)
            .map_err(|error| format!("parse Codex Remote clients: {error}"))?;
            response.data
        }
        None => Vec::new(),
    };
    let _ = socket.close(None);

    Ok(RemoteControlSnapshot {
        status: status.status,
        server_name: Some(status.server_name),
        environment_id: status.environment_id,
        clients,
    })
}

pub fn start_pairing(codex_home: &Path) -> Result<RemoteControlPairing, String> {
    launch_environment(codex_home)?;
    let mut socket = initialize_client(&managed_remote(codex_home))?;
    let pairing = serde_json::from_value(request(
        &mut socket,
        2,
        "remoteControl/pairing/start",
        json!({ "manualCode": true }),
    )?)
    .map_err(|error| format!("parse Codex Remote pairing: {error}"))?;
    let _ = socket.close(None);
    Ok(pairing)
}

pub fn pairing_status(
    codex_home: &Path,
    pairing_code: &str,
) -> Result<RemoteControlPairingStatus, String> {
    if pairing_code.trim().is_empty() {
        return Err("Codex Remote pairing code is empty".to_string());
    }
    let mut socket = initialize_client(&managed_remote(codex_home))?;
    let status = serde_json::from_value(request(
        &mut socket,
        2,
        "remoteControl/pairing/status",
        json!({ "pairingCode": pairing_code }),
    )?)
    .map_err(|error| format!("parse Codex Remote pairing status: {error}"))?;
    let _ = socket.close(None);
    Ok(status)
}

pub fn revoke_client(
    codex_home: &Path,
    environment_id: &str,
    client_id: &str,
) -> Result<(), String> {
    if environment_id.trim().is_empty() || client_id.trim().is_empty() {
        return Err("Codex Remote environment and client are required".to_string());
    }
    let mut socket = initialize_client(&managed_remote(codex_home))?;
    request(
        &mut socket,
        2,
        "remoteControl/client/revoke",
        json!({
            "environmentId": environment_id,
            "clientId": client_id,
        }),
    )?;
    let _ = socket.close(None);
    Ok(())
}

pub fn start_turn(
    remote: &str,
    thread_id: &str,
    client_user_message_id: &str,
    prompt: &str,
) -> Result<(), String> {
    if thread_id.trim().is_empty() {
        return Err("Codex thread id is empty".to_string());
    }
    if prompt.trim().is_empty() {
        return Err("Codex callback prompt is empty".to_string());
    }

    let mut socket = initialize_client(remote)?;
    request(
        &mut socket,
        2,
        "turn/start",
        json!({
            "threadId": thread_id,
            "clientUserMessageId": client_user_message_id,
            "input": [{ "type": "text", "text": prompt }],
        }),
    )?;

    let _ = socket.close(None);
    let _ = socket.get_ref().shutdown(Shutdown::Both);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_snapshot(owned_threads: &[&str]) -> Arc<Mutex<AppServerSnapshotState>> {
        let mut state = AppServerSnapshotState {
            connection: ConnectionState {
                status: "connected".to_string(),
                version: Some(json!({ "serverInfo": { "version": "test" } })),
                last_error: None,
            },
            ..AppServerSnapshotState::default()
        };
        for thread_id in owned_threads {
            state
                .threads
                .insert((*thread_id).to_string(), ThreadState::default());
        }
        Arc::new(Mutex::new(state))
    }

    #[test]
    fn validates_native_settings_against_the_0147_model_catalog() {
        let catalog = vec![ModelCatalogEntry {
            id: "gpt-5.6".to_string(),
            is_default: true,
            efforts: vec!["low".to_string(), "high".to_string()],
            tiers: vec!["default".to_string(), "priority".to_string()],
            modalities: vec!["text".to_string(), "image".to_string()],
        }];
        assert!(validate_native_settings_catalog(&json!({
            "model": "gpt-5.6", "effort": "high", "serviceTier": "priority"
        }), &catalog).is_ok());
        assert!(validate_native_settings_catalog(&json!({ "effort": "high" }), &catalog).is_ok());
        assert_eq!(validate_native_settings_catalog(&json!({ "model": "missing" }), &catalog).unwrap_err(), "Codex model missing is unavailable");
        assert_eq!(validate_native_settings_catalog(&json!({ "effort": "max" }), &catalog).unwrap_err(), "Codex model gpt-5.6 does not support reasoning effort max");
        assert_eq!(validate_native_settings_catalog(&json!({ "serviceTier": "fast" }), &catalog).unwrap_err(), "Codex model gpt-5.6 does not support service tier fast");

        let exact_fixture = model_catalog_entry(json!({
            "id": "catalog-id", "model": "gpt-5.6", "isDefault": true,
            "supportedReasoningEfforts": [{ "reasoningEffort": "high" }],
            "serviceTiers": [{ "id": "priority" }],
            "defaultServiceTier": "default", "additionalSpeedTiers": ["fast", "priority"],
            "inputModalities": ["text", "image"],
        })).unwrap();
        assert_eq!(exact_fixture.tiers, vec!["priority", "default", "fast"]);
        assert!(validate_native_settings_catalog(&json!({ "model": "gpt-5.6", "serviceTier": "default" }), &[exact_fixture]).is_ok());
    }

    #[test]
    fn native_catalog_cache_is_short_lived() {
        let now = Instant::now();
        let catalog = CachedModelCatalog { fetched_at: now, catalog: Vec::new(), truncated: false };
        assert!(catalog_is_fresh(&catalog, now + MODEL_CATALOG_TTL - Duration::from_millis(1)));
        assert!(!catalog_is_fresh(&catalog, now + MODEL_CATALOG_TTL));
    }

    #[test]
    fn diagnostics_are_curated_and_sections_fail_independently() {
        let account = sanitize_account(&json!({
            "account": { "type": "chatgpt", "email": "person@example.com", "planType": "pro", "accessToken": "secret" },
            "requiresOpenaiAuth": true,
        }));
        assert_eq!(account.email.as_deref(), Some("person@example.com"));
        assert_eq!(account.plan.as_deref(), Some("pro"));
        assert!(!serde_json::to_string(&account).unwrap().contains("secret"));
        let config = sanitize_config(&json!({ "config": {
            "model": "gpt-5.6", "model_reasoning_effort": "high", "service_tier": "priority",
            "approval_policy": "on-request", "sandbox_mode": "workspace-write", "api_key": "secret"
        }}));
        assert_eq!(config.model.as_deref(), Some("gpt-5.6"));
        assert!(!serde_json::to_string(&config).unwrap().contains("secret"));
        let failed: DiagnosticsSection<DiagnosticsConfig> = DiagnosticsSection::failure("offline".to_string());
        assert_eq!(failed.error.as_deref(), Some("offline"));
        assert!(failed.data.is_none());
    }

    #[test]
    fn diagnostics_pagination_is_bounded_and_visible() {
        assert!(!diagnostics_page_limit_reached(DIAGNOSTICS_MAX_PAGES - 2));
        assert!(diagnostics_page_limit_reached(DIAGNOSTICS_MAX_PAGES - 1));
    }

    #[test]
    fn multiplexes_numeric_and_string_ids_around_notifications() {
        let snapshot = test_snapshot(&["thread-1"]);
        let (numeric_sender, numeric_receiver) = mpsc::channel();
        let (string_sender, string_receiver) = mpsc::channel();
        let mut pending = HashMap::from([
            (
                "n:2".to_string(),
                PendingCall {
                    method: "thread/read".to_string(),
                    params: json!({ "threadId": "thread-1" }),
                    reply: numeric_sender,
                },
            ),
            (
                "s:turn".to_string(),
                PendingCall {
                    method: "turn/start".to_string(),
                    params: json!({ "threadId": "thread-1" }),
                    reply: string_sender,
                },
            ),
        ]);

        let string_response = json!({ "id": "turn", "result": { "turn": { "id": "turn-2" } } });
        assert!(handle_response_envelope(
            &string_response,
            &request_id_key(&string_response["id"]).unwrap(),
            &mut pending,
            &snapshot,
        ));
        let unknown_notification = json!({
            "method": "future/notification",
            "params": { "threadId": "thread-1", "newField": { "kept": true } },
            "futureTopLevel": [1, 2, 3],
        });
        apply_notification(&unknown_notification, &snapshot);
        let numeric_response = json!({
            "id": 2,
            "result": { "thread": { "id": "thread-1", "status": "idle" } },
        });
        assert!(handle_response_envelope(
            &numeric_response,
            &request_id_key(&numeric_response["id"]).unwrap(),
            &mut pending,
            &snapshot,
        ));

        assert_eq!(
            string_receiver.recv().unwrap().unwrap(),
            string_response["result"]
        );
        assert_eq!(
            numeric_receiver.recv().unwrap().unwrap(),
            numeric_response["result"]
        );
        let recovered = snapshot.lock().unwrap().snapshot();
        assert_eq!(recovered.threads[0].active_turn.as_deref(), Some("turn-2"));
        assert!(recovered
            .recent_events
            .iter()
            .any(|event| event == &unknown_notification));
        assert_eq!(request_id_key(&json!(2)).unwrap(), "n:2");
        assert_eq!(request_id_key(&json!("2")).unwrap(), "s:2");
    }

    #[test]
    fn routes_known_server_requests_and_rejects_unknown_methods() {
        let snapshot = test_snapshot(&["thread-1"]);
        assert!(server_request_is_supported(
            "item/commandExecution/requestApproval",
            Some("thread-1"),
            &snapshot,
        ));
        assert!(!server_request_is_supported(
            "future/approval",
            Some("thread-1"),
            &snapshot,
        ));
        assert!(!server_request_is_supported(
            "item/commandExecution/requestApproval",
            Some("terminal-owned-thread"),
            &snapshot,
        ));
        assert_eq!(method_not_supported_error()["code"], -32601);

        snapshot
            .lock()
            .unwrap()
            .threads
            .get_mut("thread-1")
            .unwrap()
            .pending_server_requests
            .push(CodexAppServerServerRequest {
                request_id: json!(17),
                method: "item/commandExecution/requestApproval".to_string(),
                params: json!({ "threadId": "thread-1" }),
                thread_id: Some("thread-1".to_string()),
            });
        assert_eq!(
            take_server_request(&snapshot, &json!(17))
                .unwrap()
                .thread_id
                .as_deref(),
            Some("thread-1")
        );
    }

    #[test]
    fn validates_server_request_responses_against_the_stored_method() {
        let request = |method: &str, params: Value| CodexAppServerServerRequest {
            request_id: json!(1),
            method: method.to_string(),
            params,
            thread_id: Some("thread-1".to_string()),
        };
        let command = request("item/commandExecution/requestApproval", json!({}));
        assert!(validate_server_request_response(&command, &Some(json!({ "decision": "accept" })), &None).is_ok());
        assert!(validate_server_request_response(&command, &Some(json!({ "decision": "acceptForSession" })), &None).is_err());
        let file = request("item/fileChange/requestApproval", json!({}));
        assert!(validate_server_request_response(&file, &Some(json!({ "decision": "decline" })), &None).is_ok());
        let permissions = request("item/permissions/requestApproval", json!({}));
        assert!(validate_server_request_response(&permissions, &None, &Some(json!({ "code": -32000, "message": "Permission declined" }))).is_ok());
        assert!(validate_server_request_response(&permissions, &Some(json!({ "permissions": {} })), &None).is_err());
        let tool = request("item/tool/requestUserInput", json!({ "questions": [{ "id": "choice" }] }));
        assert!(validate_server_request_response(&tool, &Some(json!({ "answers": { "choice": { "answers": ["Read"] } } })), &None).is_ok());
        assert!(validate_server_request_response(&tool, &Some(json!({ "answers": { "other": { "answers": ["Read"] } } })), &None).is_err());
        let mcp = request("mcpServer/elicitation/request", json!({ "mode": "form" }));
        assert!(validate_server_request_response(&mcp, &Some(json!({ "action": "accept", "content": { "count": 2, "enabled": true } })), &None).is_ok());
        assert!(validate_server_request_response(&mcp, &Some(json!({ "action": "accept" })), &None).is_err());
        let mcp_url = request("mcpServer/elicitation/request", json!({ "mode": "url" }));
        assert!(validate_server_request_response(&mcp_url, &Some(json!({ "action": "cancel" })), &None).is_ok());
        assert!(validate_server_request_response(&mcp_url, &Some(json!({ "action": "accept", "content": {} })), &None).is_err());
        let unknown = request("future/request", json!({}));
        assert!(validate_server_request_response(&unknown, &Some(json!({})), &None).is_err());
        assert!(validate_server_request_response(&unknown, &None, &Some(json!({ "code": -32000, "message": "no" }))).is_err());
        assert!(validate_server_request_response(&command, &None, &Some(json!({ "code": "bad", "message": "no" }))).is_err());
    }

    #[test]
    fn server_request_is_retained_until_a_response_is_written_once() {
        let snapshot = test_snapshot(&["thread-1"]);
        snapshot
            .lock()
            .unwrap()
            .threads
            .get_mut("thread-1")
            .unwrap()
            .pending_server_requests
            .push(CodexAppServerServerRequest {
                request_id: json!(19),
                method: "item/tool/requestUserInput".to_string(),
                params: json!({ "threadId": "thread-1" }),
                thread_id: Some("thread-1".to_string()),
            });
        assert_eq!(consume_server_request_after_write(&snapshot, &json!(19), Err("write failed".to_string())).unwrap_err(), "write failed");
        assert!(has_server_request(&snapshot, &json!(19)));
        // A successful write consumes it exactly once.
        consume_server_request_after_write(&snapshot, &json!(19), Ok(())).unwrap();
        assert!(!has_server_request(&snapshot, &json!(19)));
        assert!(take_server_request(&snapshot, &json!(19)).is_none());
    }

    #[test]
    fn reduces_thread_and_turn_notifications_without_losing_unknown_fields() {
        let snapshot = test_snapshot(&["thread-1"]);
        let started = json!({
            "method": "turn/started",
            "params": {
                "threadId": "thread-1",
                "turn": { "id": "turn-1", "status": "inProgress", "items": [], "extension": "kept" },
            },
        });
        apply_notification(&started, &snapshot);
        let started_snapshot = snapshot.lock().unwrap().snapshot();
        assert_eq!(
            started_snapshot.threads[0].active_turn.as_deref(),
            Some("turn-1")
        );
        assert_eq!(
            started_snapshot.threads[0].status.as_deref(),
            Some("inProgress")
        );
        apply_notification(
            &json!({
                "method": "turn/completed",
                "params": {
                    "threadId": "thread-1",
                    "turn": {
                        "id": "turn-1",
                        "status": "failed",
                        "error": { "message": "approval rejected", "kind": "approval" },
                        "items": [],
                        "future": { "v": 1 },
                    },
                },
            }),
            &snapshot,
        );

        let recovered = snapshot.lock().unwrap().snapshot();
        assert_eq!(recovered.threads[0].active_turn, None);
        assert_eq!(recovered.threads[0].status.as_deref(), Some("failed"));
        assert_eq!(
            recovered.threads[0].last_error.as_deref(),
            Some("approval rejected")
        );
        assert_eq!(recovered.threads[0].event_sequence, 2);
        assert_eq!(
            recovered.threads[0].last_event.as_ref().unwrap()["params"]["turn"]["future"]["v"],
            1
        );
    }

    #[test]
    fn disconnect_fails_pending_and_reconnect_selects_only_owned_threads() {
        let snapshot = test_snapshot(&["thread-owned"]);
        let (sender, receiver) = mpsc::channel();
        let mut pending = HashMap::from([(
            "n:4".to_string(),
            PendingCall {
                method: "turn/start".to_string(),
                params: json!({ "threadId": "thread-owned" }),
                reply: sender,
            },
        )]);
        fail_pending_calls(&mut pending, "disconnected");
        assert_eq!(receiver.recv().unwrap().unwrap_err(), "disconnected");
        assert!(pending.is_empty());

        let reconnect = reconnect_requests(owned_thread_ids(&snapshot));
        assert_eq!(reconnect.len(), 2);
        assert!(reconnect
            .iter()
            .all(|(_, params)| params["threadId"] == "thread-owned"));
        assert_eq!(reconnect[0].0, "thread/resume");
        assert_eq!(reconnect[1].0, "thread/read");
    }

    #[test]
    fn snapshots_recover_state_without_reconnecting() {
        let snapshot = test_snapshot(&["thread-1"]);
        apply_response(
            "thread/read",
            &json!({ "threadId": "thread-1" }),
            &json!({ "thread": { "id": "thread-1", "status": "idle" } }),
            &snapshot,
        );
        let first = snapshot.lock().unwrap().snapshot();
        let second = snapshot.lock().unwrap().snapshot();
        assert_eq!(first.connection.status, "connected");
        assert_eq!(first.threads[0].status, second.threads[0].status);
        assert_eq!(
            first.threads[0].event_sequence,
            second.threads[0].event_sequence
        );
    }

    #[test]
    fn uses_the_shared_remote_enabled_daemon_socket() {
        let codex_home = Path::new("/Users/test/.codex");
        let socket = codex_home.join(DAEMON_SOCKET);
        let enabled = format!(
            r#"{{"remoteControlEnabled":true,"socketPath":"{}"}}"#,
            socket.display()
        );
        let started = format!(
            r#"{{"status":"started","socketPath":"{}"}}"#,
            socket.display()
        );

        let env =
            environment_from_daemon_outputs(codex_home, enabled.as_bytes(), started.as_bytes())
                .unwrap();

        assert_eq!(
            env["IMPALA_CODEX_APP_SERVER"],
            "unix:///Users/test/.codex/app-server-control/app-server-control.sock"
        );
        assert_eq!(
            env["IMPALA_CODEX_BIN"],
            "/Users/test/.codex/packages/standalone/current/codex"
        );
        assert!(environment_from_daemon_outputs(
            codex_home,
            br#"{"remoteControlEnabled":false,"socketPath":"/Users/test/.codex/app-server-control/app-server-control.sock"}"#,
            started.as_bytes(),
        )
        .is_err());
        assert!(is_managed_remote_in(
            "unix:///Users/test/.codex/app-server-control/app-server-control.sock",
            codex_home,
        ));
        assert!(!is_managed_remote_in(
            "unix:///tmp/app-server-control/app-server-control.sock",
            codex_home,
        ));
    }

    #[test]
    fn rejects_empty_turn_inputs_before_connecting() {
        assert_eq!(
            start_turn("unix:///tmp/codex.sock", "", "completion-1", "continue").unwrap_err(),
            "Codex thread id is empty"
        );
        assert_eq!(
            start_turn("unix:///tmp/codex.sock", "thread-1", "completion-1", " ").unwrap_err(),
            "Codex callback prompt is empty"
        );
    }

    #[test]
    fn rejects_empty_remote_management_inputs_before_connecting() {
        let codex_home = Path::new("/Users/test/.codex");

        assert_eq!(
            pairing_status(codex_home, " ").unwrap_err(),
            "Codex Remote pairing code is empty"
        );
        assert_eq!(
            revoke_client(codex_home, "environment-1", "").unwrap_err(),
            "Codex Remote environment and client are required"
        );
    }

    #[test]
    #[ignore = "requires a running Impala Codex app-server"]
    fn reads_remote_status_and_devices_from_a_live_server() {
        let codex_home = std::env::var("IMPALA_TEST_CODEX_HOME").unwrap();
        let snapshot = remote_snapshot(Path::new(&codex_home)).unwrap();

        assert_eq!(snapshot.status, "connected");
        assert!(snapshot.environment_id.is_some());
        assert!(!snapshot.clients.is_empty());
    }

    #[test]
    #[ignore = "requires a running Impala Codex app-server"]
    fn addresses_a_thread_through_a_live_server() {
        let remote = std::env::var("IMPALA_TEST_CODEX_APP_SERVER").unwrap();
        let mut creator = connect(&remote).unwrap();
        request(
            &mut creator,
            1,
            "initialize",
            json!({
                "clientInfo": {
                    "name": "impala-test",
                    "title": "Impala test",
                    "version": env!("CARGO_PKG_VERSION"),
                }
            }),
        )
        .unwrap();
        send_json(&mut creator, json!({ "method": "initialized" })).unwrap();
        let created = request(
            &mut creator,
            2,
            "thread/start",
            json!({ "cwd": std::env::current_dir().unwrap() }),
        )
        .unwrap();
        let thread_id = created["thread"]["id"].as_str().unwrap().to_string();
        creator.close(None).unwrap();

        let mut socket = initialize_client(&remote).unwrap();
        request(
            &mut socket,
            2,
            "thread/read",
            json!({ "threadId": thread_id, "includeTurns": false }),
        )
        .unwrap();
        socket.close(None).unwrap();
    }
}
