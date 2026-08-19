// Side quest, isolated: a blind DCT-domain watermark stamped into the background
// image when someone opens the public 编辑模式.
//
// Purpose and limits. The public page deliberately lets anyone edit results locally,
// so this is not access control -- anyone can edit the DOM directly and never run this
// code at all. It only marks a locally-altered background so a casually-shared
// screenshot can be told apart from the official bracket. Embedding in the frequency
// domain (rather than in low pixel bits) is what lets the mark survive rescaling and
// mild recompression.
//
// steg/dct_watermark.py is the offline twin of this algorithm, and
// steg/decode_edited_marker.py extracts the mark from a suspect image. Any change here
// has to be mirrored there or the decoder stops agreeing.

const GRID = 5;              // the mark is repeated over a 5x5 grid of tiles, so a crop
const BLOCK = 8;             // of the image still contains whole copies
const HEADER_BITS = 48;      // 2 bytes length + 4 bytes CRC32
const MAX_PAYLOAD_BYTES = 12;
const POS_A = [4, 1];        // the coefficient pair whose relative order carries a bit
const POS_B = [3, 2];
const MARGIN = 8.0;          // how far apart to force them; higher survives more, but
const KEY = 'edited-watermark-key';  // shows more visible texture
const MESSAGE = 'edited';

// --- Deterministic block ordering, so the decoder can find the bits without a map ---
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = h << 13 | h >>> 19;
  }
  return () => {
    h = Math.imul(h ^ h >>> 16, 2246822507);
    h = Math.imul(h ^ h >>> 13, 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function mulberry32(a) {
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function blockOrder(key, count) {
  const rng = mulberry32(xmur3(key)());
  const arr = Array.from({ length: count }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// --- 8x8 DCT-II via matrix multiplication ---
function dctMatrix(n) {
  const m = [];
  for (let k = 0; k < n; k++) {
    const alpha = k === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n);
    const row = [];
    for (let x = 0; x < n; x++) row.push(alpha * Math.cos(Math.PI / n * (x + 0.5) * k));
    m.push(row);
  }
  return m;
}

const C = dctMatrix(BLOCK);
const CT = C[0].map((_, j) => C.map(row => row[j]));

function matMul(a, b) {
  const n = a.length, out = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(n).fill(0);
    for (let k = 0; k < n; k++) {
      const aik = a[i][k];
      for (let j = 0; j < n; j++) row[j] += aik * b[k][j];
    }
    out.push(row);
  }
  return out;
}

const dct2 = block => matMul(matMul(C, block), CT);
const idct2 = coeffs => matMul(matMul(CT, coeffs), C);

// --- Payload framing ---
function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function payloadBits(message) {
  const msg = Array.from(new TextEncoder().encode(message));
  const crc = crc32(msg);
  const header = [
    (msg.length >> 8) & 0xFF, msg.length & 0xFF,
    (crc >>> 24) & 0xFF, (crc >>> 16) & 0xFF, (crc >>> 8) & 0xFF, crc & 0xFF,
  ];
  const bits = [];
  for (const byte of header.concat(msg)) {
    for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  }
  return bits;
}

function embedBit(block, bit) {
  const d = dct2(block);
  const diff = d[POS_A[0]][POS_A[1]] - d[POS_B[0]][POS_B[1]];
  if ((bit === 1 && diff < MARGIN) || (bit === 0 && diff > -MARGIN)) {
    const delta = ((bit === 1 ? MARGIN : -MARGIN) - diff) / 2;
    d[POS_A[0]][POS_A[1]] += delta;
    d[POS_B[0]][POS_B[1]] -= delta;
  }
  const spatial = idct2(d);
  for (let r = 0; r < BLOCK; r++) {
    for (let c = 0; c < BLOCK; c++) {
      spatial[r][c] = Math.min(255, Math.max(0, Math.round(spatial[r][c])));
    }
  }
  return spatial;
}

export function loadBackground(canvas, src = 'assets/bg.png') {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const img = new Image();
  img.onload = () => {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.dataset.loaded = '1';
  };
  img.src = src;
}

// Embeds the constant "edited" marker into the luma channel of every tile. Silently
// does nothing if the background never loaded, or if reading the pixels is blocked
// (a file:// page taints the canvas, so this only works when the page is served).
export function stampEdited(canvas) {
  if (!canvas || !canvas.dataset.loaded) return false;
  const w = canvas.width, h = canvas.height;
  const tileW = Math.floor(w / GRID), tileH = Math.floor(h / GRID);
  const blocksX = Math.floor(tileW / BLOCK), blocksY = Math.floor(tileH / BLOCK);
  const blocksPerTile = blocksX * blocksY;
  // Budget by the maximum payload rather than this message's length, so the decoder's
  // idea of the redundancy factor does not depend on the message.
  const redundancy = Math.floor(blocksPerTile / (HEADER_BITS + MAX_PAYLOAD_BYTES * 8));
  if (redundancy < 1) return false;

  const ctx = canvas.getContext('2d');
  let imgData;
  try {
    imgData = ctx.getImageData(0, 0, w, h);
  } catch (err) {
    console.warn('无法读取背景像素（页面可能以 file:// 打开），水印已跳过。', err);
    return false;
  }
  const px = imgData.data;

  const y = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    y[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  }

  const bits = payloadBits(MESSAGE);
  const order = blockOrder(KEY, blocksPerTile);

  const getBlock = (x0, y0, bx, by) => {
    const block = [];
    for (let r = 0; r < BLOCK; r++) {
      const row = [];
      for (let c = 0; c < BLOCK; c++) row.push(y[(y0 + by * BLOCK + r) * w + (x0 + bx * BLOCK + c)]);
      block.push(row);
    }
    return block;
  };
  const setBlock = (x0, y0, bx, by, block) => {
    for (let r = 0; r < BLOCK; r++) {
      for (let c = 0; c < BLOCK; c++) {
        y[(y0 + by * BLOCK + r) * w + (x0 + bx * BLOCK + c)] = block[r][c];
      }
    }
  };

  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const x0 = col * tileW, y0 = row * tileH;
      let slot = 0;
      for (const bit of bits) {
        for (let k = 0; k < redundancy; k++) {
          const idx = order[slot++];
          const bx = idx % blocksX, by = Math.floor(idx / blocksX);
          setBlock(x0, y0, bx, by, embedBit(getBlock(x0, y0, bx, by), bit));
        }
      }
    }
  }

  // Apply the luma change back to RGB as an equal offset on all three channels, which
  // keeps hue intact.
  for (let i = 0; i < w * h; i++) {
    const oldY = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    const delta = y[i] - oldY;
    for (let c = 0; c < 3; c++) {
      px[i * 4 + c] = Math.min(255, Math.max(0, px[i * 4 + c] + delta));
    }
  }
  ctx.putImageData(imgData, 0, 0);
  return true;
}
