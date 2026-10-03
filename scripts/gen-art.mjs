// 占位像素素材生成器：程序化画出桌宠各状态的精灵图与应用图标源图。
// 正式形象定稿后，本脚本产出会被替换，接口（文件名/帧布局）保持不变。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "public", "sprites");
const iconDir = path.join(root, "src-tauri", "icons");
// 同步输出到皮肤目录（本地 skins + 安装包内置资源）
const skinAgentDir = path.join(root, "src-tauri", "target", "release", "skins", "agentpet");
const skinAgentResDir = path.join(root, "src-tauri", "resources", "skins", "agentpet");
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(iconDir, { recursive: true });
fs.mkdirSync(skinAgentDir, { recursive: true });
fs.mkdirSync(skinAgentResDir, { recursive: true });

const SIZE = 16;

const PALETTE = {
  o: [43, 43, 58, 255], // 描边
  b: [126, 222, 206, 255], // 身体（薄荷绿）
  d: [86, 191, 174, 255], // 身体阴影
  w: [255, 255, 255, 255], // 眼白
  k: [43, 43, 58, 255], // 瞳孔/嘴
  c: [255, 168, 160, 255], // 腮红
  y: [255, 215, 110, 255], // 黄色点缀
  g: [123, 217, 123, 255], // 绿色星星
  r: [255, 107, 107, 255], // 红色（报错）
};

const BLANK = () => Array.from({ length: SIZE }, () => ".".repeat(SIZE));

function validate(grid, name) {
  if (grid.length !== SIZE) throw new Error(`${name}: 行数 ${grid.length} != ${SIZE}`);
  for (const [i, row] of grid.entries()) {
    if (row.length !== SIZE) throw new Error(`${name} 第${i}行长度 ${row.length} != ${SIZE}`);
    for (const ch of row) {
      if (ch !== "." && !PALETTE[ch]) throw new Error(`${name} 第${i}行出现未知字符 '${ch}'`);
    }
  }
}

function shiftV(grid, n) {
  const out = BLANK();
  for (let r = 0; r < SIZE; r++) {
    const src = r - n;
    if (src >= 0 && src < SIZE) out[r] = grid[src];
  }
  return out;
}

function shiftH(grid, n) {
  return grid.map((row) => {
    if (n === 0) return row;
    const pad = ".".repeat(Math.abs(n));
    return n > 0 ? pad + row.slice(0, SIZE - n) : row.slice(-n) + pad;
  });
}

function overlay(grid, patch, row, col) {
  const out = [...grid];
  patch.forEach((patchRow, pr) => {
    const r = row + pr;
    if (r < 0 || r >= SIZE) return;
    const chars = out[r].split("");
    patchRow.split("").forEach((ch, pc) => {
      const c = col + pc;
      if (c >= 0 && c < SIZE && ch !== ".") chars[c] = ch;
    });
    out[r] = chars.join("");
  });
  return out;
}

function overlayPixels(grid, pixels) {
  let out = grid;
  for (const [r, c, ch] of pixels) {
    out = overlay(out, [ch], r, c);
  }
  return out;
}

// ---- 基础形象：薄荷绿小团子 ----

const BASE = [
  "................",
  ".....oooooo.....",
  "....obbbbbbo....",
  "...obbbbbbbbo...",
  "..obbbbbbbbbbo..",
  "..obbwwbbbbwwbo.",
  "..obbwkbbbbkwbo.",
  "..obcbbbbbbbcbo.",
  "..obbbbkkbbbbo..",
  "..obbbbbbbbbbo..",
  "..odbbbbbbbbdo..",
  "..obbbbbbbbbbo..",
  "...obbbbbbbbo...",
  "....ooo..ooo....",
  "................",
  "................",
];

// 眨眼（闭眼线条）
const BLINK = BASE.map((row, i) => {
  if (i === 5) return "..obbbbbbbbbbo..";
  if (i === 6) return "..obbkkbbbbkkbo.";
  return row;
});

// 开心大笑（闭眼 + 大嘴）
const GRIN = BLINK.map((row, i) => (i === 8 ? "..obbkkkkbbbbo.." : row));

// ---- idle：睁眼 / 眨眼 ----
const idleFrames = [BASE, BLINK];

// ---- working：头顶星星 + 上下浮动 ----
const STAR = [".y.", "yyy", ".y."];
const work0 = overlay(BASE, STAR, 0, 12);
const work1 = overlay(shiftV(BASE, -1), STAR, 0, 12);
const workingFrames = [work0, work1, work0, work1];

// ---- waiting：头顶问号闪烁 ----
const QUESTION = [".yy.", "...y", "..y.", "....", "..y."];
const wait0 = overlay(BASE, QUESTION, 0, 11);
const waitingFrames = [wait0, wait0, BASE, wait0];

// ---- success：跳跃 + 撒花 ----
const s1 = overlayPixels(shiftV(GRIN, -1), [
  [2, 1, "g"],
  [4, 14, "g"],
  [1, 7, "w"],
]);
const s2 = overlayPixels(shiftV(GRIN, -2), [
  [1, 1, "g"],
  [3, 14, "g"],
  [0, 8, "w"],
  [2, 15, "g"],
]);
const successFrames = [GRIN, s1, s2, s1];

// ---- error：头顶红叉 + 左右晃动 ----
const XCROSS = ["r..r", ".rr.", ".rr.", "r..r"];
const e0 = overlay(BASE, XCROSS, 0, 1);
const e1 = overlay(shiftH(BASE, -1), XCROSS, 0, 2);
const e2 = overlay(shiftH(BASE, 1), XCROSS, 0, 0);
const errorFrames = [e0, e1, e0, e2];

// ---- 输出 PNG ----

function writeSheet(name, frames) {
  frames.forEach((g, i) => validate(g, `${name}#${i}`));
  const png = new PNG({ width: SIZE * frames.length, height: SIZE });
  frames.forEach((grid, f) => {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const ch = grid[r][c];
        const px = (r * SIZE * frames.length + f * SIZE + c) * 4;
        const [R, G, B, A] = PALETTE[ch] ?? [0, 0, 0, 0];
        png.data[px] = R;
        png.data[px + 1] = G;
        png.data[px + 2] = B;
        png.data[px + 3] = A;
      }
    }
  });
  const bytes = PNG.sync.write(png);
  fs.writeFileSync(path.join(outDir, `${name}.png`), bytes);
  fs.writeFileSync(path.join(skinAgentDir, `${name}.png`), bytes);
  fs.writeFileSync(path.join(skinAgentResDir, `${name}.png`), bytes);
  console.log(`✓ ${name}.png (${frames.length} 帧)`);
}

writeSheet("idle", idleFrames);
writeSheet("working", workingFrames);
writeSheet("waiting", waitingFrames);
writeSheet("success", successFrames);
writeSheet("error", errorFrames);

fs.writeFileSync(
  path.join(skinAgentDir, "manifest.json"),
  JSON.stringify({ name: "agentpet", frame: 16 }, null, 2) + "\n",
);
console.log("✓ skins/agentpet/manifest.json");

// ---- 应用图标源图（512x512 最近邻放大）----

function writeIcon() {
  const S = 512;
  const px = S / SIZE; // 32
  const png = new PNG({ width: S, height: S });
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const ch = BASE[Math.floor(y / px)][Math.floor(x / px)];
      const [R, G, B, A] = PALETTE[ch] ?? [0, 0, 0, 0];
      const i = (y * S + x) * 4;
      png.data[i] = R;
      png.data[i + 1] = G;
      png.data[i + 2] = B;
      png.data[i + 3] = A;
    }
  }
  fs.writeFileSync(path.join(iconDir, "source.png"), PNG.sync.write(png));
  console.log("✓ icons/source.png (512x512)");
}

writeIcon();
console.log("全部占位素材生成完毕");
