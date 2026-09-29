//! Desktop bridge: persists the bridge config and runs agent CLIs (Claude Code,
//! Codex, …) headlessly, streaming their JSON-lines output to the webview.
//! The webview builds each CLI's arguments and interprets its events.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{Mutex, Notify},
};

#[derive(Default)]
pub struct Runs(Mutex<HashMap<String, Arc<Notify>>>);

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BridgeConfig {
    pub service_key: String,
    pub workspace: String,
    pub permission_mode: String,
    pub claude_path: String,
    /// Legacy single-chat session; moved onto the first Claude chat on upgrade.
    pub session_id: String,
    pub model: String,
    pub codex_path: String,
    pub codex_model: String,
}

/// `~/.relay/bridge.json`. Kept out of AppData so tools running inside
/// packaged (MSIX) apps, like the Claude desktop app, see the same file.
fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(home.join(".relay").join("bridge.json"))
}

#[tauri::command]
pub async fn load_config(app: AppHandle) -> Result<BridgeConfig, String> {
    let path = config_path(&app)?;
    match tokio::fs::read_to_string(&path).await {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("Invalid {}: {e}", path.display())),
        Err(_) => Ok(BridgeConfig::default()),
    }
}

#[tauri::command]
pub async fn save_config(app: AppHandle, config: BridgeConfig) -> Result<(), String> {
    let path = config_path(&app)?;
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    tokio::fs::write(&path, text).await.map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    machine: String,
    home: String,
    claude_path: Option<String>,
    codex_path: Option<String>,
}

/// Parses "2.1.281" into comparable parts; non-version dirs sort first.
fn version_key(name: &str) -> Vec<u64> {
    name.split('.').map(|p| p.parse().unwrap_or(0)).collect()
}

fn newest_in(dir: PathBuf) -> Option<PathBuf> {
    let mut best: Option<(Vec<u64>, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let exe = entry.path().join(if cfg!(windows) { "claude.exe" } else { "claude" });
        if !exe.is_file() {
            continue;
        }
        let key = version_key(&entry.file_name().to_string_lossy());
        if best.as_ref().map_or(true, |(k, _)| key > *k) {
            best = Some((key, exe));
        }
    }
    best.map(|(_, p)| p)
}

/// Finds a Claude Code CLI: standalone install, PATH, or the copy bundled
/// with the Claude desktop app (including its MSIX-virtualized location).
fn find_claude() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "claude.exe" } else { "claude" };
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from);
    if let Some(h) = &home {
        let p = h.join(".local").join("bin").join(exe);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let p = dir.join(exe);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let mut roots = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(appdata).join("Claude").join("claude-code"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let packages = PathBuf::from(local).join("Packages");
        if let Ok(entries) = std::fs::read_dir(&packages) {
            for e in entries.flatten() {
                if e.file_name().to_string_lossy().starts_with("Claude_") {
                    roots.push(e.path().join("LocalCache").join("Roaming").join("Claude").join("claude-code"));
                }
            }
        }
    }
    roots.into_iter().filter_map(newest_in).next()
}

/// Looks for `name` up to `depth` directories below `dir`.
fn find_below(dir: &Path, name: &str, depth: u32) -> Option<PathBuf> {
    let p = dir.join(name);
    if p.is_file() {
        return Some(p);
    }
    if depth == 0 {
        return None;
    }
    std::fs::read_dir(dir).ok()?.flatten().filter(|e| e.path().is_dir()).find_map(|e| find_below(&e.path(), name, depth - 1))
}

/// Finds the Codex CLI. Prefers the native binary inside the npm package over the
/// `codex.cmd` shim, so cancelling a task kills Codex itself and not just cmd.exe.
fn find_codex() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "codex.exe" } else { "codex" };
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let p = dir.join(exe);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let mut npm_roots = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        npm_roots.push(PathBuf::from(appdata).join("npm"));
    }
    if let Some(prefix) = std::env::var_os("NPM_CONFIG_PREFIX") {
        npm_roots.push(PathBuf::from(prefix));
    }
    for root in &npm_roots {
        if let Some(p) = find_below(&root.join("node_modules").join("@openai"), exe, 6) {
            return Some(p);
        }
    }
    if let Some(h) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from) {
        for p in [h.join(".local").join("bin").join(exe), h.join(".cargo").join("bin").join(exe)] {
            if p.is_file() {
                return Some(p);
            }
        }
    }
    if cfg!(windows) {
        for root in &npm_roots {
            let p = root.join("codex.cmd");
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

#[tauri::command]
pub fn host_info() -> HostInfo {
    let machine = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "this PC".into());
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
    HostInfo {
        machine,
        home,
        claude_path: find_claude().map(|p| p.to_string_lossy().into_owned()),
        codex_path: find_codex().map(|p| p.to_string_lossy().into_owned()),
    }
}


#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunArgs {
    run_id: String,
    program: String,
    args: Vec<String>,
    cwd: String,
    /// Written to stdin, then closed. Prompts go this way to avoid quoting issues.
    stdin: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunEvent {
    run_id: String,
    event: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    exit_code: Option<i32>,
    stderr: String,
    cancelled: bool,
}

/// Runs an agent CLI and emits each JSON line it prints as an `agent-event`.
#[tauri::command]
pub async fn run_agent(app: AppHandle, runs: State<'_, Runs>, args: RunArgs) -> Result<RunResult, String> {
    let mut cmd = Command::new(&args.program);
    cmd.args(&args.args)
        .current_dir(&args.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let mut child = cmd.spawn().map_err(|e| format!("Could not start {}: {e}", args.program))?;

    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    if let Some(input) = &args.stdin {
        stdin.write_all(input.as_bytes()).await.map_err(|e| e.to_string())?;
    }
    drop(stdin);

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;
    let stderr_task = tauri::async_runtime::spawn(async move {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s).await;
        s
    });

    let cancel = Arc::new(Notify::new());
    runs.0.lock().await.insert(args.run_id.clone(), cancel.clone());

    let mut lines = BufReader::new(stdout).lines();
    let mut cancelled = false;
    loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(line)) => {
                    let Ok(event) = serde_json::from_str::<Value>(line.trim()) else { continue };
                    let _ = app.emit("agent-event", RunEvent { run_id: args.run_id.clone(), event });
                }
                _ => break,
            },
            _ = cancel.notified() => {
                cancelled = true;
                let _ = child.kill().await;
                break;
            }
        }
    }

    let status = child.wait().await.ok();
    runs.0.lock().await.remove(&args.run_id);
    let stderr = stderr_task.await.unwrap_or_default();
    Ok(RunResult { exit_code: status.and_then(|s| s.code()), stderr, cancelled })
}

#[tauri::command]
pub async fn cancel_agent(runs: State<'_, Runs>, run_id: String) -> Result<bool, String> {
    match runs.0.lock().await.get(&run_id) {
        Some(n) => {
            n.notify_one();
            Ok(true)
        }
        None => Ok(false),
    }
}
