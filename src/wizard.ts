import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface AgentStatus {
  id: string;
  name: string;
  detected: boolean;
  integrated: boolean;
  has_backup: boolean;
  config_path: string;
  warning: string;
  note: string;
}

// 与 integrations/README.md 的双向交互文案一致
const RULE_TEXT = `执行删除文件、覆盖发布等不可逆操作前，先用 pet_request_approval 工具向桌宠请求授权，得到 approved 再继续；
遇到多个可选方案时，用 pet_ask 工具让用户在桌宠上点选；
干活过程中随时调用 pet_notify(progress, 一句话) 播报你正在做的事——文字会实时显示在桌宠头顶。`;

const CURSOR_TEMPLATE = `{
  "mcpServers": {
    "agentpet": {
      "command": "node",
      "args": ["<Nekode 仓库路径>\\\\integrations\\\\cursor-mcp\\\\index.mjs"]
    }
  }
}`;

const root = document.getElementById("wizard-root")!;
root.classList.remove("hidden");

root.innerHTML = `
  <h1>接入向导</h1>
  <p class="sub">自动检测本机已装的 AI Agent，一键写入钩子配置。写前自动备份，随时可还原；接入后重启对应 Agent 生效。</p>
  <div id="agent-list"></div>
  <div id="wizard-msg"></div>
  <section class="tipbox">
    <h2>双向交互（可选）</h2>
    <p>把下面的说明加进项目的 CLAUDE.md / .cursorrules 等规则文件，Agent 就能反过来在桌宠上向你提问、请求授权：</p>
    <pre id="rule-text"></pre>
    <div class="btnrow">
      <button id="copy-rule">复制说明文案</button>
      <button id="copy-cursor">复制 Cursor 配置模板</button>
    </div>
  </section>
`;

(root.querySelector("#rule-text") as HTMLElement).textContent = RULE_TEXT;

const listEl = root.querySelector("#agent-list") as HTMLDivElement;
const msgEl = root.querySelector("#wizard-msg") as HTMLElement;

function badge(a: AgentStatus): { text: string; cls: string } {
  if (a.id === "dsh")
    return a.detected ? { text: "自动生效", cls: "ok" } : { text: "未安装", cls: "dim" };
  if (!a.detected) return { text: "未安装", cls: "dim" };
  if (a.id === "cursor")
    return { text: "需手动接入", cls: "warn" };
  if (a.integrated) return { text: "已接入 ✓", cls: "ok" };
  return { text: "未接入", cls: "warn" };
}

function render(agents: AgentStatus[]): void {
  listEl.innerHTML = "";
  for (const a of agents) {
    const row = document.createElement("div");
    row.className = "agent-row";
    const b = badge(a);
    const warn = a.warning
      ? `<p class="warn-text">⚠ ${a.warning}</p>`
      : a.note
        ? `<p class="note-text">${a.note}</p>`
        : "";
    row.innerHTML = `
      <div class="agent-info">
        <div class="agent-head"><b>${a.name}</b><span class="badge ${b.cls}">${b.text}</span></div>
        <p class="path">${a.config_path || "无需配置文件"}</p>
        ${warn}
      </div>
      <div class="agent-actions"></div>
    `;
    const actions = row.querySelector(".agent-actions") as HTMLDivElement;
    const canAuto = a.detected && !a.integrated && !["cursor", "dsh"].includes(a.id);
    if (canAuto) {
      const btn = document.createElement("button");
      btn.className = "primary";
      btn.textContent = a.warning ? "覆盖接入" : "一键接入";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "接入中…";
        try {
          await invoke<AgentStatus>("wizard_integrate", { id: a.id });
          msgEl.textContent = "";
        } catch (e) {
          msgEl.textContent = `${a.name} 接入失败：${e}`;
        }
        await refresh();
      });
      actions.append(btn);
    }
    if (a.has_backup) {
      const restore = document.createElement("button");
      restore.textContent = "还原";
      restore.title = "把配置文件回滚到最近一次接入前的状态";
      restore.addEventListener("click", async () => {
        restore.disabled = true;
        try {
          await invoke<AgentStatus>("wizard_restore", { id: a.id });
          msgEl.textContent = "";
        } catch (e) {
          msgEl.textContent = `${a.name} 还原失败：${e}`;
        }
        await refresh();
      });
      actions.append(restore);
    }
    listEl.append(row);
  }
}

async function refresh(): Promise<void> {
  const agents = await invoke<AgentStatus[]>("wizard_scan").catch(() => []);
  render(agents);
}

listen("wizard-changed", () => {
  refresh();
});

refresh();

root.querySelector("#copy-rule")?.addEventListener("click", (e) => {
  navigator.clipboard
    .writeText(RULE_TEXT)
    .then(() => {
      const btn = e.target as HTMLButtonElement;
      btn.textContent = "已复制 ✓";
      window.setTimeout(() => (btn.textContent = "复制说明文案"), 1500);
    })
    .catch(() => {});
});

root.querySelector("#copy-cursor")?.addEventListener("click", (e) => {
  navigator.clipboard
    .writeText(CURSOR_TEMPLATE)
    .then(() => {
      const btn = e.target as HTMLButtonElement;
      btn.textContent = "已复制 ✓";
      window.setTimeout(() => (btn.textContent = "复制 Cursor 配置模板"), 1500);
    })
    .catch(() => {});
});
