"""Layered face-sculpture sampling from MediaPipe mesh landmarks.

A face is not a shell: behind the lips sit teeth, a tongue, and a dark mouth
cavity; behind the eyelids sit eyeballs with iris and pupil. This module
samples all of those as separate tagged dot layers so a renderer can animate
them — jaw opens and reveals teeth instead of a hole, lids sweep down over
eyeballs, pupils look around.

Tags:
  0 skin   1 lipUpper   2 lipLower   3 lidA   4 lidB   5 jaw
  6 browA  7 browB      8 teethUpper 9 teethLower 10 tongue 11 cavity
  12 sclA  13 irisA     14 pupilA    15 sclB   16 irisB    17 pupilB

Mouth-interior layers (8-11) are exported with background color — invisible
while the mouth is closed; the renderer reveals them with mouth openness
using the true values shipped in regions["tagValues"].
"""

from __future__ import annotations

import numpy as np
from PIL import Image

from . import sampling
from .faces import (
    BROW_A, BROW_B, CHIN, EYE_A, EYE_B, FACE_OVAL, IRIS_A, IRIS_B,
    LIPS_INNER_LO, LIPS_INNER_UP, LIPS_OUTER_LO, LIPS_OUTER_UP,
)

TAG_SKIN, TAG_LIPU, TAG_LIPL, TAG_LIDA, TAG_LIDB, TAG_JAW = 0, 1, 2, 3, 4, 5
TAG_BROWA, TAG_BROWB, TAG_TEETHU, TAG_TEETHL, TAG_TONGUE, TAG_CAVITY = 6, 7, 8, 9, 10, 11
TAG_SCLA, TAG_IRISA, TAG_PUPA, TAG_SCLB, TAG_IRISB, TAG_PUPB = 12, 13, 14, 15, 16, 17

HIDDEN_TAGS = (TAG_TEETHU, TAG_TEETHL, TAG_TONGUE, TAG_CAVITY)
TAG_VALUES = {TAG_TEETHU: 0.88, TAG_TEETHL: 0.84, TAG_TONGUE: 0.42, TAG_CAVITY: 0.15}

# Fractions of n reserved for the anatomy layers.
FRAC = {"teethU": 0.035, "teethL": 0.030, "tongue": 0.025, "cavity": 0.020, "eye": 0.030}


def _resample_arc(pts: np.ndarray, m: int) -> np.ndarray:
    """m points evenly spaced (by arclength) along a 3D polyline."""
    seg = np.linalg.norm(np.diff(pts[:, :2], axis=0), axis=1)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    total = max(cum[-1], 1e-9)
    t = np.linspace(0.04, 0.96, m) * total
    out = np.empty((m, pts.shape[1]))
    for c in range(pts.shape[1]):
        out[:, c] = np.interp(t, cum, pts[:, c])
    return out


def _depth_at(depth: np.ndarray, xy: np.ndarray) -> np.ndarray:
    H, W = depth.shape
    xi = np.clip(xy[:, 0].round().astype(int), 0, W - 1)
    yi = np.clip(xy[:, 1].round().astype(int), 0, H - 1)
    return depth[yi, xi]


def _ellipse_disk(rng, m, cx, cy, rx, ry):
    a = rng.uniform(0, 2 * np.pi, m)
    r = np.sqrt(rng.uniform(0, 1, m))
    return np.stack([cx + rx * r * np.cos(a), cy + ry * r * np.sin(a)], axis=1)


def build_layers(rgb: np.ndarray, mesh: dict, mask: np.ndarray, depth: np.ndarray,
                 density: np.ndarray, n: int, rng: np.random.Generator,
                 bg: np.ndarray, fg: np.ndarray, photo: bool = False,
                 relax_iters: int = 9, img_weight: float = 1.0
                 ) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict]:
    """Sample the full layered sculpture.

    Returns (points (n,3) image-px, colors (n,3), tags (n,), regions dict in
    image-px coordinates — caller rescales to canvas).
    """
    import cv2

    H, W = mask.shape
    pts = mesh["points"]
    oval = pts[FACE_OVAL]
    fw = max(float(oval[:, 0].max() - oval[:, 0].min()), 8.0)

    up_in = pts[LIPS_INNER_UP]
    lo_in = pts[LIPS_INNER_LO]
    up_out = pts[LIPS_OUTER_UP]
    lo_out = pts[LIPS_OUTER_LO]
    mouth_c = np.vstack([up_in, lo_in]).mean(axis=0)
    mouth_w = float(np.linalg.norm(pts[291][:2] - pts[61][:2]))

    eyes = {}
    for key, idx, iris_idx in (("A", EYE_A, IRIS_A), ("B", EYE_B, IRIS_B)):
        e = pts[idx]
        cx, cy = float(e[:, 0].mean()), float(e[:, 1].mean())
        rx = max(float(e[:, 0].max() - e[:, 0].min()) / 2, 2.0)
        ry = max(float(e[:, 1].max() - e[:, 1].min()) / 2, 1.5) * 1.25
        ic = pts[iris_idx[0]]
        ir = float(np.mean(np.linalg.norm(pts[iris_idx[1:]][:, :2] - ic[:2], axis=1)))
        if not np.isfinite(ir) or ir < 1.0:
            ir = 0.45 * rx
        eyes[key] = {"cx": cx, "cy": cy, "rx": rx, "ry": ry,
                     "irisX": float(ic[0]), "irisY": float(ic[1]), "irisR": ir,
                     "poly": e[:, :2].astype(np.int32)}

    # ---------------- layer budgets
    n_teethU = max(int(n * FRAC["teethU"]), 20)
    n_teethL = max(int(n * FRAC["teethL"]), 16)
    n_tongue = max(int(n * FRAC["tongue"]), 12)
    n_cavity = max(int(n * FRAC["cavity"]), 10)
    n_eye = max(int(n * FRAC["eye"]), 24)
    n_skin = n - (n_teethU + n_teethL + n_tongue + n_cavity + 2 * n_eye)

    # ---------------- skin: suppress density where eyeballs/mouth interior live
    density = density.copy()
    hole = np.zeros((H, W), np.uint8)
    for key in ("A", "B"):
        e = eyes[key]
        cv2.ellipse(hole, (int(e["cx"]), int(e["cy"])),
                    (int(e["rx"] * 0.85), int(e["ry"] * 0.55)), 0, 0, 360, 1, -1)
    inner_poly = np.vstack([up_in[:, :2], lo_in[::-1][:, :2]]).astype(np.int32)
    cv2.fillPoly(hole, [inner_poly], 1)
    density[hole > 0] *= 0.06

    skin_xy = sampling.stipple(density, n_skin, rng, relax_iters=relax_iters)
    skin_z = _depth_at(depth, skin_xy)
    skin_pts = np.column_stack([skin_xy, skin_z])

    # ---------------- tag skin dots via a label raster
    label = np.zeros((H, W), np.uint8)
    # jaw: oval region below the outer lower lip
    oval_mask = np.zeros((H, W), np.uint8)
    cv2.fillPoly(oval_mask, [oval[:, :2].astype(np.int32)], 1)
    jaw_top = int(lo_out[:, 1].max())
    jaw_zone = oval_mask.copy()
    jaw_zone[:jaw_top, :] = 0
    label[jaw_zone > 0] = TAG_JAW
    # eyelids: expanded eye ellipses
    for key, tag in (("A", TAG_LIDA), ("B", TAG_LIDB)):
        e = eyes[key]
        cv2.ellipse(label, (int(e["cx"]), int(e["cy"])),
                    (int(e["rx"] * 1.45), int(e["ry"] * 1.15)), 0, 0, 360, int(tag), -1)
    # brows: thick polylines
    for idx, tag in ((BROW_A, TAG_BROWA), (BROW_B, TAG_BROWB)):
        bp = pts[idx][:, :2].astype(np.int32)
        cv2.polylines(label, [bp], False, int(tag), thickness=max(3, int(0.055 * fw)))
    # lips: upper and lower polygons (outer arc + reversed inner arc)
    lipU_poly = np.vstack([up_out[:, :2], up_in[::-1][:, :2]]).astype(np.int32)
    lipL_poly = np.vstack([lo_out[:, :2], lo_in[::-1][:, :2]]).astype(np.int32)
    cv2.fillPoly(label, [lipU_poly], int(TAG_LIPU))
    cv2.fillPoly(label, [lipL_poly], int(TAG_LIPL))

    xi = np.clip(skin_xy[:, 0].round().astype(int), 0, W - 1)
    yi = np.clip(skin_xy[:, 1].round().astype(int), 0, H - 1)
    skin_tags = label[yi, xi].astype(np.int64)

    # ---------------- mouth interior layers (hidden while closed)
    def teeth_row(arc_pts, count, dy0, dy1, recess):
        base = _resample_arc(arc_pts, count)
        row = rng.uniform(0, 1, count)
        xy = base[:, :2].copy()
        xy[:, 1] += dy0 + (dy1 - dy0) * row
        xy[:, 0] += rng.uniform(-0.006, 0.006, count) * fw
        z = _depth_at(depth, xy) - recess * fw
        return np.column_stack([xy, z])

    teethU = teeth_row(up_in, n_teethU, 0.008 * fw, 0.030 * fw, 0.050)
    teethL = teeth_row(lo_in, n_teethL, 0.004 * fw, 0.024 * fw, 0.055)

    tong_xy = np.stack([
        rng.normal(mouth_c[0], 0.14 * mouth_w, n_tongue),
        rng.normal(mouth_c[1] + 0.030 * fw, 0.035 * fw, n_tongue),
    ], axis=1)
    tongue = np.column_stack([tong_xy, _depth_at(depth, tong_xy) - 0.085 * fw])

    cav_xy = _ellipse_disk(rng, n_cavity, mouth_c[0], mouth_c[1] + 0.02 * fw,
                           0.42 * mouth_w, 0.05 * fw)
    cavity = np.column_stack([cav_xy, _depth_at(depth, cav_xy) - 0.13 * fw])

    # ---------------- eyeballs: sclera / iris / pupil
    eye_layers = {}
    for key in ("A", "B"):
        e = eyes[key]
        n_pup = max(int(n_eye * 0.15), 4)
        n_iris = max(int(n_eye * 0.35), 8)
        n_scl = n_eye - n_pup - n_iris
        pup = _ellipse_disk(rng, n_pup, e["irisX"], e["irisY"], e["irisR"] * 0.42, e["irisR"] * 0.42)
        a = rng.uniform(0, 2 * np.pi, n_iris)
        rr = e["irisR"] * np.sqrt(rng.uniform(0.20, 1.0, n_iris))
        iris = np.stack([e["irisX"] + rr * np.cos(a), e["irisY"] + rr * 0.9 * np.sin(a)], axis=1)
        scl = _ellipse_disk(rng, n_scl, e["cx"], e["cy"], e["rx"] * 0.88, e["ry"] * 0.52)
        stack = []
        for xy in (scl, iris, pup):
            z = _depth_at(depth, xy) - 0.022 * fw
            stack.append(np.column_stack([xy, z]))
        eye_layers[key] = stack  # [sclera, iris, pupil]

    # ---------------- assemble points + tags
    parts = [
        (skin_pts, skin_tags),
        (teethU, np.full(len(teethU), TAG_TEETHU)),
        (teethL, np.full(len(teethL), TAG_TEETHL)),
        (tongue, np.full(len(tongue), TAG_TONGUE)),
        (cavity, np.full(len(cavity), TAG_CAVITY)),
        (eye_layers["A"][0], np.full(len(eye_layers["A"][0]), TAG_SCLA)),
        (eye_layers["A"][1], np.full(len(eye_layers["A"][1]), TAG_IRISA)),
        (eye_layers["A"][2], np.full(len(eye_layers["A"][2]), TAG_PUPA)),
        (eye_layers["B"][0], np.full(len(eye_layers["B"][0]), TAG_SCLB)),
        (eye_layers["B"][1], np.full(len(eye_layers["B"][1]), TAG_IRISB)),
        (eye_layers["B"][2], np.full(len(eye_layers["B"][2]), TAG_PUPB)),
    ]
    points = np.vstack([p for p, _ in parts])
    tags = np.concatenate([t for _, t in parts]).astype(np.int64)

    # ---------------- colors
    gray = np.asarray(Image.fromarray(rgb).convert("L"), dtype=np.float64) / 255.0
    xi = np.clip(points[:, 0].round().astype(int), 0, W - 1)
    yi = np.clip(points[:, 1].round().astype(int), 0, H - 1)

    if photo:
        colors = rgb[yi, xi].astype(np.float64)
    else:
        v_img = 0.35 + 0.65 * gray[yi, xi] ** 0.85
        # Geometry shading fallback: when the capture angle was bad the photo's
        # lighting lies, but the relief doesn't — blend toward shape-derived
        # values as img_weight drops.
        zr = depth[yi, xi]
        zspan = max(float(np.abs(zr).max()), 1e-6)
        v_geo = 0.38 + 0.42 * np.clip(zr / (0.6 * zspan), -1, 1) * 0.5 + 0.21
        v = img_weight * v_img + (1.0 - img_weight) * v_geo
        colors = bg[None, :] + (fg[None, :] - bg[None, :]) * v[:, None]

    def value_color(v):
        return bg + (fg - bg) * v

    for tag, val in ((TAG_SCLA, 0.85), (TAG_SCLB, 0.85), (TAG_IRISA, 0.50),
                     (TAG_IRISB, 0.50), (TAG_PUPA, 0.12), (TAG_PUPB, 0.12)):
        colors[tags == tag] = value_color(val)

    # Mouth interior: hidden while closed, but if the source expression has
    # parted lips (a smile), keep it proportionally visible at rest so the
    # sculpture matches the face it scanned.
    rest_open = float(np.clip((lo_in[:, 1].mean() - up_in[:, 1].mean()) / (0.10 * fw), 0.0, 1.0))
    for tag in HIDDEN_TAGS:
        colors[tags == tag] = bg + (value_color(TAG_VALUES[tag]) - bg) * (rest_open * 0.85)

    # ---------------- regions metadata (image px; caller rescales)
    regions = {
        "v": 2,
        "faceW": fw,
        "mouth": {
            "cx": float(mouth_c[0]), "cy": float(mouth_c[1]), "w": mouth_w,
            "upperY": float(up_in[:, 1].mean()), "lowerY": float(lo_in[:, 1].mean()),
            "cornerL": [float(pts[61][0]), float(pts[61][1])],
            "cornerR": [float(pts[291][0]), float(pts[291][1])],
            "open": 0.16 * fw,
        },
        "eyeA": {k: eyes["A"][k] for k in ("cx", "cy", "rx", "ry", "irisX", "irisY", "irisR")},
        "eyeB": {k: eyes["B"][k] for k in ("cx", "cy", "rx", "ry", "irisX", "irisY", "irisR")},
        "chinY": float(pts[CHIN][1]),
        "browLift": 0.045 * fw,
        "restOpen": rest_open,
        "tagValues": {str(t): v for t, v in TAG_VALUES.items()},
        "blend": mesh.get("blendshapes", {}),
    }
    return points, colors, tags, regions


def _resample_ring(ring: np.ndarray, k: int) -> np.ndarray:
    """Resample a closed 2D ring to k points, evenly spaced by arc length."""
    closed = np.vstack([ring, ring[:1]])
    seg = np.linalg.norm(np.diff(closed, axis=0), axis=1)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    t = np.linspace(0, cum[-1], k, endpoint=False)
    out = np.empty((k, 2))
    for c in range(2):
        out[:, c] = np.interp(t, cum, closed[:, c])
    return out


def predicted_head_shell(oval: np.ndarray, m: int, rng: np.random.Generator) -> np.ndarray:
    """A human head lofted from the person's own face contour.

    Not a primitive: the scanned (frontalized) face-oval ring — their actual
    jawline and hairline — is swept backward and closed into a cranium whose
    proportions are predicted from the facial measurements (craniofacial
    anthropometry: head depth ~0.92x face width, crown ~1/3 face height above
    the hairline, skull base well above the chin). The sweep's first ring IS
    the face rim at z=0, so the shell meets the face patch with no seam.
    Returns (m, 3) canvas points."""
    cx = float(oval[:, 0].mean())
    fw = max(float(oval[:, 0].max() - oval[:, 0].min()), 8.0)
    y0, y1 = float(oval[:, 1].min()), float(oval[:, 1].max())
    fh = max(y1 - y0, 8.0)
    cy = (y0 + y1) / 2

    ring0 = _resample_ring(oval, 72)

    # Predicted cranial cross-section (what the ring becomes as it sweeps back).
    Cc = np.array([cx, cy - 0.16 * fh])
    rxE, ryE = 0.56 * fw, 0.60 * fh
    zdepth = 0.92 * fw

    d = ring0 - Cc[None, :]
    dn = np.linalg.norm(d, axis=1, keepdims=True)
    dn[dn < 1e-6] = 1.0
    u = d / dn
    r_ell = (rxE * ryE) / np.sqrt((ryE * u[:, 0]) ** 2 + (rxE * u[:, 1]) ** 2)
    ell = Cc[None, :] + u * r_ell[:, None]

    def ring_at(t: float) -> np.ndarray:
        ang = t * np.pi / 2
        w = min(1.0, t * 2.6) ** 0.8          # ring morphs to the cranial section quickly
        ring = ring0 + (ell - ring0) * w
        return Cc[None, :] + (ring - Cc[None, :]) * np.cos(ang), -zdepth * np.sin(ang)

    # Budget: the full loft, plus a dedicated crown fill — the visible band
    # between the hairline and the top of the head must read solid, not scanty.
    m_loft = int(m * 0.60)
    m_crown = m - m_loft

    K = 15
    ts = (np.arange(K) + 0.5) / K
    weights = np.cos(ts * np.pi / 2) + 0.10
    counts = np.maximum((weights / weights.sum() * m_loft).astype(int), 2)
    while counts.sum() > m_loft:
        counts[np.argmax(counts)] -= 1
    while counts.sum() < m_loft:
        counts[np.argmin(counts)] += 1

    pts = []
    for t, cnt in zip(ts, counts):
        ring, z = ring_at(t)
        idx = rng.choice(72, size=cnt, replace=cnt > 72)
        p = np.column_stack([ring[idx], np.full(cnt, z)])
        p += rng.normal(0, 0.012 * fw, p.shape)   # organic jitter
        pts.append(p)

    # Crown fill: early sweep stations, upper-arc ring points only (the
    # forehead-to-crown surface that faces the viewer).
    upper = np.where(ring0[:, 1] < cy - 0.10 * fh)[0]
    if len(upper) == 0:
        upper = np.arange(72)
    if m_crown > 0:
        ts2 = np.linspace(0.05, 0.45, 8)
        per_counts = np.full(len(ts2), m_crown // len(ts2))
        per_counts[: m_crown % len(ts2)] += 1
        for t, cnt in zip(ts2, per_counts):
            if cnt <= 0:
                continue
            ring, z = ring_at(float(t))
            idx = rng.choice(upper, size=int(cnt), replace=int(cnt) > len(upper))
            p = np.column_stack([ring[idx], np.full(int(cnt), z)])
            p += rng.normal(0, 0.014 * fw, p.shape)
            pts.append(p)

    out = np.vstack(pts)
    out = out[out[:, 2] > -0.16 * fw]   # face-only: no back of head
    if len(out) < m:   # never come up short — pad with jittered copies
        extra = out[rng.choice(len(out), size=m - len(out), replace=True)]
        out = np.vstack([out, extra + rng.normal(0, 1.5, extra.shape)])
    return out[:m]


def face_dome(x: np.ndarray, y: np.ndarray, oval: np.ndarray) -> np.ndarray:
    """Shallow forward curvature of the head's face side: zero at the oval rim
    (where the lofted shell starts), gently proud at the center. The facial
    relief rides on top of this."""
    cx = float(oval[:, 0].mean())
    fw = max(float(oval[:, 0].max() - oval[:, 0].min()), 8.0)
    y0, y1 = float(oval[:, 1].min()), float(oval[:, 1].max())
    fh = max(y1 - y0, 8.0)
    cy = (y0 + y1) / 2
    e = 1.0 - ((x - cx) / (0.55 * fw)) ** 2 - ((y - cy) / (0.57 * fh)) ** 2
    return 0.26 * fw * np.sqrt(np.clip(e, 0.0, None))


def rotate_regions(regions: dict, R: np.ndarray, center: np.ndarray) -> dict:
    """Rotate a (canvas-space) regions dict's anchor points with the same
    transform applied to the dot cloud (z approximated at the mid-plane)."""

    def rot(x, y):
        p = (np.array([x, y, 0.0]) - center) @ R.T + center
        return float(p[0]), float(p[1])

    r = dict(regions)
    m = dict(regions["mouth"])
    m["cx"], m["cy"] = rot(m["cx"], m["cy"])
    m["cornerL"] = list(rot(*regions["mouth"]["cornerL"]))
    m["cornerR"] = list(rot(*regions["mouth"]["cornerR"]))
    _, m["upperY"] = rot(regions["mouth"]["cx"], regions["mouth"]["upperY"])
    _, m["lowerY"] = rot(regions["mouth"]["cx"], regions["mouth"]["lowerY"])
    r["mouth"] = m
    for key in ("eyeA", "eyeB"):
        e = dict(regions[key])
        e["cx"], e["cy"] = rot(e["cx"], e["cy"])
        e["irisX"], e["irisY"] = rot(regions[key]["irisX"], regions[key]["irisY"])
        r[key] = e
    _, r["chinY"] = rot(regions["mouth"]["cx"], regions["chinY"])
    return r


def scale_regions(regions: dict, scale: float, off: np.ndarray) -> dict:
    """Rescale a regions dict from image px to canvas coordinates."""
    r = {"v": regions["v"], "faceW": regions["faceW"] * scale,
         "chinY": regions["chinY"] * scale + off[1],
         "browLift": regions["browLift"] * scale,
         "restOpen": regions.get("restOpen", 0.0),
         "tagValues": regions["tagValues"], "blend": regions["blend"]}
    m = regions["mouth"]
    r["mouth"] = {
        "cx": m["cx"] * scale + off[0], "cy": m["cy"] * scale + off[1],
        "w": m["w"] * scale, "open": m["open"] * scale,
        "upperY": m["upperY"] * scale + off[1], "lowerY": m["lowerY"] * scale + off[1],
        "cornerL": [m["cornerL"][0] * scale + off[0], m["cornerL"][1] * scale + off[1]],
        "cornerR": [m["cornerR"][0] * scale + off[0], m["cornerR"][1] * scale + off[1]],
    }
    for key in ("eyeA", "eyeB"):
        e = regions[key]
        r[key] = {
            "cx": e["cx"] * scale + off[0], "cy": e["cy"] * scale + off[1],
            "rx": e["rx"] * scale, "ry": e["ry"] * scale,
            "irisX": e["irisX"] * scale + off[0], "irisY": e["irisY"] * scale + off[1],
            "irisR": e["irisR"] * scale,
        }
    return r
