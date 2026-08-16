"""Turn images/masks into density maps and well-arranged point sets.

Pipeline: density map -> importance sampling -> weighted Lloyd relaxation.
The relaxation step spreads dots into an even, stipple-like arrangement that
follows the density (dark/bright areas get proportionally more dots) instead
of a noisy random scatter.
"""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageFilter
from scipy.spatial import cKDTree


def _normalize(d: np.ndarray) -> np.ndarray:
    d = np.clip(d.astype(np.float64), 0, None)
    total = d.sum()
    if total <= 0:
        raise ValueError("density map is empty (all zeros) — nothing to sample dots from")
    return d / total


def density_from_image(
    rgb: np.ndarray,
    tone: str = "bright",
    gamma: float = 1.6,
    edges: float = 0.0,
    blur: float = 1.0,
    floor: float = 0.0,
) -> np.ndarray:
    """Build a sampling density from an RGB image.

    tone: 'bright' -> bright pixels get dots (light dots on dark canvas),
          'dark'   -> dark pixels get dots (ink on paper look).
    gamma: contrast on the tone response (higher = punchier separation).
    edges: 0..1 blend weight for an edge-detection layer (outlines).
    blur:  pre-blur in px to suppress pixel noise.
    floor: small constant added everywhere (a faint dust of dots outside the subject).
    """
    gray = np.asarray(Image.fromarray(rgb).convert("L"), dtype=np.float64) / 255.0
    if blur > 0:
        gray = np.asarray(
            Image.fromarray((gray * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(blur)),
            dtype=np.float64,
        ) / 255.0

    val = gray if tone == "bright" else 1.0 - gray
    val = np.clip(val, 0, 1) ** gamma

    if edges > 0:
        try:
            import cv2

            e = cv2.Canny((gray * 255).astype(np.uint8), 60, 160).astype(np.float64) / 255.0
            e = np.asarray(
                Image.fromarray((e * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2)),
                dtype=np.float64,
            ) / 255.0
        except ImportError:
            e = np.asarray(
                Image.fromarray((gray * 255).astype(np.uint8)).filter(ImageFilter.FIND_EDGES),
                dtype=np.float64,
            ) / 255.0
        if e.max() > 0:
            e = e / e.max()
        val = (1 - edges) * val + edges * e

    if floor > 0:
        val = val + floor * max(val.max(), 1e-9)
    return val


def structure_density(rgb: np.ndarray) -> np.ndarray:
    """Density emphasizing *structure* (edges + local contrast) rather than tone.

    Produces near-uniform coverage with extra articulation along contours and
    features — the right base for monochrome 3D point-cloud looks, where depth
    (not brightness) carries the image.
    """
    gray = np.asarray(Image.fromarray(rgb).convert("L"), dtype=np.float64) / 255.0
    h, w = gray.shape
    try:
        import cv2

        sigma = max(2.0, 0.03 * max(h, w))
        lowf = cv2.GaussianBlur(gray, (0, 0), sigma)
        contrast = np.abs(gray - lowf)
        edges = cv2.Canny((gray * 255).astype(np.uint8), 50, 140).astype(np.float64) / 255.0
        edges = cv2.GaussianBlur(edges, (0, 0), 1.6)
    except ImportError:
        blurred = np.asarray(
            Image.fromarray((gray * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(8)),
            dtype=np.float64,
        ) / 255.0
        contrast = np.abs(gray - blurred)
        edges = np.asarray(
            Image.fromarray((gray * 255).astype(np.uint8)).filter(ImageFilter.FIND_EDGES),
            dtype=np.float64,
        ) / 255.0

    if contrast.max() > 0:
        contrast = contrast / contrast.max()
    if edges.max() > 0:
        edges = edges / edges.max()
    layer = np.clip(0.55 * contrast + 0.45 * edges, 0.0, 1.0)
    return 0.30 + 0.70 * layer ** 0.8


def sample_density(density: np.ndarray, n: int, rng: np.random.Generator) -> np.ndarray:
    """Importance-sample n (x, y) points from a 2D density map (pixel units)."""
    p = _normalize(density).ravel()
    idx = rng.choice(p.size, size=n, replace=True, p=p)
    h, w = density.shape
    ys, xs = np.divmod(idx, w)
    pts = np.stack([xs, ys], axis=1).astype(np.float64)
    pts += rng.uniform(0, 1, pts.shape)  # jitter inside the pixel
    return pts


def lloyd_relax(
    points: np.ndarray,
    density: np.ndarray,
    iters: int = 12,
    rng: np.random.Generator | None = None,
    n_samples: int | None = None,
) -> np.ndarray:
    """Weighted Lloyd relaxation: nudge points toward the centroid of the density
    they 'own', producing an even, well-arranged stipple with no clumps or gaps."""
    if iters <= 0:
        return points
    rng = rng or np.random.default_rng(0)
    n = len(points)
    if n_samples is None:
        n_samples = int(min(max(30 * n, 20_000), 120_000))
    samples = sample_density(density, n_samples, rng)

    pts = points.copy()
    for _ in range(iters):
        tree = cKDTree(pts)
        _, owner = tree.query(samples, k=1, workers=-1)
        sums = np.zeros((n, 2), dtype=np.float64)
        counts = np.zeros(n, dtype=np.float64)
        np.add.at(sums, owner, samples)
        np.add.at(counts, owner, 1)
        moved = counts > 0
        pts[moved] = sums[moved] / counts[moved, None]
    return pts


def stipple(
    density: np.ndarray,
    n: int,
    rng: np.random.Generator,
    relax_iters: int = 12,
) -> np.ndarray:
    """Full pipeline: sample n points from density, then relax into a clean arrangement."""
    pts = sample_density(density, n, rng)
    return lloyd_relax(pts, density, iters=relax_iters, rng=rng)
