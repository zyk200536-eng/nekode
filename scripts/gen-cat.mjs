// 橘猫设计稿生成器：24×24 像素，4 个候选方案（idle 姿态）。
// 程序化拼形（椭圆/三角 + 自动描边），避免手数像素出错。
// 选稿后正式精灵图将以选中方案为基准扩展全套状态帧。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "design");
fs.mkdirSync(outDir, { recursive: true });

const SIZE = 24;

const PALETTE = {
  o: [82, 51, 40, 255], // 描边（深棕）
  b: [245, 166, 86, 255], // 橘
  d: [226, 141, 68, 255], // 橘阴影
  s: [199, 113, 52, 255], // 虎斑条纹
  w: [255, 251, 243, 255], // 白（胸/爪/ blaze）
  k: [48, 34, 30, 255], // 瞳孔/嘴
  c: [255, 130, 120, 255], // 粉（耳内/鼻/腮红）
};

function grid() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill("."));
}

function ellipse(g, cx, cy, rx, ry, ch) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) g[y][x] = ch;
    }
  }
}

// 三角耳：顶点在 (apexX, y0)，底边在 y1，宽度线性展开
function ear(g, apexX, y0, y1, halfBase, ch) {
  for (let y = y0; y <= y1; y++) {
    const t = (y - y0) / (y1 - y0);
    const half = Math.max(1, Math.round(halfBase * t));
    for (let x = apexX - half; x <= apexX + half; x++) {
      if (x >= 0 && x < SIZE) g[y][x] = ch;
    }
  }
}

function rect(g, x0, y0, x1, y1, ch) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (y >= 0 && y < SIZE && x >= 0 && x < SIZE) g[y][x] = ch;
    }
  }
}

function dot(g, x, y, ch) {
  if (y >= 0 && y < SIZE && x >= 0 && x < SIZE) g[y][x] = ch;
}

// 自动描边：所有与主体相邻（4 邻域）的空格变成描边色
function outline(g) {
  const out = g.map((r) => [...r]);
  const isBody = (x, y) =>
    y >= 0 && y < SIZE && x >= 0 && x < SIZE && g[y][x] !== ".";
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (g[y][x] === "." && (isBody(x + 1, y) || isBody(x - 1, y) || isBody(x, y + 1) || isBody(x, y - 1))) {
        out[y][x] = "o";
      }
    }
  }
  return out;
}

function px(g, y, x, ch) {
  if (y >= 0 && y < SIZE && x >= 0 && x < SIZE) g[y][x] = ch;
}

function eyes(g, lx, rx, y, wink = false) {
  // 3 宽 3 高大眼睛：白底 + 深瞳 + 高光
  for (const cx of [lx, rx]) {
    if (wink && cx === lx) {
      // 眨眼 ^ 弧线
      px(g, y - 1, cx - 1, "k");
      px(g, y, cx, "k");
      px(g, y - 1, cx + 1, "k");
      continue;
    }
    rect(g, cx - 1, y - 1, cx + 1, y + 1, "w");
    rect(g, cx, y - 1, cx + 1, y + 1, "k");
    dot(g, cx - 1, y - 1, "w"); // 高光
  }
}

function face(g, cy, { wink = false } = {}) {
  eyes(g, 8, 16, cy, wink);
  // 鼻子 + 嘴
  rect(g, 11, cy + 2, 12, cy + 2, "c");
  dot(g, 10, cy + 3, "k");
  dot(g, 13, cy + 3, "k");
  // 腮红
  rect(g, 5, cy + 2, 6, cy + 2, "c");
  rect(g, 17, cy + 2, 18, cy + 2, "c");
}

function whiskers(g, y) {
  dot(g, 2, y, "w");
  dot(g, 1, y + 1, "w");
  dot(g, 21, y, "w");
  dot(g, 22, y + 1, "w");
}

// ---- 方案一：经典橘白（坐姿，额头 blaze、白胸、白爪、虎斑）----
function v1() {
  const g = grid();
  ear(g, 6, 0, 3, 3, "b");
  ear(g, 17, 0, 3, 3, "b");
  ear(g, 6, 1, 2, 1, "c");
  ear(g, 17, 1, 2, 1, "c");
  ellipse(g, 12, 8.5, 8.6, 5.6, "b"); // 头
  ellipse(g, 12, 17.5, 7.2, 4.4, "b"); // 身体
  ellipse(g, 12, 17.5, 3.8, 3.6, "w"); // 白胸
  rect(g, 10, 4, 13, 6, "w"); // 额头 blaze
  ellipse(g, 12, 11, 4.2, 2.2, "w"); // 白嘴部
  ellipse(g, 9, 21.5, 2.4, 1.6, "w"); // 左爪
  ellipse(g, 15, 21.5, 2.4, 1.6, "w"); // 右爪
  // 尾巴：从右下卷起
  ellipse(g, 20.5, 19, 2.2, 3.2, "b");
  ellipse(g, 21, 15.5, 1.8, 2.4, "b");
  rect(g, 21, 14, 22, 15, "s"); // 尾尖纹
  // 虎斑：额头 M 纹 + 侧身纹
  rect(g, 9, 3, 9, 4, "s");
  rect(g, 12, 3, 12, 3, "s");
  rect(g, 15, 3, 15, 4, "s");
  rect(g, 4, 16, 4, 18, "s");
  rect(g, 19, 16, 19, 17, "s");
  face(g, 7);
  whiskers(g, 10);
  return outline(g);
}

// ---- 方案二：橘团子（loaf，矮胖无爪，尾巴绕前）----
function v2() {
  const g = grid();
  ear(g, 8, 2, 4, 3, "b");
  ear(g, 15, 2, 4, 3, "b");
  ear(g, 8, 3, 3, 1, "c");
  ear(g, 15, 3, 3, 1, "c");
  ellipse(g, 12, 10, 8.8, 6, "b"); // 头（更大更圆）
  ellipse(g, 12, 19, 9.4, 3.6, "b"); // 长条身体（loaf）
  ellipse(g, 12, 11.5, 4.4, 2.2, "w"); // 大白嘴部
  // 尾巴绕到前面
  ellipse(g, 12, 22.2, 8.6, 1.6, "b");
  rect(g, 6, 21, 8, 23, "s");
  rect(g, 16, 21, 18, 23, "s");
  // 虎斑
  rect(g, 8, 5, 8, 6, "s");
  rect(g, 12, 4, 12, 5, "s");
  rect(g, 16, 5, 16, 6, "s");
  rect(g, 3, 19, 3, 20, "s");
  face(g, 9);
  whiskers(g, 12);
  return outline(g);
}

// ---- 方案三：橘白奶牛斑（不对称白斑，一只白耳，白肚）----
function v3() {
  const g = grid();
  ear(g, 6, 0, 3, 3, "w"); // 右耳白色（观者视角右侧）
  ear(g, 17, 0, 3, 3, "b");
  ear(g, 6, 1, 2, 1, "c");
  ear(g, 17, 1, 2, 1, "c");
  ellipse(g, 12, 8.5, 8.6, 5.6, "b");
  ellipse(g, 8, 10.5, 3.8, 2.6, "w"); // 左脸颊白斑（避开眼睛）
  ellipse(g, 12, 17.5, 7.2, 4.4, "b");
  ellipse(g, 12, 18.5, 4.6, 3, "w"); // 白肚
  ellipse(g, 9, 21.5, 2.4, 1.6, "w");
  ellipse(g, 15, 21.5, 2.4, 1.6, "w");
  ellipse(g, 12, 11, 4.2, 2.2, "w");
  ellipse(g, 20.5, 19, 2.2, 3.2, "b");
  ellipse(g, 21, 15.5, 1.8, 2.4, "b");
  face(g, 7);
  whiskers(g, 10);
  return outline(g);
}

// ---- 方案四：歪头橘白（头右歪，左眼 wink，尾巴高翘）----
function v4() {
  const g = grid();
  const dx = 2; // 头部右偏
  ear(g, 6 + dx, 0, 3, 3, "b");
  ear(g, 17 + dx, 0, 3, 3, "b");
  ear(g, 6 + dx, 1, 2, 1, "c");
  ear(g, 17 + dx, 1, 2, 1, "c");
  ellipse(g, 12 + dx, 8.5, 8.4, 5.6, "b");
  ellipse(g, 12, 17.5, 7.2, 4.4, "b");
  ellipse(g, 12, 17.5, 3.8, 3.6, "w");
  ellipse(g, 12 + dx, 11, 4.2, 2.2, "w");
  ellipse(g, 9, 21.5, 2.4, 1.6, "w");
  ellipse(g, 15, 21.5, 2.4, 1.6, "w");
  // 尾巴高高翘起
  ellipse(g, 20.5, 16, 2, 3.4, "b");
  ellipse(g, 20, 11.5, 1.8, 2.6, "b");
  rect(g, 19, 9, 20, 11, "s");
  rect(g, 5, 16, 5, 18, "s");
  face(g, 7, { wink: true });
  whiskers(g, 10);
  return outline(g);
}

// ---- 渲染输出 ----

function renderSheet(name, frames, scale) {
  const png = new PNG({ width: SIZE * frames.length * scale, height: SIZE * scale });
  frames.forEach((grid2, f) => {
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const [R, G, B, A] = PALETTE[grid2[y][x]] ?? [0, 0, 0, 0];
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px2 = ((y * scale + sy) * SIZE * frames.length * scale + (f * SIZE + x) * scale + sx) * 4;
            png.data[px2] = R;
            png.data[px2 + 1] = G;
            png.data[px2 + 2] = B;
            png.data[px2 + 3] = A;
          }
        }
      }
    }
  });
  fs.writeFileSync(path.join(outDir, name), PNG.sync.write(png));
  console.log(`✓ design/${name}`);
}

const variants = [
  ["cat-v1-classic.png", v1()],
  ["cat-v2-loaf.png", v2()],
  ["cat-v3-cow.png", v3()],
  ["cat-v4-tilt.png", v4()],
];

for (const [name, g] of variants) {
  // 行长校验
  g.forEach((row, i) => {
    if (row.length !== SIZE) throw new Error(`${name} 第${i}行长度 ${row.length}`);
  });
  renderSheet(name, [g], 8);
}

// 2×2 总览图（顺序：左上 v1、右上 v2、左下 v3、右下 v4）
const SCALE = 6;
const GAP = 2;
const overview = new PNG({
  width: (SIZE * SCALE + GAP) * 2 + GAP,
  height: (SIZE * SCALE + GAP) * 2 + GAP,
});
variants.forEach(([, g], i) => {
  const col = i % 2;
  const row = Math.floor(i / 2);
  const ox = GAP + col * (SIZE * SCALE + GAP);
  const oy = GAP + row * (SIZE * SCALE + GAP);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [R, G, B, A] = PALETTE[g[y][x]] ?? [0, 0, 0, 0];
      for (let sy = 0; sy < SCALE; sy++) {
        for (let sx = 0; sx < SCALE; sx++) {
          const px2 = ((oy + y * SCALE + sy) * overview.width + ox + x * SCALE + sx) * 4;
          overview.data[px2] = R;
          overview.data[px2 + 1] = G;
          overview.data[px2 + 2] = B;
          overview.data[px2 + 3] = A;
        }
      }
    }
  }
});
fs.writeFileSync(path.join(outDir, "cat-overview.png"), PNG.sync.write(overview));
console.log("✓ design/cat-overview.png（左上v1经典 右上v2团子 左下v3奶牛斑 右下v4歪头）");
