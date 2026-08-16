"""Dot-to-target matching.

Every dot must claim exactly one target point (a permutation — no target
skipped, none doubled). Two strategies:

- 'exact':   Hungarian algorithm on squared distances (optimal transport-style,
             minimal total travel, no long criss-crossing paths). O(n^3); great
             up to a few thousand dots.
- 'hilbert': sort both point sets along a Hilbert space-filling curve and pair
             by rank. O(n log n), visually near-optimal, works for 100k+ dots.

'auto' picks exact for small n, hilbert for large.
"""

from __future__ import annotations

import numpy as np
from scipy.optimize import linear_sum_assignment
from scipy.spatial.distance import cdist

EXACT_LIMIT = 2600


def hilbert_index(x: np.ndarray, y: np.ndarray, order: int = 10) -> np.ndarray:
    """Vectorized Hilbert curve index for integer coords in [0, 2**order)."""
    x = x.astype(np.int64).copy()
    y = y.astype(np.int64).copy()
    d = np.zeros_like(x)
    s = 1 << (order - 1)
    while s > 0:
        rx = ((x & s) > 0).astype(np.int64)
        ry = ((y & s) > 0).astype(np.int64)
        d += s * s * ((3 * rx) ^ ry)
        # Rotate quadrant contents where ry == 0.
        mask = ry == 0
        flip = mask & (rx == 1)
        xf = np.where(flip, s - 1 - x, x)
        yf = np.where(flip, s - 1 - y, y)
        x, y = np.where(mask, yf, xf), np.where(mask, xf, yf)
        s >>= 1
    return d


def _hilbert_rank(points: np.ndarray, bounds: tuple[float, float, float, float], order: int = 10) -> np.ndarray:
    x0, y0, x1, y1 = bounds
    span = max(x1 - x0, y1 - y0, 1e-9)
    scale = (1 << order) - 1
    xi = np.clip(((points[:, 0] - x0) / span * scale), 0, scale)
    yi = np.clip(((points[:, 1] - y0) / span * scale), 0, scale)
    return np.argsort(hilbert_index(xi, yi, order), kind="stable")


def _morton_spread3(v: np.ndarray) -> np.ndarray:
    """Spread 21-bit integers so their bits occupy every 3rd position."""
    v = v.astype(np.int64)
    v = (v | (v << 32)) & 0x1F00000000FFFF
    v = (v | (v << 16)) & 0x1F0000FF0000FF
    v = (v | (v << 8)) & 0x100F00F00F00F00F
    v = (v | (v << 4)) & 0x10C30C30C30C30C3
    v = (v | (v << 2)) & 0x1249249249249249
    return v


def _morton_rank3(points: np.ndarray, lo: np.ndarray, span: float, order: int = 10) -> np.ndarray:
    scale = (1 << order) - 1
    q = np.clip((points - lo) / span * scale, 0, scale).astype(np.int64)
    code = _morton_spread3(q[:, 0]) | (_morton_spread3(q[:, 1]) << 1) | (_morton_spread3(q[:, 2]) << 2)
    return np.argsort(code, kind="stable")


def match(src: np.ndarray, dst: np.ndarray, method: str = "auto") -> np.ndarray:
    """Return perm such that dot i travels to dst[perm[i]]. perm is a permutation of range(n).

    Accepts 2D (n, 2) or 3D (n, 3) point sets. The curve-rank path uses a
    Hilbert curve in 2D and a Morton (Z-order) curve in 3D.
    """
    n = len(src)
    if len(dst) != n:
        raise ValueError(f"point count mismatch: {n} dots vs {len(dst)} targets")
    if src.shape[1] != dst.shape[1]:
        raise ValueError(f"dimension mismatch: src {src.shape} vs dst {dst.shape}")
    if method == "auto":
        method = "exact" if n <= EXACT_LIMIT else "hilbert"

    if method == "exact":
        cost = cdist(src, dst, "sqeuclidean")
        rows, cols = linear_sum_assignment(cost)
        perm = np.empty(n, dtype=np.int64)
        perm[rows] = cols
        return perm

    if method == "hilbert":
        both = np.vstack([src, dst])
        is_3d = both.shape[1] >= 3 and (both[:, 2].max() - both[:, 2].min()) > 1e-6
        perm = np.empty(n, dtype=np.int64)
        if is_3d:
            lo = both.min(axis=0)
            span = max(float((both.max(axis=0) - lo).max()), 1e-9)
            src_order = _morton_rank3(src, lo, span)
            dst_order = _morton_rank3(dst, lo, span)
        else:
            bounds = (both[:, 0].min(), both[:, 1].min(), both[:, 0].max(), both[:, 1].max())
            src_order = _hilbert_rank(src, bounds)
            dst_order = _hilbert_rank(dst, bounds)
        perm[src_order] = dst_order
        return perm

    raise ValueError(f"unknown match method {method!r}; use 'auto', 'exact', or 'hilbert'")
