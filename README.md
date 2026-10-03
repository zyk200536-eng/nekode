# Nekode 🐾

**一只桌宠，盯着你所有的 AI Agent 干活。**

Nekode 是一个桌面宠物程序：它常驻你的屏幕角落，通过各家 AI Agent 的钩子（Hook）机制实时获取任务状态——开始干活、正在做什么、等你确认、完成、出错——并用动画和气泡提示你。

兼容 Claude Code 系、Codex、Hermes、Cursor 等主流 CLI Agent，一次配置，全家桶监控。

> Nekode = **Neko**（猫）+ **Code**（代码）：一只能帮你盯着代码的猫。

## 功能

- 🐱 **状态动画 + 气泡提示**：待机 / 干活 / 等你确认 / 撒花 / 报错，五种状态自动切换
- 🔌 **多 Agent 兼容**：基于钩子机制的统一事件桥，新增 Agent 只需一份配置模板
- 🎨 **皮肤系统**：右键一键换肤；像素风、应用图标、任意尺寸精灵图都能当皮肤
- 🫧 **零打扰设计**：气泡窗永久点击穿透，不挡桌面、不抢焦点
- ⚙️ **设置面板**：皮肤选择、气泡时长、开机自启、位置重置
- 🪶 **轻量常驻**：Tauri 构建，安装包 ~1.6MB，后台内存占用几十 MB

## 支持的 AI Agent

| Agent | 接入方式 | 难度 |
|---|---|---|
| Claude Code / ZCode / CodeBuddy | 原生 hooks | ⭐ 一行配置 |
| Codex CLI / 桌面版 | notify 配置（含转发器，不覆盖原通知） | ⭐⭐ |
| Hermes Agent | config.yaml 钩子块 | ⭐ |
| Cursor 等无钩子 Agent | MCP 工具软接入 | ⭐⭐ |

各 Agent 的完整接入配置见 **[integrations/README.md](integrations/README.md)**。

## 架构

```
各家 Agent（每个只需一行钩子配置）
   ↓  hooks / notify / MCP
事件桥（本地 127.0.0.1 HTTP 服务，统一事件格式）
   ↓  start / progress / waiting / done / error
宠物本体（透明置顶小窗：状态动画 + 气泡）
```

## 快速开始

### 安装（Windows）

从 [Releases](../../releases) 下载 `Nekode_x.y.z_x64-setup.exe` 安装运行即可。
macOS 版由 GitHub Actions 自动构建（Release 附 dmg）。

### 源码构建

```bash
npm install
npm run tauri build
# 产物：src-tauri/target/release/bundle/nsis/*.exe
```

依赖：Node 20+、Rust 1.77+、平台 WebView 运行时（Windows 自带 WebView2）。

### 验证事件桥

桌宠运行时：

```bash
curl "http://127.0.0.1:21435/e?agent=test&event=done&msg=hello"
```

## 皮肤系统

`skins/<名字>/` 目录 = `manifest.json`（名称 + 帧尺寸）+ 五张状态精灵图（idle/working/waiting/success/error，横向排帧，帧数 = 图宽 ÷ 帧宽；manifest 标  即为高清原图直出模式，由渲染器自动选择采样方式）。

- 内置皮肤：Nekode 原创像素团子
- 把任意 PNG 图标像素化成皮肤的脚本：`node scripts/gen-skins.mjs`（源图放 `design/logos/`）
- ⚠️ 各 AI Agent 的官方 Logo 属于其商标，**仅限本地自用，请勿随安装包分发或入库**

## 路线图

- [x] v1：状态动画 + 气泡 + 多 Agent 事件桥 + 皮肤 + 设置面板
- [x] v2：点击宠物授权（MCP 工具 pet_request_approval：批准/拒绝/单击小猫）
- [x] v3：询问选择交互（MCP 工具 pet_ask：桌宠弹选择题返回选项）
- [ ] 更多原创皮肤 / 皮肤商店

## English

Nekode is a desktop pet that watches your AI coding agents work. It receives
lifecycle events (task started / tool activity / waiting for approval / done /
error) from agents like Claude Code, Codex, Hermes, ZCode and CodeBuddy via
their native hook mechanisms (plus an MCP server for agents without hooks),
and renders them as sprite animations with speech bubbles on a
click-through transparent window. Built with Tauri 2 — installer is ~1.6 MB.

See [integrations/README.md](integrations/README.md) for per-agent setup, and
the skin pack format above.

## License

[MIT](LICENSE) © Nekode contributors
