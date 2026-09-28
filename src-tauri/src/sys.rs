//! Live machine telemetry for the desktop dashboard (CPU, memory, network).

use serde::Serialize;
use std::sync::Mutex;
use sysinfo::{Networks, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::State;

pub struct Sys(Mutex<(System, Networks)>);

impl Default for Sys {
    fn default() -> Self {
        Sys(Mutex::new((System::new(), Networks::new_with_refreshed_list())))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SysStats {
    /// Overall CPU usage, 0–100.
    cpu: f32,
    /// Per-core CPU usage, 0–100.
    cores: Vec<f32>,
    mem_used: u64,
    mem_total: u64,
    /// Bytes received/sent across all interfaces since the previous call.
    rx: u64,
    tx: u64,
    uptime: u64,
    processes: usize,
    os: String,
}

/// CPU figures are deltas between calls, so poll this on an interval (~1s).
#[tauri::command]
pub fn sys_stats(state: State<'_, Sys>) -> SysStats {
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let (sys, nets) = &mut *guard;
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    nets.refresh(true);
    let (rx, tx) = nets.iter().fold((0, 0), |(r, t), (_, n)| (r + n.received(), t + n.transmitted()));
    SysStats {
        cpu: sys.global_cpu_usage(),
        cores: sys.cpus().iter().map(|c| c.cpu_usage()).collect(),
        mem_used: sys.used_memory(),
        mem_total: sys.total_memory(),
        rx,
        tx,
        uptime: System::uptime(),
        processes: sys.processes().len(),
        os: System::long_os_version().unwrap_or_default(),
    }
}

/// Keeps the display (and PC) awake while the console is on show. Sync commands run on
/// the main thread, which lives for the whole app, so the continuous flag sticks.
#[tauri::command]
pub fn keep_awake(on: bool) {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED};
        SetThreadExecutionState(if on { ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED } else { ES_CONTINUOUS });
    }
    #[cfg(not(windows))]
    let _ = on;
}
