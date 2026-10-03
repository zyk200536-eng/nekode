#!/usr/bin/env node
// agentpet MCP server：给 Cursor 等支持 MCP 但没有钩子机制的 agent 使用。
// v1: pet_notify 单向报告；v2/v3: pet_request_approval / pet_ask 双向交互。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const PORT = process.env.AGENTPET_PORT || "21435";
const AGENT = process.env.AGENTPET_AGENT || "cursor";
const BRIDGE = `http://127.0.0.1:${PORT}`;

async function notify(event, message) {
  const url =
    `${BRIDGE}/e?agent=${AGENT}&event=${event}` +
    (message ? `&msg=${encodeURIComponent(message)}` : "");
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) });
  } catch {}
}

async function ask(kind, message, options, timeoutSec) {
  const res = await fetch(`${BRIDGE}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: AGENT, kind, message, options, timeout: timeoutSec }),
    signal: AbortSignal.timeout(5000),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || "ask failed");
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      const r2 = await fetch(`${BRIDGE}/result?id=${encodeURIComponent(j.id)}`, {
        signal: AbortSignal.timeout(3000),
      });
      const jj = await r2.json();
      if (jj.status === "resolved") return jj.value;
      if (jj.status === "timeout" || jj.status === "unknown") return jj.status;
    } catch {}
  }
  return "timeout";
}

const server = new McpServer({ name: "agentpet", version: "0.2.0" });

server.tool(
  "pet_notify",
  "向桌宠报告任务进展（桌宠会显示对应状态动画和气泡文字）。任务开始用 start，需要用户确认用 waiting，任务完成用 done，失败用 error。",
  {
    event: z.enum(["start", "progress", "waiting", "done", "error"]).describe("事件类型"),
    message: z.string().max(200).optional().describe("气泡文字，一句话描述当前状态"),
  },
  async ({ event, message }) => {
    await notify(event, message);
    return { content: [{ type: "text", text: "已通知桌宠" }] };
  },
);

server.tool(
  "pet_request_approval",
  "在桌宠上弹出授权卡片，用户点「批准/拒绝」或直接单击小猫即批准。执行删除文件、发布、支付等不可逆操作前应调用此工具请求许可，返回 \"approved\"/\"denied\"/\"timeout\"。",
  {
    message: z.string().max(200).describe("请求授权的事项说明，一句话"),
    timeout_seconds: z.number().optional().describe("等待超时秒数，默认 60，最大 600"),
  },
  async ({ message, timeout_seconds }) => {
    const t = Math.min(600, Math.max(5, Math.round(timeout_seconds ?? 60)));
    await notify("waiting", message);
    const value = await ask("approval", message, [], t).catch(() => "timeout");
    const text = value === "approved" ? "已批准" : value === "denied" ? "已拒绝" : "超时未响应";
    return { content: [{ type: "text", text }] };
  },
);

server.tool(
  "pet_ask",
  "在桌宠上弹出选择题卡片，返回用户点选的选项文本。遇到多个可选方案时用它让用户点选。",
  {
    message: z.string().max(200).describe("问题说明"),
    options: z.array(z.string()).min(2).max(6).describe("候选选项，2-6 个"),
    timeout_seconds: z.number().optional().describe("等待超时秒数，默认 60，最大 600"),
  },
  async ({ message, options, timeout_seconds }) => {
    const t = Math.min(600, Math.max(5, Math.round(timeout_seconds ?? 60)));
    await notify("waiting", message);
    const value = await ask("choice", message, options, t).catch(() => "timeout");
    return {
      content: [{ type: "text", text: value === "timeout" ? "超时未响应" : `用户选择：${value}` }],
    };
  },
);

await server.connect(new StdioServerTransport());
