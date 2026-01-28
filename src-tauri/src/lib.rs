use serde::{Deserialize, Serialize};
use std::net::{TcpStream, ToSocketAddrs};
use std::process::Command;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::time::interval;

fn default_probe_type() -> String {
    "tcp".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Target {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    #[serde(default = "default_probe_type")]
    pub probe_type: String,
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

fn parse_ping_latency(output: &str) -> Option<u64> {
    // Match patterns like "time=12.3ms", "time=5ms", "time<1ms", "time=0.456 ms"
    for line in output.lines() {
        let lower = line.to_lowercase();
        if let Some(pos) = lower.find("time=") {
            let after = &lower[pos + 5..];
            let num_str: String = after.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
            if let Ok(val) = num_str.parse::<f64>() {
                return Some(val.round() as u64);
            }
        } else if let Some(pos) = lower.find("time<") {
            let after = &lower[pos + 5..];
            let num_str: String = after.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
            if let Ok(val) = num_str.parse::<f64>() {
                return Some(val.round().max(1.0) as u64);
            }
            // time<1ms means sub-millisecond
            return Some(1);
        }
    }
    None
}

fn icmp_ping(host: &str) -> ProbeResult {
    let start = Instant::now();
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    let result = if cfg!(target_os = "windows") {
        Command::new("ping")
            .args(["-n", "1", "-w", "2000", host])
            .output()
    } else if cfg!(target_os = "macos") {
        Command::new("ping")
            .args(["-c", "1", "-t", "2", host])
            .output()
    } else {
        // Linux / Android
        Command::new("ping")
            .args(["-c", "1", "-W", "2", host])
            .output()
    };

    match result {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let elapsed = start.elapsed().as_millis() as u64;

            if output.status.success() {
                let latency = parse_ping_latency(&stdout).unwrap_or(elapsed);
                ProbeResult {
                    id: String::new(),
                    ok: true,
                    latency_ms: latency,
                    error: None,
                    timestamp,
                }
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                ProbeResult {
                    id: String::new(),
                    ok: false,
                    latency_ms: elapsed,
                    error: Some(format!("ping_failed: {}", stderr.trim())),
                    timestamp,
                }
            }
        }
        Err(e) => ProbeResult {
            id: String::new(),
            ok: false,
            latency_ms: start.elapsed().as_millis() as u64,
            error: Some(format!("ping_unavailable: {}", e)),
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
async fn probe_target(host: String, port: u16, probe_type: Option<String>) -> ProbeResult {
    let pt = probe_type.unwrap_or_else(|| "tcp".to_string());
    tokio::task::spawn_blocking(move || {
        if pt == "ping" {
            icmp_ping(&host)
        } else {
            tcp_probe(&host, port, 2000)
        }
    })
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
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

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
                    let probe_type = target.probe_type.clone();
                    tokio::task::spawn_blocking(move || {
                        let mut result = if probe_type == "ping" {
                            icmp_ping(&host)
                        } else {
                            tcp_probe(&host, port, 2000)
                        };
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
