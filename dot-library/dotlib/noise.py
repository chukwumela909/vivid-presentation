"""Smooth per-dot drift so the field feels alive.

Each dot gets an independent, smooth, bounded 3D offset built from two
incommensurate sinusoids per axis with random phases/frequencies. It is a pure
function of absolute time, so drift stays continuous across timeline segments.
"""

from __future__ import annotations

import numpy as np


class Drift:
    def __init__(self, n: int, rng: np.random.Generator, speed: float = 1.0):
        two_pi = 2 * np.pi
        self.w1 = rng.uniform(0.25, 0.6, (n, 3)) * two_pi * speed
        self.w2 = rng.uniform(0.7, 1.3, (n, 3)) * two_pi * speed
        self.p1 = rng.uniform(0, two_pi, (n, 3))
        self.p2 = rng.uniform(0, two_pi, (n, 3))
        # Normalize so a unit amplitude gives offsets roughly in [-1, 1].
        self._scale = 1.0 / 1.6

    def __call__(self, t: float) -> np.ndarray:
        """Unit-amplitude offsets at absolute time t, shape (n, 3)."""
        return (np.sin(self.w1 * t + self.p1) + 0.6 * np.sin(self.w2 * t + self.p2)) * self._scale
