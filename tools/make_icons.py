"""Generate the home-screen icons.

PIL is not installed on the server and adding it for six PNGs would be silly, so the PNGs
are written by hand: a tiny zlib-compressed RGBA encoder is about forty lines and has no
dependencies at all.

The mark is a radar sweep - concentric rings with one bright arc - in the alarm red over
the map's own navy. Recognisable at 40 px on a home screen, which is the only size that
actually matters.

    python -m tools.make_icons web/icons
"""
from __future__ import annotations

import math
import struct
import sys
import zlib
from pathlib import Path

BG = (17, 19, 31)          # --ground-deep
RING = (58, 65, 96)
SWEEP = (255, 45, 85)      # --alarm
CORE = (255, 255, 255)


def _png(width: int, height: int, pixels: bytes) -> bytes:
    """Minimal RGBA PNG writer. `pixels` is width*height*4 bytes, row-major."""
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)                       # filter type 0 for every scanline
        raw += pixels[y * stride:(y + 1) * stride]

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b""))


def _blend(dst: tuple[int, int, int], src: tuple[int, int, int], a: float):
    return tuple(round(d + (s - d) * a) for d, s in zip(dst, src))


def render(size: int, maskable: bool = False) -> bytes:
    """Draw the radar mark at `size` px.

    `maskable` shrinks the artwork into the safe zone Android crops to when it applies its
    own shape mask; without it the rings lose their edges on a circular launcher.
    """
    px = bytearray(size * size * 4)
    cx = cy = (size - 1) / 2
    scale = 0.62 if maskable else 0.80
    radius = size * scale / 2

    # 2x supersampling: at 48 px an aliased circle looks broken, and this is cheap.
    ss = 2
    for y in range(size):
        for x in range(size):
            acc = [0.0, 0.0, 0.0]
            for sy in range(ss):
                for sx in range(ss):
                    fx = x + (sx + 0.5) / ss
                    fy = y + (sy + 0.5) / ss
                    dx, dy = fx - cx, fy - cy
                    dist = math.hypot(dx, dy)
                    colour = BG

                    # Three rings.
                    for k in (1.0, 0.66, 0.33):
                        r = radius * k
                        edge = abs(dist - r)
                        w = max(1.0, size / 48)
                        if edge < w:
                            colour = _blend(colour, RING, 1 - edge / w)

                    # The sweep: a wedge from 12 o'clock clockwise, fading out.
                    if dist <= radius:
                        ang = (math.degrees(math.atan2(dx, -dy)) + 360) % 360
                        if ang <= 75:
                            colour = _blend(colour, SWEEP, 0.85 * (1 - ang / 75))

                    # Centre dot.
                    core = radius * 0.13
                    if dist < core:
                        colour = _blend(colour, CORE, min(1.0, (core - dist) / max(core * 0.5, 1)))

                    for i in range(3):
                        acc[i] += colour[i]

            n = ss * ss
            o = (y * size + x) * 4
            px[o] = round(acc[0] / n)
            px[o + 1] = round(acc[1] / n)
            px[o + 2] = round(acc[2] / n)
            px[o + 3] = 255
    return _png(size, size, bytes(px))


SVG = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="rgb{BG}"/>
  <g fill="none" stroke="rgb{RING}" stroke-width="2">
    <circle cx="50" cy="50" r="40"/><circle cx="50" cy="50" r="26"/><circle cx="50" cy="50" r="13"/>
  </g>
  <path d="M50 50 L50 10 A40 40 0 0 1 88.6 39.6 Z" fill="rgb{SWEEP}" opacity=".8"/>
  <circle cx="50" cy="50" r="5" fill="rgb{CORE}"/>
</svg>
"""


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "web/icons")
    out.mkdir(parents=True, exist_ok=True)

    for size in (192, 512):
        (out / f"icon-{size}.png").write_bytes(render(size))
    # Android masks this one to its own shape, so the art sits inside a safe zone.
    (out / "icon-512-maskable.png").write_bytes(render(512, maskable=True))
    # iOS uses exactly this file and this name for the home screen.
    (out / "apple-touch-icon.png").write_bytes(render(180))
    (out / "icon.svg").write_text(SVG, encoding="utf-8")

    for f in sorted(out.iterdir()):
        print(f"  {f.name:<26} {f.stat().st_size:>7} B")


if __name__ == "__main__":
    main()
