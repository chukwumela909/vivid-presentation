"""Rendering: 3D dots -> perspective projection -> PIL frames -> GIF / MP4 / PNGs.

Dots are projected with a simple pinhole camera on the +z axis (z toward the
viewer): closer dots draw larger and brighter, farther dots smaller and
dimmer, and drawing runs far-to-near (painter's order). Frames are drawn
supersampled then downscaled for smooth antialiased dots. Per-dot alpha is
applied by blending dot colors toward the background, which is exact on a
solid background and keeps the renderer dependency-light.
"""

from __future__ import annotations

import os

import numpy as np
from PIL import Image, ImageDraw

# Depth-shading range: brightness factor spans [1-DEPTH_SHADE, 1+DEPTH_SHADE*0.35]
# across the visible depth range.
DEPTH_SHADE = 0.45


def project(positions: np.ndarray, size: tuple[int, int], camera: float
            ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Perspective-project (n, 3) world points.

    Returns (xy (n, 2) screen coords, scale (n,) perspective factors, z (n,)).
    Points with z >= ~camera are clamped rather than flipped.
    """
    cx, cy = size[0] / 2.0, size[1] / 2.0
    z = np.clip(positions[:, 2], -4.0 * camera, 0.82 * camera)
    s = camera / (camera - z)
    xy = np.empty((len(positions), 2))
    xy[:, 0] = cx + (positions[:, 0] - cx) * s
    xy[:, 1] = cy + (positions[:, 1] - cy) * s
    return xy, s, z


def render_frame(
    positions: np.ndarray,
    colors: np.ndarray,
    radii: np.ndarray,
    size: tuple[int, int],
    bg: np.ndarray,
    alpha: float = 1.0,
    supersample: int = 2,
    camera: float | None = None,
) -> Image.Image:
    ss = max(int(supersample), 1)
    w, h = size
    if camera is None:
        camera = 2.4 * min(w, h)

    if positions.shape[1] == 2:  # tolerate legacy 2D input
        positions = np.hstack([positions, np.zeros((len(positions), 1))])

    xy, persp, z = project(positions, size, camera)

    # Depth shading against a FIXED reference range (not the per-frame z
    # min/max): flat formations stay uniformly lit and morphs between deep and
    # flat targets don't pump brightness.
    zref = 0.22 * min(w, h)
    znorm = np.clip(z / zref, -1.0, 1.0)                 # -1 far .. +1 near
    shade = 1.0 + znorm * DEPTH_SHADE * np.where(znorm > 0, 0.35, 1.0)

    a = float(np.clip(alpha, 0.0, 1.0))
    blended = bg[None, :] + (colors - bg[None, :]) * (a * shade[:, None])
    blended = np.clip(blended, 0, 255).astype(np.uint8)

    img = Image.new("RGB", (w * ss, h * ss), tuple(int(v) for v in bg))
    draw = ImageDraw.Draw(img)

    order = np.argsort(z, kind="stable")                 # far first
    xs = xy[:, 0] * ss
    ys = xy[:, 1] * ss
    rs = np.asarray(radii, dtype=np.float64) * persp * ss
    for i in order:
        x, y, r = xs[i], ys[i], rs[i]
        c = blended[i]
        draw.ellipse([x - r, y - r, x + r, y + r], fill=(int(c[0]), int(c[1]), int(c[2])))

    if ss > 1:
        img = img.resize((w, h), Image.Resampling.LANCZOS)
    return img


def save_frames(frames, path: str, fps: int = 30) -> str:
    """Consume an iterable of PIL images into .gif, .mp4/.mov/.webm, or a PNG directory."""
    lower = path.lower()
    if lower.endswith(".gif"):
        it = iter(frames)
        first = next(it)
        rest = list(it)
        first.save(
            path, save_all=True, append_images=rest,
            duration=max(int(round(1000 / fps)), 20), loop=0, optimize=True,
        )
        return path

    if lower.endswith((".mp4", ".mov", ".webm", ".mkv")):
        try:
            import imageio.v2 as imageio
        except ImportError as exc:
            raise ImportError(
                "video export needs imageio + imageio-ffmpeg. Install with: pip install 'dotlib[video]'"
            ) from exc
        writer = imageio.get_writer(path, fps=fps, quality=8)
        for frame in frames:
            writer.append_data(np.asarray(frame))
        writer.close()
        return path

    # Otherwise treat as a directory for a PNG sequence.
    os.makedirs(path, exist_ok=True)
    for i, frame in enumerate(frames):
        frame.save(os.path.join(path, f"frame_{i:05d}.png"))
    return path
