"""FLAME statistical head model integration (template-based).

FLAME (Faces Learned with an Articulated Model and Expressions, MPI) is the
reference statistical 3D head model — a true human head learned from thousands
of scans: cranium, occiput, jawline, ears. dotlib uses its neutral template
surface as the head shell that carries the scanned face patch.

The model file is LICENSE-GATED and cannot ship with dotlib:
  1. Register (free) at https://flame.is.tue.mpg.de
  2. Download "FLAME 2023" and unzip
  3. Put flame2023.pkl at models/flame/flame2023.pkl
     (or set DOTLIB_FLAME_MODEL to its path)

Only `v_template` and `f` are read — plain pickle + numpy, no torch — which
is exactly what's needed for the neutral head surface. (Older FLAME releases
store chumpy arrays; the 2023 file is numpy-native. Shape/expression fitting
via torch+smplx is a future, optional upgrade.)

Check your setup:  python -m dotlib.flamehead
"""

from __future__ import annotations

import os
import pickle

import numpy as np

_TEMPLATE: dict | None = None
_TEMPLATE_FAILED = False

_CANDIDATE_NAMES = (
    "flame2023.pkl", "flame2023_Open.pkl", "flame2023_no_jaw.pkl",
    "generic_model.pkl", "FLAME2020_generic.pkl", "male_model.pkl", "female_model.pkl",
)


def _candidate_paths() -> list[str]:
    roots = [
        os.environ.get("DOTLIB_FLAME_MODEL", ""),
        *[os.path.join(os.getcwd(), "models", "flame", n) for n in _CANDIDATE_NAMES],
        *[os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models", "flame", n)
          for n in _CANDIDATE_NAMES],
    ]
    return [p for p in roots if p]


def load_template() -> dict | None:
    """{'verts': (V, 3) float64, 'faces': (F, 3) int64} or None if the model
    file is absent/unreadable. Cached after first load."""
    global _TEMPLATE, _TEMPLATE_FAILED
    if _TEMPLATE is not None:
        return _TEMPLATE
    if _TEMPLATE_FAILED:
        return None
    for path in _candidate_paths():
        if not os.path.exists(path):
            continue
        try:
            with open(path, "rb") as fh:
                data = pickle.load(fh, encoding="latin1")
            verts = np.array(data["v_template"], dtype=np.float64)
            faces = np.array(data["f"], dtype=np.int64)
            if verts.ndim == 2 and verts.shape[1] == 3 and faces.ndim == 2 and faces.shape[1] == 3:
                _TEMPLATE = {"verts": verts, "faces": faces, "path": path}
                return _TEMPLATE
        except Exception:
            continue
    _TEMPLATE_FAILED = True
    return None


def available() -> bool:
    return load_template() is not None


def _sample_surface(verts: np.ndarray, faces: np.ndarray, m: int,
                    rng: np.random.Generator) -> np.ndarray:
    """Area-weighted uniform sampling of m points on a triangle mesh."""
    tri = verts[faces]                                   # (F, 3, 3)
    cross = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    area = 0.5 * np.linalg.norm(cross, axis=1)
    p = area / area.sum()
    idx = rng.choice(len(faces), size=m, p=p)
    a, b = rng.uniform(0, 1, (2, m))
    swap = a + b > 1
    a[swap], b[swap] = 1 - a[swap], 1 - b[swap]
    t = tri[idx]
    return t[:, 0] + (t[:, 1] - t[:, 0]) * a[:, None] + (t[:, 2] - t[:, 0]) * b[:, None]


def head_shell(oval: np.ndarray, m: int, rng: np.random.Generator) -> np.ndarray | None:
    """Sample m dots on the FLAME neutral head, aligned to the frontalized
    face oval (canvas coords, y down), with the front face cap culled so the
    scanned face patch mounts there. None when the model file is absent."""
    tpl = load_template()
    if tpl is None or m <= 0:
        return None
    verts, faces = tpl["verts"], tpl["faces"]

    cx = float(oval[:, 0].mean())
    fw = max(float(oval[:, 0].max() - oval[:, 0].min()), 8.0)
    y0, y1 = float(oval[:, 1].min()), float(oval[:, 1].max())
    fh = max(y1 - y0, 8.0)
    cy = (y0 + y1) / 2

    # FLAME axes: x right, y up, z forward (face looks +z), meters.
    # Estimate the template's own face-region frame from its front band.
    vz = verts[:, 2]
    front = verts[vz > vz.min() + 0.80 * (vz.max() - vz.min())]
    t_face_cy = float(front[:, 1].mean())
    t_face_cx = float(front[:, 0].mean())
    t_width = float(verts[:, 0].max() - verts[:, 0].min())

    # Scale: full head width ≈ 1.30x face-oval width. Flip y (canvas is y-down).
    s = (1.30 * fw) / t_width
    pts = np.empty((len(verts), 3))
    pts[:, 0] = (verts[:, 0] - t_face_cx) * s + cx
    pts[:, 1] = -(verts[:, 1] - t_face_cy) * s + cy - 0.02 * fh
    pts[:, 2] = (verts[:, 2] - float(front[:, 2].mean())) * s + 0.20 * fw

    # Cull the front face cap (the scanned patch replaces it), anything below
    # the chin (no neck), and the entire back of the head — the sculpture is
    # the FACE with a shallow front shell (crown, temples, cheeks), not a skull.
    # Those culls discard most of the head, so oversample ADAPTIVELY: a fixed
    # small factor would leave the shell mostly jittered duplicates.
    def cull(s: np.ndarray) -> np.ndarray:
        in_oval = (((s[:, 0] - cx) / (0.56 * fw)) ** 2
                   + ((s[:, 1] - cy) / (0.58 * fh)) ** 2) < 1.0
        cap = in_oval & (s[:, 2] > -0.06 * fw)
        below_chin = s[:, 1] > y1 + 0.06 * fh
        behind = s[:, 2] < -0.16 * fw
        return s[~(cap | below_chin | behind)]

    keep = np.empty((0, 3))
    budget = int(m * 4) + 256
    for _ in range(6):
        keep = np.vstack([keep, cull(_sample_surface(pts, faces, budget, rng))])
        if len(keep) >= m:
            break
        budget = min(budget * 2, 400_000)

    if len(keep) == 0:          # degenerate framing — let the caller fall back
        return None
    if len(keep) < m:
        extra = keep[rng.choice(len(keep), size=m - len(keep), replace=True)]
        keep = np.vstack([keep, extra + rng.normal(0, 1.5, extra.shape)])
    idx = rng.choice(len(keep), size=m, replace=False)
    out = keep[idx]
    out += rng.normal(0, 0.006 * fw, out.shape)          # organic jitter
    return out


if __name__ == "__main__":
    tpl = load_template()
    if tpl is None:
        print("FLAME: model file NOT found.")
        print("  1. Register (free): https://flame.is.tue.mpg.de")
        print("  2. Download 'FLAME 2023', unzip")
        print("  3. Place flame2023.pkl at models/flame/flame2023.pkl")
        print("     (or export DOTLIB_FLAME_MODEL=/path/to/flame2023.pkl)")
        print(f"  Searched: {', '.join(_candidate_paths()[:3])} ...")
    else:
        v, f = tpl["verts"], tpl["faces"]
        print(f"FLAME: OK — {tpl['path']}")
        print(f"  {len(v)} vertices, {len(f)} triangles; "
              f"head width {v[:, 0].max() - v[:, 0].min():.3f}m")
