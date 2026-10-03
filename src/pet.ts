import { invoke } from "@tauri-apps/api/core";

export type PetEventType = "start" | "progress" | "waiting" | "done" | "error";
export type PetState = "idle" | "working" | "waiting" | "success" | "error";

export interface PetEvent {
  agent: string;
  event: PetEventType;
  msg?: string | null;
  ts?: number;
}

export interface SkinInfo {
  name: string;
  frame: number;
}

const FRAME_MS = 150;
const ONE_SHOT_MS = 2000;
const CANVAS_SIZE = 96;

export const BUBBLE_DEFAULTS: Record<PetEventType, string> = {
  start: "开工啦！",
  progress: "正在努力干活…",
  waiting: "需要你确认一下~",
  done: "搞定！",
  error: "呜…出错了",
};

const DEMO_STEPS: [number, PetEvent][] = [
  [0, { agent: "demo", event: "start", msg: "开始执行任务…" }],
  [1800, { agent: "demo", event: "progress", msg: "正在读取 src/main.ts" }],
  [3600, { agent: "demo", event: "progress", msg: "正在运行测试 npm test" }],
  [5400, { agent: "demo", event: "waiting", msg: "需要你确认是否继续" }],
  [7200, { agent: "demo", event: "done", msg: "全部完成，测试通过！" }],
  [9600, { agent: "demo", event: "start", msg: "再来一个任务" }],
  [11400, { agent: "demo", event: "error", msg: "编译失败：缺少分号" }],
];

const STATES: PetState[] = ["idle", "working", "waiting", "success", "error"];

interface AgentState {
  state: PetEventType;
  ts: number;
}

/** 宠物窗：只负责动画与状态机。皮肤从 Rust 端 skins/ 目录加载。 */
export class Pet {
  private sheets = new Map<PetState, HTMLImageElement>();
  private frameCounts = new Map<PetState, number>();
  private agentStates = new Map<string, AgentState>();
  private display: PetState = "idle";
  private oneShot: { state: PetState; until: number } | null = null;
  private frame = 0;
  private lastFrameAt = 0;
  private art = 16;
  private scale = 6;
  private ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.ctx.imageSmoothingEnabled = false;
  }

  /** 从皮肤目录加载指定皮肤；失败返回 false（调用方回退到内置素材）。 */
  async loadSkin(name: string): Promise<boolean> {
    const skins = await invoke<SkinInfo[]>("list_skins").catch(() => []);
    if (!skins.length) return false;
    const skin =
      skins.find((s) => s.name === name) ??
      skins.find((s) => s.name === "agentpet") ??
      skins[0];
    const nextSheets = new Map<PetState, HTMLImageElement>();
    const nextCounts = new Map<PetState, number>();
    for (const state of STATES) {
      const bytes = await invoke<number[] | null>("read_sheet", {
        skin: skin.name,
        state,
      }).catch(() => null);
      if (!bytes || bytes.length === 0) continue;
      const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
      const img = new Image();
      img.src = URL.createObjectURL(blob);
      try {
        await img.decode();
      } catch {
        continue;
      }
      nextSheets.set(state, img);
      nextCounts.set(state, Math.max(1, Math.floor(img.width / skin.frame)));
    }
    if (nextSheets.size === 0) return false;
    this.sheets = nextSheets;
    this.frameCounts = nextCounts;
    this.art = skin.frame;
    this.scale = Math.max(1, Math.floor(CANVAS_SIZE / skin.frame));
    this.display = this.oneShot ? this.display : this.persistent();
    this.frame = 0;
    return true;
  }

  /** 内置兜底素材（public/sprites，16×16）。 */
  async loadBundled(): Promise<void> {
    await Promise.all(
      STATES.map(
        (state) =>
          new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => {
              this.sheets.set(state, img);
              this.frameCounts.set(state, 4);
              resolve();
            };
            img.onerror = () => resolve();
            img.src = `/sprites/${state}.png`;
          }),
      ),
    );
    this.art = 16;
    this.scale = 6;
  }

  start(): void {
    requestAnimationFrame(this.tick);
  }

  handleEvent(ev: PetEvent): void {
    this.agentStates.set(ev.agent, { state: ev.event, ts: Date.now() });
    if (ev.event === "done") {
      this.oneShot = { state: "success", until: Date.now() + ONE_SHOT_MS };
      this.display = "success";
    } else if (ev.event === "error") {
      this.oneShot = { state: "error", until: Date.now() + ONE_SHOT_MS };
      this.display = "error";
    } else {
      this.display = ev.event === "waiting" ? "waiting" : "working";
      this.oneShot = null;
    }
    this.frame = 0;
  }

  demo(): void {
    for (const [t, ev] of DEMO_STEPS) {
      window.setTimeout(() => this.handleEvent(ev), t);
    }
  }

  private persistent(): PetState {
    const states = [...this.agentStates.values()];
    if (states.some((s) => s.state === "waiting")) return "waiting";
    if (states.some((s) => s.state === "start" || s.state === "progress")) return "working";
    return "idle";
  }

  private tick = (ts: number): void => {
    if (this.oneShot && Date.now() > this.oneShot.until) {
      this.oneShot = null;
      this.display = this.persistent();
      this.frame = 0;
    }
    if (ts - this.lastFrameAt >= FRAME_MS) {
      this.lastFrameAt = ts;
      const count = this.frameCounts.get(this.display) || 1;
      this.frame = (this.frame + 1) % count;
      this.draw();
    }
    requestAnimationFrame(this.tick);
  };

  private draw(): void {
    const sheet = this.sheets.get(this.display);
    if (!sheet) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const size = this.art * this.scale;
    const off = Math.floor((this.canvas.width - size) / 2);
    this.ctx.drawImage(
      sheet,
      this.frame * this.art,
      0,
      this.art,
      this.art,
      off,
      off,
      size,
      size,
    );
  }
}

/** 气泡窗：只负责文字气泡。 */
export class Bubble {
  private timer: number | null = null;
  private seconds = 5;

  constructor(
    private el: HTMLElement,
    private text: HTMLElement,
  ) {}

  setBubbleSeconds(s: number): void {
    if (s > 0) this.seconds = s;
  }

  show(text: string): void {
    this.text.textContent = text;
    this.el.classList.remove("hidden");
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.el.classList.add("hidden");
    }, this.seconds * 1000);
  }

  handleEvent(ev: PetEvent): void {
    this.show(ev.msg || BUBBLE_DEFAULTS[ev.event] || ev.event);
  }

  demo(): void {
    for (const [t, ev] of DEMO_STEPS) {
      window.setTimeout(() => this.handleEvent(ev), t);
    }
  }
}
