import "./style.css";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Pet, Bubble, type PetEvent, type SkinInfo } from "./pet";

const isBubble = getCurrentWindow().label === "bubble";
const isSettings = getCurrentWindow().label === "settings";
const isPanel = getCurrentWindow().label === "panel";
document.body.classList.add(
  isBubble
    ? "win-bubble"
    : isSettings
      ? "win-settings"
      : isPanel
        ? "win-panel"
        : "win-pet",
);

if (isBubble) {
  const bubble = new Bubble(document.getElementById("bubble")!);
  listen<PetEvent>("pet-event", (e) => bubble.handleEvent(e.payload));
  listen("pet-demo", () => bubble.demo());
  invoke<{ bubbleSeconds: number }>("get_state")
    .then((s) => bubble.setBubbleSeconds(s.bubbleSeconds))
    .catch(() => {});
  listen<{ bubbleSeconds: number }>("config-changed", (e) =>
    bubble.setBubbleSeconds(e.payload.bubbleSeconds),
  );
} else if (isPanel) {
  await import("./panel");
} else {
  const canvas = document.getElementById("pet") as HTMLCanvasElement;
  const pet = new Pet(canvas);

  (async () => {
    const state = await invoke<{ skin: string }>("get_state").catch(() => null);
    const ok = state ? await pet.loadSkin(state.skin) : false;
    if (!ok) await pet.loadBundled();
    pet.start();
  })();

  // 自动换肤：单任务时切换成对应 agent 的皮肤；多任务/空闲时用小猫
  const agentActivity = new Map<string, { state: PetEvent["event"]; ts: number }>();
  let currentSkin = "neko";
  const ACTIVE_STATES = new Set(["start", "progress", "waiting"]);

  listen<PetEvent>("pet-event", (e) => {
    pet.handleEvent(e.payload);
    const now = Date.now();
    agentActivity.set(e.payload.agent, { state: e.payload.event, ts: now });
    for (const [k, v] of [...agentActivity]) {
      if (now - v.ts > 10 * 60 * 1000) agentActivity.delete(k);
    }
    const active = [...agentActivity.entries()].filter(([, v]) => ACTIVE_STATES.has(v.state));
    const desired = active.length === 1 ? active[0][0] : "neko";
    if (desired !== currentSkin) {
      currentSkin = desired;
      pet
        .loadSkin(desired)
        .then((ok) => {
          if (!ok) {
            currentSkin = "neko";
            return pet.loadSkin("neko");
          }
          return undefined;
        })
        .catch(() => {});
    }
  });
  listen<SkinInfo>("skin-changed", async (e) => {
    currentSkin = e.payload.name;
    const ok = await pet.loadSkin(e.payload.name);
    if (!ok) await pet.loadBundled();
  });
  listen("pet-demo", () => pet.demo());

  // v2：有待决授权时，单击小猫 = 批准（此时不触发拖拽）
  let pendingCount = 0;
  let downPos: { x: number; y: number } | null = null;
  listen<{ count: number }>("pet-question", (e) => {
    pendingCount = e.payload.count;
  });
  listen<{ count: number }>("panel-resolved", (e) => {
    pendingCount = e.payload.count;
  });

  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    downPos = { x: e.clientX, y: e.clientY };
    if (pendingCount === 0) {
      getCurrentWindow()
        .startDragging()
        .catch(() => {});
    }
  });

  canvas.addEventListener("mouseup", (e) => {
    if (!downPos) return;
    const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
    downPos = null;
    if (moved < 6 && pendingCount > 0) {
      invoke("click_approve").catch(() => {});
    }
  });

  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    invoke("show_ctx_menu").catch(() => {});
  });
}
