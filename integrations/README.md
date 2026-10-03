# Nekode 接入指南

各 AI agent 通过"钩子/通知机制 → pet-bridge → 事件桥"把任务状态推给桌宠。

## 统一事件格式

| 事件 | 含义 | 宠物表现 |
|---|---|---|
| `start` | 任务开始 | 干活动画 |
| `progress` | 干活中的动作（如"正在改 main.ts"） | 干活动画 + 气泡 |
| `waiting` | 需要用户确认/输入 | 等待动画 + 气泡 |
| `done` | 任务完成 | 撒花动画 + 气泡 |
| `error` | 出错 | 报错动画 + 气泡 |

事件桥监听 `http://127.0.0.1:21435`（端口可在 `~/.agentpet/config.json` 改 `port` 字段，被占用时自动 +1 重试）。实际端口以启动日志/托盘为准。

快速自测（桌宠运行时）：

```bash
curl "http://127.0.0.1:21435/e?agent=test&event=done&msg=%E6%B5%8B%E8%AF%95"
```

## 接入方式 A：pet-bridge（推荐）

pet-bridge.exe 随 Nekode 一起安装，自动解析各家钩子传来的 stdin/argv JSON，任何失败都静默退出、不影响 agent。安装后位于安装目录（默认 `%LOCALAPPDATA%\agentpet\pet-bridge.exe`）。

- `--agent <名字>`：事件里显示的 agent 名
- `--map <claude|codex|hermes>`：stdin JSON 解析规则（claude 适用于 ZCode/CodeBuddy 等 Claude Code 系钩子）
- `--event <事件>`：不指定时由 --map 自动推断

## 各 agent 配置

### 1. ZCode（~/.zcode/cli/config.json）

ZCode 钩子与 Claude Code 系不同：配置写在 `hooks.events` 下、**必须 `enabled: true`**（否则钩子不运行）、没有 Notification 事件（等价的是 `PermissionRequest`）。推荐 `process` 类型（免 shell 转义，跨平台最稳）：

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "SessionStart": [
        { "hooks": [ { "type": "process", "command": "<PET_DIR>\\pet-bridge.exe", "args": ["--map", "claude", "--agent", "zcode"] } ] }
      ],
      "UserPromptSubmit": [
        { "hooks": [ { "type": "process", "command": "<PET_DIR>\\pet-bridge.exe", "args": ["--map", "claude", "--agent", "zcode"] } ] }
      ],
      "PostToolUse": [
        { "hooks": [ { "type": "process", "command": "<PET_DIR>\\pet-bridge.exe", "args": ["--map", "claude", "--agent", "zcode"] } ] }
      ],
      "PermissionRequest": [
        { "hooks": [ { "type": "process", "command": "<PET_DIR>\\pet-bridge.exe", "args": ["--map", "claude", "--agent", "zcode"] } ] }
      ],
      "Stop": [
        { "hooks": [ { "type": "process", "command": "<PET_DIR>\\pet-bridge.exe", "args": ["--map", "claude", "--agent", "zcode"] } ] }
      ]
    }
  }
}
```

`<PET_DIR>` 替换为 pet-bridge.exe 所在目录。修改后重启 ZCode 生效。

### 2. Hermes Agent（~/.hermes/config.yaml）

```yaml
hooks:
  on_session_start:
    - command: "<PET_DIR>/pet-bridge --map hermes --agent hermes"
      timeout: 10
  post_tool_call:
    - command: "<PET_DIR>/pet-bridge --map hermes --agent hermes"
      timeout: 10
  pre_approval_request:
    - command: "<PET_DIR>/pet-bridge --map hermes --agent hermes"
      timeout: 10
  on_session_end:
    - command: "<PET_DIR>/pet-bridge --map hermes --agent hermes"
      timeout: 10
```

注意：
- Hermes 首次触发钩子会弹同意确认，或在 config.yaml 加 `hooks_auto_accept: true`。
- Windows 上路径用正斜杠（Hermes 用 shlex.split 解析命令）。

### 3. WorkBuddy / CodeBuddy CLI（~/.codebuddy/settings.json）

钩子结构与 ZCode/Claude Code 相同，把 `--agent` 换成 `codebuddy`：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "<PET_DIR>\\pet-bridge.exe --map claude --agent codebuddy" } ] }
    ],
    "PostToolUse": [
      { "hooks": [ { "type": "command", "command": "<PET_DIR>\\pet-bridge.exe --map claude --agent codebuddy" } ] }
    ],
    "Notification": [
      { "hooks": [ { "type": "command", "command": "<PET_DIR>\\pet-bridge.exe --map claude --agent codebuddy" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "<PET_DIR>\\pet-bridge.exe --map claude --agent codebuddy" } ] }
    ]
  }
}
```

### 4. Codex CLI（~/.codex/config.toml）

```toml
notify = ["<PET_DIR>\\pet-bridge.exe", "--map", "codex"]
```

Codex 在一轮任务结束时调用该命令并把 JSON 作为最后一个参数传入，桌宠显示"完成 + 回复摘要"。

### 5. Cursor（MCP 软接入）

无钩子机制，走 MCP 工具让 agent 主动报告：

```bash
cd integrations/cursor-mcp && npm install
```

Cursor 的 MCP 配置（`~/.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "agentpet": {
      "command": "node",
      "args": ["<REPO_DIR>\\integrations\\cursor-mcp\\index.mjs"]
    }
  }
}
```

再在项目 `.cursorrules`（或 Cursor 设置的 Rules）里加一句：

```
任务开始、需要确认、完成或失败时，调用 pet_notify 工具报告状态，message 用一句话概括。
```

## 用户配置（~/.agentpet/config.json）

```json
{
  "port": 21435,
  "bubble_seconds": 5
}
```

## 已知边界

- 钩子给的是状态变化，不是百分比进度条；气泡展示"正在做什么"的一句话摘要。
- 多个 agent 同时干活时：宠物显示最高优先级状态（等待 > 干活），气泡显示最近一条事件。

## v2/v3：点击授权与选择交互（MCP）

接入 agentpet MCP server 的 agent 额外获得两个双向交互工具：

- `pet_request_approval(message, timeout_seconds)`：桌宠上方弹出授权卡片，用户点「批准/拒绝」，或**直接单击小猫即批准**。返回 `"approved"` / `"denied"` / `"timeout"`。执行删除、发布、支付等不可逆操作前调用。
- `pet_ask(message, options, timeout_seconds)`：弹出选择题卡片（2-6 个选项），返回用户点选的选项文本。

建议在 agent 的规则文件（`.cursorrules` / `CLAUDE.md` / `AGENTS.md`）中加入：

```text
执行删除文件、覆盖发布等不可逆操作前，先用 pet_request_approval 工具向桌宠请求授权，得到 approved 再继续；
遇到多个可选方案时，用 pet_ask 工具让用户在桌宠上点选；
干活过程中随时调用 pet_notify(progress, 一句话) 播报你正在做的事——文字会实时显示在桌宠头顶。
```
