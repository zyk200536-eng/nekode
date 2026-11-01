//! 手机推送：把事件桥的 waiting/error/done 事件转发到 ntfy（安卓/网页）或 Bark（iOS）。
//!
//! 设计约束：fire-and-forget，任何失败静默（绝不影响事件桥与桌宠）；同 agent 同事件
//! 60 秒静默窗防轰炸；topic 即凭据，设置面板生成时用随机串。API 形态：
//! - ntfy：POST {topic}/publish?title=..&tags=cat，body 为消息文本（query 传参避免
//!   非 ASCII HTTP 头的兼容问题）
//! - Bark：POST https://api.day.app/push，JSON {device_key, title, body, group}

use crate::bridge_server::PetEvent;
use crate::config;
use percent_encoding::NON_ALPHANUMERIC;
use percent_encoding::utf8_percent_encode;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

const QUIET_MS: u64 = 60_000;
const DEFAULT_EVENTS: [&str; 3] = ["waiting", "error", "done"];

/// (agent|event) -> 上次推送时间戳（毫秒）
static LAST_SENT: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 事件桥收到事件后调用：判定是否需要推送，需要则起线程发送（不阻塞事件桥）。
pub fn dispatch(_app: &tauri::AppHandle, e: &PetEvent) {
    let v = config::read_raw();
    let channel = v
        .get("push_channel")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let target = v
        .get("push_target")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    if channel.is_empty() || target.is_empty() {
        return;
    }
    let events: Vec<String> = v
        .get("push_events")
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_else(|| DEFAULT_EVENTS.iter().map(|s| s.to_string()).collect());
    if !events.iter().any(|s| s == &e.event) {
        return;
    }
    let key = format!("{}|{}", e.agent, e.event);
    if !should_send(&key, now_ms(), QUIET_MS) {
        return;
    }
    let e2 = e.clone();
    std::thread::spawn(move || {
        let res = match channel.as_str() {
            "ntfy" => send_ntfy(&target, &e2),
            "bark" => send_bark(&target, &e2),
            _ => return,
        };
        if let Err(err) = res {
            eprintln!("[nekode] 手机推送失败: {err}");
        }
    });
}

/// 防轰炸：同键 quiet_ms 内只放行第一次（放行时记录时间戳）。
fn should_send(key: &str, now: u64, quiet_ms: u64) -> bool {
    let mut guard = LAST_SENT.lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    if let Some(&last) = map.get(key) {
        if now.saturating_sub(last) < quiet_ms {
            return false;
        }
    }
    map.insert(key.to_string(), now);
    true
}

fn state_word(event: &str) -> &str {
    match event {
        "waiting" => "等你确认",
        "error" => "出错了",
        "done" => "完成了",
        other => other,
    }
}

/// 通知文案：title = "{agent} {状态词}"，body = msg 截断 200 字。
fn build_message(e: &PetEvent) -> (String, String) {
    let title = format!("{} {}", e.agent, state_word(&e.event));
    let body = e
        .msg
        .as_deref()
        .unwrap_or("")
        .chars()
        .take(200)
        .collect::<String>();
    (title, body)
}

/// ntfy 发布 URL：{topic}/publish?title=..&tags=cat（title 百分号编码支持中文）。
fn ntfy_url(target: &str, title: &str) -> String {
    let t = target.trim_end_matches('/');
    format!(
        "{t}/publish?title={}&tags=cat",
        utf8_percent_encode(title, NON_ALPHANUMERIC)
    )
}

fn send_ntfy(target: &str, e: &PetEvent) -> Result<(), String> {
    if !target.starts_with("http://") && !target.starts_with("https://") {
        return Err("ntfy 目标应为完整 topic URL（如 https://ntfy.sh/mytopic）".into());
    }
    let (title, body) = build_message(e);
    ureq::post(&ntfy_url(target, &title))
        .timeout(Duration::from_secs(5))
        .send_string(&body)
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn bark_body(target: &str, e: &PetEvent) -> serde_json::Value {
    let (title, body) = build_message(e);
    serde_json::json!({
        "device_key": target,
        "title": title,
        "body": body,
        "group": "nekode",
    })
}

fn send_bark(target: &str, e: &PetEvent) -> Result<(), String> {
    if target.trim().is_empty() {
        return Err("Bark Key 为空".into());
    }
    ureq::post("https://api.day.app/push")
        .timeout(Duration::from_secs(5))
        .send_json(bark_body(target, e))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 设置面板测试按钮：同步发送，成败直接回显给用户。
pub fn send_test(channel: &str, target: &str) -> Result<(), String> {
    let e = PetEvent {
        agent: "nekode".into(),
        event: "done".into(),
        msg: Some("喵！这是一条测试推送 🐾".into()),
        ts: 0,
    };
    match channel {
        "ntfy" => send_ntfy(target, &e),
        "bark" => send_bark(target, &e),
        _ => Err("请先选择推送通道".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(agent: &str, event: &str, msg: Option<&str>) -> PetEvent {
        PetEvent {
            agent: agent.into(),
            event: event.into(),
            msg: msg.map(String::from),
            ts: 0,
        }
    }

    #[test]
    fn message_maps_chinese_state_and_truncates() {
        let (t, b) = build_message(&ev("zcode", "waiting", Some("Run npm test?")));
        assert_eq!(t, "zcode 等你确认");
        assert_eq!(b, "Run npm test?");
        let long = "喵".repeat(300);
        let (_, b2) = build_message(&ev("a", "done", Some(&long)));
        assert_eq!(b2.chars().count(), 200);
        let (_, b3) = build_message(&ev("a", "error", None));
        assert_eq!(b3, "");
    }

    #[test]
    fn state_word_falls_back_to_raw_event() {
        assert_eq!(state_word("progress"), "progress");
        assert_eq!(state_word("done"), "完成了");
    }

    #[test]
    fn quiet_window_blocks_within_and_allows_after() {
        let key = "unit|quiet";
        assert!(should_send(key, 1_000, 60_000));
        assert!(!should_send(key, 1_000 + 59_999, 60_000), "静默窗内应拦截");
        assert!(should_send(key, 1_000 + 61_000, 60_000), "过期后应放行");
    }

    #[test]
    fn ntfy_url_encodes_chinese_title_and_trims_slash() {
        let url = ntfy_url("https://ntfy.sh/mytopic/", "zcode 等你确认");
        assert_eq!(
            url,
            "https://ntfy.sh/mytopic/publish?title=zcode%20%E7%AD%89%E4%BD%A0%E7%A1%AE%E8%AE%A4&tags=cat"
        );
    }

    #[test]
    fn bark_payload_has_required_fields() {
        let v = bark_body("abc123", &ev("codex", "error", Some("boom")));
        assert_eq!(v["device_key"], "abc123");
        assert_eq!(v["title"], "codex 出错了");
        assert_eq!(v["body"], "boom");
        assert_eq!(v["group"], "nekode");
    }
}
