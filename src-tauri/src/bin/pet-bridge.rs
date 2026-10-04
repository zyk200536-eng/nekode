//! pet-bridge：钩子事件转发器。
//! 各 agent 的钩子调用本命令，本命令把事件转发给 Nekode 的事件桥（默认 127.0.0.1:21435）。
//! 任何失败都静默退出（exit 0），绝不影响 agent 本身运行。
//!
//! 用法：
//!   pet-bridge --agent zcode --event stop
//!   pet-bridge --map claude --agent zcode      （自动解析 Claude Code 系钩子的 stdin JSON）
//!   pet-bridge --map codex                     （Codex notify：JSON 作为参数传入）
//!   pet-bridge --map hermes --agent hermes     （Hermes 钩子 stdin JSON）
use std::io::{IsTerminal, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

const DEFAULT_PORT: u16 = 21435;

fn main() {
    let mut agent = String::new();
    let mut event = String::new();
    let mut msg = String::new();
    let mut port = DEFAULT_PORT;
    let mut mapping = String::from("none");
    let mut payload = String::new();

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--agent" => agent = args.next().unwrap_or_default(),
            "--event" => event = args.next().unwrap_or_default(),
            "--msg" => msg = args.next().unwrap_or_default(),
            "--port" => port = args.next().and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_PORT),
            "--map" => mapping = args.next().unwrap_or_else(|| "claude".into()),
            other => {
                // Codex notify 把 JSON 作为最后一个位置参数传入
                if other.trim_start().starts_with('{') {
                    payload = other.to_string();
                }
            }
        }
    }

    if mapping != "none" {
        if payload.trim().is_empty() && !std::io::stdin().is_terminal() {
            let mut buf = String::new();
            if std::io::stdin().read_to_string(&mut buf).is_ok() {
                payload = buf;
            }
        }
        if !payload.trim().is_empty() {
            apply_mapping(&mapping, &payload, &mut agent, &mut event, &mut msg);
        }
    }

    if agent.is_empty() || event.is_empty() {
        return;
    }
    send_event(&agent, &event, &msg, port);
}

/// 把各家钩子的 stdin/argv JSON 映射为统一事件。
fn apply_mapping(map: &str, raw: &str, agent: &mut String, event: &mut String, msg: &mut String) {
    let v: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return,
    };

    match map {
        // Claude Code / ZCode / CodeBuddy 同款钩子结构
        "claude" => {
            if agent.is_empty() {
                *agent = "claude".into();
            }
            let hook = v
                .get("hook_event_name")
                .and_then(|x| x.as_str())
                .unwrap_or("");
            if event.is_empty() {
                *event = match hook {
                    "SessionStart" | "UserPromptSubmit" => "start",
                    "Notification" | "PermissionRequest" => "waiting",
                    "Stop" => "done",
                    _ => "progress",
                }
                .into();
            }
            if msg.is_empty() {
                // 优先提取会话记录里最近一段 assistant 文字（任务过程播报）
                let transcript = v
                    .get("transcript_path")
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                if hook == "UserPromptSubmit" {
                    let prompt = v.get("prompt").and_then(|x| x.as_str()).unwrap_or("");
                    if !prompt.is_empty() {
                        *msg = truncate(&format!("任务：{prompt}"), 80);
                    }
                } else if !transcript.is_empty() {
                    if let Some(text) = last_assistant_text(transcript) {
                        *msg = truncate(&text, 100);
                    }
                }
                if msg.is_empty() {
                    let tool = v.get("tool_name").and_then(|x| x.as_str()).unwrap_or("");
                    let input = &v["tool_input"];
                    let detail = [
                        "file_path", "path", "command", "pattern", "url", "query", "prompt",
                        "description",
                    ]
                    .iter()
                    .find_map(|k| input.get(k).and_then(|x| x.as_str()))
                    .or_else(|| v.get("message").and_then(|x| x.as_str()))
                    .unwrap_or("");
                    let text = if hook == "Notification" || hook == "PermissionRequest" {
                        v.get("message")
                            .and_then(|x| x.as_str())
                            .unwrap_or("需要你的注意")
                            .to_string()
                    } else if !tool.is_empty() && !detail.is_empty() {
                        let base = std::path::Path::new(detail)
                            .file_name()
                            .map(|s| s.to_string_lossy().into_owned())
                            .unwrap_or_else(|| detail.to_string());
                        format!("{tool} {base}")
                    } else {
                        String::new()
                    };
                    if !text.is_empty() {
                        *msg = truncate(&text, 120);
                    }
                }
            }
        }
        // Codex notify：{"type":"agent-turn-complete","last-assistant-message":..}
        "codex" => {
            if agent.is_empty() {
                *agent = "codex".into();
            }
            if event.is_empty() {
                *event = "done".into();
            }
            if msg.is_empty() {
                let m = v
                    .get("last-assistant-message")
                    .and_then(|x| x.as_str())
                    .or_else(|| v.get("last_assistant_message").and_then(|x| x.as_str()))
                    .unwrap_or("");
                if !m.is_empty() {
                    *msg = truncate(m.trim(), 120);
                }
            }
        }
        // Hermes 钩子：stdin JSON 同样带 hook_event_name，另兼容 event/type/status 字段
        "hermes" => {
            if agent.is_empty() {
                *agent = "hermes".into();
            }
            let hook = v
                .get("hook_event_name")
                .and_then(|x| x.as_str())
                .unwrap_or("");
            if event.is_empty() {
                let t = if hook.is_empty() {
                    v.get("event")
                        .and_then(|x| x.as_str())
                        .or_else(|| v.get("type").and_then(|x| x.as_str()))
                        .or_else(|| v.get("status").and_then(|x| x.as_str()))
                        .unwrap_or("")
                } else {
                    hook
                };
                *event = match t {
                    "on_session_start" | "start" | "task_start" | "started" => "start",
                    "pre_approval_request" | "waiting" | "input_required" => "waiting",
                    "on_session_end" | "agent_loop_stopped" | "subagent_stop" | "done"
                    | "complete" | "completed" => "done",
                    "error" | "failed" => "error",
                    _ => "progress",
                }
                .into();
            }
            if msg.is_empty() {
                let tool = v.get("tool_name").and_then(|x| x.as_str()).unwrap_or("");
                let input = &v["tool_input"];
                let detail = ["file_path", "path", "command", "pattern", "url", "query"]
                    .iter()
                    .find_map(|k| input.get(k).and_then(|x| x.as_str()))
                    .unwrap_or("");
                let text = if !tool.is_empty() && !detail.is_empty() {
                    let base = std::path::Path::new(detail)
                        .file_name()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_else(|| detail.to_string());
                    format!("{tool} {base}")
                } else {
                    v.get("message")
                        .and_then(|x| x.as_str())
                        .or_else(|| v.get("msg").and_then(|x| x.as_str()))
                        .unwrap_or("")
                        .to_string()
                };
                if !text.is_empty() {
                    *msg = truncate(&text, 120);
                }
            }
        }
        _ => {}
    }
}

fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let t: String = s.chars().take(max_chars).collect();
        format!("{t}…")
    }
}

/// 从会话 JSONL 记录尾部提取最近一段 assistant 文字（任务过程播报）。
/// 兼容 Claude Code 系 transcript 结构：{"type":"assistant","message":{"content":[{"type":"text","text":..}]}}
/// 任何解析失败都返回 None，静默回退。
fn last_assistant_text(path: &str) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let size = meta.len() as usize;
    let read_len = size.min(256 * 1024);
    let mut file = std::fs::File::open(path).ok()?;
    use std::io::{Read, Seek, SeekFrom};
    file.seek(SeekFrom::Start((size - read_len) as u64)).ok()?;
    let mut buf = String::new();
    file.take(read_len as u64).read_to_string(&mut buf).ok()?;
    // 丢掉首行（可能被截断）
    if let Some(pos) = buf.find('\n') {
        buf = buf[pos + 1..].to_string();
    }
    for line in buf.lines().rev() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let kind = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if kind != "assistant" {
            continue;
        }
        let content = v
            .get("message")
            .and_then(|m| m.get("content"))
            .or_else(|| v.get("content"));
        let Some(items) = content.and_then(|c| c.as_array()) else {
            continue;
        };
        // 取最后一个非空 text 块
        for item in items.iter().rev() {
            if item.get("type").and_then(|x| x.as_str()) == Some("text") {
                let text = item.get("text").and_then(|x| x.as_str()).unwrap_or("").trim();
                if !text.is_empty() {
                    // 压成单行，避免字幕里出现换行
                    let one_line = text.replace('\n', " ").replace('\r', " ");
                    return Some(one_line);
                }
            }
        }
    }
    None
}

/// 用 GET 请求转发事件（URL 编码避开一切 shell 转义问题）。
fn send_event(agent: &str, event: &str, msg: &str, port: u16) {
    let q = |s: &str| {
        percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
    };
    let mut url = format!("/e?agent={}&event={}", q(agent), q(event));
    if !msg.is_empty() {
        url.push_str(&format!("&msg={}", q(msg)));
    }
    let req = format!("GET {url} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) {
        let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
        let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
        if stream.write_all(req.as_bytes()).is_ok() {
            let mut buf = [0u8; 256];
            let _ = stream.read(&mut buf);
        }
    }
}
