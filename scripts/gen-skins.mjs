// logo 平滑皮肤生成器：design/logos/*.png → skins/<agent>/（192×192，smooth:true 高清直出）。
// design/logos 里的商标图片仅限本地自用，不入库不发布（已加 .gitignore）。
// hermes 只有 32px 源图，保持像素版不在此生成。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const logosDir = path.join(root, "design", "logos");
const skinsDir = path.join(root, "src-tauri", "target", "release", "skins");

const SSIZE = 192;
const OVERLAY = {
  yellow: [255, 215, 110, 255],
  green: [123, 217, 123, 255],
  red: [255, 90, 90, 255],
};

function loadPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

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

/** 块平均缩放：alpha=覆盖率（边缘自然抗锯齿），RGB 按 alpha 加权（无底色污染）。 */
function extractSmoothAlpha(src, outSize) {
  const t = trim(src);
  const k = outSize / Math.max(t.width, t.height);
  const dw = Math.round(t.width * k);
  const dh = Math.round(t.height * k);
  const ox = Math.floor((outSize - dw) / 2);
  const oy = Math.floor((outSize - dh) / 2);
  const grid = Array.from({ length: outSize }, () => Array.from({ length: outSize }, () => null));
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor(x / k);
      const sx1 = Math.min(t.width - 1, Math.floor((x + 1) / k));
      const sy0 = Math.floor(y / k);
      const sy1 = Math.min(t.height - 1, Math.floor((y + 1) / k));
      let r = 0, g = 0, b = 0, a = 0, tot = 0;
      for (let sy = sy0; sy <= sy1; sy++) {
        for (let sx = sx0; sx <= sx1; sx++) {
          const i = (sy * t.width + sx) * 4;
          const w = t.data[i + 3] / 255;
          r += t.data[i] * w;
          g += t.data[i + 1] * w;
          b += t.data[i + 2] * w;
          a += w;
          tot++;
        }
      }
      const cov = a / tot;
      if (cov > 0.02) {
        const ai = Math.min(255, Math.round(cov * 255 * 1.15));
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

function fillCircle(g, cx, cy, rad, color) {
  const S = g.length;
  for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) {
    for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
      if (x < 0 || x >= S || y < 0 || y >= S) continue;
      if (Math.hypot(x - cx, y - cy) <= rad) g[y][x] = color;
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

function typingDots(g, n) {
  const S = g.length;
  const out = g.map((r) => [...r]);
  const baseX = S - 66, baseY = 30;
  for (let i = 0; i < 3; i++) {
    if (i < n) fillCircle(out, baseX + i * 22, baseY, 8, OVERLAY.yellow);
  }
  return out;
}

function exclMark(g) {
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
  const steps = Math.ceil(len) * 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    fillCircle(out, c - len / 2 + len * t, r0 + len * t, th / 2, OVERLAY.red);
    fillCircle(out, c + len / 2 - len * t, r0 + len * t, th / 2, OVERLAY.red);
  }
  return out;
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

const SOURCES = ["codex", "zcode", "codebuddy"]; // hermes 仅 32px 源，保持像素版
for (const name of SOURCES) {
  const file = path.join(logosDir, `${name}.png`);
  if (!fs.existsSync(file)) {
    console.log(`- 跳过 ${name}（缺 ${name}.png）`);
    continue;
  }
  const base = extractSmoothAlpha(loadPng(file), SSIZE);
  const frames = makeFramesSmooth(base);
  writeSkin(
    path.join(skinsDir, name),
    { name, frame: SSIZE, smooth: true },
    frames,
    SSIZE,
  );
  console.log(`✓ skins/${name}/（平滑 ${SSIZE}×${SSIZE}）`);
}
console.log("logo 平滑皮肤生成完毕");
