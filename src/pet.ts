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
  smooth?: boolean;
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
  private scaleDevices = 6; // 每个艺术像素占多少物理像素（对齐整数保证锐利）
  private smooth = false; // 平滑皮肤：高清原图整帧缩放，开启双线性采样
  private ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.ctx.imageSmoothingEnabled = false;
  }

  /** 画布按设备像素渲染，避免 DPI 缩放导致的模糊。 */
  private setupCanvas(): void {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const backing = Math.round(CANVAS_SIZE * dpr);
    if (this.canvas.width !== backing) {
      this.canvas.width = backing;
      this.canvas.height = backing;
    }
    // 像素皮肤：每艺术像素对齐整数物理像素；平滑皮肤：整帧铺满 + 双线性
    this.scaleDevices = this.smooth ? 1 : Math.max(1, Math.floor(backing / this.art));
    this.ctx.imageSmoothingEnabled = this.smooth;
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
    this.smooth = !!skin.smooth;
    this.setupCanvas();
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
    this.setupCanvas();
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
    const size = this.smooth ? this.canvas.width : this.art * this.scaleDevices;
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

/** 气泡窗：头顶字幕——透明底，常驻显示最近的工作播报（思考过程），任务结束淡出。 */
export class Bubble {
  private timer: number | null = null;
  private seconds = 5;
  private lines: string[] = [];

  constructor(private el: HTMLElement) {}

  setBubbleSeconds(s: number): void {
    if (s > 0) this.seconds = s;
  }

  private render(): void {
    this.el.innerHTML = "";
    const visible = this.lines.slice(-3);
    visible.forEach((text, i) => {
      const div = document.createElement("div");
      div.className = "line" + (i < visible.length - 1 ? " dim" : "");
      div.textContent = text;
      this.el.append(div);
    });
    this.el.classList.remove("hidden");
  }

  private scheduleHide(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.hide(), this.seconds * 1000);
  }

  hide(): void {
    this.lines = [];
    this.el.classList.add("hidden");
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  handleEvent(ev: PetEvent): void {
    this.lines.push(ev.msg || BUBBLE_DEFAULTS[ev.event] || ev.event);
    if (this.lines.length > 3) this.lines.shift();
    this.render();
    // 干活中/等待中保持常驻（思考过程）；完成/出错后定时淡出
    if (ev.event === "done" || ev.event === "error") {
      this.scheduleHide();
    } else if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  demo(): void {
    for (const [t, ev] of DEMO_STEPS) {
      window.setTimeout(() => this.handleEvent(ev), t);
    }
  }
}
