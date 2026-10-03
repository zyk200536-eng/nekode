#!/usr/bin/env node
// agentpet MCP server：给 Cursor 等支持 MCP 但没有钩子机制的 agent 使用。
// agent 主动调用 pet_notify 工具向桌宠报告状态。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const PORT = process.env.AGENTPET_PORT || "21435";

const server = new McpServer({ name: "agentpet", version: "0.1.0" });

server.tool(
  "pet_notify",
  "向桌宠报告任务进展（桌宠会显示对应状态动画和气泡文字）。任务开始用 start，需要用户确认用 waiting，任务完成用 done，失败用 error。",
  {
    event: z
      .enum(["start", "progress", "waiting", "done", "error"])
      .describe("事件类型"),
    message: z.string().max(200).optional().describe("气泡文字，一句话描述当前状态"),
  },
  async ({ event, message }) => {
    const url =
      `http://127.0.0.1:${PORT}/e?agent=cursor&event=${event}` +
      (message ? `&msg=${encodeURIComponent(message)}` : "");
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) });
      return { content: [{ type: "text", text: "已通知桌宠" }] };
    } catch {
      // 桌宠未运行时静默成功，不影响 agent 任务
      return { content: [{ type: "text", text: "桌宠未运行，已跳过通知" }] };
    }
  },
);

await server.connect(new StdioServerTransport());
