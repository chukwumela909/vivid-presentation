"""Easing functions. All operate on numpy arrays (or scalars) of progress in [0, 1]."""

from __future__ import annotations

import numpy as np


def linear(p):
    return p


def quad_out(p):
    return 1 - (1 - p) ** 2


def cubic_in_out(p):
    p = np.asarray(p, dtype=np.float64)
    return np.where(p < 0.5, 4 * p**3, 1 - (-2 * p + 2) ** 3 / 2)


def quint_in_out(p):
    p = np.asarray(p, dtype=np.float64)
    return np.where(p < 0.5, 16 * p**5, 1 - (-2 * p + 2) ** 5 / 2)


def expo_out(p):
    p = np.asarray(p, dtype=np.float64)
    return np.where(p >= 1.0, 1.0, 1 - 2.0 ** (-10 * p))


def back_out(p, s: float = 1.70158):
    p = np.asarray(p, dtype=np.float64) - 1.0
    return 1 + p * p * ((s + 1) * p + s)


def elastic_out(p):
    p = np.asarray(p, dtype=np.float64)
    c = (2 * np.pi) / 3
    out = 2.0 ** (-10 * p) * np.sin((p * 10 - 0.75) * c) + 1
    return np.where(p <= 0, 0.0, np.where(p >= 1, 1.0, out))


EASINGS = {
    "linear": linear,
    "quad": quad_out,
    "cubic": cubic_in_out,
    "quint": quint_in_out,
    "expo": expo_out,
    "back": back_out,
    "elastic": elastic_out,
}


def get_easing(name):
    if callable(name):
        return name
    try:
        return EASINGS[name]
    except KeyError:
        raise ValueError(f"unknown easing {name!r}; options: {sorted(EASINGS)}") from None
