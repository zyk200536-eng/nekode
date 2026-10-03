// 正式橘猫皮肤生成器：即梦 AI 源图 → 两种皮肤：
//   neko       平滑高清版（192×192 帧，smooth:true，原图直接上屏）
//   neko-pixel 像素版（48×48，块平均+量化+描边，备选）
// 共享：色键抠掉纯色背景 → 裁内容包围盒。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcPath = path.join(root, "design", "cat-source-jimeng.png");
const skinsDir = path.join(root, "src-tauri", "target", "release", "skins");
const resourceDir = path.join(root, "src-tauri", "resources", "skins");

const OVERLAY = {
  yellow: [255, 215, 110, 255],
  green: [123, 217, 123, 255],
  red: [255, 90, 90, 255],
};

function loadPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

/** 色键抠图：采样左上/右上背景色，距离阈值内视为背景。 */
function keyBackground(src) {
  const W = src.width, H = src.height, D = src.data;
  const bgSample = [3, 3].map((x) => {
    const i = (x * W + x) * 4;
    return [D[i], D[i + 1], D[i + 2]];
  })[0];
  const mask = new Uint8Array(W * H);
  let count = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (D[i + 3] < 128) continue;
      const d = Math.hypot(D[i] - bgSample[0], D[i + 1] - bgSample[1], D[i + 2] - bgSample[2]);
      if (d >= 110) {
        mask[y * W + x] = 1;
        count++;
      }
    }
  }
  console.log(`背景色 rgb(${bgSample.join(",")})，主体占比 ${((100 * count) / (W * H)).toFixed(1)}%`);
  return { mask, W, H, D };
}

function bbox({ mask, W, H }) {
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

function shiftGrid(g, dx, dy) {
  const S = g.length;
  const out = Array.from({ length: S }, () => Array.from({ length: S }, () => null));
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const sy = y - dy, sx = x - dx;
      if (sy >= 0 && sy < S && sx >= 0 && sx < S) out[y][x] = g[sy][sx];
    }
  }
  return out;
}

// ============ 平滑高清版 ============

const SSIZE = 192; // 帧尺寸（96 CSS × dpr ≤2 全覆盖）

/** 块平均缩放到 SSIZE×SSIZE：alpha=主体覆盖率（边缘自然抗锯齿），RGB 按主体色加权（无背景色污染）。 */
function extractSmooth(t, outSize) {
  const { mask, W, H, D } = t;
  const bw = t.box.maxX - t.box.minX + 1;
  const bh = t.box.maxY - t.box.minY + 1;
  const k = outSize / Math.max(bw, bh);
  const dw = Math.round(bw * k);
  const dh = Math.round(bh * k);
  const ox = Math.floor((outSize - dw) / 2);
  const oy = Math.floor((outSize - dh) / 2);

  const grid = Array.from({ length: outSize }, () => Array.from({ length: outSize }, () => null));
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const sx0 = t.box.minX + Math.floor(x / k);
      const sx1 = t.box.minX + Math.min(bw - 1, Math.floor((x + 1) / k));
      const sy0 = t.box.minY + Math.floor(y / k);
      const sy1 = t.box.minY + Math.min(bh - 1, Math.floor((y + 1) / k));
      let r = 0, g = 0, b = 0, a = 0, tot = 0;
      for (let sy = sy0; sy <= sy1; sy++) {
        for (let sx = sx0; sx <= sx1; sx++) {
          tot++;
          const i = (sy * W + sx) * 4;
          if (mask[sy * W + sx]) {
            const w = D[i + 3] / 255;
            r += D[i] * w;
            g += D[i + 1] * w;
            b += D[i + 2] * w;
            a += w;
          }
        }
      }
      const cov = a / tot;
      if (cov > 0.02) {
        const ai = Math.min(255, Math.round(cov * 255 * 1.15)); // 边缘略增厚
        const f = a > 0 ? 1 / a : 0;
        grid[oy + y][ox + x] = [
          Math.min(255, Math.round(r * f)),
          Math.min(255, Math.round(g * f)),
          Math.min(255, Math.round(b * f)),
          ai,
        ];
      }
    }
  }
  return grid;
}

function fillCircle(g, cx, cy, rad, color) {
  const S = g.length;
  for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) {
    for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
      if (x < 0 || x >= S || y < 0 || y >= S) continue;
      const d = Math.hypot(x - cx, y - cy);
      if (d <= rad) g[y][x] = color;
    }
  }
}

function fillRect(g, x0, y0, w, h, color) {
  const S = g.length;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x >= 0 && x < S && y >= 0 && y < S) g[y][x] = color;
    }
  }
}

function thickLine(g, x0, y0, x1, y1, thick, color) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) * 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    fillCircle(g, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, thick / 2, color);
  }
}

function typingDots(g, n) {
  // 右上角三个"打字"圆点，按 n 递点点亮（克隆，不污染 base）
  const S = g.length;
  const out = g.map((r) => [...r]);
  const baseX = S - 66, baseY = 30;
  for (let i = 0; i < 3; i++) {
    if (i < n) fillCircle(out, baseX + i * 22, baseY, 8, OVERLAY.yellow);
  }
  return out;
}

function exclMark(g) {
  // 右上角黄色感叹号（等待确认）
  const S = g.length;
  const out = g.map((r) => [...r]);
  const x = S - 42, y = 22;
  fillRect(out, x, y, 16, 44, OVERLAY.yellow);
  fillCircle(out, x + 8, y + 62, 9, OVERLAY.yellow);
  return out;
}

function sparkles(g) {
  const S = g.length;
  const out = g.map((r) => [...r]);
  for (const [x, y, r] of [[24, 40, 9], [S - 30, 60, 11], [40, S - 60, 8], [S - 44, S - 90, 9]]) {
    fillCircle(out, x, y, r, OVERLAY.green);
  }
  return out;
}

function redCross(g) {
  const S = g.length;
  const out = g.map((r) => [...r]);
  const c = S - 52, r0 = 30, len = 56, th = 14;
  thickLine(out, c - len / 2, r0, c + len / 2, r0 + len, th, OVERLAY.red);
  thickLine(out, c + len / 2, r0, c - len / 2, r0 + len, th, OVERLAY.red);
  return out;
}

/** 连通域过滤：仅保留最大不透明块（去水印/碎屑）。 */
function keepLargest(g) {
  const S = g.length;
  const label = Array.from({ length: S }, () => new Array(S).fill(0));
  const sizes = [0];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (g[y][x] && !label[y][x]) {
        const id = sizes.length;
        let count = 0;
        const stack = [[x, y]];
        label[y][x] = id;
        while (stack.length) {
          const [cx, cy] = stack.pop();
          count++;
          for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
            if (nx >= 0 && nx < S && ny >= 0 && ny < S && g[ny][nx] && !label[ny][nx]) {
              label[ny][nx] = id;
              stack.push([nx, ny]);
            }
          }
        }
        sizes.push(count);
      }
    }
  }
  const keep = sizes.indexOf(Math.max(...sizes));
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (g[y][x] && label[y][x] !== keep) g[y][x] = null;
    }
  }
  console.log(`连通域 ${sizes.length - 1} 个，保留最大（${sizes[keep]} 像素）`);
  return g;
}

function makeFramesSmooth(base) {
  const up = shiftGrid(base, 0, -3);
  const up2 = shiftGrid(base, 0, -6);
  const left = shiftGrid(base, -3, 0);
  const right = shiftGrid(base, 3, 0);
  return {
    idle: [base, up],
    working: [typingDots(base, 1), typingDots(up, 2), typingDots(base, 3), typingDots(up, 3)],
    waiting: [exclMark(base), exclMark(base), base, exclMark(base)],
    success: [sparkles(up), sparkles(up2), sparkles(up), base],
    error: [redCross(base), redCross(left), redCross(base), redCross(right)],
  };
}

function renderSheet(frames, frame) {
  const png = new PNG({ width: frame * frames.length, height: frame });
  frames.forEach((g, f) => {
    for (let y = 0; y < frame; y++) {
      for (let x = 0; x < frame; x++) {
        const c = g[y][x];
        if (!c) continue;
        const px = (y * frame * frames.length + f * frame + x) * 4;
        png.data[px] = c[0];
        png.data[px + 1] = c[1];
        png.data[px + 2] = c[2];
        png.data[px + 3] = c[3];
      }
    }
  });
  return PNG.sync.write(png);
}

function writeSkin(dir, manifest, frames, frame) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [state, fr] of Object.entries(frames)) {
    fs.writeFileSync(path.join(dir, `${state}.png`), renderSheet(fr, frame));
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

// ============ 像素版（48×48，沿用块平均+量化+描边管线） ============

const PSIZE = 48;
const PPAD = 1;
const PPAL = {
  o: [58, 36, 32, 255],
  y: [255, 215, 110, 255],
  g: [123, 217, 123, 255],
  r: [255, 107, 107, 255],
};
const P_QUESTION = [".yy.", "...y", "..y.", "....", "..y."];
const P_XCROSS = ["r..r", ".rr.", ".rr.", "r..r"];
const P_STAR = [".y.", "yyy", ".y."];

function pOverlay(g, patch, row, col) {
  const out = g.map((r2) => [...r2]);
  patch.forEach((pr, dy) => {
    pr.split("").forEach((ch, dx) => {
      if (ch !== ".") out[row + dy][col + dx] = PPAL[ch];
    });
  });
  return out;
}

function pDots(g, list, ch) {
  const out = g.map((r2) => [...r2]);
  for (const [y, x] of list) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        if (y + dy < PSIZE && x + dx < PSIZE) out[y + dy][x + dx] = PPAL[ch];
      }
    }
  }
  return out;
}

function pOutline(g) {
  const S = PSIZE;
  const filled = (x, y) => y >= 0 && y < S && x >= 0 && x < S && g[y][x] !== null;
  const out = g.map((r2) => [...r2]);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (!g[y][x] && (filled(x + 1, y) || filled(x - 1, y) || filled(x, y + 1) || filled(x, y - 1))) {
        out[y][x] = PPAL.o;
      }
    }
  }
  return out;
}

function extractPixel(t) {
  const { mask, W, H, D } = t;
  const bw = t.box.maxX - t.box.minX + 1;
  const bh = t.box.maxY - t.box.minY + 1;
  const inner = PSIZE - PPAD * 2;
  const k = inner / Math.max(bw, bh);
  const dw = Math.max(1, Math.round(bw * k));
  const dh = Math.max(1, Math.round(bh * k));
  const ox = Math.floor((PSIZE - dw) / 2);
  const oy = Math.floor((PSIZE - dh) / 2);
  const Q = 28;
  const grid = Array.from({ length: PSIZE }, () => Array.from({ length: PSIZE }, () => null));
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const sx0 = t.box.minX + Math.floor(x / k);
      const sx1 = t.box.minX + Math.min(bw - 1, Math.floor((x + 1) / k));
      const sy0 = t.box.minY + Math.floor(y / k);
      const sy1 = t.box.minY + Math.min(bh - 1, Math.floor((y + 1) / k));
      let r = 0, g = 0, b = 0, a = 0, n = 0, cov = 0, tot = 0;
      for (let sy = sy0; sy <= sy1; sy++) {
        for (let sx = sx0; sx <= sx1; sx++) {
          tot++;
          const i = (sy * W + sx) * 4;
          if (mask[sy * W + sx]) {
            const w = D[i + 3] / 255;
            r += D[i] * w;
            g += D[i + 1] * w;
            b += D[i + 2] * w;
            a += w;
            n++;
            cov += 255;
          }
        }
      }
      if (n > 0 && cov / (tot * 255) >= 0.45) {
        const q = (v) => Math.min(255, Math.round(v / a / Q) * Q);
        grid[oy + y][ox + x] = [q(r), q(g), q(b), 255];
      }
    }
  }
  // 连通域去水印/碎屑
  const label = Array.from({ length: PSIZE }, () => new Array(PSIZE).fill(0));
  const sizes = [0];
  for (let y = 0; y < PSIZE; y++) {
    for (let x = 0; x < PSIZE; x++) {
      if (grid[y][x] && !label[y][x]) {
        const id = sizes.length;
        let count = 0;
        const stack = [[x, y]];
        label[y][x] = id;
        while (stack.length) {
          const [cx, cy] = stack.pop();
          count++;
          for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
            if (nx >= 0 && nx < PSIZE && ny >= 0 && ny < PSIZE && grid[ny][nx] && !label[ny][nx]) {
              label[ny][nx] = id;
              stack.push([nx, ny]);
            }
          }
        }
        sizes.push(count);
      }
    }
  }
  const keep = sizes.indexOf(Math.max(...sizes));
  for (let y = 0; y < PSIZE; y++) {
    for (let x = 0; x < PSIZE; x++) {
      if (grid[y][x] && label[y][x] !== keep) grid[y][x] = null;
    }
  }
  return grid;
}

function pShift(g, dx, dy) {
  return shiftGrid(g, dx, dy);
}

function makeFramesPixel(base) {
  const up1 = pShift(base, 0, -1);
  const up2 = pShift(base, 0, -2);
  const left1 = pShift(base, -1, 0);
  const right1 = pShift(base, 1, 0);
  return {
    idle: [base, up1],
    working: [pOverlay(base, P_STAR, 1, 41), pOverlay(up1, P_STAR, 1, 41), pOverlay(base, P_STAR, 1, 41), pOverlay(up1, P_STAR, 1, 41)],
    waiting: [pOverlay(base, P_QUESTION, 1, 38), pOverlay(base, P_QUESTION, 1, 38), base, pOverlay(base, P_QUESTION, 1, 38)],
    success: [pDots(up1, [[3, 4], [5, 43]], "g"), pDots(up2, [[1, 3], [4, 44], [2, 24]], "g"), pDots(up1, [[3, 4], [5, 43]], "g"), base],
    error: [pOverlay(base, P_XCROSS, 1, 1), pOverlay(left1, P_XCROSS, 1, 1), pOverlay(base, P_XCROSS, 1, 1), pOverlay(right1, P_XCROSS, 1, 1)],
  };
}

// ============ 主流程 ============

const src = loadPng(srcPath);
const t = { ...keyBackground(src), box: null };
t.box = bbox(t);

// 平滑版 neko（本地 + 内置资源）
const smoothBase = keepLargest(extractSmooth(t, SSIZE));
const smoothFrames = makeFramesSmooth(smoothBase);
const smoothManifest = { name: "neko", frame: SSIZE, smooth: true };
writeSkin(path.join(skinsDir, "neko"), smoothManifest, smoothFrames, SSIZE);
writeSkin(path.join(resourceDir, "neko"), smoothManifest, smoothFrames, SSIZE);
console.log(`✓ skins/neko/（平滑 ${SSIZE}×${SSIZE}，本地+资源）`);

// 像素版 neko-pixel（仅本地）
const pixelBase = pOutline(extractPixel(t));
const pixelFrames = makeFramesPixel(pixelBase);
writeSkin(path.join(skinsDir, "neko-pixel"), { name: "neko-pixel", frame: PSIZE }, pixelFrames, PSIZE);
console.log(`✓ skins/neko-pixel/（像素 ${PSIZE}×${PSIZE}，仅本地）`);

// 预览：平滑 idle 2 帧
const SCALE = 1;
const preview = new PNG({ width: SSIZE * 2 * SCALE + 8, height: SSIZE * SCALE });
const idle = PNG.sync.read(fs.readFileSync(path.join(skinsDir, "neko", "idle.png")));
for (let f = 0; f < 2; f++) {
  for (let y = 0; y < SSIZE; y++) {
    for (let x = 0; x < SSIZE; x++) {
      const si = (y * idle.width + f * SSIZE + x) * 4;
      const di = (y * preview.width + f * (SSIZE * SCALE + 8) + x) * 4;
      for (let k = 0; k < 4; k++) preview.data[di + k] = idle.data[si + k];
    }
  }
}
fs.writeFileSync(path.join(root, "design", "neko-preview.png"), PNG.sync.write(preview));
console.log("✓ design/neko-preview.png");
