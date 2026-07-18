'use strict';

// Generates the Restaurant Cloud logo / PWA icons as real PNGs with zero
// dependencies (Node's zlib + a tiny CRC32), anti-aliased via 3x3 supersampling.
//
//   node scripts/make-icons.js preview   → two design options at 256px
//   node scripts/make-icons.js a|b       → writes the real icon set

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public');

// --- minimal PNG encoder -----------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// --- geometry (all coords are 0..1 fractions of the tile) --------------------
const circle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const rect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
function roundRect(x, y, x0, y0, x1, y1, r) {
  if (!rect(x, y, x0, y0, x1, y1)) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || x >= x0 + r && x <= x1 - r || y >= y0 + r && y <= y1 - r;
}
/** The cloud: three bumps with a flat bottom at y=0.575. */
const cloud = (x, y) =>
  circle(x, y, 0.3775, 0.460, 0.115) ||
  circle(x, y, 0.4975, 0.415, 0.160) ||
  circle(x, y, 0.6225, 0.465, 0.110) ||
  rect(x, y, 0.2625, 0.460, 0.7375, 0.575);
/** Variant A adds a plate/tray line under the cloud. */
const plate = (x, y) => roundRect(x, y, 0.270, 0.650, 0.730, 0.705, 0.0275);

const mark = (variant) => (x, y) => (variant === 'a' ? cloud(x, y) || plate(x, y) : cloud(x, y));

// --- render ------------------------------------------------------------------
const lerp = (a, b, t) => a + (b - a) * t;
function draw(size, variant) {
  const buf = Buffer.alloc(size * size * 4);
  const inMark = mark(variant);
  const R = 0.22; // tile corner radius
  const S = 3;    // supersample grid
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let tile = 0, ink = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (px + (sx + 0.5) / S) / size, y = (py + (sy + 0.5) / S) / size;
          if (roundRect(x, y, 0, 0, 1, 1, R)) { tile++; if (inMark(x, y)) ink++; }
        }
      }
      const n = S * S, i = (py * size + px) * 4;
      if (!tile) { buf[i + 3] = 0; continue; }
      const t = py / size;                       // vertical gradient #3b82f6 → #1d4ed8
      const base = [lerp(0x3b, 0x1d, t), lerp(0x82, 0x4e, t), lerp(0xf6, 0xd8, t)];
      const k = ink / n;                          // white coverage
      buf[i] = Math.round(lerp(base[0], 255, k));
      buf[i + 1] = Math.round(lerp(base[1], 255, k));
      buf[i + 2] = Math.round(lerp(base[2], 255, k));
      buf[i + 3] = Math.round((tile / n) * 255);
    }
  }
  return encodePNG(size, size, buf);
}

const arg = (process.argv[2] || 'preview').toLowerCase();
fs.mkdirSync(OUT, { recursive: true });
if (arg === 'preview') {
  fs.writeFileSync(path.join(OUT, 'logo-preview-a.png'), draw(256, 'a'));
  fs.writeFileSync(path.join(OUT, 'logo-preview-b.png'), draw(256, 'b'));
  console.log('wrote public/logo-preview-a.png (cloud + plate) and logo-preview-b.png (cloud)');
} else {
  const v = arg === 'b' ? 'b' : 'a';
  for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180], ['logo.png', 256]]) {
    fs.writeFileSync(path.join(OUT, name), draw(size, v));
    console.log('wrote public/' + name);
  }
}
