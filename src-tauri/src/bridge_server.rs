//! 事件桥：监听 127.0.0.1，把各 agent 钩子发来的事件转发给宠物界面。
//! GET /e?agent=..&event=..&msg=..     —— 钩子里一行 curl 即可接入
//! GET /health                         —— 探活
//! POST /event {agent,event,msg}       —— JSON 接入
//! POST /ask {agent,kind,message,options,timeout} —— v2/v3 交互请求（授权/选择题）
//! GET  /result?id=                    —— 轮询交互请求结果
//! POST /resolve {id,value}            —— 解决交互请求（等价于面板点击）
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
use tiny_http::{Header, Method, Response, Server};

#[derive(Clone, Debug, Serialize)]
pub struct PetEvent {
    pub agent: String,
    pub event: String,
    pub msg: Option<String>,
    pub ts: u64,
}

/// v2/v3：待决交互请求（授权 / 选择题）
#[derive(Clone, Debug, Serialize)]
pub struct PendingRequest {
    pub id: String,
    pub agent: String,
    pub kind: String, // approval | choice
    pub message: String,
    pub options: Vec<String>,
    pub timeout_sec: u64,
    pub created: u64,
}

#[derive(Default)]
pub struct SharedState {
    /// id -> (请求, 结果)
    pub pending: Mutex<HashMap<String, (PendingRequest, Option<String>)>>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 在 port 起连续尝试 20 个端口，返回实际监听的端口（0 表示失败）。
pub fn start(app: tauri::AppHandle, port: u16, state: Arc<SharedState>) -> u16 {
    let last = port.saturating_add(20);
    for p in port..last {
        match Server::http(("127.0.0.1", p)) {
            Ok(server) => {
                println!("[nekode] 事件桥已启动: http://127.0.0.1:{p}");
                std::thread::spawn(move || serve(app, server, state));
                return p;
            }
            Err(_) => continue,
        }
    }
    eprintln!("[nekode] 端口 {port}~{} 均被占用，事件桥未启动", last - 1);
    0
}

fn serve(app: tauri::AppHandle, server: Server, state: Arc<SharedState>) {
    let json_header =
        Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).expect("static header");

    for mut request in server.incoming_requests() {
        let method = request.method().clone();
        let url = request.url().to_string();
        let (path, query) = match url.split_once('?') {
            Some((p, q)) => (p, Some(q)),
            None => (url.as_str(), None),
        };

        let mut event: Option<PetEvent> = None;

        match (&method, path) {
            (Method::Get, "/health") => {
                let body = serde_json::json!({ "ok": true, "app": "nekode", "ts": now_ms() });
                let _ = request.respond(
                    Response::from_string(body.to_string()).with_header(json_header.clone()),
                );
            }
            (Method::Get, "/e") => {
                let mut agent = String::new();
                let mut ev = String::new();
                let mut msg = String::new();
                if let Some(q) = query {
                    for pair in q.split('&') {
                        let Some((k, v)) = pair.split_once('=') else {
                            continue;
                        };
                        let val = percent_encoding::percent_decode_str(v)
                            .decode_utf8_lossy()
                            .replace('+', " ");
                        match k {
                            "agent" => agent = val,
                            "event" => ev = val,
                            "msg" => msg = val,
                            _ => {}
                        }
                    }
                }
                if !agent.is_empty() && !ev.is_empty() {
                    event = Some(PetEvent {
                        agent,
                        event: ev,
                        msg: (!msg.is_empty()).then_some(msg),
                        ts: now_ms(),
                    });
                }
                let _ = request.respond(
                    Response::from_string("{\"ok\":true}").with_header(json_header.clone()),
                );
            }
            (Method::Post, "/event") => {
                let mut body = String::new();
                let _ = std::io::Read::read_to_string(request.as_reader(), &mut body);
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
                    let agent = v
                        .get("agent")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let ev = v
                        .get("event")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let msg = v.get("msg").and_then(|x| x.as_str()).map(|s| s.to_string());
                    if !agent.is_empty() && !ev.is_empty() {
                        event = Some(PetEvent {
                            agent,
                            event: ev,
                            msg,
                            ts: now_ms(),
                        });
                    }
                }
                let _ = request.respond(
                    Response::from_string("{\"ok\":true}").with_header(json_header.clone()),
                );
            }
            (Method::Post, "/ask") => {
                let mut body = String::new();
                let _ = std::io::Read::read_to_string(request.as_reader(), &mut body);
                let resp = match parse_ask(&body) {
                    Ok(mut req) => {
                        req.id = format!("q{}-{}", now_ms(), state.pending.lock().unwrap().len());
                        let id = req.id.clone();
                        {
                            let mut map = state.pending.lock().unwrap();
                            map.retain(|_, (r, res)| {
                                res.is_some()
                                    || now_ms().saturating_sub(r.created) <= r.timeout_sec * 1000
                            });
                            map.insert(id.clone(), (req.clone(), None));
                        }
                        println!("[nekode] 交互请求 {} {}: {}", req.kind, req.agent, req.message);
                        let count = state.pending.lock().unwrap().len();
                        let _ = app.emit(
                            "pet-question",
                            serde_json::json!({ "request": req, "count": count }),
                        );
                        crate::open_panel(&app);
                        serde_json::json!({ "ok": true, "id": id }).to_string()
                    }
                    Err(e) => serde_json::json!({ "ok": false, "error": e }).to_string(),
                };
                let _ = request.respond(Response::from_string(resp).with_header(json_header.clone()));
            }
            (Method::Get, "/result") => {
                let mut id = String::new();
                if let Some(q) = query {
                    for pair in q.split('&') {
                        if let Some((k, v)) = pair.split_once('=') {
                            if k == "id" {
                                id = percent_encoding::percent_decode_str(v)
                                    .decode_utf8_lossy()
                                    .to_string();
                            }
                        }
                    }
                }
                let resp = {
                    let mut map = state.pending.lock().unwrap();
                    match map.get_mut(&id) {
                        Some((req, res)) => {
                            if let Some(v) = res.clone() {
                                map.remove(&id);
                                serde_json::json!({ "status": "resolved", "value": v }).to_string()
                            } else if now_ms().saturating_sub(req.created) > req.timeout_sec * 1000 {
                                map.remove(&id);
                                serde_json::json!({ "status": "timeout" }).to_string()
                            } else {
                                serde_json::json!({ "status": "pending" }).to_string()
                            }
                        }
                        None => serde_json::json!({ "status": "unknown" }).to_string(),
                    }
                };
                let _ = request.respond(Response::from_string(resp).with_header(json_header.clone()));
            }
            (Method::Post, "/resolve") => {
                let mut body = String::new();
                let _ = std::io::Read::read_to_string(request.as_reader(), &mut body);
                let resp = match serde_json::from_str::<serde_json::Value>(&body) {
                    Ok(v) => {
                        let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                        let value =
                            v.get("value").and_then(|x| x.as_str()).unwrap_or("").to_string();
                        if resolve_impl(&app, &state, &id, &value) {
                            serde_json::json!({ "ok": true }).to_string()
                        } else {
                            serde_json::json!({ "ok": false, "error": "unknown or already resolved" })
                                .to_string()
                        }
                    }
                    Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }).to_string(),
                };
                let _ = request.respond(Response::from_string(resp).with_header(json_header.clone()));
            }
            _ => {
                let _ = request.respond(
                    Response::from_string("{\"ok\":false,\"error\":\"not found\"}")
                        .with_header(json_header.clone())
                        .with_status_code(404),
                );
            }
        }

        if let Some(e) = event {
            println!("[nekode] {} {}: {:?}", e.agent, e.event, e.msg);
            let _ = app.emit("pet-event", e);
        }
    }
}

fn parse_ask(body: &str) -> Result<PendingRequest, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("invalid json: {e}"))?;
    let agent = v
        .get("agent")
        .and_then(|x| x.as_str())
        .unwrap_or("unknown")
        .to_string();
    let kind = v
        .get("kind")
        .and_then(|x| x.as_str())
        .unwrap_or("approval")
        .to_string();
    if kind != "approval" && kind != "choice" {
        return Err("kind must be approval or choice".into());
    }
    let message = v
        .get("message")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    if message.is_empty() {
        return Err("message required".into());
    }
    let options: Vec<String> = v
        .get("options")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|o| o.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    if kind == "choice" && options.len() < 2 {
        return Err("choice requires at least 2 options".into());
    }
    let timeout_sec = v
        .get("timeout")
        .and_then(|x| x.as_u64())
        .unwrap_or(60)
        .min(600);
    Ok(PendingRequest {
        id: String::new(),
        agent,
        kind,
        message,
        options,
        timeout_sec,
        created: now_ms(),
    })
}

/// 解决请求：写入结果、通知面板；全部处理完则隐藏面板。返回是否成功。
pub fn resolve_impl(
    app: &tauri::AppHandle,
    state: &Arc<SharedState>,
    id: &str,
    value: &str,
) -> bool {
    let ok = {
        let mut map = state.pending.lock().unwrap();
        match map.get_mut(id) {
            Some(entry) => {
                if entry.1.is_some() {
                    false
                } else {
                    entry.1 = Some(value.to_string());
                    true
                }
            }
            None => false,
        }
    };
    if ok {
        let remaining = {
            let map = state.pending.lock().unwrap();
            map.values().filter(|(_, res)| res.is_none()).count()
        };
        let _ = app.emit(
            "panel-resolved",
            serde_json::json!({ "id": id, "count": remaining }),
        );
        if remaining == 0 {
            if let Some(p) = app.get_webview_window("panel") {
                let _ = p.hide();
            }
        }
    }
    ok
}
