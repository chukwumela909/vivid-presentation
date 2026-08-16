"""dotlib web demo server.

Serves the camera page and exposes the dotlib pipeline over three endpoints:

- POST /api/scan      camera frame (+ current dot positions) -> face-detect,
                      head-segment, depth, stipple, assign -> morph timeline
- POST /api/target    morph the field into a word, a shape, or back into the
                      last scanned face (kind: text | shape | face)
- POST /api/disperse  current dot positions -> disperse timeline
                      (style: drift | fill | explode; fill floods the viewport)

Face responses also carry per-dot region tags (mouth / eyes / jaw) plus the
region geometry, so the browser can puppet expressions — talking mouth,
blinking, cursor-following pupils — locally at 60fps on top of the replayed
timeline. The browser stays a thin replayer; all particle math lives here.

Run:  .venv/bin/python web/server.py          (http://127.0.0.1:5177)
Optional: DOTWEB_SAMPLE=/path/to/portrait.jpg enables a no-camera demo button.
"""

from __future__ import annotations

import base64
import io
import os
import sys
import time

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import dotlib as dl
from dotlib import faces as F

from flask import Flask, jsonify, request

SAMPLE = os.environ.get("DOTWEB_SAMPLE") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "sample.jpg"
)

app = Flask(__name__, static_folder="static", static_url_path="/static")

MAX_N = 6000
MAX_SIDE = 640
FACE_SWAY = 0.0    # no auto-tilt: the user rotates the head (drag / cursor)

SHAPES = {
    "heart": dl.heart,
    "star": dl.star,
    "ring": dl.ring,
    "spiral": dl.spiral,
    "polygon": dl.polygon,
    "circle": dl.circle,
}

_last_rgb: np.ndarray | None = None   # most recent scanned frame (single local user)


def _decode_data_url(data_url: str) -> np.ndarray:
    _, _, b64 = data_url.partition(",")
    img = Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")
    return np.asarray(img)


def _downscale(rgb: np.ndarray, max_side: int = MAX_SIDE) -> np.ndarray:
    h, w = rgb.shape[:2]
    s = max_side / max(h, w)
    if s >= 1.0:
        return rgb
    img = Image.fromarray(rgb).resize((int(w * s), int(h * s)), Image.Resampling.LANCZOS)
    return np.asarray(img)


def _field_from_body(body: dict) -> dl.DotField:
    n = int(np.clip(int(body.get("n", 3200)), 200, MAX_N))
    size = body.get("size", [840, 840])
    field = dl.DotField(n=n, size=(int(size[0]), int(size[1])), seed=7, dot_radius=1.5)
    pos = body.get("positions")
    if pos is not None and len(pos) == n:
        field.set_positions(np.asarray(pos, dtype=np.float64))
    return field


def _face_regions(box: list[float]) -> dict:
    """Feature ellipses (canvas coords) from a detected face box — heuristic
    bands that hold up well for frontal Haar boxes."""
    x, y, w, h = box
    return {
        "eyeL": {"cx": x + 0.30 * w, "cy": y + 0.37 * h, "rx": 0.15 * w, "ry": 0.10 * h},
        "eyeR": {"cx": x + 0.70 * w, "cy": y + 0.37 * h, "rx": 0.15 * w, "ry": 0.10 * h},
        "mouth": {"cx": x + 0.50 * w, "cy": y + 0.72 * h, "rx": 0.25 * w, "ry": 0.115 * h},
        "face": {"cx": x + 0.50 * w, "cy": y + 0.52 * h, "rx": 0.64 * w, "ry": 0.76 * h},
    }


def _region_tags(points: np.ndarray, regions: dict) -> list[int]:
    """Per-dot region tag from final positions: 0 none, 1 mouth, 2 eyeL, 3 eyeR, 4 jaw."""

    def inside(e):
        return (((points[:, 0] - e["cx"]) / e["rx"]) ** 2
                + ((points[:, 1] - e["cy"]) / e["ry"]) ** 2) <= 1.0

    tags = np.zeros(len(points), dtype=int)
    tags[inside(regions["mouth"])] = 1
    tags[inside(regions["eyeL"])] = 2
    tags[inside(regions["eyeR"])] = 3
    jaw = (inside(regions["face"])
           & (points[:, 1] > regions["mouth"]["cy"] + regions["mouth"]["ry"] * 0.7)
           & (tags == 0))
    tags[jaw] = 4
    return tags.tolist()


def _face_response(rgb: np.ndarray, body: dict, live: bool, t_start: float):
    try:
        found = F.detect_faces(rgb)
    except Exception as exc:
        return jsonify({"ok": False, "error": f"detector_unavailable: {exc}"})
    if not found:
        return jsonify({"ok": False, "error": "no_face"})

    pose = F.head_pose(rgb, F.largest_face(found))

    field = _field_from_body(body)
    # "structure" (default): monochrome 3D bust — contour+tone density, depth
    # from the segmented head. "photo": colored stipple with depth.
    mode = body.get("mode", "structure")
    spec = dl.face(
        rgb,
        color=(mode == "photo"),
        structure=(mode != "photo"),
        depth=True,
        relax=(5 if live else 9),
    )
    field.morph_to(
        spec,
        duration=(0.95 if live else 1.8),
        stagger=(0.12 if live else 0.3),
        drift=1.0,        # livelier hold
        spin=0.0,
        sway=FACE_SWAY,
        match_method="hilbert",
    )

    regions, tags = None, None
    meta_t = field.last_target_meta or {}
    if field.last_target_tags is not None and meta_t.get("regions"):
        # v2: landmark-true layered regions + per-dot tags from the library.
        regions = meta_t["regions"]
        tags = np.asarray(field.last_target_tags).tolist()
    elif meta_t.get("face_box"):
        # v1 fallback: heuristic ellipse bands from the face box.
        regions = {"v": 1, **_face_regions(meta_t["face_box"])}
        tags = _region_tags(field.segments[-1].p1, regions)

    blend = (regions or {}).get("blend", {})
    return jsonify({
        "ok": True,
        "timeline": field.timeline_dict(),
        "regions": regions,
        "tags": tags,
        "meta": {
            "pose": pose,
            "faces": len(found),
            "live": live,
            "elapsed": round(time.time() - t_start, 3),
            "expression": {k: blend[k] for k in
                           ("jawOpen", "mouthSmileLeft", "mouthSmileRight",
                            "eyeBlinkLeft", "eyeBlinkRight")
                           if k in blend},
        },
    })


@app.get("/")
def index():
    return app.send_static_file("index.html")


@app.get("/api/health")
def health():
    try:
        import cv2  # noqa: F401

        has_cv = True
    except ImportError:
        has_cv = False
    from dotlib import flamehead

    return jsonify({
        "ok": True,
        "opencv": has_cv,
        "mediapipe": F._try_mediapipe() is not None,
        "flame": flamehead.available(),
        "sample": os.path.exists(SAMPLE),
        "version": dl.__version__,
    })


@app.post("/api/scan")
def scan():
    global _last_rgb
    t_start = time.time()
    body = request.get_json(force=True, silent=True) or {}
    live = bool(body.get("live", False))

    if body.get("sample"):
        if not os.path.exists(SAMPLE):
            return jsonify({"ok": False, "error": "no_sample"})
        rgb = np.asarray(Image.open(SAMPLE).convert("RGB"))
    elif body.get("image"):
        try:
            rgb = _decode_data_url(body["image"])
        except Exception:
            return jsonify({"ok": False, "error": "bad_image"})
    else:
        return jsonify({"ok": False, "error": "no_image"})

    rgb = _downscale(rgb)
    _last_rgb = rgb
    return _face_response(rgb, body, live, t_start)


@app.post("/api/target")
def target():
    t_start = time.time()
    body = request.get_json(force=True, silent=True) or {}
    kind = body.get("kind", "text")

    if kind == "face":
        rgb = _last_rgb
        if rgb is None and os.path.exists(SAMPLE):
            rgb = _downscale(np.asarray(Image.open(SAMPLE).convert("RGB")))
        if rgb is None:
            return jsonify({"ok": False, "error": "no_face_yet"})
        return _face_response(rgb, body, bool(body.get("live")), t_start)

    field = _field_from_body(body)
    if kind == "text":
        word = str(body.get("text") or "HELLO").strip()[:24] or "HELLO"
        spec, name, sway = dl.text(word), f"text:{word}", 0.18
    elif kind == "shape":
        shape = body.get("shape", "heart")
        if shape not in SHAPES:
            return jsonify({"ok": False, "error": "bad_shape"})
        spec, name, sway = SHAPES[shape](), shape, 0.30
    else:
        return jsonify({"ok": False, "error": "bad_kind"})

    field.morph_to(spec, duration=1.6, stagger=0.3, drift=0.9,
                   spin=0.0, sway=sway, match_method="hilbert")
    return jsonify({
        "ok": True,
        "timeline": field.timeline_dict(),
        "regions": None,
        "tags": None,
        "meta": {"kind": kind, "name": name, "elapsed": round(time.time() - t_start, 3)},
    })


@app.post("/api/disperse")
def disperse():
    body = request.get_json(force=True, silent=True) or {}
    style = body.get("style", "fill")
    if style not in ("drift", "fill", "explode"):
        return jsonify({"ok": False, "error": "bad_style"})
    field = _field_from_body(body)
    field.disperse(duration=1.5, style=style, spin=0.0, sway=0.08)
    return jsonify({"ok": True, "timeline": field.timeline_dict()})


if __name__ == "__main__":
    print(f"dotlib web demo on http://127.0.0.1:5177  (sample: {os.path.exists(SAMPLE)})")
    app.run(host="127.0.0.1", port=5177, debug=False, threaded=True)
