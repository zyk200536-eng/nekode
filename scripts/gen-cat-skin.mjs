// 正式橘猫皮肤生成器：即梦 AI 源图 → skins/neko/（48×48 全状态精灵图）。
// 流程：色键抠掉纯色背景 → 裁内容 → 降采样 48×48 → 连通域去水印/噪点 → 自动描边 → 状态帧。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcPath = path.join(root, "design", "cat-source-jimeng.png");
const skinsDir = path.join(root, "src-tauri", "target", "release", "skins");
const resourceDir = path.join(root, "src-tauri", "resources", "skins"); // 随安装包分发的内置皮肤
const outDirs = [path.join(skinsDir, "neko"), path.join(resourceDir, "neko")];
for (const d of outDirs) fs.mkdirSync(d, { recursive: true });

const SIZE = 48; // 帧尺寸（canvas 96 = 48×2）
const PAD = 1; // 描边留边

const OVERLAY_COLORS = {
  y: [255, 215, 110, 255],
  g: [123, 217, 123, 255],
  r: [255, 107, 107, 255],
};

function loadPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

/** 采样四角背景色（避开右下水印，只取上三角区角点），色键抠图。 */
function keyBackground(src) {
  const W = src.width, H = src.height, D = src.data;
  const corners = [
    [3, 3],
    [W - 4, 3],
    [3, Math.floor(H * 0.3)],
    [3, Math.floor(H * 0.6)],
  ].map(([x, y]) => {
    const i = (y * W + x) * 4;
    return [D[i], D[i + 1], D[i + 2]];
  });
  const bg = corners[0];

  const dist = (r, g, b) => Math.hypot(r - bg[0], g - bg[1], b - bg[2]);
  const isBg = (x, y) => {
    const i = (y * W + x) * 4;
    if (D[i + 3] < 128) return true;
    return dist(D[i], D[i + 1], D[i + 2]) < 110;
  };

  const mask = new Uint8Array(W * H); // 1 = 主体
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!isBg(x, y)) mask[y * W + x] = 1;
    }
  }
  // 背景容差内的孤立色块由后续连通域过滤处理
  console.log(`背景色 rgb(${bg.join(",")})，主体像素占比 ${(100 * mask.reduce((a, b) => a + b, 0) / (W * H)).toFixed(1)}%`);
  return { mask, W, H, D };
}

/** 裁到主体包围盒。 */
function trim({ mask, W, H, D }) {
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
  return { mask, W, H, D, box: { minX, minY, maxX, maxY } };
}

/** 降采样：每格做 alpha 加权块平均 + 颜色量化（28 级/通道），消除点采样的噪点糊感。 */
function downsample(t) {
  const { mask, W, H, D, box } = t;
  const bw = box.maxX - box.minX + 1;
  const bh = box.maxY - box.minY + 1;
  const inner = SIZE - PAD * 2;
  const k = inner / Math.max(bw, bh);
  const dw = Math.max(1, Math.round(bw * k));
  const dh = Math.max(1, Math.round(bh * k));
  const ox = Math.floor((SIZE - dw) / 2);
  const oy = Math.floor((SIZE - dh) / 2);
  const Q = 28; // 颜色量化步长

  const grid = Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => null));
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      // 该格在源图中的足迹
      const sx0 = box.minX + Math.floor(x / k);
      const sx1 = box.minX + Math.min(bw - 1, Math.floor((x + 1) / k));
      const sy0 = box.minY + Math.floor(y / k);
      const sy1 = box.minY + Math.min(bh - 1, Math.floor((y + 1) / k));
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

  // 连通域（4 邻域），仅保留最大块
  const label = Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
  const sizes = [0];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (grid[y][x] && !label[y][x]) {
        const id = sizes.length;
        let count = 0;
        const stack = [[x, y]];
        label[y][x] = id;
        while (stack.length) {
          const [cx, cy] = stack.pop();
          count++;
          for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
            if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && grid[ny][nx] && !label[ny][nx]) {
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
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (grid[y][x] && label[y][x] !== keep) grid[y][x] = null;
    }
  }
  console.log(`连通域 ${sizes.length - 1} 个，保留最大（${sizes[keep]} 像素）`);
  return grid;
}

function outline(g) {
  const filled = (x, y) => y >= 0 && y < SIZE && x >= 0 && x < SIZE && g[y][x] !== null;
  const out = g.map((r) => [...r]);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (!g[y][x] && (filled(x + 1, y) || filled(x - 1, y) || filled(x, y + 1) || filled(x, y - 1))) {
        out[y][x] = [58, 36, 32, 255]; // 与源图描边一致的深棕
      }
    }
  }
  return out;
}

function shift(g, dx, dy) {
  const out = Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => null));
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const sy = y - dy, sx = x - dx;
      if (sy >= 0 && sy < SIZE && sx >= 0 && sx < SIZE) out[y][x] = g[sy][sx];
    }
  }
  return out;
}

/** 状态装饰：48 网格上用 2px 块绘制（问号/叉/星星）。 */
function patchBlock(g, cells, ch, row, col) {
  const out = g.map((r) => [...r]);
  for (const [py, px] of cells) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const y = row + py * 2 + dy;
        const x = col + px * 2 + dx;
        if (y >= 0 && y < SIZE && x >= 0 && x < SIZE) out[y][x] = OVERLAY_COLORS[ch];
      }
    }
  }
  return out;
}

// 问号（5×6 逻辑格）与红叉（4×4）、星星（3×3）在 24 网格的设计，×2 放大
const Q_CELLS = [[0, 1], [0, 2], [1, 3], [2, 2], [4, 2]];
const X_CELLS = [[0, 0], [0, 3], [1, 1], [1, 2], [2, 1], [2, 2], [3, 0], [3, 3]];
const STAR_CELLS = [[0, 1], [1, 0], [1, 1], [1, 2], [2, 1]];

function makeFrames(base) {
  const up1 = shift(base, 0, -1);
  const up2 = shift(base, 0, -2);
  const left1 = shift(base, -1, 0);
  const right1 = shift(base, 1, 0);
  return {
    idle: [base, up1],
    working: [
      patchBlock(base, STAR_CELLS, "y", 1, 41),
      patchBlock(up1, STAR_CELLS, "y", 1, 41),
      patchBlock(base, STAR_CELLS, "y", 1, 41),
      patchBlock(up1, STAR_CELLS, "y", 1, 41),
    ],
    waiting: [
      patchBlock(base, Q_CELLS, "y", 1, 38),
      patchBlock(base, Q_CELLS, "y", 1, 38),
      base,
      patchBlock(base, Q_CELLS, "y", 1, 38),
    ],
    success: [
      dots(up1, [[3, 4], [5, 43]], "g"),
      dots(up2, [[1, 3], [4, 44], [2, 24]], "g"),
      dots(up1, [[3, 4], [5, 43]], "g"),
      base,
    ],
    error: [
      patchBlock(base, X_CELLS, "r", 1, 1),
      patchBlock(left1, X_CELLS, "r", 1, 1),
      patchBlock(base, X_CELLS, "r", 1, 1),
      patchBlock(right1, X_CELLS, "r", 1, 1),
    ],
  };
}

function dots(g, list, ch) {
  const out = g.map((r) => [...r]);
  for (const [y, x] of list) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        if (y + dy < SIZE && x + dx < SIZE) out[y + dy][x + dx] = OVERLAY_COLORS[ch];
      }
    }
  }
  return out;
}

function renderSheet(frames) {
  const png = new PNG({ width: SIZE * frames.length, height: SIZE });
  frames.forEach((g, f) => {
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const c = g[y][x];
        if (!c) continue;
        const px = (y * SIZE * frames.length + f * SIZE + x) * 4;
        png.data[px] = c[0];
        png.data[px + 1] = c[1];
        png.data[px + 2] = c[2];
        png.data[px + 3] = c[3];
      }
    }
  });
  return PNG.sync.write(png);
}

const base = outline(downsample(trim(keyBackground(loadPng(srcPath)))));
const frames = makeFrames(base);
for (const dir of outDirs) {
  for (const [state, fr] of Object.entries(frames)) {
    fs.writeFileSync(path.join(dir, `${state}.png`), renderSheet(fr));
  }
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ name: "neko", frame: SIZE }, null, 2) + "\n",
  );
}
console.log(`✓ skins/neko/ + resources/skins/neko/（48×48，5 状态）`);

// 预览图：idle 4 帧横排 ×4 放大
const SCALE = 4;
const preview = new PNG({ width: SIZE * 2 * SCALE, height: SIZE * SCALE });
const idle = PNG.sync.read(fs.readFileSync(path.join(outDirs[0], "idle.png")));
for (let f = 0; f < 2; f++) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const si = (y * idle.width + f * SIZE + x) * 4;
      for (let sy = 0; sy < SCALE; sy++) {
        for (let sx = 0; sx < SCALE; sx++) {
          const di = ((y * SCALE + sy) * preview.width + (f * SIZE + x) * SCALE + sx) * 4;
          preview.data[di] = idle.data[si];
          preview.data[di + 1] = idle.data[si + 1];
          preview.data[di + 2] = idle.data[si + 2];
          preview.data[di + 3] = idle.data[si + 3];
        }
      }
    }
  }
}
fs.writeFileSync(path.join(root, "design", "neko-preview.png"), PNG.sync.write(preview));
console.log("✓ design/neko-preview.png");
