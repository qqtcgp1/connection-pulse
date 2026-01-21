use serde::{Deserialize, Serialize};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::time::interval;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Target {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProbeResult {
    pub id: String,
    pub ok: bool,
    pub latency_ms: u64,
    pub error: Option<String>,
    pub timestamp: u64,
}

#[derive(Default)]
pub struct AppState {
    pub targets: RwLock<Vec<Target>>,
}

fn tcp_probe(host: &str, port: u16, timeout_ms: u64) -> ProbeResult {
    let addr = format!("{}:{}", host, port);
    let start = Instant::now();
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    let resolved = match addr.to_socket_addrs() {
        Ok(mut addrs) => match addrs.next() {
            Some(a) => a,
            None => {
                return ProbeResult {
                    id: String::new(),
                    ok: false,
                    latency_ms: start.elapsed().as_millis() as u64,
                    error: Some("dns_failed".into()),
                    timestamp,
                }
            }
        },
        Err(e) => {
            return ProbeResult {
                id: String::new(),
                ok: false,
                latency_ms: start.elapsed().as_millis() as u64,
                error: Some(format!("dns_error: {}", e)),
                timestamp,
            }
        }
    };

    match TcpStream::connect_timeout(&resolved, Duration::from_millis(timeout_ms)) {
        Ok(_) => ProbeResult {
            id: String::new(),
            ok: true,
            latency_ms: start.elapsed().as_millis() as u64,
            error: None,
            timestamp,
        },
        Err(e) => ProbeResult {
            id: String::new(),
            ok: false,
            latency_ms: start.elapsed().as_millis() as u64,
            error: Some(e.to_string()),
            timestamp,
        },
    }
}

#[tauri::command]
fn get_targets(state: tauri::State<'_, Arc<AppState>>) -> Vec<Target> {
    state.targets.read().unwrap().clone()
}

#[tauri::command]
fn set_targets(state: tauri::State<'_, Arc<AppState>>, targets: Vec<Target>) {
    let mut t = state.targets.write().unwrap();
    *t = targets;
}

#[tauri::command]
async fn probe_target(host: String, port: u16) -> ProbeResult {
    tokio::task::spawn_blocking(move || tcp_probe(&host, port, 2000))
        .await
        .unwrap_or_else(|_| ProbeResult {
            id: String::new(),
            ok: false,
            latency_ms: 0,
            error: Some("task_failed".into()),
            timestamp: 0,
        })
}

fn start_probe_loop(app: AppHandle, state: Arc<AppState>) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = interval(Duration::from_secs(5));

        loop {
            ticker.tick().await;

            let targets = {
                let t = state.targets.read().unwrap();
                t.clone()
            };

            if targets.is_empty() {
                continue;
            }

            // Run probes concurrently (up to 20 at a time)
            let handles: Vec<_> = targets
                .into_iter()
                .map(|target| {
                    let host = target.host.clone();
                    let port = target.port;
                    let id = target.id.clone();
                    tokio::task::spawn_blocking(move || {
                        let mut result = tcp_probe(&host, port, 2000);
                        result.id = id;
                        result
                    })
                })
                .collect();

            for handle in handles {
                if let Ok(result) = handle.await {
                    let _ = app.emit("probe:update", &result);
                }
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = Arc::new(AppState::default());
    let state_clone = state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![get_targets, set_targets, probe_target])
        .setup(move |app| {
            let handle = app.handle().clone();
            start_probe_loop(handle, state_clone);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
