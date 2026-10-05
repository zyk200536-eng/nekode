//! DeepSeek Harness（DSH）集成：监视 ~/.dsh/sessions 的会话记录（zstd JSONL），
//! 增量提取新事件并映射为桌宠事件。DSH 无钩子机制，此监视器实现零配置接入。
//!
//! 事件映射（源自真实会话数据结构）：
//!   turn/start          → start
//!   assistant/message   → progress（取最近一段 text 原话）
//!   tool/call           → progress（工具名 + 关键参数）
//!   approval/asked      → waiting（取 data.reason）
//!   turn/end            → done
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::Emitter;

#[derive(Clone)]
struct FileState {
    last_seq: u64,
    last_size: u64,
}

pub fn start(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        if let Err(e) = scan_once(&app) {
            eprintln!("[nekode] DSH 监视异常: {e}");
        }
        std::thread::sleep(std::time::Duration::from_millis(1500));
    });
}

fn sessions_root() -> Option<PathBuf> {
    home::home_dir().map(|h| h.join(".dsh").join("sessions"))
}

fn scan_once(app: &tauri::AppHandle) -> Result<(), String> {
    use std::fs;
    let root = sessions_root().ok_or("no home")?;
    let entries = fs::read_dir(&root).map_err(|e| e.to_string())?;
    for ws in entries.flatten() {
        if !ws.path().is_dir() {
            continue;
        }
        let Ok(sessions) = fs::read_dir(ws.path()) else {
            continue;
        };
        for sess in sessions.flatten() {
            let file = sess.path().join("session.v4.jsonl.zstd");
            if !file.is_file() {
                continue;
            }
            watch_file(app, &file);
        }
    }
    Ok(())
}

fn watch_file(app: &tauri::AppHandle, file: &PathBuf) {
    use std::fs;
    static STATES: std::sync::Mutex<Option<HashMap<PathBuf, FileState>>> =
        std::sync::Mutex::new(None);

    let meta = match fs::metadata(file) {
        Ok(m) => m,
        Err(_) => return,
    };
    let size = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut states = STATES.lock().unwrap();
    let map = states.get_or_insert_with(HashMap::new);
    let known = map.get(file);
    if let Some(st) = known {
        if st.last_size == size {
            return; // 大小未变，无新事件
        }
    }
    let _ = mtime;

    // 解压并解析
    let events = match decompress_and_parse(file) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[nekode] DSH 解压失败 {}: {e}", file.display());
            return;
        }
    };
    let max_seq = events.last().map(|(seq, _)| *seq).unwrap_or(0);

    let replay: u64 = std::env::var("NEKODE_DSH_REPLAY")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let baseline = known.map(|st| st.last_seq).unwrap_or(max_seq.saturating_sub(replay));

    let fresh: Vec<(u64, &Value)> = events
        .iter()
        .filter(|(seq, _)| *seq > baseline)
        .map(|(seq, v)| (*seq, v))
        .collect();
    let fresh_count = fresh.len();

    map.insert(
        file.clone(),
        FileState {
            last_seq: max_seq,
            last_size: size,
        },
    );
    drop(states);

    for (seq, v) in fresh {
        if let Some(ev) = map_event(v) {
            println!("[nekode] dsh {}: {:?}", ev.event, ev.msg);
            let _ = app.emit("pet-event", ev);
        }
        let _ = seq;
    }
    if fresh_count > 0 {
        println!("[nekode] DSH {} 新事件 {} 条", file.display(), fresh_count);
    }
}

type RawEvent = (u64, Value);

fn decompress_and_parse(file: &PathBuf) -> Result<Vec<RawEvent>, String> {
    let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
    let out_bytes = zstd::stream::decode_all(bytes.as_slice())
        .map_err(|e| format!("zstd decode: {e}"))?;
    let text = String::from_utf8_lossy(&out_bytes).into_owned();
    let mut out = Vec::new();
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            let seq = v.get("seq").and_then(|x| x.as_u64()).unwrap_or(0);
            out.push((seq, v));
        }
    }
    out.sort_by_key(|(seq, _)| *seq);
    Ok(out)
}

fn data_str<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get("data").and_then(|d| d.get(key)).and_then(|x| x.as_str()).unwrap_or("")
}

fn map_event(v: &Value) -> Option<crate::bridge_server::PetEvent> {
    let kind = v.get("type").and_then(|x| x.as_str())?;
    let (event, msg) = match kind {
        "turn/start" => ("start".to_string(), None),
        "assistant/message" => {
            let text = last_text(v);
            if text.is_empty() {
                return None; // 纯工具轮次无话可说
            }
            ("progress".to_string(), Some(text))
        }
        "tool/call" => {
            let name = data_str(v, "name").to_string();
            if name.is_empty() {
                return None;
            }
            let args: Value = serde_json::from_str(data_str(v, "arguments")).unwrap_or(Value::Null);
            let detail = ["file_path", "path", "command", "query", "url", "prompt"]
                .iter()
                .find_map(|k| args.get(k).and_then(|x| x.as_str()))
                .unwrap_or("");
            let base = if detail.is_empty() {
                String::new()
            } else {
                std::path::Path::new(detail)
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| detail.to_string())
            };
            let m = if base.is_empty() { name.clone() } else { format!("{name} {base}") };
            ("progress".to_string(), Some(m))
        }
        "approval/asked" => {
            let reason = data_str(v, "reason").trim().to_string();
            let m = if reason.is_empty() {
                "需要你授权".to_string()
            } else {
                format!("需要授权：{reason}")
            };
            ("waiting".to_string(), Some(m))
        }
        "turn/end" => ("done".to_string(), None),
        _ => return None,
    };
    Some(crate::bridge_server::PetEvent {
        agent: "dsh".into(),
        event,
        msg: msg.map(|m| truncate(&m, 120)),
        ts: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    })
}

/// assistant/message 的 content 数组里最后一个非空 text 块。
fn last_text(v: &Value) -> String {
    let content = v
        .get("data")
        .and_then(|d| d.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array());
    let Some(items) = content else {
        return String::new();
    };
    for item in items.iter().rev() {
        if item.get("type").and_then(|x| x.as_str()) == Some("text") {
            let t = item.get("text").and_then(|x| x.as_str()).unwrap_or("").trim();
            if !t.is_empty() {
                return t.replace('\n', " ").replace('\r', " ");
            }
        }
    }
    String::new()
}

fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let t: String = s.chars().take(max_chars).collect();
        format!("{t}…")
    }
}
