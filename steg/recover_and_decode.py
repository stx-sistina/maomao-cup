"""Recover the 1800x880 canvas coordinate system from an arbitrary, uncalibrated
crop/scale of the page (a real screenshot with unknown DPR and unknown crop
offset), then run the standard per-tile "edited" marker extraction on it.

Rather than trusting metadata, this brute-force searches candidate (scale,
offset_x, offset_y) triples and keeps whichever placement of the source image
inside a blank 1800x880 canvas maximizes the number of CRC-verified tile
decodes. This search is safe from false positives: each tile decode requires
a 48-bit header (16-bit length + 32-bit CRC32) to check out, so a wrong
alignment "succeeding" by chance is astronomically unlikely -- any OK tile
found by the search is real signal, not a search artifact.

Usage: python3 recover_and_decode.py <image.png> [--full-height] [--fast]
"""

import argparse
import sys
import time

import numpy as np
from PIL import Image

from decode_edited_marker import CANVAS_H, CANVAS_W, GRID, TILE_H, TILE_W, WM_MESSAGE, extract_tile

# NOTE: extract_tile's CRC check trivially passes for an all-zero (unfilled/padding)
# tile: every block's DCT reads a "0" bit, giving header bits length=0, crc=0, and an
# empty payload's CRC32 is *also* 0 -- so a fully-blank region "validates" with message
# == ''. That is a real false-positive, not signal. Require the exact expected message.
def is_real_hit(message, ok):
    return ok and message == WM_MESSAGE


def build_y_channel(rgb: np.ndarray) -> np.ndarray:
    return 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]


def place_on_canvas(resized_rgb: np.ndarray, ox: int, oy: int) -> np.ndarray:
    canvas = np.zeros((CANVAS_H, CANVAS_W, 3), dtype=np.float64)
    rh, rw = resized_rgb.shape[:2]
    sy0, sy1 = max(0, oy), min(CANVAS_H, oy + rh)
    sx0, sx1 = max(0, ox), min(CANVAS_W, ox + rw)
    if sy0 >= sy1 or sx0 >= sx1:
        return canvas
    ry0, ry1 = sy0 - oy, sy1 - oy
    rx0, rx1 = sx0 - ox, sx1 - ox
    canvas[sy0:sy1, sx0:sx1] = resized_rgb[ry0:ry1, rx0:rx1]
    return canvas


def count_ok_tiles(y: np.ndarray) -> tuple[int, list]:
    results = []
    ok_count = 0
    for row in range(GRID):
        for col in range(GRID):
            tile = y[row * TILE_H:(row + 1) * TILE_H, col * TILE_W:(col + 1) * TILE_W]
            message, ok = extract_tile(tile)
            ok_count += is_real_hit(message, ok)
            results.append((row, col, message, ok))
    return ok_count, results


def search(img: Image.Image, scales, ox_range, oy_range, verbose=False):
    best = (0, None, None, None)
    tried = 0
    t0 = time.time()
    for s in scales:
        rw, rh = max(1, round(img.width / s)), max(1, round(img.height / s))
        resized = np.array(img.resize((rw, rh), Image.LANCZOS)).astype(np.float64)
        for oy in oy_range:
            if oy + rh <= 0 or oy >= CANVAS_H:
                continue
            for ox in ox_range:
                if ox + rw <= 0 or ox >= CANVAS_W:
                    continue
                tried += 1
                canvas = place_on_canvas(resized, ox, oy)
                y = build_y_channel(canvas)
                ok_count, results = count_ok_tiles(y)
                if ok_count > best[0]:
                    best = (ok_count, s, ox, oy)
                    if verbose:
                        print(f"  new best: {ok_count}/25 tiles  scale={s:.4f} ox={ox} oy={oy}")
    elapsed = time.time() - t0
    print(f"Searched {tried} placements in {elapsed:.1f}s")
    return best


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image")
    parser.add_argument("--full-height", action="store_true",
                         help="Assume the crop shows the full canvas height (oy=0, scale=img_h/880); "
                              "only searches the horizontal offset. Fast, for desktop-style crops.")
    parser.add_argument("--scale-min", type=float, default=2.0)
    parser.add_argument("--scale-max", type=float, default=3.5)
    parser.add_argument("--scale-step", type=float, default=0.1)
    parser.add_argument("--oy-max", type=int, default=1200)
    parser.add_argument("--oy-step", type=int, default=20)
    parser.add_argument("--ox-step", type=int, default=10)
    args = parser.parse_args()

    img = Image.open(args.image).convert("RGB")
    print(f"Image: {img.width}x{img.height}")

    if args.full_height:
        s = img.height / CANVAS_H
        rw = round(img.width / s)
        ox_range = range(0, max(1, CANVAS_W - rw + 1), 1)
        best = search(img, [s], ox_range, [0], verbose=True)
    else:
        scales = np.arange(args.scale_min, args.scale_max + 1e-9, args.scale_step)
        ox_range = range(-200, CANVAS_W, args.ox_step)
        oy_range = range(-200, args.oy_max, args.oy_step)
        best = search(img, scales, ox_range, oy_range, verbose=True)

    ok_count, s, ox, oy = best
    if ok_count == 0:
        print("\nNo alignment found any CRC-valid tile in the searched range.")
        sys.exit(0)

    print(f"\nBest alignment: scale={s:.4f} ox={ox} oy={oy} -> {ok_count}/25 tiles")
    rw, rh = max(1, round(img.width / s)), max(1, round(img.height / s))
    resized = np.array(img.resize((rw, rh), Image.LANCZOS)).astype(np.float64)
    canvas = place_on_canvas(resized, ox, oy)
    y = build_y_channel(canvas)
    _, results = count_ok_tiles(y)
    for row, col, message, ok in results:
        if ok or message is not None:
            print(f"tile[{row}][{col}] {'OK  ' if ok else 'FAIL'} -> {message!r}")


if __name__ == "__main__":
    main()
