"""Small shared helpers: colors, fonts, image loading, geometry."""

from __future__ import annotations

import os
import sys

import numpy as np
from PIL import Image, ImageFont


def parse_color(c) -> np.ndarray:
    """Accept '#rgb', '#rrggbb', (r,g,b) 0-255, or grayscale float. Return float array [r,g,b] 0-255."""
    if isinstance(c, str):
        s = c.lstrip("#")
        if len(s) == 3:
            s = "".join(ch * 2 for ch in s)
        if len(s) != 6:
            raise ValueError(f"bad color string: {c!r}")
        return np.array([int(s[i : i + 2], 16) for i in (0, 2, 4)], dtype=np.float64)
    arr = np.asarray(c, dtype=np.float64).ravel()
    if arr.size == 1:
        arr = np.repeat(arr, 3)
    if arr.size != 3:
        raise ValueError(f"bad color: {c!r}")
    return arr


_FONT_CANDIDATES = [
    # macOS
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/HelveticaNeue.ttc",
    "/System/Library/Fonts/SFNS.ttf",
    "/Library/Fonts/Arial.ttf",
    # Linux
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    # Windows
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/arial.ttf",
]


def load_font(size: int, font: str | None = None) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """Load a truetype font at `size`, trying an explicit path/name first, then platform defaults."""
    candidates = ([font] if font else []) + _FONT_CANDIDATES
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default(size)


def load_image_rgb(source) -> np.ndarray:
    """Load an image path / PIL image / array into an RGB uint8 array (H, W, 3)."""
    if isinstance(source, np.ndarray):
        arr = source
        if arr.ndim == 2:
            arr = np.stack([arr] * 3, axis=-1)
        return arr.astype(np.uint8)
    if isinstance(source, Image.Image):
        return np.asarray(source.convert("RGB"))
    if isinstance(source, (str, os.PathLike)):
        with Image.open(source) as im:
            return np.asarray(im.convert("RGB"))
    raise TypeError(f"cannot load image from {type(source)}")


def fit_rect(src_w: float, src_h: float, box_w: float, box_h: float) -> tuple[float, float]:
    """Return (w, h) of src scaled to fit inside box, preserving aspect ratio."""
    scale = min(box_w / src_w, box_h / src_h)
    return src_w * scale, src_h * scale


def progress_line(done: int, total: int, label: str) -> None:
    pct = int(100 * done / max(total, 1))
    sys.stdout.write(f"\r{label}: {pct:3d}% ({done}/{total})")
    sys.stdout.flush()
    if done >= total:
        sys.stdout.write("\n")
