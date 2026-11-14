/**
 * 极简 PNG 生成器（无第三方依赖）
 *
 * 为什么手写：图标是安装体验的一部分（iOS 主屏、macOS 程序坞、任务切换器），
 * 但本项目刻意保持零构建依赖。用 node:zlib 直接产出合法的 8 位 RGBA PNG 即可，
 * 不需要引入 canvas / sharp 这类会拖慢部署的原生模块。
 */
import zlib from "node:zlib";
import fs from "node:fs";

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filter
  ihdr[12] = 0;  // no interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/** 圆角矩形覆盖率：返回 0..1（抗锯齿用 1px 边缘采样近似） */
function roundRectCoverage(x, y, w, h, r) {
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx, dy = y - cy;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= r - 0.5) return 1;
  if (d >= r + 0.5) return 0;
  return Math.max(0, Math.min(1, r + 0.5 - d));
}

/**
 * 绘制图标：品牌蓝渐变底 + 三根递增的白色负荷条。
 * @param {number} size 边长
 * @param {{tight?:boolean}} opt tight=true 用于 maskable（内容收紧，避免被系统圆形裁切咬掉）
 */
export function iconRGBA(size, opt = {}) {
  const tight = !!opt.tight;
  const buf = Buffer.alloc(size * size * 4);
  const radius = tight ? 0 : size * 0.225;
  const inset = tight ? size * 0.20 : 0;          // maskable 安全区内缩
  const box = size - inset * 2;

  // 三根柱子：宽 12%，间距 9%，底部对齐，高度 34% / 52% / 70%
  const barW = box * 0.135;
  const gap = box * 0.10;
  const totalW = barW * 3 + gap * 2;
  const left0 = inset + (box - totalW) / 2;
  const baseY = inset + box * 0.78;
  const heights = [0.34, 0.52, 0.70].map((k) => box * k);
  const rr = barW / 2;

  for (let y = 0; y < size; y++) {
    // 纵向渐变：#0A84FF → #0046B8
    const t = y / (size - 1);
    const br = Math.round(10 + (0 - 10) * t);
    const bg = Math.round(132 + (70 - 132) * t);
    const bb = Math.round(255 + (184 - 255) * t);

    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const bgCov = tight ? 1 : roundRectCoverage(x + 0.5, y + 0.5, size, size, radius);
      if (bgCov <= 0) { buf[i + 3] = 0; continue; }

      // 前景：白条
      let fg = 0;
      for (let b = 0; b < 3; b++) {
        const bx = left0 + b * (barW + gap);
        const by = baseY - heights[b];
        const cov = roundRectCoverage(
          x + 0.5 - bx, y + 0.5 - by,
          barW, heights[b], Math.min(rr, heights[b] / 2)
        );
        if (cov > fg) fg = cov;
      }

      buf[i] = Math.round(br * (1 - fg) + 255 * fg);
      buf[i + 1] = Math.round(bg * (1 - fg) + 255 * fg);
      buf[i + 2] = Math.round(bb * (1 - fg) + 255 * fg);
      buf[i + 3] = Math.round(255 * bgCov);
    }
  }
  return buf;
}

export function writeIcon(file, size, opt = {}) {
  const png = encodePNG(size, size, iconRGBA(size, opt));
  fs.writeFileSync(file, png);
  return png.length;
}
