import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

interface PendingRequest {
  id: string;
  agent: string;
  kind: string; // approval | choice
  message: string;
  options: string[];
  timeout_sec: number;
}

const root = document.getElementById("panel-root")!;
root.classList.remove("hidden");
root.innerHTML = `
  <div id="panel-card">
    <div id="panel-head">暂无待处理请求</div>
    <div id="panel-msg"></div>
    <div id="panel-actions"></div>
  </div>
`;

const head = root.querySelector("#panel-head") as HTMLElement;
const msg = root.querySelector("#panel-msg") as HTMLElement;
const actions = root.querySelector("#panel-actions") as HTMLElement;

function clear(): void {
  head.textContent = "暂无待处理请求";
  msg.textContent = "";
  actions.innerHTML = "";
}

function render(req: PendingRequest): void {
  head.textContent = `${req.agent} 请求${req.kind === "approval" ? "授权" : "选择"}（${req.timeout_sec}s 内有效）`;
  msg.textContent = req.message;
  actions.innerHTML = "";

  const mk = (label: string, value: string, primary = false) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (primary) b.className = "primary";
    b.addEventListener("click", () => {
      invoke("resolve_request", { id: req.id, value })
        .catch(() => {})
        .finally(() => clear());
    });
    actions.append(b);
  };

  if (req.kind === "approval") {
    mk("批准（也可直接点击小猫）", "approved", true);
    mk("拒绝", "denied");
  } else {
    for (const opt of req.options) mk(opt, opt);
  }
}

listen<{ request: PendingRequest }>("pet-question", (e) => render(e.payload.request));
listen<{ count: number }>("panel-resolved", () => {
  invoke<PendingRequest[]>("get_pending")
    .then((list) => (list.length ? render(list[0]) : clear()))
    .catch(() => {});
});

invoke<PendingRequest[]>("get_pending")
  .then((list) => {
    if (list.length) render(list[0]);
  })
  .catch(() => {});
