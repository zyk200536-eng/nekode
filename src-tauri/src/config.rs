use serde::Deserialize;
use std::fs;
use std::path::PathBuf;

fn default_port() -> u16 {
    21435
}

fn default_bubble_seconds() -> u64 {
    5
}

fn default_skin() -> String {
    "agentpet".into()
}

/// 用户配置文件：~/.agentpet/config.json
#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_bubble_seconds")]
    pub bubble_seconds: u64,
    #[serde(default = "default_skin")]
    pub skin: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            port: default_port(),
            bubble_seconds: default_bubble_seconds(),
            skin: default_skin(),
        }
    }
}

impl Config {
    pub fn load() -> Self {
        if let Some(p) = config_path() {
            if let Ok(txt) = fs::read_to_string(&p) {
                match serde_json::from_str::<Config>(&txt) {
                    Ok(c) => return c,
                    Err(e) => eprintln!("[nekode] 配置解析失败，使用默认配置: {e}"),
                }
            }
        }
        Config::default()
    }
}

/// 读-改-写 config.json（只动指定字段，其余保留）。
pub fn update_config(f: impl FnOnce(&mut serde_json::Value)) {
    let Some(p) = config_path() else { return };
    let mut v = fs::read_to_string(&p)
        .ok()
        .and_then(|txt| serde_json::from_str::<serde_json::Value>(&txt).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    f(&mut v);
    if let Ok(txt) = serde_json::to_string_pretty(&v) {
        if let Some(dir) = p.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(&p, txt);
    }
}

pub fn config_path() -> Option<PathBuf> {
    home::home_dir().map(|h| h.join(".agentpet").join("config.json"))
}
