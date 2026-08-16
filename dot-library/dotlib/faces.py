"""Face-aware detection, segmentation, and head pose (optional extras).

Detector backends, picked automatically:

- Haar cascades (OpenCV 4.x): bundled with the wheel, works offline. This is
  the default — the `face` extra pins opencv-python<5 for exactly this reason.
- YuNet / FaceDetectorYN (OpenCV 5.x): needs a model file. Point the
  DOTLIB_YUNET_MODEL env var at a downloaded
  `face_detection_yunet_2023mar.onnx` (from the opencv_zoo repo) to use it;
  its landmarks give even better eye/mouth emphasis.
- MediaPipe (optional, `pip install mediapipe`): when importable it upgrades
  two things automatically — person segmentation (cleaner head isolation than
  GrabCut) and full yaw/pitch/roll head pose from 468 face landmarks.

Three public capabilities:

- detect_faces(rgb)            -> face boxes (+ landmarks on capable backends)
- face_boost_map(rgb)          -> density multiplier emphasizing faces/features
- segment_head(rgb)            -> soft 0..1 mask isolating just the head
- head_pose(rgb)               -> {yaw, pitch, roll, backend} (degrees, None if unknown)
"""

from __future__ import annotations

import os
import warnings

import numpy as np


class Face:
    """A detected face: bounding box plus optional landmark points."""

    def __init__(self, box: tuple[int, int, int, int], landmarks: np.ndarray | None = None):
        self.box = box               # (x, y, w, h)
        self.landmarks = landmarks   # (5, 2): right eye, left eye, nose, mouth-r, mouth-l


def _require_cv2():
    try:
        import cv2

        return cv2
    except ImportError as exc:
        raise ImportError(
            "face-aware targets need opencv-python. Install with: pip install 'dotlib[face]'"
        ) from exc


# --------------------------------------------------------------- detection

def _detect_haar(cv2, rgb: np.ndarray) -> list[Face]:
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    gray = cv2.equalizeHist(gray)
    path = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
    cascade = cv2.CascadeClassifier(path)
    if cascade.empty():
        raise RuntimeError(f"failed to load OpenCV haarcascade at {path}")
    boxes = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(48, 48))
    return [Face(tuple(map(int, b))) for b in boxes]


def _detect_yunet(cv2, rgb: np.ndarray, model_path: str) -> list[Face]:
    h, w = rgb.shape[:2]
    det = cv2.FaceDetectorYN_create(model_path, "", (w, h), 0.7)
    det.setInputSize((w, h))
    _, results = det.detect(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
    faces = []
    if results is not None:
        for row in results:
            box = tuple(int(v) for v in row[:4])
            landmarks = row[4:14].reshape(5, 2).astype(np.float64)
            faces.append(Face(box, landmarks))
    return faces


def detect_faces(rgb: np.ndarray) -> list[Face]:
    """Detect faces — MediaPipe mesh when available (precise box + landmarks),
    else whichever OpenCV backend this build supports."""
    mesh = mesh_scan(rgb)
    if mesh is not None:
        return [face_from_mesh(mesh)]

    cv2 = _require_cv2()
    if hasattr(cv2, "CascadeClassifier"):
        return _detect_haar(cv2, rgb)

    model = os.environ.get("DOTLIB_YUNET_MODEL", "")
    if hasattr(cv2, "FaceDetectorYN_create") and model and os.path.exists(model):
        return _detect_yunet(cv2, rgb, model)

    raise RuntimeError(
        "this OpenCV build has no usable face detector. Either install the 4.x line "
        "(pip install 'opencv-python>=4.8,<5', which bundles Haar cascades) or set "
        "DOTLIB_YUNET_MODEL to a downloaded face_detection_yunet_2023mar.onnx."
    )


def largest_face(faces: list[Face]) -> Face | None:
    return max(faces, key=lambda f: f.box[2] * f.box[3]) if faces else None


def face_from_mesh(mesh: dict) -> Face:
    """Build a Face (box + 5-pt landmarks) from a mesh_scan result."""
    pts = mesh["points"]
    oval = pts[FACE_OVAL]
    x0, y0 = float(oval[:, 0].min()), float(oval[:, 1].min())
    x1, y1 = float(oval[:, 0].max()), float(oval[:, 1].max())
    five = np.array([
        pts[EYE_A][:, :2].mean(axis=0),
        pts[EYE_B][:, :2].mean(axis=0),
        pts[NOSE_TIP][:2],
        pts[61][:2],
        pts[291][:2],
    ], dtype=np.float64)
    return Face((int(x0), int(y0), int(x1 - x0), int(y1 - y0)), five)


# --------------------------------------------------------------- mediapipe (optional)

_LANDMARKER = None
_LANDMARKER_FAILED = False

# Canonical MediaPipe face-mesh index sets (478-landmark model with iris).
FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365,
             379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93,
             234, 127, 162, 21, 54, 103, 67, 109]
LIPS_OUTER_UP = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291]
LIPS_INNER_UP = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308]
LIPS_OUTER_LO = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291]
LIPS_INNER_LO = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308]
EYE_A = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]
EYE_B = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398]
IRIS_A = [468, 469, 470, 471, 472]          # center first
IRIS_B = [473, 474, 475, 476, 477]
BROW_A = [70, 63, 105, 66, 107]
BROW_B = [336, 296, 334, 293, 300]
CHIN = 152
NOSE_TIP = 1


def _try_mediapipe():
    try:
        import mediapipe as mp

        return mp
    except Exception:
        return None


def _find_model(filename: str, env_var: str) -> str | None:
    candidates = [
        os.environ.get(env_var, ""),
        os.path.join(os.getcwd(), "models", filename),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models", filename),
    ]
    for path in candidates:
        if path and os.path.exists(path):
            return path
    return None


def _find_landmarker_model() -> str | None:
    return _find_model("face_landmarker.task", "DOTLIB_LANDMARKER_MODEL")


def mesh_scan(rgb: np.ndarray) -> dict | None:
    """Run the MediaPipe FaceLandmarker (Tasks API) on an RGB frame.

    Returns {"points": (478, 3) float px  (+z toward the viewer),
             "blendshapes": {name: score}  (52 expression coefficients),
             "matrix": (4, 4) facial transformation matrix}
    or None when mediapipe / the .task model / a face is unavailable.
    Model file: models/face_landmarker.task (or DOTLIB_LANDMARKER_MODEL).
    """
    global _LANDMARKER, _LANDMARKER_FAILED
    if _LANDMARKER_FAILED:
        return None
    mp = _try_mediapipe()
    model = _find_landmarker_model()
    if mp is None or model is None:
        return None
    try:
        if _LANDMARKER is None:
            from mediapipe.tasks import python as mp_python
            from mediapipe.tasks.python import vision

            _LANDMARKER = vision.FaceLandmarker.create_from_options(
                vision.FaceLandmarkerOptions(
                    base_options=mp_python.BaseOptions(
                        model_asset_path=model,
                        delegate=mp_python.BaseOptions.Delegate.CPU,
                    ),
                    output_face_blendshapes=True,
                    output_facial_transformation_matrixes=True,
                    num_faces=1,
                )
            )
        res = _LANDMARKER.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)))
    except Exception:
        _LANDMARKER_FAILED = True   # e.g. broken wheel — don't retry every frame
        return None
    if not res.face_landmarks:
        return None
    h, w = rgb.shape[:2]
    lm = res.face_landmarks[0]
    # mediapipe z is negative toward the camera; dotlib uses +z toward viewer.
    points = np.array([[p.x * w, p.y * h, -p.z * w] for p in lm], dtype=np.float64)
    blend = {}
    if res.face_blendshapes:
        blend = {b.category_name: round(float(b.score), 4) for b in res.face_blendshapes[0]}
    matrix = None
    if res.facial_transformation_matrixes:
        matrix = np.array(res.facial_transformation_matrixes[0], dtype=np.float64)
    return {"points": points, "blendshapes": blend, "matrix": matrix}


def mediapipe_landmarks(rgb: np.ndarray) -> np.ndarray | None:
    """(478, 2) pixel-space landmarks via the Tasks API, or None."""
    mesh = mesh_scan(rgb)
    return None if mesh is None else mesh["points"][:, :2]


_SEGMENTER = None
_SEGMENTER_FAILED = False

# selfie_multiclass categories
CAT_BG, CAT_HAIR, CAT_BODY_SKIN, CAT_FACE_SKIN, CAT_CLOTHES, CAT_OTHER = 0, 1, 2, 3, 4, 5


def person_classes(rgb: np.ndarray) -> np.ndarray | None:
    """Per-pixel person-part categories (H, W) uint8 from MediaPipe's
    selfie-multiclass segmenter: 0 bg, 1 hair, 2 body-skin, 3 face-skin,
    4 clothes, 5 other. None when the model/wheel is unavailable.
    Model file: models/selfie_multiclass_256x256.tflite (DOTLIB_SEGMENTER_MODEL)."""
    global _SEGMENTER, _SEGMENTER_FAILED
    if _SEGMENTER_FAILED:
        return None
    mp = _try_mediapipe()
    model = _find_model("selfie_multiclass_256x256.tflite", "DOTLIB_SEGMENTER_MODEL")
    if mp is None or model is None:
        return None
    try:
        if _SEGMENTER is None:
            from mediapipe.tasks import python as mp_python
            from mediapipe.tasks.python import vision

            _SEGMENTER = vision.ImageSegmenter.create_from_options(
                vision.ImageSegmenterOptions(
                    base_options=mp_python.BaseOptions(
                        model_asset_path=model,
                        delegate=mp_python.BaseOptions.Delegate.CPU,
                    ),
                    output_category_mask=True,
                )
            )
        res = _SEGMENTER.segment(mp.Image(image_format=mp.ImageFormat.SRGB,
                                          data=np.ascontiguousarray(rgb)))
    except Exception:
        _SEGMENTER_FAILED = True
        return None
    if res.category_mask is None:
        return None
    cat = np.asarray(res.category_mask.numpy_view())
    return cat.reshape(cat.shape[0], cat.shape[1]).astype(np.uint8)


# --------------------------------------------------------------- head segmentation

def _head_rect(face: Face, shape: tuple[int, int]) -> tuple[int, int, int, int]:
    """Rectangle around the whole head: hair above, chin below, ears both sides."""
    H, W = shape
    x, y, w, h = face.box
    x0 = max(0, int(x - 0.50 * w))
    y0 = max(0, int(y - 0.85 * h))
    x1 = min(W, int(x + w + 0.50 * w))
    y1 = min(H, int(y + h + 0.60 * h))
    return x0, y0, x1, y1


def _soft_window(shape: tuple[int, int], rect: tuple[int, int, int, int], sigma_frac: float = 0.07) -> np.ndarray:
    """1 inside rect, feathered falloff outside (keeps mask edges organic)."""
    import cv2

    H, W = shape
    x0, y0, x1, y1 = rect
    win = np.zeros((H, W), dtype=np.float32)
    win[y0:y1, x0:x1] = 1.0
    sigma = max(sigma_frac * max(x1 - x0, y1 - y0), 2.0)
    return cv2.GaussianBlur(win, (0, 0), sigma).astype(np.float64)


def _grabcut_head(cv2, rgb: np.ndarray, face: Face, iters: int) -> np.ndarray | None:
    """GrabCut foreground for the head rect; float 0/1 mask at full resolution."""
    H, W = rgb.shape[:2]
    rect = _head_rect(face, (H, W))
    x, y, w, h = face.box
    cx, cy = min(x + w // 2, W - 1), min(y + h // 2, H - 1)

    scale = 1.0
    small = rgb
    if max(H, W) > 720:
        scale = 720.0 / max(H, W)
        small = cv2.resize(rgb, (int(W * scale), int(H * scale)), interpolation=cv2.INTER_AREA)
    sh, sw = small.shape[:2]
    sx0, sy0, sx1, sy1 = [int(round(v * scale)) for v in rect]
    sx1, sy1 = min(sx1, sw), min(sy1, sh)
    if (sx1 - sx0) < 8 or (sy1 - sy0) < 8:
        return None
    if (sx1 - sx0) >= sw - 1 and (sy1 - sy0) >= sh - 1:
        return None  # head fills the frame; nothing to segment away

    gc_mask = np.zeros((sh, sw), np.uint8)
    bgd = np.zeros((1, 65), np.float64)
    fgd = np.zeros((1, 65), np.float64)
    bgr = cv2.cvtColor(small, cv2.COLOR_RGB2BGR)
    try:
        cv2.grabCut(bgr, gc_mask, (sx0, sy0, sx1 - sx0, sy1 - sy0),
                    bgd, fgd, iters, cv2.GC_INIT_WITH_RECT)
    except cv2.error:
        return None
    fg = ((gc_mask == cv2.GC_FGD) | (gc_mask == cv2.GC_PR_FGD)).astype(np.uint8)

    # Keep only the connected component under the face center.
    _, labels = cv2.connectedComponents(fg)
    scx, scy = min(int(cx * scale), sw - 1), min(int(cy * scale), sh - 1)
    lab = labels[scy, scx]
    if lab != 0:
        fg = (labels == lab).astype(np.uint8)

    m = fg.astype(np.float32)
    if scale != 1.0:
        m = cv2.resize(m, (W, H), interpolation=cv2.INTER_LINEAR)
    return m.astype(np.float64)


def segment_head(rgb: np.ndarray, face: Face | None = None, iters: int = 5,
                 feather_px: float = 3.0, mesh: dict | None = None) -> np.ndarray | None:
    """Isolate the face sculpture as a soft 0..1 mask.

    With MediaPipe mesh landmarks: the exact face-oval polygon plus the hair
    (GrabCut foreground above the chin line) — shoulders and chest are cut, so
    only the face structure itself remains. Without landmarks: GrabCut seeded
    from the detected face box. Returns None when there is no face or
    segmentation fails — callers fall back to the unsegmented density.
    """
    cv2 = _require_cv2()
    if mesh is None:
        mesh = mesh_scan(rgb)

    if face is None:
        det = detect_faces(rgb)
        face = largest_face(det)
        if face is None:
            return None

    H, W = rgb.shape[:2]
    x, y, w, h = face.box
    cx, cy = min(x + w // 2, W - 1), min(y + h // 2, H - 1)

    if mesh is not None:
        pts = mesh["points"]
        oval = pts[FACE_OVAL][:, :2].astype(np.int32)
        face_mask = np.zeros((H, W), np.float32)
        cv2.fillPoly(face_mask, [oval], 1.0)
        face_mask = face_mask.astype(np.float64)

        chin_y = float(pts[CHIN][1])
        oval_h = max(float(oval[:, 1].max() - oval[:, 1].min()), 8.0)
        oval_w = max(float(oval[:, 0].max() - oval[:, 0].min()), 8.0)
        ocx = float(oval[:, 0].mean())
        ocy = float(oval[:, 1].mean())
        cut_y = int(min(H, chin_y + 0.10 * oval_h))

        cat = person_classes(rgb)
        if cat is not None:
            # Semantic path: keep exactly hair + face skin (plus ears/neck
            # body-skin close to the head). Background, clothes, and anything
            # else — headboards, walls, shoulders — never enters the mask.
            hairface = ((cat == CAT_HAIR) | (cat == CAT_FACE_SKIN)).astype(np.float64)
            near = np.zeros((H, W), np.float32)
            cv2.ellipse(near, (int(ocx), int(ocy)), (int(oval_w * 0.78), int(oval_h * 0.82)),
                        0, 0, 360, 1.0, -1)
            hairface = np.maximum(hairface, (cat == CAT_BODY_SKIN).astype(np.float64) * near)
            mask = np.maximum(face_mask, hairface)
            # Below the chin: only the face oval and hair may remain.
            keep_below = np.maximum(face_mask, (cat == CAT_HAIR).astype(np.float64))
        else:
            # GrabCut fallback, constrained to an elliptical hair zone hugging
            # the head so a busy background can't ride along.
            fg = _grabcut_head(cv2, rgb, face, iters)
            mask = face_mask.copy()
            if fg is not None:
                zone = np.zeros((H, W), np.float32)
                cv2.ellipse(zone, (int(ocx), int(ocy - 0.20 * oval_h)),
                            (int(oval_w * 0.95), int(oval_h * 1.05)), 0, 0, 360, 1.0, -1)
                mask = np.maximum(mask, fg * zone.astype(np.float64))
            keep_below = face_mask

        below = np.zeros((H, W), np.float64)
        below[cut_y:, :] = 1.0
        mask = np.where(below > 0, np.minimum(mask, keep_below), mask)
    else:
        mask = _grabcut_head(cv2, rgb, face, iters)
        if mask is None:
            return None
        # Guarantee the detected face region itself always survives segmentation.
        ell = np.zeros((H, W), np.float32)
        cv2.ellipse(ell, (int(cx), int(cy)), (int(w * 0.44), int(h * 0.58)), 0, 0, 360, 1.0, -1)
        mask = np.maximum(mask, ell.astype(np.float64))

    if feather_px > 0:
        mask = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), feather_px).astype(np.float64)
    return np.clip(mask, 0.0, 1.0)


# --------------------------------------------------------------- depth

def depth_map(rgb: np.ndarray, mask: np.ndarray, face: Face,
              amplitude: float | None = None, relief: float = 0.24) -> np.ndarray:
    """Estimate a per-pixel height field (px, + toward the viewer) for the head.

    Two components, both derived without any learned model:

    - dome: the segmented head silhouette inflated like a balloon (sqrt of the
      distance transform), giving the overall 3D bust volume.
    - relief: local luminance contrast (shading), so the nose, brow, cheeks and
      lips rise out of the dome while eye sockets and mouth corners recess.

    `amplitude` is the dome height in pixels (default 0.42 * face width);
    `relief` scales the feature layer relative to the amplitude.
    """
    cv2 = _require_cv2()
    H, W = mask.shape
    x, y, w, h = face.box
    amp = float(amplitude if amplitude is not None else 0.48 * w)

    hard = (mask > 0.5).astype(np.uint8)
    if hard.sum() < 16:
        return np.zeros((H, W), dtype=np.float64)

    dist = cv2.distanceTransform(hard, cv2.DIST_L2, 5).astype(np.float64)
    peak = dist.max()
    dome = np.sqrt(dist / peak) if peak > 0 else dist

    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float64) / 255.0
    sigma = max(2.0, 0.16 * w)
    lowf = cv2.GaussianBlur(gray, (0, 0), sigma)
    detail = cv2.GaussianBlur(gray - lowf, (0, 0), 2.0)
    dmax = np.abs(detail[hard > 0]).max() if (hard > 0).any() else 0.0
    if dmax > 0:
        detail = detail / dmax

    z = amp * dome + (relief * amp) * detail
    z = cv2.GaussianBlur(z, (0, 0), 2.0) * mask
    inside = z[hard > 0]
    if inside.size:
        z = z - inside.mean()
    return z * (mask > 0.05)


def mirror_x_map(width: int, cx: float) -> np.ndarray:
    """Column index map reflecting about the vertical line x = cx."""
    xm = np.round(2.0 * cx - np.arange(width)).astype(int)
    return np.clip(xm, 0, width - 1)


def symmetrize_face(rgb: np.ndarray, mesh: dict) -> np.ndarray:
    """Average the face-oval region with its mirror about the face midline —
    the alignment trick recognition pipelines use. Kills the lighting and
    foreshortening asymmetry a tilted capture bakes into the image."""
    import cv2

    H, W = rgb.shape[:2]
    oval = mesh["points"][FACE_OVAL]
    cx = float(oval[:, 0].mean())
    xm = mirror_x_map(W, cx)
    mirrored = rgb[:, xm]
    mask = np.zeros((H, W), np.float32)
    cv2.fillPoly(mask, [oval[:, :2].astype(np.int32)], 1.0)
    mask = cv2.GaussianBlur(mask, (0, 0), max(2.0, 0.03 * (oval[:, 0].max() - oval[:, 0].min())))
    m3 = mask[:, :, None].astype(np.float64)
    out = rgb.astype(np.float64) * (1 - 0.5 * m3) + mirrored.astype(np.float64) * (0.5 * m3)
    return np.clip(out, 0, 255).astype(np.uint8)


def landmark_relief(shape: tuple[int, int], mesh: dict, relief: float = 1.15) -> np.ndarray:
    """Facial relief field only (px, + toward viewer): landmark z splatted and
    smoothed across the face oval, referenced to zero at the oval rim. No dome
    — callers mount this onto their own base geometry (e.g. a canonical head)."""
    cv2 = _require_cv2()
    H, W = shape[:2]
    pts = mesh["points"]
    oval = pts[FACE_OVAL]
    face_w = max(float(oval[:, 0].max() - oval[:, 0].min()), 8.0)

    zsum = np.zeros((H, W), np.float64)
    wsum = np.zeros((H, W), np.float64)
    xi = np.clip(pts[:, 0].round().astype(int), 0, W - 1)
    yi = np.clip(pts[:, 1].round().astype(int), 0, H - 1)
    np.add.at(zsum, (yi, xi), pts[:, 2])
    np.add.at(wsum, (yi, xi), 1.0)
    sigma = max(2.0, 0.05 * face_w)
    zs = cv2.GaussianBlur(zsum, (0, 0), sigma)
    ws = cv2.GaussianBlur(wsum, (0, 0), sigma)
    zfield = np.where(ws > 1e-5, zs / np.maximum(ws, 1e-5), 0.0)

    rim = zfield[np.clip(oval[:, 1].astype(int), 0, H - 1),
                 np.clip(oval[:, 0].astype(int), 0, W - 1)]
    zfield = zfield - float(np.median(rim))

    oval_poly = np.zeros((H, W), np.float32)
    cv2.fillPoly(oval_poly, [oval[:, :2].astype(np.int32)], 1.0)
    oval_soft = cv2.GaussianBlur(oval_poly, (0, 0), max(2.0, 0.04 * face_w)).astype(np.float64)
    zfield = np.clip(zfield, -0.25 * face_w, 0.45 * face_w) * oval_soft

    # Symmetrize about the face midline: a tilted capture distorts one side;
    # the averaged field keeps the structure bilaterally true.
    xm = mirror_x_map(W, float(oval[:, 0].mean()))
    zfield = 0.5 * (zfield + zfield[:, xm])
    return relief * zfield


def depth_from_mesh(rgb: np.ndarray, mask: np.ndarray, mesh: dict,
                    relief: float = 1.35) -> np.ndarray:
    """Sculpture height field from real mesh landmarks (px, + toward viewer).

    The 478 landmarks carry true z: the field is their z splatted and smoothed
    across the face oval (nose out, sockets in — the actual facial geometry),
    riding on the silhouette dome that gives the skull/hair volume.
    """
    cv2 = _require_cv2()
    H, W = mask.shape
    pts = mesh["points"]
    oval = pts[FACE_OVAL]
    face_w = max(float(oval[:, 0].max() - oval[:, 0].min()), 8.0)

    # Splat landmark z into a smooth field: gaussian-weighted scatter average.
    zsum = np.zeros((H, W), np.float64)
    wsum = np.zeros((H, W), np.float64)
    xi = np.clip(pts[:, 0].round().astype(int), 0, W - 1)
    yi = np.clip(pts[:, 1].round().astype(int), 0, H - 1)
    np.add.at(zsum, (yi, xi), pts[:, 2])
    np.add.at(wsum, (yi, xi), 1.0)
    sigma = max(2.0, 0.05 * face_w)
    zs = cv2.GaussianBlur(zsum, (0, 0), sigma)
    ws = cv2.GaussianBlur(wsum, (0, 0), sigma)
    zfield = np.where(ws > 1e-5, zs / np.maximum(ws, 1e-5), 0.0)

    # Reference the field to the oval rim so it blends into the dome at zero.
    rim = zfield[np.clip(oval[:, 1].astype(int), 0, H - 1), np.clip(oval[:, 0].astype(int), 0, W - 1)]
    zfield = zfield - float(np.median(rim))

    oval_poly = np.zeros((H, W), np.float32)
    cv2.fillPoly(oval_poly, [oval[:, :2].astype(np.int32)], 1.0)
    oval_soft = cv2.GaussianBlur(oval_poly, (0, 0), max(2.0, 0.04 * face_w)).astype(np.float64)
    zfield = np.clip(zfield, -0.30 * face_w, 0.55 * face_w) * oval_soft

    # Skull/hair volume: silhouette dome (slightly flatter than the legacy one
    # since the mesh supplies the facial relief).
    hard = (mask > 0.5).astype(np.uint8)
    if hard.sum() < 16:
        return np.zeros((H, W), dtype=np.float64)
    dist = cv2.distanceTransform(hard, cv2.DIST_L2, 5).astype(np.float64)
    peak = dist.max()
    dome = (np.sqrt(dist / peak) if peak > 0 else dist) * 0.34 * face_w

    z = (dome + relief * zfield) * mask
    z = cv2.GaussianBlur(z, (0, 0), 2.0)
    inside = z[hard > 0]
    if inside.size:
        z = z - inside.mean()
    return z * (mask > 0.05)


# --------------------------------------------------------------- head pose

_PNP_IDX = [1, 152, 33, 263, 61, 291]  # nose, chin, eye corners, mouth corners
_PNP_MODEL = np.array([
    (0.0, 0.0, 0.0),
    (0.0, -330.0, -65.0),
    (-225.0, 170.0, -135.0),
    (225.0, 170.0, -135.0),
    (-150.0, -150.0, -125.0),
    (150.0, -150.0, -125.0),
], dtype=np.float64)


def _pose_from_mesh(cv2, shape, lms: np.ndarray) -> dict:
    h, w = shape[:2]
    cam = np.array([[w, 0, w / 2], [0, w, h / 2], [0, 0, 1]], dtype=np.float64)
    ok, rvec, _ = cv2.solvePnP(_PNP_MODEL, lms[_PNP_IDX], cam, np.zeros(4),
                               flags=cv2.SOLVEPNP_ITERATIVE)
    if not ok:
        return {"yaw": None, "pitch": None, "roll": None}
    R, _ = cv2.Rodrigues(rvec)
    pitch, yaw, roll = cv2.RQDecomp3x3(R)[0]
    if pitch < -90:
        pitch += 180
    elif pitch > 90:
        pitch -= 180
    return {"yaw": round(float(yaw), 1), "pitch": round(float(pitch), 1), "roll": round(float(roll), 1)}


def _pose_from_5pt(face: Face) -> dict:
    eye_r, eye_l, nose, mouth_r, mouth_l = face.landmarks
    mid = (eye_r + eye_l) / 2
    d = float(np.linalg.norm(eye_l - eye_r)) + 1e-6
    roll = float(np.degrees(np.arctan2(eye_l[1] - eye_r[1], eye_l[0] - eye_r[0])))
    yaw = float(np.clip((nose[0] - mid[0]) / (d / 2), -1, 1)) * 45.0
    mouth_mid = (mouth_r + mouth_l) / 2
    ratio = float((nose[1] - mid[1]) / (np.linalg.norm(mouth_mid - mid) + 1e-6))
    pitch = float(np.clip(ratio - 0.58, -1, 1)) * -60.0  # rough: nose rides high when looking up
    return {"yaw": round(yaw, 1), "pitch": round(pitch, 1), "roll": round(roll, 1)}


def _roll_from_haar_eyes(cv2, rgb: np.ndarray, face: Face) -> float | None:
    x, y, w, h = face.box
    top = rgb[max(0, y): y + int(h * 0.65), max(0, x): x + w]
    if top.size == 0:
        return None
    gray = cv2.cvtColor(top, cv2.COLOR_RGB2GRAY)
    cascade = cv2.CascadeClassifier(os.path.join(cv2.data.haarcascades, "haarcascade_eye.xml"))
    if cascade.empty():
        return None
    eyes = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5,
                                    minSize=(max(8, w // 10), max(8, w // 10)))
    if len(eyes) < 2:
        return None
    eyes = sorted(eyes, key=lambda e: e[2] * e[3], reverse=True)[:2]
    (x1, y1, w1, h1), (x2, y2, w2, h2) = sorted(eyes, key=lambda e: e[0])
    c1 = (x1 + w1 / 2, y1 + h1 / 2)
    c2 = (x2 + w2 / 2, y2 + h2 / 2)
    return round(float(np.degrees(np.arctan2(c2[1] - c1[1], c2[0] - c1[0]))), 1)


def _pose_from_matrix(matrix: np.ndarray) -> dict:
    """Euler angles from the FaceLandmarker facial transformation matrix."""
    R = matrix[:3, :3]
    sy = float(np.hypot(R[0, 0], R[1, 0]))
    if sy > 1e-6:
        pitch = float(np.degrees(np.arctan2(R[2, 1], R[2, 2])))
        yaw = float(np.degrees(np.arctan2(-R[2, 0], sy)))
        roll = float(np.degrees(np.arctan2(R[1, 0], R[0, 0])))
    else:
        pitch = float(np.degrees(np.arctan2(-R[1, 2], R[1, 1])))
        yaw = float(np.degrees(np.arctan2(-R[2, 0], sy)))
        roll = 0.0
    return {"yaw": round(yaw, 1), "pitch": round(pitch, 1), "roll": round(roll, 1)}


_S_FLIP = np.diag([1.0, -1.0, -1.0])   # mediapipe matrix space (y up, z out) -> canvas (y down, z toward viewer)


def frontalization_candidates(matrix: np.ndarray) -> list[np.ndarray]:
    """Exact de-rotation candidates from the facial transformation matrix —
    no euler round-trip (which composes wrongly for mixed yaw+pitch+roll).
    Two candidates cover the convention ambiguity; best_frontalization picks
    by measurement."""
    R = matrix[:3, :3]
    Rc = _S_FLIP @ R @ _S_FLIP
    return [Rc.T, Rc]


def best_frontalization(shape: tuple[int, int], mesh: dict) -> tuple[np.ndarray | None, dict]:
    """Self-verifying frontalization: try the exact matrix-derived rotations,
    re-measure the landmark pose after each, and keep the one that actually
    makes the face more frontal. Returns (rotation | None, residual pose).
    None = nothing beat the unrotated face (then symmetrization still applies) —
    a wrong-convention rotation can never blow the sculpture up."""
    cv2 = _require_cv2()
    if mesh.get("matrix") is None:
        return None, {}
    pts = mesh["points"]
    c = pts.mean(axis=0)

    def score(pose: dict) -> float:
        return abs(pose.get("yaw") or 0) + abs(pose.get("pitch") or 0) + abs(pose.get("roll") or 0)

    base = _pose_from_mesh(cv2, shape, pts[:, :2])
    best_R, best_s, best_pose = None, score(base), base
    for R in frontalization_candidates(mesh["matrix"]):
        out = (pts - c) @ R.T + c
        pose = _pose_from_mesh(cv2, shape, out[:, :2])
        s = score(pose)
        if s < best_s - 0.5:
            best_R, best_s, best_pose = R, s, pose
    return best_R, best_pose


def head_pose(rgb: np.ndarray, face: Face | None = None, mesh: dict | None = None) -> dict:
    """Estimate head orientation. Returns {yaw, pitch, roll, backend}; angles in
    degrees or None where the active backend cannot measure them."""
    cv2 = _require_cv2()

    if mesh is None:
        mesh = mesh_scan(rgb)
    if mesh is not None:
        if mesh.get("matrix") is not None:
            return {**_pose_from_matrix(mesh["matrix"]), "backend": "mediapipe"}
        return {**_pose_from_mesh(cv2, rgb.shape, mesh["points"][:, :2]), "backend": "mediapipe"}

    if face is None:
        face = largest_face(detect_faces(rgb))
    if face is None:
        return {"yaw": None, "pitch": None, "roll": None, "backend": "none"}

    if face.landmarks is not None:
        return {**_pose_from_5pt(face), "backend": "yunet"}

    return {"yaw": None, "pitch": None,
            "roll": _roll_from_haar_eyes(cv2, rgb, face), "backend": "haar"}


# --------------------------------------------------------------- density boost

def _elliptical_boost(shape: tuple[int, int], box, amount: float) -> np.ndarray:
    """Soft elliptical multiplier (1 outside, up to `amount` inside) over a box."""
    h, w = shape
    x, y, bw, bh = box
    cy, cx = y + bh / 2.0, x + bw / 2.0
    yy, xx = np.mgrid[0:h, 0:w]
    r2 = ((xx - cx) / max(bw * 0.62, 1)) ** 2 + ((yy - cy) / max(bh * 0.72, 1)) ** 2
    soft = np.clip(1.0 - r2, 0.0, 1.0) ** 1.5
    return 1.0 + (amount - 1.0) * soft


def face_boost_map(rgb: np.ndarray, boost: float = 2.6, feature_boost: float = 1.7) -> np.ndarray | None:
    """Multiplier map emphasizing detected faces; None if no face is found."""
    faces = detect_faces(rgb)
    if not faces:
        warnings.warn("no face detected — using the plain image density instead", stacklevel=2)
        return None

    h, w = rgb.shape[:2]
    total = np.ones((h, w), dtype=np.float64)
    for f in faces:
        x, y, bw, bh = f.box
        total *= _elliptical_boost((h, w), f.box, boost)
        if f.landmarks is not None:
            # Landmark-centered patches: eyes, nose, mouth.
            eye_r, eye_l, nose, mouth_r, mouth_l = f.landmarks
            eye_s = max(bw * 0.22, 8)
            for cx, cy in (eye_r, eye_l):
                total *= _elliptical_boost((h, w), (cx - eye_s / 2, cy - eye_s / 2, eye_s, eye_s * 0.8), feature_boost)
            total *= _elliptical_boost((h, w), (nose[0] - eye_s / 2, nose[1] - eye_s / 2, eye_s, eye_s), 1.0 + (feature_boost - 1.0) * 0.6)
            mx, my = (mouth_r + mouth_l) / 2
            mw = max(abs(mouth_l[0] - mouth_r[0]) * 1.6, 10)
            total *= _elliptical_boost((h, w), (mx - mw / 2, my - mw * 0.3, mw, mw * 0.6), feature_boost)
        else:
            # Heuristic bands within the face box: eyes ~25-48% height, mouth ~62-88%.
            eyes = (x + int(0.12 * bw), y + int(0.25 * bh), int(0.76 * bw), int(0.23 * bh))
            mouth = (x + int(0.22 * bw), y + int(0.62 * bh), int(0.56 * bw), int(0.26 * bh))
            total *= _elliptical_boost((h, w), eyes, feature_boost)
            total *= _elliptical_boost((h, w), mouth, feature_boost)
    return total
