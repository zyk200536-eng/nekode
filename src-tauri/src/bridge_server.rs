//! 事件桥：监听 127.0.0.1，把各 agent 钩子发来的事件转发给宠物界面。
//! GET /e?agent=..&event=..&msg=..   —— 钩子里一行 curl 即可接入
//! GET /health                       —— 探活
//! POST /event {"agent":..,"event":..,"msg":..} —— JSON 接入
use serde::Serialize;
use tauri::Emitter;
use tiny_http::{Header, Method, Response, Server};

#[derive(Clone, Debug, Serialize)]
pub struct PetEvent {
    pub agent: String,
    pub event: String,
    pub msg: Option<String>,
    pub ts: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 在 port 起连续尝试 20 个端口，返回实际监听的端口（0 表示失败）。
pub fn start(app: tauri::AppHandle, port: u16) -> u16 {
    let last = port.saturating_add(20);
    for p in port..last {
        match Server::http(("127.0.0.1", p)) {
            Ok(server) => {
                println!("[nekode] 事件桥已启动: http://127.0.0.1:{p}");
                std::thread::spawn(move || serve(app, server));
                return p;
            }
            Err(_) => continue,
        }
    }
    eprintln!("[nekode] 端口 {port}~{} 均被占用，事件桥未启动", last - 1);
    0
}

fn serve(app: tauri::AppHandle, server: Server) {
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
                    let msg = v
                        .get("msg")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string());
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
