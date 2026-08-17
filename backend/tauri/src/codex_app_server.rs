use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
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

#[derive(Default)]
struct AppServerState {
    connection: ConnectionState,
    owned_threads: HashSet<String>,
}

#[derive(Default)]
struct ConnectionState {
    status: String,
    version: Option<Value>,
    last_error: Option<String>,
}

#[derive(Clone)]
pub struct CodexAppServerState {
    sender: mpsc::Sender<WorkerCommand>,
    state: Arc<Mutex<AppServerState>>,
    model_catalog: Arc<Mutex<Option<CachedModelCatalog>>>,
}

enum WorkerCommand {
    Request {
        method: String,
        params: Value,
        reply: mpsc::Sender<Result<Value, String>>,
    },
}

struct PendingCall {
    method: String,
    params: Value,
    reply: mpsc::Sender<Result<Value, String>>,
}

impl CodexAppServerState {
    pub fn new(app: tauri::AppHandle) -> Self {
        let (sender, receiver) = mpsc::channel();
        let state = Arc::new(Mutex::new(AppServerState {
            connection: ConnectionState {
                status: "offline".to_string(),
                ..ConnectionState::default()
            },
            ..AppServerState::default()
        }));
        let worker_state = state.clone();
        std::thread::spawn(move || app_server_worker(receiver, worker_state, app));
        Self { sender, state, model_catalog: Arc::new(Mutex::new(None)) }
    }

    fn diagnostics_connection(&self) -> Result<CodexDiagnosticsConnection, String> {
        self.state
            .lock()
            .map(|state| CodexDiagnosticsConnection {
                status: state.connection.status.clone(),
                version: safe_version(state.connection.version.as_ref()),
                error: state.connection.last_error.clone(),
            })
            .map_err(|_| "Codex app-server state lock poisoned".to_string())
    }

    /// Restore only durable Impala ownership. This never subscribes to an
    /// arbitrary Codex thread; recovery callers must provide DB-owned ids.
    pub fn adopt_thread(&self, thread_id: &str) -> Result<(), String> {
        if thread_id.trim().is_empty() {
            return Err("Codex app-server thread id is empty".to_string());
        }
        self.state
            .lock()
            .map_err(|_| "Codex app-server state lock poisoned".to_string())?
            .owned_threads
            .insert(thread_id.to_string());
        Ok(())
    }

    /// The generic protocol seam for managed app-server operations.
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

        let connection = self.diagnostics_connection().unwrap_or_else(|error| CodexDiagnosticsConnection {
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
        let impala = find_configured_mcp_server(&servers);
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
            .state
            .lock()
            .map_err(|_| "Codex app-server state lock poisoned".to_string())?
            .owned_threads
            .contains(thread_id);
        if owned {
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

fn find_configured_mcp_server(servers: &[DiagnosticsMcpServer]) -> Option<&DiagnosticsMcpServer> {
    servers
        .iter()
        .find(|server| server.name == crate::agent_config::CONFIGURED_MCP_SERVER_NAME)
}

fn app_server_worker(
    receiver: mpsc::Receiver<WorkerCommand>,
    state: Arc<Mutex<AppServerState>>,
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
                &state,
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
                    &state,
                    &app,
                ),
                Err(_) => break,
            }
            continue;
        };

        match active_socket.read() {
            Ok(Message::Text(text)) => match serde_json::from_str(text.as_str()) {
                Ok(envelope) => {
                    handle_envelope(envelope, active_socket, &mut pending, &state, &app)
                }
                Err(error) => record_connection_error(
                    &state,
                    format!("parse Codex app-server message: {error}"),
                ),
            },
            Ok(Message::Close(_)) => disconnect(
                &mut socket,
                &mut pending,
                &state,
                "Codex app-server disconnected".to_string(),
            ),
            Ok(_) => {}
            Err(error) if is_poll_timeout(&error) => {}
            Err(error) => disconnect(
                &mut socket,
                &mut pending,
                &state,
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
    state: &Arc<Mutex<AppServerState>>,
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
                    | "turn/start"
                    | "turn/interrupt"
            ) {
                let thread_id = params.get("threadId").and_then(Value::as_str);
                if !thread_id.map(|id| is_owned(state, id)).unwrap_or(false) {
                    let _ = reply.send(Err("Codex thread is not Impala-owned".to_string()));
                    return;
                }
            }
            if let Err(error) = ensure_connection(socket, pending, state, app, next_request_id) {
                record_connection_error(state, error.clone());
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
                    disconnect(socket, pending, state, error.clone());
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
    }
}

fn ensure_connection(
    socket: &mut Option<WebSocket<UnixStream>>,
    pending: &mut HashMap<String, PendingCall>,
    state: &Arc<Mutex<AppServerState>>,
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
    let initialized = wait_for_response(&mut connected, &initialize_id, pending, state, app)?;
    send_json(&mut connected, json!({ "method": "initialized" }))?;
    {
        let mut managed_state = state
            .lock()
            .map_err(|_| "Codex app-server state lock poisoned".to_string())?;
        managed_state.connection.status = "connected".to_string();
        managed_state.connection.version = Some(initialized);
        managed_state.connection.last_error = None;
    }
    *socket = Some(connected);
    reconnect_owned_threads(socket, pending, state, app, next_request_id);
    Ok(())
}

fn reconnect_owned_threads(
    socket: &mut Option<WebSocket<UnixStream>>,
    pending: &mut HashMap<String, PendingCall>,
    state: &Arc<Mutex<AppServerState>>,
    app: &tauri::AppHandle,
    next_request_id: &mut u64,
) {
    for (method, params) in reconnect_requests(owned_thread_ids(state)) {
        let Some(active_socket) = socket.as_mut() else {
            return;
        };
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
        let _ = wait_for_response(active_socket, &id, pending, state, app);
    }
}

fn wait_for_response(
    socket: &mut WebSocket<UnixStream>,
    expected_id: &Value,
    pending: &mut HashMap<String, PendingCall>,
    state: &Arc<Mutex<AppServerState>>,
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
                handle_envelope(envelope, socket, pending, state, app);
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
    state: &Arc<Mutex<AppServerState>>,
    app: &tauri::AppHandle,
) {
    if envelope.get("method").is_some() && envelope.get("id").is_some() {
        handle_server_request(envelope, socket);
        return;
    }
    if envelope.get("method").is_some() {
        handle_notification(envelope, app);
        return;
    }
    let Some(id) = envelope.get("id") else {
        record_connection_error(
            state,
            "Codex app-server message has no id or method".to_string(),
        );
        return;
    };
    let Ok(key) = request_id_key(id) else {
        record_connection_error(
            state,
            "Codex app-server response has unsupported id".to_string(),
        );
        return;
    };
    if !handle_response_envelope(&envelope, &key, pending, state) {
        handle_notification(envelope, app);
    }
}

fn handle_response_envelope(
    envelope: &Value,
    key: &str,
    pending: &mut HashMap<String, PendingCall>,
    state: &Arc<Mutex<AppServerState>>,
) -> bool {
    if let Some(call) = pending.remove(key) {
        let result = response_result(&envelope);
        if let Ok(value) = &result {
            apply_response(&call.method, &call.params, value, state);
        }
        let _ = call.reply.send(result);
        true
    } else {
        false
    }
}

fn handle_notification(
    envelope: Value,
    app: &tauri::AppHandle,
) {
    crate::automations::apply_native_codex_notification(app, &envelope);
}

fn handle_server_request(
    envelope: Value,
    socket: &mut WebSocket<UnixStream>,
) {
    let response = reject_server_request(&envelope);
    let _ = send_json(socket, response);
}

fn reject_server_request(envelope: &Value) -> Value {
    let request_id = envelope.get("id").cloned().unwrap_or(Value::Null);
    let error = method_not_supported_error();
    json!({ "id": request_id, "error": error })
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
    state: &Arc<Mutex<AppServerState>>,
) {
    if method != "thread/start" {
        return;
    }
    if let Some(thread_id) = thread_id_from(result).or_else(|| thread_id_from(params)) {
        if let Ok(mut managed_state) = state.lock() {
            managed_state.owned_threads.insert(thread_id);
        }
    }
}

fn disconnect(
    socket: &mut Option<WebSocket<UnixStream>>,
    pending: &mut HashMap<String, PendingCall>,
    state: &Arc<Mutex<AppServerState>>,
    error: String,
) {
    *socket = None;
    fail_pending_calls(pending, &error);
    if let Ok(mut managed_state) = state.lock() {
        managed_state.connection.status = "disconnected".to_string();
        managed_state.connection.last_error = Some(error.clone());
    }
}

fn fail_pending_calls(pending: &mut HashMap<String, PendingCall>, error: &str) {
    for (_, call) in pending.drain() {
        let _ = call.reply.send(Err(error.to_string()));
    }
}

fn record_connection_error(
    state: &Arc<Mutex<AppServerState>>,
    error: String,
) {
    if let Ok(mut managed_state) = state.lock() {
        managed_state.connection.last_error = Some(error.clone());
    }
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

fn is_owned(state: &Arc<Mutex<AppServerState>>, thread_id: &str) -> bool {
    state
        .lock()
        .map(|state| state.owned_threads.contains(thread_id))
        .unwrap_or(false)
}

fn owned_thread_ids(state: &Arc<Mutex<AppServerState>>) -> Vec<String> {
    state
        .lock()
        .map(|state| state.owned_threads.iter().cloned().collect())
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
) -> Result<Value, String> {
    if thread_id.trim().is_empty() {
        return Err("Codex thread id is empty".to_string());
    }
    if prompt.trim().is_empty() {
        return Err("Codex callback prompt is empty".to_string());
    }

    let mut socket = initialize_client(remote)?;
    let result = request(
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
    Ok(result)
}

pub fn steer_turn(
    remote: &str,
    thread_id: &str,
    expected_turn_id: &str,
    client_user_message_id: &str,
    prompt: &str,
) -> Result<(), String> {
    if thread_id.trim().is_empty() {
        return Err("Codex thread id is empty".to_string());
    }
    if expected_turn_id.trim().is_empty() {
        return Err("Codex expected turn id is empty".to_string());
    }
    if prompt.trim().is_empty() {
        return Err("Codex steer prompt is empty".to_string());
    }

    let mut socket = initialize_client(remote)?;
    request(
        &mut socket,
        2,
        "turn/steer",
        json!({
            "threadId": thread_id,
            "expectedTurnId": expected_turn_id,
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

    fn test_state(owned_threads: &[&str]) -> Arc<Mutex<AppServerState>> {
        let mut state = AppServerState {
            connection: ConnectionState {
                status: "connected".to_string(),
                version: Some(json!({ "serverInfo": { "version": "test" } })),
                last_error: None,
            },
            ..AppServerState::default()
        };
        for thread_id in owned_threads {
            state.owned_threads.insert((*thread_id).to_string());
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
    fn diagnostics_recognize_configured_impala_mcp_server() {
        let server = sanitize_mcp_server(json!({
            "name": "impala",
            "authStatus": "loggedIn",
            "tools": { "list_annotations": {} },
            "serverInfo": { "name": "impala-mcp" },
        }))
        .unwrap();

        let servers = vec![server];
        let selected = find_configured_mcp_server(&servers);

        assert_eq!(selected.map(|server| server.name.as_str()), Some("impala"));
    }

    #[test]
    fn multiplexes_numeric_and_string_rpc_responses() {
        let state = test_state(&["thread-1"]);
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
            &state,
        ));
        let numeric_response = json!({
            "id": 2,
            "result": { "thread": { "id": "thread-1", "status": "idle" } },
        });
        assert!(handle_response_envelope(
            &numeric_response,
            &request_id_key(&numeric_response["id"]).unwrap(),
            &mut pending,
            &state,
        ));

        assert_eq!(
            string_receiver.recv().unwrap().unwrap(),
            string_response["result"]
        );
        assert_eq!(
            numeric_receiver.recv().unwrap().unwrap(),
            numeric_response["result"]
        );
        assert_eq!(request_id_key(&json!(2)).unwrap(), "n:2");
        assert_eq!(request_id_key(&json!("2")).unwrap(), "s:2");
    }

    #[test]
    fn owned_server_requests_are_rejected_immediately() {
        let request = json!({
            "id": 17,
            "method": "item/commandExecution/requestApproval",
            "params": { "threadId": "thread-1" },
        });

        assert_eq!(
            reject_server_request(&request),
            json!({
                "id": 17,
                "error": {
                    "code": -32601,
                    "message": "Impala does not support this Codex app-server request",
                },
            }),
        );
    }

    #[test]
    fn disconnect_fails_pending_and_reconnect_selects_only_owned_threads() {
        let state = test_state(&["thread-owned"]);
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

        let reconnect = reconnect_requests(owned_thread_ids(&state));
        assert_eq!(reconnect.len(), 2);
        assert!(reconnect
            .iter()
            .all(|(_, params)| params["threadId"] == "thread-owned"));
        assert_eq!(reconnect[0].0, "thread/resume");
        assert_eq!(reconnect[1].0, "thread/read");
        apply_response(
            "thread/start",
            &json!({}),
            &json!({ "thread": { "id": "thread-created" } }),
            &state,
        );
        assert!(is_owned(&state, "thread-created"));
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
        assert_eq!(
            steer_turn("unix:///tmp/codex.sock", "thread-1", "", "steer-1", "continue").unwrap_err(),
            "Codex expected turn id is empty"
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
