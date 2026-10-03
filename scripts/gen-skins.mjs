// 像素化皮肤生成器：design/logos/*.png → skins/<agent>/（24×24 全状态精灵图）。
// 流程：最近邻降采样 20×20 → 24×24 画布居中 → 自动描边 → 生成各状态帧。
// design/logos 里的商标图片仅限本地自用，不入库不发布（已加 .gitignore）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const logosDir = path.join(root, "design", "logos");
const skinsDir = path.join(root, "src-tauri", "target", "release", "skins");
fs.mkdirSync(skinsDir, { recursive: true });

const SIZE = 24; // 画布
const ART = 20; // logo 有效区域

const PAL = {
  o: [82, 51, 40, 255], // 描边
  y: [255, 215, 110, 255], // 黄（干活星星/问号）
  g: [123, 217, 123, 255], // 绿（成功撒花）
  r: [255, 107, 107, 255], // 红（报错叉）
};

// 单元格：[r,g,b,a] 颜色数组，或 null（透明）
function loadPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

/** 裁掉透明边，只留内容。 */
function trim(src) {
  let minX = src.width, minY = src.height, maxX = -1, maxY = -1;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      if (src.data[(y * src.width + x) * 4 + 3] >= 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return src;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y + minY) * src.width + (x + minX)) * 4;
      const di = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) out.data[di + k] = src.data[si + k];
    }
  }
  return out;
}

/** 最近邻降采样：内容按比例铺满 ART×ART，alpha 阈值 128 保证边缘干净。 */
function pixelate(src) {
  const t = trim(src);
  const k = ART / Math.max(t.width, t.height);
  const dw = Math.max(1, Math.round(t.width * k));
  const dh = Math.max(1, Math.round(t.height * k));
  const ox = Math.floor((ART - dw) / 2);
  const oy = Math.floor((ART - dh) / 2);
  const out = Array.from({ length: ART }, () => Array.from({ length: ART }, () => null));
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(t.width - 1, Math.floor((x + 0.5) / k));
      const sy = Math.min(t.height - 1, Math.floor((y + 0.5) / k));
      const i = (sy * t.width + sx) * 4;
      if (t.data[i + 3] >= 128) {
        out[oy + y][ox + x] = [t.data[i], t.data[i + 1], t.data[i + 2], 255];
      }
    }
  }
  return out;
}

function blank() {
  return Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => null));
}

function toCanvas(px20) {
  const g = blank();
  const off = Math.floor((SIZE - ART) / 2);
  for (let y = 0; y < ART; y++) {
    for (let x = 0; x < ART; x++) {
      g[y + off][x + off] = px20[y][x];
    }
  }
  return g;
}

function outline(g) {
  const filled = (x, y) => y >= 0 && y < SIZE && x >= 0 && x < SIZE && g[y][x] !== null;
  const out = g.map((r) => [...r]);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (g[y][x] === null && (filled(x + 1, y) || filled(x - 1, y) || filled(x, y + 1) || filled(x, y - 1))) {
        out[y][x] = PAL.o;
      }
    }
  }
  return out;
}

function shift(g, dx, dy) {
  const out = blank();
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const sy = y - dy;
      const sx = x - dx;
      if (sy >= 0 && sy < SIZE && sx >= 0 && sx < SIZE) out[y][x] = g[sy][sx];
    }
  }
  return out;
}

function overlay(g, patch, row, col) {
  const out = g.map((r) => [...r]);
  patch.forEach((pr, dy) => {
    pr.split("").forEach((ch, dx) => {
      if (ch !== ".") out[row + dy][col + dx] = PAL[ch];
    });
  });
  return out;
}

function dots(g, list, ch) {
  const out = g.map((r) => [...r]);
  for (const [y, x] of list) out[y][x] = PAL[ch];
  return out;
}

const QUESTION = [".yy.", "...y", "..y.", "....", "..y."];
const XCROSS = ["r..r", ".rr.", ".rr.", "r..r"];
const STAR = [".y.", "yyy", ".y."];

function makeFrames(base) {
  const up1 = shift(base, 0, -1);
  const up2 = shift(base, 0, -2);
  const left1 = shift(base, -1, 0);
  const right1 = shift(base, 1, 0);
  return {
    idle: [base, up1],
    working: [
      overlay(base, STAR, 1, 19),
      overlay(up1, STAR, 1, 19),
      overlay(base, STAR, 1, 19),
      overlay(up1, STAR, 1, 19),
    ],
    waiting: [
      overlay(base, QUESTION, 1, 18),
      overlay(base, QUESTION, 1, 18),
      base,
      overlay(base, QUESTION, 1, 18),
    ],
    success: [
      dots(up1, [[2, 2], [3, 21]], "g"),
      dots(up2, [[1, 1], [2, 22], [0, 12]], "g"),
      dots(up1, [[2, 2], [3, 21]], "g"),
      base,
    ],
    error: [
      overlay(base, XCROSS, 1, 1),
      overlay(left1, XCROSS, 1, 1),
      overlay(base, XCROSS, 1, 1),
      overlay(right1, XCROSS, 1, 1),
    ],
  };
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

const SOURCES = [
  ["zcode", "zcode.png"],
  ["codebuddy", "codebuddy.png"],
  ["hermes", "hermes.png"],
  ["codex", "codex.png"], // 文件存在才生成（等代理补图后重跑本脚本）
];

for (const [skin, file] of SOURCES) {
  const logoPath = path.join(logosDir, file);
  if (!fs.existsSync(logoPath)) {
    console.log(`- 跳过 ${skin}（缺 ${file}）`);
    continue;
  }
  const base = outline(toCanvas(pixelate(loadPng(logoPath))));
  const frames = makeFrames(base);
  const dir = path.join(skinsDir, skin);
  fs.mkdirSync(dir, { recursive: true });
  for (const [state, fr] of Object.entries(frames)) {
    fs.writeFileSync(path.join(dir, `${state}.png`), renderSheet(fr));
  }
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ name: skin, frame: SIZE }, null, 2) + "\n",
  );
  console.log(`✓ skins/${skin}/（5 状态）`);
}
console.log("像素化皮肤生成完毕");
