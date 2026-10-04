use std::sync::Arc;
use bridge_server::SharedState;
mod bridge_server;
mod dsh_watcher;
mod config;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_single_instance::init as single_instance_init;

pub struct StateInfo {
    pub port: std::sync::Mutex<u16>,
    pub bubble_seconds: u64,
}

/// 气泡窗尺寸（物理像素偏移用）

const BUBBLE_GAP: i32 = 20; // 字幕窗与宠物的间距

#[derive(Clone, serde::Serialize)]
pub struct SkinInfo {
    pub name: String,
    pub frame: u32,
    pub smooth: bool,
}

#[tauri::command]
fn get_state(state: tauri::State<'_, StateInfo>) -> serde_json::Value {
    let port = *state.port.lock().unwrap();
    serde_json::json!({
        "port": port,
        "bubbleSeconds": state.bubble_seconds,
        "skin": config::Config::load().skin
    })
}

/// 皮肤搜索目录：本地 skins/（用户自定义/可覆盖官方）优先，其次安装包内置资源。
fn skin_search_dirs(_app: &AppHandle) -> Vec<std::path::PathBuf> {
    let mut v = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            v.push(d.join("skins"));
            v.push(d.join("resources").join("skins"));
        }
    }
    v
}

fn list_skins_impl(app: &AppHandle) -> Vec<SkinInfo> {
    let mut by_name = std::collections::BTreeMap::new();
    for dir in skin_search_dirs(app) {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten() {
            if !e.path().is_dir() {
                continue;
            }
            let Ok(txt) = std::fs::read_to_string(e.path().join("manifest.json")) else {
                continue;
            };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else {
                continue;
            };
            let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("");
            if name.is_empty() || by_name.contains_key(name) {
                continue;
            }
            by_name.insert(
                name.to_string(),
                SkinInfo {
                    name: name.to_string(),
                    frame: v.get("frame").and_then(|x| x.as_u64()).unwrap_or(24) as u32,
                    smooth: v.get("smooth").and_then(|x| x.as_bool()).unwrap_or(false),
                },
            );
        }
    }
    by_name.into_values().collect()
}

#[tauri::command]
fn list_skins(app: AppHandle) -> Vec<SkinInfo> {
    list_skins_impl(&app)
}

/// 读取某皮肤的某状态精灵图，返回 PNG 字节（前端转 Blob 加载）。
#[tauri::command]
fn read_sheet(app: AppHandle, skin: String, state: String) -> Option<Vec<u8>> {
    // 防路径穿越
    if skin.contains("..") || skin.contains('/') || skin.contains('\\') {
        return None;
    }
    for dir in skin_search_dirs(&app) {
        let p = dir.join(&skin).join(format!("{state}.png"));
        if let Ok(data) = std::fs::read(p) {
            return Some(data);
        }
    }
    None
}

/// 切换到下一个皮肤并持久化，通知前端重载。
#[tauri::command]
fn cycle_skin(app: AppHandle) {
    let skins = list_skins_impl(&app);
    if skins.is_empty() {
        return;
    }
    let current = config::Config::load().skin;
    let idx = skins
        .iter()
        .position(|s| s.name == current)
        .map(|i| (i + 1) % skins.len())
        .unwrap_or(0);
    apply_skin(&app, skins[idx].clone());
}

fn apply_skin(app: &AppHandle, skin: SkinInfo) {
    config::update_config(|v| {
        v["skin"] = serde_json::json!(skin.name);
    });
    println!("[nekode] 皮肤切换 → {}", skin.name);
    let _ = app.emit("skin-changed", skin);
}

/// 设置面板写入：气泡时长 / 皮肤。
#[tauri::command]
fn set_config(app: AppHandle, bubble_seconds: Option<u64>, skin: Option<String>) {
    if let Some(bs) = bubble_seconds {
        config::update_config(|v| {
            v["bubble_seconds"] = serde_json::json!(bs);
        });
        let _ = app.emit("config-changed", serde_json::json!({ "bubbleSeconds": bs }));
    }
    if let Some(sk) = skin {
        if !sk.contains("..") && !sk.contains('/') && !sk.contains('\\') {
            if let Some(s) = list_skins_impl(&app).into_iter().find(|s| s.name == sk) {
                apply_skin(&app, s);
            }
        }
    }
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: AppHandle, enable: bool) {
    let al = app.autolaunch();
    let result = if enable { al.enable() } else { al.disable() };
    if let Err(e) = result {
        eprintln!("[nekode] 设置开机自启失败: {e}");
    }
}

fn place_default(pet: &WebviewWindow, bubble: &WebviewWindow) {
    let Ok(Some(monitor)) = pet.primary_monitor() else {
        return;
    };
    let Ok(ws) = pet.outer_size() else {
        return;
    };
    let ms = monitor.size();
    let x = ms.width as i32 - ws.width as i32 - 24;
    let y = ms.height as i32 - ws.height as i32 - 90;
    let _ = pet.set_position(tauri::PhysicalPosition::new(x, y));
    // 气泡定位用逻辑坐标（窗口高度随 DPI 缩放，物理偏移会造成重叠）
    let Ok(scale) = pet.scale_factor() else {
        return;
    };
    let logical: tauri::LogicalPosition<f64> = tauri::PhysicalPosition::new(x, y).to_logical(scale);
    let _ = bubble.set_position(tauri::LogicalPosition::new(
        logical.x + 50.0 - 210.0,
        logical.y - 150.0 - BUBBLE_GAP as f64,
    ));
}

#[tauri::command]
fn reset_position(app: AppHandle) {
    if let (Some(pet), Some(bubble)) = (
        app.get_webview_window("pet"),
        app.get_webview_window("bubble"),
    ) {
        place_default(&pet, &bubble);
    }
}

/// 打开设置面板（首次时创建窗口，之后复用）。
#[tauri::command]
fn open_settings(app: AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = tauri::webview::WebviewWindowBuilder::new(
        &app,
        "settings",
        WebviewUrl::App("index.html".into()),
    )
    .title("Nekode 设置")
    .inner_size(400.0, 540.0)
    .resizable(false)
    .center()
    .build();
}

/// 打开交互面板（v2/v3）：面板窗口在启动时已预建（主线程创建，避免后台线程建窗
/// 导致 webview 加载失败显示"localhost 拒绝连接"），这里只定位并显示。
pub fn open_panel(app: &AppHandle) {
    let Some(panel) = app.get_webview_window("panel") else {
        return;
    };
    position_panel(app, &panel);
    let _ = panel.show();
}

fn position_panel(app: &AppHandle, panel: &WebviewWindow) {
    let Some(pet) = app.get_webview_window("pet") else {
        return;
    };
    let Ok(pos) = pet.outer_position() else {
        return;
    };
    let Ok(scale) = pet.scale_factor() else {
        return;
    };
    let logical: tauri::LogicalPosition<f64> = pos.to_logical(scale);
    // 宠物窗 100 逻辑宽；面板 340 逻辑宽，水平居中于宠物，垂直叠在气泡上方
    let x = logical.x + 50.0 - 170.0;
    let y = logical.y - 124.0 - 20.0 - 320.0 - 4.0;
    let _ = panel.set_position(tauri::LogicalPosition::new(x, y));
}

/// v2：点击宠物 = 批准最早的授权类请求。
#[tauri::command]
fn click_approve(app: AppHandle, state: tauri::State<'_, Arc<SharedState>>) -> bool {
    let target = {
        let map = state.pending.lock().unwrap();
        map.values()
            .filter(|(r, res)| res.is_none() && r.kind == "approval")
            .map(|(r, _)| r.id.clone())
            .next()
    };
    match target {
        Some(id) => bridge_server::resolve_impl(&app, &state, &id, "approved"),
        None => false,
    }
}

/// v2/v3：面板点击解决请求。
#[tauri::command]
fn resolve_request(
    app: AppHandle,
    state: tauri::State<'_, Arc<SharedState>>,
    id: String,
    value: String,
) -> bool {
    bridge_server::resolve_impl(&app, &state, &id, &value)
}

/// v2/v3：面板加载时拉取未决请求。
#[tauri::command]
fn get_pending(state: tauri::State<'_, Arc<SharedState>>) -> Vec<bridge_server::PendingRequest> {
    let map = state.pending.lock().unwrap();
    map.values()
        .filter(|(_, res)| res.is_none())
        .map(|(r, _)| r.clone())
        .collect()
}

pub fn run() {
    let cfg = config::Config::load();
    let shared = std::sync::Arc::new(bridge_server::SharedState::default());
    tauri::Builder::default()
        .plugin(single_instance_init(|app, _args, _cwd| {
            show_all(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(StateInfo {
            port: std::sync::Mutex::new(0),
            bubble_seconds: cfg.bubble_seconds,
        })
        .manage(shared.clone())
        .invoke_handler(tauri::generate_handler![
            get_state,
            show_ctx_menu,
            list_skins,
            read_sheet,
            cycle_skin,
            set_config,
            get_autostart,
            set_autostart,
            reset_position,
            open_settings,
            resolve_request,
            click_approve,
            get_pending
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let actual_port = bridge_server::start(handle.clone(), cfg.port, shared.clone());
            *app.state::<StateInfo>().port.lock().unwrap() = actual_port;
            if actual_port != 0 {
                let _ = handle.emit("bridge-ready", serde_json::json!({ "port": actual_port }));
            }
            dsh_watcher::start(app.handle().clone());
            setup_bubble_window(app);
            register_ctx_menu_handler(app);
            build_tray(app)?;
            position_windows(app);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running nekode");
}

/// 气泡窗：永久免鼠标拦截（点击穿透），不抢焦点，拖动宠物时气泡与面板跟随。
fn setup_bubble_window(app: &tauri::App) {
    let Some(bubble) = app.get_webview_window("bubble") else {
        return;
    };
    let _ = bubble.set_ignore_cursor_events(true);
    let _ = bubble.set_focusable(false);
    if let Some(pet) = app.get_webview_window("pet") {
        let bubble2 = bubble.clone();
        let handle = app.handle().clone();
        let pet2 = pet.clone();
        pet.on_window_event(move |event| {
            if let WindowEvent::Moved(pos) = event {
                let scale = pet2.scale_factor().unwrap_or(1.0);
                let logical: tauri::LogicalPosition<f64> = pos.to_logical(scale);
                let _ = bubble2.set_position(tauri::LogicalPosition::new(
                    logical.x + 50.0 - 210.0,
                    logical.y - 150.0 - BUBBLE_GAP as f64,
                ));
                if let Some(panel) = handle.get_webview_window("panel") {
                    if panel.is_visible().unwrap_or(false) {
                        let _ = panel.set_position(tauri::LogicalPosition::new(
                            logical.x + 50.0 - 170.0,
                            logical.y - 150.0 - BUBBLE_GAP as f64 - 320.0 - 4.0,
                        ));
                    }
                }
            }
        });
    }
}

fn show_all(app: &AppHandle) {
    for label in ["pet", "bubble"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.show();
        }
    }
    if let Some(w) = app.get_webview_window("pet") {
        let _ = w.set_focus();
    }
}

fn hide_all(app: &AppHandle) {
    for label in ["pet", "bubble"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.hide();
        }
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示宠物", true, None::<&str>)?;
    let demo = MenuItem::with_id(app, "demo", "演示动画", true, None::<&str>)?;
    let skin = MenuItem::with_id(app, "tray-skin", "切换皮肤", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "tray-settings", "设置…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &demo, &skin, &settings, &quit])?;
    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().expect("missing window icon").clone())
        .tooltip("Nekode")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_all(app),
            "demo" => {
                let _ = app.emit("pet-demo", ());
            }
            "tray-skin" => cycle_skin(app.clone()),
            "tray-settings" => open_settings(app.clone()),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_all(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// 宠物右键菜单：原生菜单弹出，避免 100x100 小窗被 DOM 菜单撑爆。
/// 菜单事件处理器只在启动时注册一次（popup 每次新建菜单）。
fn register_ctx_menu_handler(app: &tauri::App) {
    let Some(pet) = app.get_webview_window("pet") else {
        return;
    };
    let handle = app.handle().clone();
    pet.on_menu_event(move |_window, event| match event.id.as_ref() {
        "ctx-demo" => {
            let _ = handle.emit("pet-demo", ());
        }
        "ctx-skin" => cycle_skin(handle.clone()),
        "ctx-settings" => open_settings(handle.clone()),
        "ctx-hide" => hide_all(&handle),
        "ctx-quit" => handle.exit(0),
        _ => {}
    });
}

#[tauri::command]
fn show_ctx_menu(app: AppHandle) {
    let Some(pet) = app.get_webview_window("pet") else {
        return;
    };
    let Ok(demo) = MenuItem::with_id(&app, "ctx-demo", "演示动画", true, None::<&str>) else {
        return;
    };
    let Ok(skin) = MenuItem::with_id(&app, "ctx-skin", "切换皮肤", true, None::<&str>) else {
        return;
    };
    let Ok(settings) = MenuItem::with_id(&app, "ctx-settings", "设置…", true, None::<&str>) else {
        return;
    };
    let Ok(hide) = MenuItem::with_id(&app, "ctx-hide", "隐藏到托盘", true, None::<&str>) else {
        return;
    };
    let Ok(quit) = MenuItem::with_id(&app, "ctx-quit", "退出", true, None::<&str>) else {
        return;
    };
    let Ok(menu) = Menu::with_items(&app, &[&demo, &skin, &settings, &hide, &quit]) else {
        return;
    };
    let _ = pet.popup_menu(&menu);
}

fn position_windows(app: &tauri::App) {
    let Some(pet) = app.get_webview_window("pet") else {
        return;
    };
    let Some(bubble) = app.get_webview_window("bubble") else {
        return;
    };
    place_default(&pet, &bubble);
}
