//! 一键接入向导：扫描本机已装的 AI Agent、备份并写入各家钩子配置、一键还原。
//!
//! 合并语义与配置模板一一对应 `integrations/README.md` 的已验证写法；所有写入均幂等
//! （重复接入不产生重复条目），且写前必然把原文件备份到 `~/.agentpet/backups/<agent>/`。
//! JSON/YAML 重排会丢弃注释（原文件可从备份还原）；Codex 的 TOML 走 toml_edit，注释保留。

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;

#[derive(Clone, Serialize)]
pub struct AgentStatus {
    pub id: &'static str,
    pub name: &'static str,
    /// 特征目录存在
    pub detected: bool,
    /// 配置里已有 pet-bridge 痕迹（dsh 检测到即视为已接入）
    pub integrated: bool,
    pub has_backup: bool,
    pub config_path: String,
    /// 非空时 UI 需显著提示（如 Codex 将覆盖自定义 notify）
    pub warning: String,
    /// 补充说明
    pub note: String,
}

struct AgentDef {
    id: &'static str,
    name: &'static str,
    /// 特征目录（相对 home），存在即视为已安装
    dir: &'static str,
    /// 配置文件（相对 home）；空串 = 无需配置文件
    config: &'static str,
}

const AGENTS: [AgentDef; 6] = [
    AgentDef { id: "zcode", name: "ZCode", dir: ".zcode", config: ".zcode/cli/config.json" },
    AgentDef { id: "codebuddy", name: "CodeBuddy", dir: ".codebuddy", config: ".codebuddy/settings.json" },
    AgentDef { id: "codex", name: "Codex CLI", dir: ".codex", config: ".codex/config.toml" },
    AgentDef { id: "hermes", name: "Hermes Agent", dir: ".hermes", config: ".hermes/config.yaml" },
    AgentDef { id: "cursor", name: "Cursor", dir: ".cursor", config: ".cursor/mcp.json" },
    AgentDef { id: "dsh", name: "DeepSeek Harness", dir: ".dsh", config: "" },
];

// ---------- 路径 ----------

fn home() -> Option<PathBuf> {
    home::home_dir()
}

/// pet-bridge 与主程序同目录（与 nekode-codex-shim 的定位方式一致，兼容自定义安装目录）。
fn bridge_exe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) { "pet-bridge.exe" } else { "pet-bridge" };
    let p = dir.join(name);
    p.exists().then_some(p)
}

fn backups_dir(agent_id: &str) -> Option<PathBuf> {
    home().map(|h| h.join(".agentpet").join("backups").join(agent_id))
}

fn backup_config(cfg: &Path, agent_id: &str) -> Result<(), String> {
    if !cfg.exists() {
        return Ok(()); // 全新配置文件，无需备份
    }
    let dir = backups_dir(agent_id).ok_or("无法定位备份目录")?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败: {e}"))?;
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let name = cfg
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "config".into());
    fs::copy(cfg, dir.join(format!("{ms}_{name}"))).map_err(|e| format!("备份失败: {e}"))?;
    Ok(())
}

fn latest_backup(agent_id: &str) -> Option<PathBuf> {
    let dir = backups_dir(agent_id)?;
    let mut best: Option<(u128, PathBuf)> = None;
    for e in fs::read_dir(&dir).ok()?.flatten() {
        let p = e.path();
        let stem = p.file_name()?.to_string_lossy().to_string();
        let Ok(ts) = stem.split('_').next()?.parse::<u128>() else {
            continue;
        };
        if best.as_ref().map_or(true, |(t, _)| ts > *t) {
            best = Some((ts, p));
        }
    }
    best.map(|(_, p)| p)
}

// ---------- 探测：JSON 钩子（zcode / codebuddy） ----------

/// 在任意 JSON 结构里找 pet-bridge 条目：command 含 "pet-bridge"，且
/// zcode 式（args 含 --agent <agent>）或 codebuddy 式（command 含 --agent <agent>）。
fn json_has_bridge(v: &serde_json::Value, agent: &str) -> bool {
    match v {
        serde_json::Value::Object(map) => {
            let cmd = map.get("command").and_then(|x| x.as_str()).unwrap_or("");
            if cmd.contains("pet-bridge") {
                let args: Vec<&str> = map
                    .get("args")
                    .and_then(|x| x.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
                    .unwrap_or_default();
                if args.windows(2).any(|w| w[0] == "--agent" && w[1] == agent)
                    || cmd.contains(&format!("--agent {agent}"))
                {
                    return true;
                }
            }
            map.values().any(|x| json_has_bridge(x, agent))
        }
        serde_json::Value::Array(a) => a.iter().any(|x| json_has_bridge(x, agent)),
        _ => false,
    }
}

// ---------- 合并：zcode（JSON，hooks.events.<Event>[].hooks[]） ----------

const ZCODE_EVENTS: [&str; 5] =
    ["SessionStart", "UserPromptSubmit", "PostToolUse", "PermissionRequest", "Stop"];

pub fn merge_zcode_json(txt: &str, bridge_exe: &str, agent: &str) -> Result<String, String> {
    let mut v: serde_json::Value = if txt.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(txt).map_err(|e| format!("config.json 解析失败: {e}"))?
    };
    if !v.is_object() {
        return Err("config.json 顶层不是对象".into());
    }
    if v.get("hooks").map_or(false, |h| !h.is_object() && !h.is_null()) {
        return Err("config.json 的 hooks 字段不是对象".into());
    }
    let hooks = &mut v["hooks"];
    hooks["enabled"] = serde_json::json!(true); // ZCode 必须 enabled，钩子才会运行
    if hooks
        .get("events")
        .map_or(false, |e| !e.is_object() && !e.is_null())
    {
        return Err("hooks.events 不是对象".into());
    }
    for ev in ZCODE_EVENTS {
        if hooks["events"][ev]
            .as_array()
            .is_none()
            && !hooks["events"][ev].is_null()
        {
            return Err(format!("hooks.events.{ev} 不是数组"));
        }
        let arr = match hooks["events"][ev].take() {
            serde_json::Value::Null => Vec::new(),
            serde_json::Value::Array(a) => a,
            _ => unreachable!(),
        };
        let arr = if json_has_bridge(&serde_json::Value::Array(arr.clone()), agent) {
            arr
        } else {
            let mut a = arr;
            a.push(serde_json::json!({
                "hooks": [{ "type": "process", "command": bridge_exe,
                            "args": ["--map", "claude", "--agent", agent] }]
            }));
            a
        };
        hooks["events"][ev] = serde_json::Value::Array(arr);
    }
    serde_json::to_string_pretty(&v).map_err(|e| format!("序列化失败: {e}"))
}

// ---------- 合并：codebuddy（JSON，hooks.<Event>[].hooks[]，command 字符串式） ----------

const CODEBUDDY_EVENTS: [&str; 4] = ["UserPromptSubmit", "PostToolUse", "Notification", "Stop"];

pub fn merge_codebuddy_json(txt: &str, bridge_exe: &str, agent: &str) -> Result<String, String> {
    let mut v: serde_json::Value = if txt.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(txt).map_err(|e| format!("settings.json 解析失败: {e}"))?
    };
    if !v.is_object() {
        return Err("settings.json 顶层不是对象".into());
    }
    if v.get("hooks").map_or(false, |h| !h.is_object() && !h.is_null()) {
        return Err("settings.json 的 hooks 字段不是对象".into());
    }
    let hooks = &mut v["hooks"];
    // command 是整条字符串（走 shell），路径带空格时加引号
    let exe = if bridge_exe.contains(' ') {
        format!("\"{bridge_exe}\"")
    } else {
        bridge_exe.to_string()
    };
    let cmd = format!("{exe} --map claude --agent {agent}");
    for ev in CODEBUDDY_EVENTS {
        if hooks[ev].as_array().is_none() && !hooks[ev].is_null() {
            return Err(format!("hooks.{ev} 不是数组"));
        }
        let arr = match hooks[ev].take() {
            serde_json::Value::Null => Vec::new(),
            serde_json::Value::Array(a) => a,
            _ => unreachable!(),
        };
        let arr = if json_has_bridge(&serde_json::Value::Array(arr.clone()), agent) {
            arr
        } else {
            let mut a = arr;
            a.push(serde_json::json!({
                "hooks": [{ "type": "command", "command": cmd }]
            }));
            a
        };
        hooks[ev] = serde_json::Value::Array(arr);
    }
    serde_json::to_string_pretty(&v).map_err(|e| format!("序列化失败: {e}"))
}

// ---------- 合并：codex（TOML，notify 数组，toml_edit 保注释） ----------

fn toml_notify_contains(doc: &toml_edit::DocumentMut, needle: &str) -> bool {
    doc.get("notify")
        .and_then(|i| i.as_array())
        .map(|a| {
            a.iter().any(|v| {
                v.as_str().map_or(false, |s| s.contains(needle))
            })
        })
        .unwrap_or(false)
}

fn toml_notify_is_ours(doc: &toml_edit::DocumentMut) -> bool {
    toml_notify_contains(doc, "pet-bridge")
}

/// 用户可能已用 nekode-codex-shim 手动接入（转发 pet-bridge 并保留 Codex 桌面版
/// 原通知，比直连更完整）——视为已接入，且不要降级覆盖成直连。
fn toml_notify_is_shim(doc: &toml_edit::DocumentMut) -> bool {
    toml_notify_contains(doc, "nekode-codex-shim")
}

pub fn merge_codex_toml(txt: &str, bridge_exe: &str) -> Result<(String, bool), String> {
    let mut doc: toml_edit::DocumentMut = if txt.trim().is_empty() {
        toml_edit::DocumentMut::new()
    } else {
        txt.parse().map_err(|e| format!("config.toml 解析失败: {e}"))?
    };
    if toml_notify_is_shim(&doc) {
        return Ok((doc.to_string(), false)); // shim 已是完整接入，原样保留
    }
    let already = toml_notify_is_ours(&doc);
    // notify 存在但不是我们的 → 覆盖（调用方在 UI 上已提示，备份可还原）
    let overwrote = doc.get("notify").is_some() && !already;
    let mut arr = toml_edit::Array::new();
    arr.push(bridge_exe);
    arr.push("--map");
    arr.push("codex");
    doc["notify"] = toml_edit::value(arr);
    Ok((doc.to_string(), overwrote))
}

fn toml_notify_integrated(txt: &str) -> bool {
    txt.parse::<toml_edit::DocumentMut>()
        .map(|d| toml_notify_is_ours(&d) || toml_notify_is_shim(&d))
        .unwrap_or(false)
}

// ---------- 合并：hermes（YAML，hooks.<key>[]，命令走 shlex） ----------

const HERMES_HOOKS: [&str; 4] =
    ["on_session_start", "post_tool_call", "pre_approval_request", "on_session_end"];

fn yaml_ensure_mapping<'a>(
    parent: &'a mut serde_yaml::Mapping,
    key: &str,
) -> Result<&'a mut serde_yaml::Mapping, String> {
    let k = serde_yaml::Value::String(key.into());
    if !parent.contains_key(&k) {
        parent.insert(k.clone(), serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    }
    parent
        .get_mut(&k)
        .and_then(|v| v.as_mapping_mut())
        .ok_or_else(|| format!("YAML 的 {key} 不是映射"))
}

fn yaml_ensure_sequence<'a>(
    parent: &'a mut serde_yaml::Mapping,
    key: &str,
) -> Result<&'a mut Vec<serde_yaml::Value>, String> {
    let k = serde_yaml::Value::String(key.into());
    if !parent.contains_key(&k) {
        parent.insert(k.clone(), serde_yaml::Value::Sequence(Vec::new()));
    }
    parent
        .get_mut(&k)
        .and_then(|v| v.as_sequence_mut())
        .ok_or_else(|| format!("YAML 的 {key} 不是列表"))
}

pub fn merge_hermes_yaml(txt: &str, bridge_dir_fwd: &str, agent: &str) -> Result<String, String> {
    // Hermes 用 shlex.split 解析命令：路径必须正斜杠、不带 .exe 后缀（README 已验证模板）
    let cmd = format!("{bridge_dir_fwd}/pet-bridge --map hermes --agent {agent}");
    let mut root: serde_yaml::Value = if txt.trim().is_empty() {
        serde_yaml::Value::Mapping(serde_yaml::Mapping::new())
    } else {
        serde_yaml::from_str(txt).map_err(|e| format!("config.yaml 解析失败: {e}"))?
    };
    let mapping = root.as_mapping_mut().ok_or("config.yaml 顶层不是映射")?;
    let hooks = yaml_ensure_mapping(mapping, "hooks")?;
    for key in HERMES_HOOKS {
        let seq = yaml_ensure_sequence(hooks, key)?;
        let already = seq.iter().any(yaml_item_has_bridge);
        if !already {
            let mut entry = serde_yaml::Mapping::new();
            entry.insert(
                serde_yaml::Value::String("command".into()),
                serde_yaml::Value::String(cmd.clone()),
            );
            entry.insert(
                serde_yaml::Value::String("timeout".into()),
                serde_yaml::Value::Number(10.into()),
            );
            seq.push(serde_yaml::Value::Mapping(entry));
        }
    }
    serde_yaml::to_string(&root).map_err(|e| format!("序列化失败: {e}"))
}

/// YAML 钩子条目是否是我们的 pet-bridge。
fn yaml_item_has_bridge(item: &serde_yaml::Value) -> bool {
    item.as_mapping()
        .and_then(|m| m.get(&serde_yaml::Value::String("command".into())))
        .and_then(|c| c.as_str())
        .map_or(false, |s| s.contains("pet-bridge"))
}

fn yaml_integrated(txt: &str) -> bool {
    let Ok(v) = serde_yaml::from_str::<serde_yaml::Value>(txt) else {
        return false;
    };
    let Some(hooks) = v.as_mapping().and_then(|m| {
        m.get(&serde_yaml::Value::String("hooks".into()))
            .and_then(|h| h.as_mapping().cloned())
    }) else {
        return false;
    };
    hooks.values().any(|val| {
        val.as_sequence()
            .map_or(false, |seq| seq.iter().any(yaml_item_has_bridge))
    })
}

// ---------- 扫描 ----------

fn scan_one(def: &AgentDef) -> AgentStatus {
    let dir_exists = home()
        .map(|h| h.join(def.dir).is_dir())
        .unwrap_or(false);
    let cfg_path = home()
        .map(|h| h.join(def.config))
        .unwrap_or_default();
    let content = if def.config.is_empty() {
        String::new()
    } else {
        fs::read_to_string(&cfg_path).unwrap_or_default()
    };
    let integrated = match def.id {
        "dsh" => dir_exists, // 检测到安装即自动生效
        "cursor" => content.contains("agentpet"),
        "zcode" | "codebuddy" => serde_json::from_str::<serde_json::Value>(&content)
            .ok()
            .map_or(false, |v| json_has_bridge(&v, def.id)),
        "codex" => toml_notify_integrated(&content),
        "hermes" => yaml_integrated(&content),
        _ => false,
    };

    let mut warnings: Vec<String> = Vec::new();
    let mut note = String::new();
    match def.id {
        "codex" => {
            let custom = content
                .parse::<toml_edit::DocumentMut>()
                .ok()
                .map_or(false, |d| {
                    d.get("notify").is_some()
                        && !toml_notify_is_ours(&d)
                        && !toml_notify_is_shim(&d)
                });
            if custom {
                warnings
                    .push("检测到自定义 notify，接入会覆盖它（原文件先备份，可一键还原）".into());
            }
        }
        "hermes" => {
            note = "首次触发钩子时 Hermes 会请求确认；也可在 config.yaml 加 hooks_auto_accept: true".into();
        }
        "cursor" => {
            note = "v1 暂不支持自动写入，配置模板可在下方复制".into();
        }
        "dsh" => {
            note = "零配置：检测到安装即自动生效，无需任何写入".into();
        }
        _ => {}
    }
    if matches!(def.id, "zcode" | "codebuddy" | "codex" | "hermes") && bridge_exe().is_none() {
        warnings.push("未找到 pet-bridge，无法自动接入（安装似乎不完整）".into());
    }
    let warning = warnings.join("；");

    AgentStatus {
        id: def.id,
        name: def.name,
        detected: dir_exists,
        integrated,
        has_backup: latest_backup(def.id).is_some(),
        config_path: cfg_path.display().to_string(),
        warning,
        note,
    }
}

pub fn scan_impl() -> Vec<AgentStatus> {
    AGENTS.iter().map(scan_one).collect()
}

// ---------- 接入 / 还原 ----------

pub fn integrate_impl(app: &tauri::AppHandle, id: &str) -> Result<AgentStatus, String> {
    let def = AGENTS.iter().find(|d| d.id == id).ok_or("未知 Agent")?;
    match id {
        "dsh" => return Ok(scan_one(def)), // 无配置可写
        "cursor" => return Err("Cursor 目前需手动接入：复制下方模板到 ~/.cursor/mcp.json".into()),
        _ => {}
    }
    let bridge = bridge_exe().ok_or("未找到 pet-bridge，无法接入（请重新安装 Nekode）")?;
    let home = home().ok_or("无法定位用户目录")?;
    let cfg_path = home.join(def.config);
    let original = fs::read_to_string(&cfg_path).unwrap_or_default();
    let bridge_str = bridge.display().to_string();

    let new_content = match id {
        "zcode" => merge_zcode_json(&original, &bridge_str, "zcode")?,
        "codebuddy" => merge_codebuddy_json(&original, &bridge_str, "codebuddy")?,
        "codex" => merge_codex_toml(&original, &bridge_str)?.0,
        "hermes" => {
            let dir_fwd = bridge
                .parent()
                .unwrap_or(Path::new(""))
                .display()
                .to_string()
                .replace('\\', "/");
            merge_hermes_yaml(&original, &dir_fwd, "hermes")?
        }
        _ => return Err("该 Agent 不支持自动接入".into()),
    };

    backup_config(&cfg_path, id)?;
    if let Some(parent) = cfg_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    fs::write(&cfg_path, new_content).map_err(|e| format!("写入失败: {e}"))?;
    println!("[nekode] 向导：{} 接入完成", def.name);
    let _ = app.emit("wizard-changed", id);
    let _ = app.emit("pet-demo", ()); // 让小猫立刻撒花，给用户即时正反馈
    Ok(scan_one(def))
}

pub fn restore_impl(app: &tauri::AppHandle, id: &str) -> Result<AgentStatus, String> {
    let def = AGENTS.iter().find(|d| d.id == id).ok_or("未知 Agent")?;
    if id == "dsh" {
        return Err("DeepSeek Harness 为零配置接入，无需还原".into());
    }
    let bk = latest_backup(id).ok_or("没有可用的备份")?;
    let home = home().ok_or("无法定位用户目录")?;
    let cfg_path = home.join(def.config);
    fs::copy(&bk, &cfg_path).map_err(|e| format!("还原失败: {e}"))?;
    println!("[nekode] 向导：{} 已还原自 {}", def.name, bk.display());
    let _ = app.emit("wizard-changed", id);
    Ok(scan_one(def))
}

// ---------- 单元测试 ----------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zcode_empty_config_gets_all_events_and_enabled() {
        let out = merge_zcode_json("", "C:\\pet\\pet-bridge.exe", "zcode").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["hooks"]["enabled"], serde_json::json!(true));
        for ev in ZCODE_EVENTS {
            let arr = v["hooks"]["events"][ev].as_array().unwrap();
            assert_eq!(arr.len(), 1, "event {ev}");
            assert_eq!(arr[0]["hooks"][0]["type"], "process");
            assert_eq!(arr[0]["hooks"][0]["command"], "C:\\pet\\pet-bridge.exe");
        }
    }

    #[test]
    fn zcode_merge_is_idempotent_and_keeps_user_fields() {
        let user = r#"{
            "model": "gpt-5",
            "hooks": { "events": { "Stop": [ { "hooks": [ { "type": "process", "command": "X:\\other\\hook.exe", "args": [] } ] } ] } }
        }"#;
        let once = merge_zcode_json(user, "C:\\pet\\pet-bridge.exe", "zcode").unwrap();
        let twice = merge_zcode_json(&once, "C:\\pet\\pet-bridge.exe", "zcode").unwrap();
        assert_eq!(once, twice, "重复接入不应追加重复条目");
        let v: serde_json::Value = serde_json::from_str(&twice).unwrap();
        assert_eq!(v["model"], "gpt-5", "用户其他字段必须保留");
        let stop = v["hooks"]["events"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2, "用户已有钩子 + 我们的钩子");
        assert_eq!(
            v["hooks"]["events"]["SessionStart"].as_array().unwrap().len(),
            1
        );
    }

    #[test]
    fn zcode_rejects_hooks_non_object() {
        let out = merge_zcode_json(r#"{"hooks": "nope"}"#, "C:\\p\\pet-bridge.exe", "zcode");
        assert!(out.is_err());
    }

    #[test]
    fn codebuddy_appends_command_style_and_dedupes() {
        let once = merge_codebuddy_json("", "C:\\pet\\pet-bridge.exe", "codebuddy").unwrap();
        let v: serde_json::Value = serde_json::from_str(&once).unwrap();
        let arr = v["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(arr[0]["hooks"][0]["type"], "command");
        assert!(arr[0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("--agent codebuddy"));
        let twice = merge_codebuddy_json(&once, "C:\\pet\\pet-bridge.exe", "codebuddy").unwrap();
        assert_eq!(once, twice, "重复接入不应追加重复条目");
    }

    #[test]
    fn codebuddy_quotes_path_with_spaces() {
        let out = merge_codebuddy_json("", "C:\\my tools\\pet-bridge.exe", "codebuddy").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let cmd = v["hooks"]["Stop"][0]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.starts_with('"'), "带空格路径需加引号: {cmd}");
    }

    #[test]
    fn codex_toml_preserves_comments_and_sets_notify() {
        let txt = "# 我的应用配置\nmodel = \"o3\"\n\n[profile.dev]\nverbose = true\n";
        let (out, overwrote) = merge_codex_toml(txt, "C:\\pet\\pet-bridge.exe").unwrap();
        assert!(!overwrote);
        assert!(out.contains("# 我的应用配置"), "注释必须保留");
        assert!(out.contains("[profile.dev]"), "表结构必须保留");
        let d: toml_edit::DocumentMut = out.parse().unwrap();
        let arr = d.get("notify").unwrap().as_array().unwrap();
        assert_eq!(arr.get(0).unwrap().as_str().unwrap(), "C:\\pet\\pet-bridge.exe");
        assert_eq!(arr.get(2).unwrap().as_str().unwrap(), "codex");
    }

    #[test]
    fn codex_overwrite_flag_and_idempotence() {
        let custom = "notify = [\"C:\\\\other\\\\notify.exe\"]\n";
        let (out, overwrote) = merge_codex_toml(custom, "C:\\pet\\pet-bridge.exe").unwrap();
        assert!(overwrote, "覆盖自定义 notify 必须打标");
        let (out2, overwrote2) = merge_codex_toml(&out, "C:\\pet\\pet-bridge.exe").unwrap();
        assert!(!overwrote2, "再次接入视为已接入");
        assert_eq!(out, out2);
    }

    #[test]
    fn codex_shim_integration_is_kept_untouched() {
        let shim = "notify = ['E:\\\\Nekode\\\\nekode-codex-shim.exe']\nmodel = \"x\"\n";
        let (out, overwrote) = merge_codex_toml(shim, "C:\\pet\\pet-bridge.exe").unwrap();
        assert!(!overwrote, "shim 是完整接入，不应打覆盖标");
        assert_eq!(out, shim, "shim 配置必须原样保留，不得降级为直连");
        assert!(toml_notify_integrated(shim), "shim 应判定为已接入");
    }

    #[test]
    fn hermes_creates_from_empty_uses_forward_slash_no_exe() {
        let out = merge_hermes_yaml("", "E:/Nekode", "hermes").unwrap();
        let v: serde_yaml::Value = serde_yaml::from_str(&out).unwrap();
        let cmd = v["hooks"]["on_session_start"][0]["command"].as_str().unwrap();
        assert_eq!(cmd, "E:/Nekode/pet-bridge --map hermes --agent hermes");
        assert!(!cmd.contains(".exe"), "Hermes 模板不带 .exe 后缀");
        assert_eq!(v["hooks"]["on_session_start"][0]["timeout"], 10);
    }

    #[test]
    fn hermes_idempotent_and_preserves_user_keys() {
        let user = "model: hermes-x\nhooks:\n  on_session_end:\n    - command: \"other-hook\"\n      timeout: 5\n";
        let once = merge_hermes_yaml(user, "E:/Nekode", "hermes").unwrap();
        let twice = merge_hermes_yaml(&once, "E:/Nekode", "hermes").unwrap();
        assert_eq!(once, twice);
        let v: serde_yaml::Value = serde_yaml::from_str(&twice).unwrap();
        assert_eq!(v["model"], "hermes-x");
        let end = v["hooks"]["on_session_end"].as_sequence().unwrap();
        assert_eq!(end.len(), 2, "用户已有钩子 + 我们的钩子");
        let start = v["hooks"]["on_session_start"].as_sequence().unwrap();
        assert_eq!(start.len(), 1);
    }

    #[test]
    fn json_has_bridge_detects_both_styles() {
        let zcode_style = serde_json::json!({
            "hooks": { "events": { "Stop": [ { "hooks": [ {
                "type": "process", "command": "C:\\pet\\pet-bridge.exe",
                "args": ["--map", "claude", "--agent", "zcode"] } ] } ] }
            }
        });
        assert!(json_has_bridge(&zcode_style, "zcode"));
        assert!(!json_has_bridge(&zcode_style, "codebuddy"));

        let cb_style = serde_json::json!({
            "hooks": { "Stop": [ { "hooks": [ {
                "type": "command", "command": "C:\\pet\\pet-bridge.exe --map claude --agent codebuddy" } ] } ] }
        });
        assert!(json_has_bridge(&cb_style, "codebuddy"));
        assert!(!json_has_bridge(&cb_style, "zcode"));
    }

    #[test]
    fn hermes_yaml_integrated_detection() {
        let out = merge_hermes_yaml("", "E:/Nekode", "hermes").unwrap();
        assert!(yaml_integrated(&out));
        assert!(!yaml_integrated("model: x\n"));
    }
}
