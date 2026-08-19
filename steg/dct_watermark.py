"""Blind DCT-domain watermark, tiled 5x5 across the canvas for redundancy
against occlusion by opaque UI elements.

Background: LSB (see lsb_watermark.py) was defeated even by a same-machine,
100%-zoom, lossless screenshot, because modern displays apply wide-gamut
color management (Display P3 on macOS) that remaps pixel values during
on-screen composition. That remap is, to a first approximation, an *affine*
transform locally within any small neighborhood (a constant offset plus a
positive scale factor) -- smooth tone curves look linear if you zoom in far
enough. Coefficient-relation DCT watermarking is close to immune to exactly
that class of distortion:

  For an 8x8 block, DCT is linear. If every pixel in the block is transformed
  by x -> s*x + c (s > 0), the resulting coefficients transform as:
    - DC term (frequency 0,0): picks up the offset c (scaled by an 8x8 sum).
    - Every AC term (any other frequency): scales by exactly s, no offset,
      because a constant added to all 64 samples only projects onto the flat
      (DC) basis function.
  So if we embed a bit by forcing sign(coeff_A - coeff_B) for two *AC*
  coefficients, that sign is invariant under any positive-scale affine
  distortion, no matter how large s or c are. Real gamma/tone curves are not
  perfectly affine over a whole 8x8 block (they're only locally linear), so
  this isn't a perfect guarantee -- but it should be dramatically more
  robust than LSB against exactly the failure mode we measured.

  This also happens to be the classic Zhao-Koch scheme, which further buys
  us some resistance to mild JPEG re-quantization (the coefficient pair is
  chosen at a middle frequency, which JPEG's quantization table treats
  fairly gently, and forcing a large-enough margin between the two survives
  moderate rounding).

Design:
- Canvas (1800x880) is split into a 5x5 grid of 360x176 tiles. The full
  payload (header + message) is embedded independently and completely in
  *each* tile. This means any single unobstructed tile is sufficient to
  recover the watermark -- important because the site places opaque white
  UI cards on top of the background image at fixed positions; any tile
  fully or mostly covered by a card carries no usable signal (see the
  occlusion note in the module docstring of index.html integration, or just
  ask the assistant that wrote this).
- Within each 360x176 tile: split into 8x8 blocks (45x22 = 990 blocks).
  Embed on the luma (Y) channel only, one payload bit per block, each bit
  redundantly written to REDUNDANCY blocks (majority vote at decode).
- Extraction reports per-tile results independently, so partial occlusion of
  some tiles doesn't prevent recovery from the rest.
"""

import argparse
import random
import struct
import sys
import zlib

import numpy as np
from PIL import Image

CANVAS_W, CANVAS_H = 1800, 880
GRID_ROWS, GRID_COLS = 5, 5
TILE_W, TILE_H = CANVAS_W // GRID_COLS, CANVAS_H // GRID_ROWS  # 360 x 176
BLOCK = 8
BLOCKS_PER_TILE_X = TILE_W // BLOCK  # 45
BLOCKS_PER_TILE_Y = TILE_H // BLOCK  # 22
BLOCKS_PER_TILE = BLOCKS_PER_TILE_X * BLOCKS_PER_TILE_Y  # 990

HEADER_BITS = 48  # 2-byte length + 4-byte CRC32
MAX_PAYLOAD_BYTES = 16
MAX_PAYLOAD_BITS = MAX_PAYLOAD_BYTES * 8
TOTAL_BITS = HEADER_BITS + MAX_PAYLOAD_BITS
REDUNDANCY = BLOCKS_PER_TILE // TOTAL_BITS  # per-tile internal majority-vote redundancy

# Classic Zhao-Koch mid-frequency AC coefficient pair (row, col), 0-indexed.
POS_A = (4, 1)
POS_B = (3, 2)
MARGIN = 8.0  # enforced minimum |coeff_A - coeff_B| after embedding

assert CANVAS_W % GRID_COLS == 0 and CANVAS_H % GRID_ROWS == 0
assert TILE_W % BLOCK == 0 and TILE_H % BLOCK == 0
assert REDUNDANCY >= 1, "payload too large for available blocks per tile"


def _dct_matrix(n: int) -> np.ndarray:
    k = np.arange(n).reshape(-1, 1)
    x = np.arange(n).reshape(1, -1)
    m = np.cos(np.pi / n * (x + 0.5) * k)
    alpha = np.full((n, 1), np.sqrt(2.0 / n))
    alpha[0, 0] = np.sqrt(1.0 / n)
    return m * alpha


_C = _dct_matrix(BLOCK)
_CT = _C.T


def _dct2(block: np.ndarray) -> np.ndarray:
    return _C @ block @ _CT


def _idct2(coeffs: np.ndarray) -> np.ndarray:
    return _CT @ coeffs @ _C


def _bits_from_bytes(data: bytes) -> list[int]:
    bits = []
    for byte in data:
        for i in range(7, -1, -1):
            bits.append((byte >> i) & 1)
    return bits


def _bytes_from_bits(bits: list[int]) -> bytes:
    out = bytearray()
    for i in range(0, len(bits) - 7, 8):
        b = 0
        for bit in bits[i:i + 8]:
            b = (b << 1) | bit
        out.append(b)
    return bytes(out)


def _build_payload(message: str) -> bytes:
    msg_bytes = message.encode("utf-8")
    if len(msg_bytes) > MAX_PAYLOAD_BYTES:
        raise ValueError(f"Message too long: {len(msg_bytes)} bytes > {MAX_PAYLOAD_BYTES} max.")
    crc = zlib.crc32(msg_bytes) & 0xFFFFFFFF
    return struct.pack(">HI", len(msg_bytes), crc) + msg_bytes


def _block_order(key: str) -> list[int]:
    rng = random.Random(key)
    order = list(range(BLOCKS_PER_TILE))
    rng.shuffle(order)
    return order


def _embed_bit_in_block(block: np.ndarray, bit: int, margin: float) -> np.ndarray:
    d = _dct2(block.astype(np.float64))
    a, b = d[POS_A], d[POS_B]
    diff = a - b
    target = margin if bit == 1 else -margin
    if (bit == 1 and diff < margin) or (bit == 0 and diff > -margin):
        delta = (target - diff) / 2.0
        d[POS_A] += delta
        d[POS_B] -= delta
    spatial = _idct2(d)
    return np.clip(np.round(spatial), 0, 255)


def _read_bit_from_block(block: np.ndarray) -> int:
    d = _dct2(block.astype(np.float64))
    return 1 if d[POS_A] > d[POS_B] else 0


def _tile_slice(arr: np.ndarray, row: int, col: int) -> tuple[slice, slice]:
    return (slice(row * TILE_H, (row + 1) * TILE_H), slice(col * TILE_W, (col + 1) * TILE_W))


def embed_tile(y_tile: np.ndarray, payload_bits: list[int], key: str, margin: float = MARGIN) -> np.ndarray:
    order = _block_order(key)
    out = y_tile.copy()
    slot = 0
    for bit in payload_bits:
        for _ in range(REDUNDANCY):
            blk_idx = order[slot]
            slot += 1
            by, bx = divmod(blk_idx, BLOCKS_PER_TILE_X)
            y0, x0 = by * BLOCK, bx * BLOCK
            out[y0:y0 + BLOCK, x0:x0 + BLOCK] = _embed_bit_in_block(
                out[y0:y0 + BLOCK, x0:x0 + BLOCK], bit, margin
            )
    return out


def extract_tile(y_tile: np.ndarray, key: str) -> tuple[str | None, bool]:
    order = _block_order(key)

    def read_bits(n_bits: int, start_slot: int):
        bits = []
        slot = start_slot
        for _ in range(n_bits):
            votes = []
            for _ in range(REDUNDANCY):
                blk_idx = order[slot]
                slot += 1
                by, bx = divmod(blk_idx, BLOCKS_PER_TILE_X)
                y0, x0 = by * BLOCK, bx * BLOCK
                votes.append(_read_bit_from_block(y_tile[y0:y0 + BLOCK, x0:x0 + BLOCK]))
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
        message = msg_bytes.decode("utf-8", errors="replace")
        ok = False
    return message, ok


def embed(input_path: str, output_path: str, message: str, key: str, margin: float = MARGIN) -> None:
    img = Image.open(input_path).convert("RGB").resize((CANVAS_W, CANVAS_H))
    ycbcr = np.array(img.convert("YCbCr")).astype(np.float64)
    y = ycbcr[:, :, 0]

    payload_bits = _bits_from_bytes(_build_payload(message))

    for row in range(GRID_ROWS):
        for col in range(GRID_COLS):
            r, c = _tile_slice(y, row, col)
            y[r, c] = embed_tile(y[r, c], payload_bits, key, margin)

    ycbcr[:, :, 0] = y
    out_img = Image.fromarray(np.clip(ycbcr, 0, 255).astype(np.uint8), "YCbCr").convert("RGB")
    out_img.save(output_path, format="PNG")

    blocks_used = min(len(payload_bits) * REDUNDANCY, BLOCKS_PER_TILE)
    print(f"Embedded {len(message.encode('utf-8'))} bytes into {GRID_ROWS}x{GRID_COLS} tiles "
          f"({len(payload_bits)} bits x{REDUNDANCY} redundancy per tile, "
          f"{blocks_used}/{BLOCKS_PER_TILE} blocks used per tile) -> {output_path}")


def extract(input_path: str, key: str) -> list[tuple[int, int, str | None, bool]]:
    img = Image.open(input_path).convert("RGB")
    w, h = img.size
    if (w, h) != (CANVAS_W, CANVAS_H):
        img = img.resize((CANVAS_W, CANVAS_H))
    y = np.array(img.convert("YCbCr")).astype(np.float64)[:, :, 0]

    results = []
    for row in range(GRID_ROWS):
        for col in range(GRID_COLS):
            r, c = _tile_slice(y, row, col)
            message, ok = extract_tile(y[r, c], key)
            results.append((row, col, message, ok))
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_embed = sub.add_parser("embed", help="Embed a watermark message into an image")
    p_embed.add_argument("input")
    p_embed.add_argument("output", help="Output PNG path (must be .png)")
    p_embed.add_argument("--message", required=True)
    p_embed.add_argument("--key", required=True)
    p_embed.add_argument("--margin", type=float, default=MARGIN)

    p_extract = sub.add_parser("extract", help="Extract a watermark message, tile by tile")
    p_extract.add_argument("input")
    p_extract.add_argument("--key", required=True)

    args = parser.parse_args()

    if args.command == "embed":
        if not args.output.lower().endswith(".png"):
            sys.exit("Output must be a .png file -- JPEG would destroy the DC/AC balance on save.")
        embed(args.input, args.output, args.message, args.key, args.margin)
    elif args.command == "extract":
        results = extract(args.input, args.key)
        ok_count = sum(1 for *_ , ok in results if ok)
        for row, col, message, ok in results:
            status = "OK " if ok else "FAIL"
            print(f"tile[{row}][{col}] {status} -> {message!r}")
        print(f"\n{ok_count}/{len(results)} tiles decoded successfully")


if __name__ == "__main__":
    main()
