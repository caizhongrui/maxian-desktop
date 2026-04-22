/*---------------------------------------------------------------------------------------------
 *  码弦 Maxian Desktop — Tauri 入口
 *
 *  职责：
 *    1. 应用启动时拉起 maxian-server sidecar（Bun --compile 产出的单文件二进制）
 *    2. 将监听地址 / 凭据通过 server_info 命令暴露给前端
 *    3. 应用退出时关闭子进程
 *
 *  Sidecar 命名约定：
 *    bin/maxian-server-<rust-target-triple>[.exe]
 *    Tauri 会按当前运行平台自动选择正确的二进制（由 externalBin 配置驱动）
 *--------------------------------------------------------------------------------------------*/

use std::sync::Mutex;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

struct ServerHandle(Mutex<Option<CommandChild>>);

fn read_env_or_default(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn spawn_server(app: &AppHandle) -> Result<CommandChild, String> {
    let port = read_env_or_default("MAXIAN_PORT", "4096");
    let user = read_env_or_default("MAXIAN_USER", "maxian");
    let pass = read_env_or_default("MAXIAN_PASS", "test123");

    let sidecar = app
        .shell()
        .sidecar("maxian-server")
        .map_err(|e| format!("创建 sidecar 失败（检查 externalBin 是否包含 bin/maxian-server）: {e}"))?
        .args([
            "--port", &port,
            "--host", "127.0.0.1",
            "--cors",
            "--username", &user,
            "--password", &pass,
        ]);

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("启动 maxian-server sidecar 失败: {e}"))?;

    let pid = child.pid();
    println!("[maxian-desktop] sidecar 已启动 pid={} port={}", pid, port);

    // 后台消费子进程 stdout/stderr，透传到本进程（便于开发时查看日志）
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(data) => {
                    if let Ok(line) = String::from_utf8(data) {
                        print!("{line}");
                    }
                }
                CommandEvent::Stderr(data) => {
                    if let Ok(line) = String::from_utf8(data) {
                        eprint!("{line}");
                    }
                }
                CommandEvent::Terminated(payload) => {
                    println!(
                        "[maxian-desktop] sidecar 已退出 code={:?} signal={:?}",
                        payload.code, payload.signal
                    );
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(child)
}

#[tauri::command]
fn server_info() -> serde_json::Value {
    serde_json::json!({
        "baseUrl": format!(
            "http://127.0.0.1:{}",
            std::env::var("MAXIAN_PORT").unwrap_or_else(|_| "4096".into())
        ),
        "username": std::env::var("MAXIAN_USER").unwrap_or_else(|_| "maxian".into()),
        "password": std::env::var("MAXIAN_PASS").unwrap_or_else(|_| "test123".into()),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_fs::init())
        .manage(ServerHandle(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![server_info])
        .setup(|app| {
            // 启动时拉起 sidecar（setup 能拿到 AppHandle）
            let handle = app.handle().clone();
            match spawn_server(&handle) {
                Ok(child) => {
                    if let Some(state) = app.try_state::<ServerHandle>() {
                        if let Ok(mut guard) = state.0.lock() {
                            *guard = Some(child);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[maxian-desktop] {e}");
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri build failed")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<ServerHandle>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(child) = guard.take() {
                            let _ = child.kill();
                            println!("[maxian-desktop] 已停止 maxian-server");
                        }
                    }
                }
            }
        });
}
