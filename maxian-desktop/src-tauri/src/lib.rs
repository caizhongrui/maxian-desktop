/*---------------------------------------------------------------------------------------------
 *  码弦 Maxian Desktop — Tauri 入口
 *
 *  职责：
 *    1. 应用启动时拉起 maxian-server sidecar（Bun --compile 产出的单文件二进制）
 *       - 启动前检测端口：若已有进程占用，尝试 /health 探活，是自己就复用，不是就 kill
 *    2. 将监听地址 / 凭据通过 server_info 命令暴露给前端
 *    3. 应用退出时可靠地 kill sidecar：
 *       - 监听 WindowEvent::CloseRequested（关窗即 kill，不等 Exit）
 *       - 也在 RunEvent::Exit 兜底
 *       - Windows: taskkill /T /F 递归杀整棵进程树
 *       - Unix:    先 SIGTERM 让 Hono 优雅关闭，250ms 后 SIGKILL 保底
 *
 *  Sidecar 命名约定：
 *    bin/maxian-server-<rust-target-triple>[.exe]
 *    Tauri 按当前运行平台自动选择（由 externalBin 配置驱动）
 *--------------------------------------------------------------------------------------------*/

use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

struct ServerHandle(Mutex<Option<CommandChild>>);
struct ServerPid(Mutex<Option<u32>>);   // 备份 pid，即使 CommandChild 被 take 走也能最后一击

fn read_env_or_default(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

/// 硬 kill sidecar：Windows 用 taskkill /T /F 杀进程树，Unix 先 SIGTERM 后 SIGKILL。
/// 即便 CommandChild 已丢失，也能靠 pid 补杀。
fn hard_kill_sidecar(child: Option<CommandChild>, pid: Option<u32>) {
    if let Some(c) = child {
        // Tauri 的 kill() 封装（通常走 SIGKILL / TerminateProcess），调用一次
        let _ = c.kill();
    }
    if let Some(p) = pid {
        println!("[maxian-desktop] 硬 kill sidecar pid={}", p);
        #[cfg(target_os = "windows")]
        {
            // taskkill /T 递归杀子进程树，/F 强制
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &p.to_string(), "/T", "/F"])
                .output();
        }
        #[cfg(unix)]
        {
            // 先 SIGTERM 让 Hono 优雅关闭（释放端口）
            let _ = std::process::Command::new("kill")
                .args(["-TERM", &p.to_string()])
                .output();
            std::thread::sleep(Duration::from_millis(250));
            // 250ms 后如果还在，SIGKILL 强杀（同时杀掉子进程组 -pid）
            let _ = std::process::Command::new("kill")
                .args(["-KILL", &format!("-{}", p)])  // 杀整个进程组
                .output();
            let _ = std::process::Command::new("kill")
                .args(["-KILL", &p.to_string()])
                .output();
        }
    }
}

/// 启动前探活：检查端口是否已被占用，是的话尝试 /health 验证是我们的 server
/// 返回值：true=复用已有 server，跳过 spawn；false=端口空闲或已 kill 掉冲突进程，可以 spawn
fn probe_existing_server(port: &str, user: &str, pass: &str) -> bool {
    // 1. 试着连一下 /health
    let url = format!("http://127.0.0.1:{}/health", port);
    let auth = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", user, pass))
    };
    // 用 curl 做 HEAD 探活（避免引入 reqwest 依赖；Windows 10+ 已自带 curl.exe）
    let out = std::process::Command::new("curl")
        .args([
            "-s", "-o", "/dev/null",
            "-w", "%{http_code}",
            "--max-time", "2",
            "-H", &format!("Authorization: Basic {}", auth),
            &url,
        ])
        .output();
    if let Ok(o) = out {
        let code = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if code == "200" {
            println!("[maxian-desktop] 端口 {} 已有 maxian-server 响应 /health=200，复用它", port);
            return true;
        }
        if !code.is_empty() && code != "000" {
            // 是别的服务占着端口（401/403/等）
            eprintln!("[maxian-desktop] ⚠️ 端口 {} 被占用（HTTP {}），但不是我们的 maxian-server", port, code);
        }
    }
    false
}

fn spawn_server(app: &AppHandle) -> Result<CommandChild, String> {
    let port = read_env_or_default("MAXIAN_PORT", "4096");
    let user = read_env_or_default("MAXIAN_USER", "maxian");
    let pass = read_env_or_default("MAXIAN_PASS", "test123");

    // 启动前探活：端口已被自己占就复用
    if probe_existing_server(&port, &user, &pass) {
        return Err("__REUSE_EXISTING__".into());
    }

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
        .manage(ServerPid(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![server_info])
        .setup(|app| {
            let handle = app.handle().clone();
            match spawn_server(&handle) {
                Ok(child) => {
                    let pid = child.pid();
                    if let Some(state) = app.try_state::<ServerHandle>() {
                        if let Ok(mut guard) = state.0.lock() {
                            *guard = Some(child);
                        }
                    }
                    if let Some(state) = app.try_state::<ServerPid>() {
                        if let Ok(mut guard) = state.0.lock() {
                            *guard = Some(pid);
                        }
                    }
                }
                Err(e) => {
                    if e == "__REUSE_EXISTING__" {
                        // 复用已有 server，跳过 spawn（也不记录 pid，不 kill 它）
                        println!("[maxian-desktop] 跳过 spawn，使用已有 sidecar");
                    } else {
                        eprintln!("[maxian-desktop] {e}");
                    }
                }
            }

            // 监听每个窗口的 CloseRequested：关窗即 kill（不等 RunEvent::Exit）
            let h2 = app.handle().clone();
            if let Some(win) = app.get_webview_window("main") {
                win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { .. } = event {
                        println!("[maxian-desktop] 检测到 CloseRequested，kill sidecar");
                        let child = h2.try_state::<ServerHandle>()
                            .and_then(|s| s.0.lock().ok().and_then(|mut g| g.take()));
                        let pid = h2.try_state::<ServerPid>()
                            .and_then(|s| s.0.lock().ok().and_then(|g| *g));
                        hard_kill_sidecar(child, pid);
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri build failed")
        .run(|app, event| {
            // 兜底：Exit 时也 kill 一次（窗口 CloseRequested 没来得及触发时保命）
            if let RunEvent::Exit = event {
                let child = app.try_state::<ServerHandle>()
                    .and_then(|s| s.0.lock().ok().and_then(|mut g| g.take()));
                let pid = app.try_state::<ServerPid>()
                    .and_then(|s| s.0.lock().ok().and_then(|g| *g));
                hard_kill_sidecar(child, pid);
            }
        });
}
