const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// CRC32 table
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf, start, end) {
  let crc = 0xFFFFFFFF;
  for (let i = start; i < end; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function writeUint32BE(buf, offset, value) {
  buf[offset]     = (value >>> 24) & 0xFF;
  buf[offset + 1] = (value >>> 16) & 0xFF;
  buf[offset + 2] = (value >>> 8)  & 0xFF;
  buf[offset + 3] =  value         & 0xFF;
}

function createPNG(size) {
  const BG  = [11,  15,  25];   // #0b0f19
  const CIR = [96, 165, 250];   // #60a5fa
  const WH  = [255, 255, 255];  // white

  const cx = size / 2;
  const cy = size / 2;
  const r  = 0.30 * size;
  const r2 = r * r;
  const thickness = Math.max(size / 24, 3);
  const half = thickness / 2;

  // Checkmark endpoints
  const x1 = 0.38 * size, y1 = 0.50 * size;
  const x2 = 0.46 * size, y2 = 0.58 * size;
  const x3 = 0.62 * size, y3 = 0.40 * size;

  // Precompute line segment distance helpers
  function distToSegmentSq(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return (px - ax) ** 2 + (py - ay) ** 2;
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
  }

  // Build raw pixel rows (filter byte 0 + RGB per pixel)
  const rowLen = 1 + size * 3;
  const raw = Buffer.alloc(rowLen * size);

  for (let y = 0; y < size; y++) {
    raw[y * rowLen] = 0; // filter byte
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const distSq = dx * dx + dy * dy;

      let pixel;
      if (distSq <= r2) {
        // Inside circle — check if on checkmark
        const d1 = distToSegmentSq(x, y, x1, y1, x2, y2);
        const d2 = distToSegmentSq(x, y, x2, y2, x3, y3);
        if (d1 <= half * half || d2 <= half * half) {
          pixel = WH;
        } else {
          pixel = CIR;
        }
      } else {
        pixel = BG;
      }

      const offset = y * rowLen + 1 + x * 3;
      raw[offset]     = pixel[0];
      raw[offset + 1] = pixel[1];
      raw[offset + 2] = pixel[2];
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk: 13 bytes of data
  const ihdrData = Buffer.alloc(13);
  writeUint32BE(ihdrData, 0, size);   // width
  writeUint32BE(ihdrData, 4, size);   // height
  ihdrData[8]  = 8;  // bit depth
  ihdrData[9]  = 2;  // color type: RGB
  ihdrData[10] = 0;  // compression
  ihdrData[11] = 0;  // filter
  ihdrData[12] = 0;  // interlace

  const ihdrType = Buffer.from('IHDR');
  const ihdrPayload = Buffer.concat([ihdrType, ihdrData]);
  const ihdrCRC = crc32(ihdrPayload, 0, ihdrPayload.length);
  const ihdrLen = Buffer.alloc(4);
  writeUint32BE(ihdrLen, 0, 13);
  const ihdrCRCBuf = Buffer.alloc(4);
  writeUint32BE(ihdrCRCBuf, 0, ihdrCRC);
  const ihdrChunk = Buffer.concat([ihdrLen, ihdrPayload, ihdrCRCBuf]);

  // IDAT chunk
  const idatType = Buffer.from('IDAT');
  const idatPayload = Buffer.concat([idatType, compressed]);
  const idatCRC = crc32(idatPayload, 0, idatPayload.length);
  const idatLen = Buffer.alloc(4);
  writeUint32BE(idatLen, 0, compressed.length);
  const idatCRCBuf = Buffer.alloc(4);
  writeUint32BE(idatCRCBuf, 0, idatCRC);
  const idatChunk = Buffer.concat([idatLen, idatPayload, idatCRCBuf]);

  // IEND chunk
  const iendType = Buffer.from('IEND');
  const iendCRC = crc32(iendType, 0, 4);
  const iendLen = Buffer.alloc(4); // 0
  const iendCRCBuf = Buffer.alloc(4);
  writeUint32BE(iendCRCBuf, 0, iendCRC);
  const iendChunk = Buffer.concat([iendLen, iendType, iendCRCBuf]);

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

const outDir = path.join(__dirname, 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const sizes = [192, 512];
for (const size of sizes) {
  const png = createPNG(size);
  const outPath = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`Created ${outPath} (${png.length} bytes)`);
}
