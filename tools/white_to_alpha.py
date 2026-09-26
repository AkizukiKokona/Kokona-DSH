#!/usr/bin/env python3
"""Key a flat light background out of a PNG and write a straight-alpha RGBA result.

How it works
------------
1. The background colour is sampled as the median of the border ring.
2. Every pixel is scored by its Euclidean distance from that colour.
3. Pixels at or below --lo become fully transparent; at or above --hi fully
   opaque; the band between them is ramped with a smoothstep. That band is
   exactly where the anti-aliased edge lives, so the ramp reproduces it.
4. Edge pixels are un-premultiplied, which removes the background colour that
   was baked into them -- otherwise the artwork keeps a pale halo on any
   surface darker than the original.
5. --kill-white force-clears any remaining bright, near-neutral pixel. Enclosed
   white counters (letter holes, shape interiors) land here, because they sit
   well inside --lo and are already at ~0 alpha; this only mops up the last
   faint specks.
6. --despeckle drops connected islands below N pixels, for scan dust.

Usage
-----
  python white_to_alpha.py IN OUT [options]

  --lo N        distance at or below which a pixel is pure background (6)
  --hi N        distance at or above which a pixel is pure subject (14)
  --hard        binary mask at --lo, no feather ramp
  --bg R,G,B    override the sampled background colour
  --crop        trim to the subject bounding box
  --pad N       padding kept when cropping (12)
  --kill-white  clear residual bright near-neutral pixels (on by default)
  --no-kill-white
  --despeckle N drop islands smaller than N pixels (0 = off)
  --preview     print an ASCII map of the resulting alpha channel
"""

from __future__ import annotations

import argparse
import sys

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

RING = 3        # border thickness used to sample the background
WHITE_MIN = 232  # a pixel counts as "white" when its darkest channel is this high
WHITE_CHROMA = 14  # ...and its channel spread is this low


def sample_background(rgb: np.ndarray) -> np.ndarray:
    ring = np.concatenate([
        rgb[:RING].reshape(-1, 3), rgb[-RING:].reshape(-1, 3),
        rgb[:, :RING].reshape(-1, 3), rgb[:, -RING:].reshape(-1, 3),
    ])
    return np.median(ring, axis=0)


def smoothstep(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def unpremultiply(rgb: np.ndarray, alpha: np.ndarray, bg: np.ndarray,
                  floor: float = 0.15) -> np.ndarray:
    """Recover the un-composited colour of partially transparent edge pixels."""
    out = rgb.copy()
    edge = (alpha > floor) & (alpha < 1.0)
    if edge.any():
        a = alpha[edge][:, None]
        out[edge] = np.clip((rgb[edge] - (1.0 - a) * bg) / a, 0.0, 255.0)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--lo', type=float, default=6.0)
    ap.add_argument('--hi', type=float, default=14.0)
    ap.add_argument('--hard', action='store_true')
    ap.add_argument('--bg', default=None, help='e.g. 255,255,255')
    ap.add_argument('--crop', action='store_true')
    ap.add_argument('--pad', type=int, default=12)
    ap.add_argument('--kill-white', dest='kill_white', action='store_true', default=True)
    ap.add_argument('--no-kill-white', dest='kill_white', action='store_false')
    ap.add_argument('--despeckle', type=int, default=0)
    ap.add_argument('--preview', action='store_true')
    args = ap.parse_args()

    im = Image.open(args.src)
    src_mode, src_size = im.mode, im.size
    rgb = np.asarray(im.convert('RGB'), dtype=np.float32)

    bg = (np.array([float(v) for v in args.bg.split(',')], dtype=np.float32)
          if args.bg else sample_background(rgb))
    dist = np.sqrt(((rgb - bg) ** 2).sum(axis=2) / 3.0)

    if args.hard or args.hi <= args.lo:
        alpha = (dist > args.lo).astype(np.float32)
    else:
        alpha = smoothstep((dist - args.lo) / (args.hi - args.lo))

    killed = 0
    if args.kill_white:
        white = (rgb.min(axis=2) >= WHITE_MIN) & \
                ((rgb.max(axis=2) - rgb.min(axis=2)) <= WHITE_CHROMA)
        hit = white & (alpha > 0.0)
        killed = int(hit.sum())
        alpha[hit] = 0.0

    speckled = 0
    if args.despeckle > 0:
        mask = alpha > 0.004
        lab, n = ndi.label(mask, np.ones((3, 3), int))
        if n:
            sizes = np.bincount(lab.ravel())
            sizes[0] = 0
            drop = np.where(sizes < args.despeckle)[0]
            if len(drop):
                speckled = int(sizes[drop].sum())
                alpha[np.isin(lab, drop)] = 0.0

    out_rgb = unpremultiply(rgb, alpha, bg)
    rgba = np.dstack([out_rgb, alpha * 255.0]).round().astype(np.uint8)

    if args.crop:
        ys, xs = np.where(alpha > 0.02)
        if len(ys):
            y0, y1 = max(0, ys.min() - args.pad), min(rgba.shape[0], ys.max() + 1 + args.pad)
            x0, x1 = max(0, xs.min() - args.pad), min(rgba.shape[1], xs.max() + 1 + args.pad)
            rgba = rgba[y0:y1, x0:x1]

    Image.fromarray(rgba, 'RGBA').save(args.dst, optimize=True)

    a = alpha
    opaque = a > 0.999
    print(f'in    {args.src}  ({src_mode} {src_size})')
    print(f'bg    {bg.round(1).tolist()}   ramp d<={args.lo} -> 0, d>={args.hi} -> 1'
          + ('  [hard]' if args.hard else ''))
    print(f'out   {args.dst}  (RGBA {rgba.shape[1]}x{rgba.shape[0]})')
    print(f'alpha clear {(a <= 0.001).mean() * 100:6.2f}%  '
          f'partial {((a > 0.001) & (a < 0.999)).mean() * 100:5.2f}%  '
          f'opaque {opaque.mean() * 100:6.2f}%')
    if killed:
        print(f'white-kill cleared {killed} residual bright neutral pixels')
    if speckled:
        print(f'despeckle dropped {speckled} pixels in islands < {args.despeckle}px')

    if opaque.any():
        oc = out_rgb[opaque].max(1) - out_rgb[opaque].min(1)
        print(f'opaque pixels: min distance from bg {dist[opaque].min():.1f}, '
              f'mean chroma {oc.mean():.0f}')

    if args.preview:
        cols, rows = 104, 42
        sm = np.array(Image.fromarray((a * 255).astype(np.uint8))
                      .resize((cols, rows), Image.BOX))
        chars = ' .:-=+*#%@'
        print('\nALPHA (blank = transparent)')
        print('+' + '-' * cols + '+')
        for r in range(rows):
            print('|' + ''.join(chars[min(9, int(sm[r, c] / 25.6))]
                                for c in range(cols)) + '|')
        print('+' + '-' * cols + '+')
    return 0


if __name__ == '__main__':
    sys.exit(main())
