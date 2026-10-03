//! nekode-codex-shim：Codex notify 转发器。
//! Codex 配置 notify 指向本程序后，每个回合结束时：
//!   1. 转发事件给 Nekode 桌宠（pet-bridge --map codex）
//!   2. 同时调用 Codex 桌面版原通知组件（computer-use），功能不受影响
//! 任何失败都静默退出（exit 0），绝不影响 Codex 本身。
use std::path::PathBuf;
use std::time::SystemTime;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // 1) 转发给桌宠（pet-bridge.exe 与本程序同目录，等待其毫秒级完成）
    let pet_bridge = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("pet-bridge.exe")));
    if let Some(bridge) = pet_bridge {
        if let Ok(mut child) = std::process::Command::new(bridge)
            .arg("--map")
            .arg("codex")
            .args(&args)
            .spawn()
        {
            let _ = child.wait();
        }
    }

    // 2) 转发给 Codex 桌面版原通知组件（不等待，fire-and-forget）
    if let Some(orig) = find_original_notifier() {
        let _ = std::process::Command::new(orig)
            .arg("turn-ended")
            .args(&args)
            .spawn();
    }
}

/// 在 %LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\* 中找最新的
/// codex-computer-use.exe——桌面版升级更换哈希目录后自动跟随。
fn find_original_notifier() -> Option<PathBuf> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    let base = PathBuf::from(local)
        .join("OpenAI")
        .join("Codex")
        .join("runtimes")
        .join("cua_node");
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(&base).ok()? {
        let Ok(entry) = entry else { continue };
        let exe = entry
            .path()
            .join(r"bin\node_modules\@oai\sky\bin\windows\codex-computer-use.exe");
        if !exe.is_file() {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        if best.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
            best = Some((mtime, exe));
        }
    }
    best.map(|(_, p)| p)
}
