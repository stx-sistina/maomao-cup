"""Offline decoder for the "edited" marker embedded client-side by index.html
when a visitor clicks 编辑模式 (see markCanvasEdited() in index.html).

This is a separate, JS-compatible twin of dct_watermark.py: same coefficient-
relation scheme, but using a mulberry32/xmur3 PRNG (matching JavaScript
exactly) instead of Python's random.Random, since the block order must be
reproducible from the public, unauthenticated client-side JS.

Usage: python3 decode_edited_marker.py <screenshot.png>
"""

import sys
import numpy as np
from PIL import Image

CANVAS_W, CANVAS_H = 1800, 880
GRID = 5
TILE_W, TILE_H = CANVAS_W // GRID, CANVAS_H // GRID
BLOCK = 8
BLOCKS_X, BLOCKS_Y = TILE_W // BLOCK, TILE_H // BLOCK
BLOCKS_PER_TILE = BLOCKS_X * BLOCKS_Y
HEADER_BITS = 48
MAX_PAYLOAD_BYTES = 12
REDUNDANCY = BLOCKS_PER_TILE // (HEADER_BITS + MAX_PAYLOAD_BYTES * 8)
POS_A, POS_B = (4, 1), (3, 2)
KEY = "edited-watermark-key"
WM_MESSAGE = "edited"


def _xmur3(s: str):
    h = (1779033703 ^ len(s)) & 0xFFFFFFFF
    for ch in s:
        h = (h ^ ord(ch)) & 0xFFFFFFFF
        h = (h * 3432918353) & 0xFFFFFFFF
        h = ((h << 13) | (h >> 19)) & 0xFFFFFFFF
    state = h

    def next_seed():
        nonlocal state
        state = (state ^ (state >> 16)) & 0xFFFFFFFF
        state = (state * 2246822507) & 0xFFFFFFFF
        state = (state ^ (state >> 13)) & 0xFFFFFFFF
        state = (state * 3266489909) & 0xFFFFFFFF
        state = (state ^ (state >> 16)) & 0xFFFFFFFF
        return state

    return next_seed


def _mulberry32(seed: int):
    state = seed & 0xFFFFFFFF

    def next_rand():
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        a = state
        t1 = ((a ^ (a >> 15)) * (1 | a)) & 0xFFFFFFFF
        inner = ((t1 ^ (t1 >> 7)) * (61 | t1)) & 0xFFFFFFFF
        t2 = ((t1 + inner) & 0xFFFFFFFF) ^ t1
        t2 &= 0xFFFFFFFF
        result = (t2 ^ (t2 >> 14)) & 0xFFFFFFFF
        return result / 4294967296.0

    return next_rand


def _block_order(key: str) -> list[int]:
    rng = _mulberry32(_xmur3(key)())
    arr = list(range(BLOCKS_PER_TILE))
    for i in range(len(arr) - 1, 0, -1):
        j = int(rng() * (i + 1))
        arr[i], arr[j] = arr[j], arr[i]
    return arr


def _dct_matrix(n: int) -> np.ndarray:
    k = np.arange(n).reshape(-1, 1)
    x = np.arange(n).reshape(1, -1)
    m = np.cos(np.pi / n * (x + 0.5) * k)
    alpha = np.full((n, 1), np.sqrt(2.0 / n))
    alpha[0, 0] = np.sqrt(1.0 / n)
    return m * alpha


_C = _dct_matrix(BLOCK)


def _dct2(block: np.ndarray) -> np.ndarray:
    return _C @ block @ _C.T


def _bytes_from_bits(bits: list[int]) -> bytes:
    out = bytearray()
    for i in range(0, len(bits) - 7, 8):
        b = 0
        for bit in bits[i:i + 8]:
            b = (b << 1) | bit
        out.append(b)
    return bytes(out)


def extract_tile(y_tile: np.ndarray) -> tuple[str | None, bool]:
    import struct
    import zlib

    order = _block_order(KEY)

    def read_bits(n_bits, start_slot):
        bits, slot = [], start_slot
        for _ in range(n_bits):
            votes = []
            for _ in range(REDUNDANCY):
                blk_idx = order[slot]
                slot += 1
                by, bx = divmod(blk_idx, BLOCKS_X)
                y0, x0 = by * BLOCK, bx * BLOCK
                d = _dct2(y_tile[y0:y0 + BLOCK, x0:x0 + BLOCK].astype(np.float64))
                votes.append(1 if d[POS_A] > d[POS_B] else 0)
            bits.append(1 if sum(votes) * 2 > len(votes) else 0)
        return bits, slot

    header_bits, slot = read_bits(HEADER_BITS, 0)
    length, crc = struct.unpack(">HI", _bytes_from_bits(header_bits))
    if length > MAX_PAYLOAD_BYTES:
        return None, False
    body_bits, _ = read_bits(length * 8, slot)
    msg_bytes = _bytes_from_bits(body_bits)
    ok = (zlib.crc32(msg_bytes) & 0xFFFFFFFF) == crc
    try:
        message = msg_bytes.decode("utf-8")
    except UnicodeDecodeError:
        message, ok = msg_bytes.decode("utf-8", errors="replace"), False
    return message, ok


def main():
    if len(sys.argv) != 2:
        sys.exit("Usage: python3 decode_edited_marker.py <screenshot.png>")
    img = Image.open(sys.argv[1]).convert("RGB")
    if img.size != (CANVAS_W, CANVAS_H):
        img = img.resize((CANVAS_W, CANVAS_H))
    # Match the JS embed's luma formula exactly (BT.601), not PIL's YCbCr convert.
    arr = np.array(img).astype(np.float64)
    y = 0.299 * arr[:, :, 0] + 0.587 * arr[:, :, 1] + 0.114 * arr[:, :, 2]

    ok_count = 0
    for row in range(GRID):
        for col in range(GRID):
            tile = y[row * TILE_H:(row + 1) * TILE_H, col * TILE_W:(col + 1) * TILE_W]
            message, ok = extract_tile(tile)
            ok_count += ok
            print(f"tile[{row}][{col}] {'OK  ' if ok else 'FAIL'} -> {message!r}")
    print(f"\n{ok_count}/{GRID*GRID} tiles decoded successfully")
    if ok_count > 0:
        print('=> This image was likely produced via 编辑模式 (customized, not official).')
    else:
        print('=> No "edited" marker found (consistent with an official, unedited view).')


if __name__ == "__main__":
    main()
