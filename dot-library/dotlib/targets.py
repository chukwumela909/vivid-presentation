"""Target generators: things the dot field can arrange itself into.

Each factory returns a TargetSpec; the DotField calls .build(field) to get the
concrete point set (and optional per-dot colors) sized for its canvas and dot
count. All coordinates are canvas pixels, origin top-left.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from . import sampling
from ._util import fit_rect, load_font, load_image_rgb, parse_color


@dataclass
class Target:
    points: np.ndarray                 # (n, 3) float — x, y in canvas px, z depth (+ toward viewer)
    colors: np.ndarray | None = None   # (n, 3) float 0-255, None -> field fg
    name: str = "target"
    meta: dict | None = None           # extra geometry (e.g. face box/regions in canvas coords)
    tags: np.ndarray | None = None     # (n,) int per-dot layer tags (see facelayers)


def _with_slab_z(pts2d: np.ndarray, field, thickness: float = 2.5) -> np.ndarray:
    """Give a flat 2D target a thin z slab so it still breathes under rotation."""
    z = field.rng.uniform(-1.0, 1.0, (len(pts2d), 1)) * thickness
    return np.hstack([pts2d, z])


class TargetSpec:
    name = "target"

    def build(self, field) -> Target:  # pragma: no cover - interface
        raise NotImplementedError


def _canvas_box(field, pad: float) -> tuple[float, float, float, float]:
    w, h = field.size
    return (w * pad, h * pad, w * (1 - 2 * pad), h * (1 - 2 * pad))


# ---------------------------------------------------------------- text

class TextSpec(TargetSpec):
    def __init__(self, text: str, font: str | None = None, pad: float = 0.12,
                 weight_fill: float = 1.0, relax: int = 12):
        self.text, self.font, self.pad, self.weight_fill, self.relax = text, font, pad, weight_fill, relax
        self.name = f"text:{text[:24]}"

    def _render_mask(self, field) -> np.ndarray:
        w, h = field.size
        bx, by, bw, bh = _canvas_box(field, self.pad)
        # Binary-search the font size that fits the padded box.
        lo, hi, best = 8, int(h * 1.2), 8
        while lo <= hi:
            mid = (lo + hi) // 2
            font = load_font(mid, self.font)
            probe = ImageDraw.Draw(Image.new("L", (1, 1)))
            l, t, r, b = probe.multiline_textbbox((0, 0), self.text, font=font, align="center")
            if (r - l) <= bw and (b - t) <= bh:
                best, lo = mid, mid + 1
            else:
                hi = mid - 1
        font = load_font(best, self.font)
        img = Image.new("L", (w, h), 0)
        draw = ImageDraw.Draw(img)
        l, t, r, b = draw.multiline_textbbox((0, 0), self.text, font=font, align="center")
        pos = (bx + (bw - (r - l)) / 2 - l, by + (bh - (b - t)) / 2 - t)
        draw.multiline_text(pos, self.text, fill=255, font=font, align="center")
        mask = np.asarray(img.filter(ImageFilter.GaussianBlur(1.0)), dtype=np.float64) / 255.0
        return mask ** 1.2

    def build(self, field) -> Target:
        density = self._render_mask(field)
        pts = sampling.stipple(density, field.n, field.rng, relax_iters=self.relax)
        return Target(points=_with_slab_z(pts, field), name=self.name)


# ---------------------------------------------------------------- image / face

class ImageSpec(TargetSpec):
    def __init__(self, source, tone: str = "auto", gamma: float = 1.6, edges: float = 0.0,
                 color: bool = False, pad: float = 0.06, relax: int = 10,
                 face_boost: float | None = None, floor: float = 0.0,
                 face_crop: bool = False, crop_margin: float = 0.65,
                 segment: bool = False, depth: bool = False, structure: bool = False,
                 frontalize: bool = True):
        self.source, self.tone, self.gamma, self.edges = source, tone, gamma, edges
        self.color, self.pad, self.relax, self.face_boost, self.floor = color, pad, relax, face_boost, floor
        self.face_crop, self.crop_margin, self.segment = face_crop, crop_margin, segment
        self.depth, self.structure, self.frontalize = depth, structure, frontalize
        self.name = "face" if face_boost else "image"

    def _build_mesh_sculpture(self, field, rgb: np.ndarray, mesh, main_face) -> Target:
        """Canonical-head face sculpture.

        The head shape is NOT derived from the image: a predefined round 3D
        dot shell (closed — it has a back, spins fully, disperses gracefully)
        carries the scanned face STRUCTURE on its front cap. Only the face
        patch comes from the scan: landmark relief for depth, image luminance
        for values, and the tagged anatomy layers (lips, lids, eyeballs,
        teeth, tongue, cavity). No neck, no shoulders, no segmentation guess."""
        import cv2

        from . import facelayers, faces as F

        ih, iw = rgb.shape[:2]
        oval_img = mesh["points"][F.FACE_OVAL][:, :2].astype(np.int32)
        face_w_img = float(main_face.box[2])

        # Face symmetry: average the oval with its mirror (recognition-style
        # alignment), and trust the photo's lighting less the further the head
        # was turned/tilted at capture — geometry shading takes over.
        rgb = F.symmetrize_face(rgb, mesh)
        pose0 = F._pose_from_matrix(mesh["matrix"]) if mesh.get("matrix") is not None else {}
        off_axis = abs(pose0.get("yaw") or 0) + abs(pose0.get("pitch") or 0)
        img_weight = float(np.clip(1.0 - off_axis / 35.0, 0.30, 1.0))

        # Face-patch mask: exactly the landmark oval (feathered) — the image
        # contributes nothing outside the face structure itself.
        mask = np.zeros((ih, iw), np.float32)
        cv2.fillPoly(mask, [oval_img], 1.0)
        mask = cv2.GaussianBlur(mask, (0, 0), max(2.0, 0.02 * face_w_img)).astype(np.float64)

        # Relief-only depth: the canonical head supplies the volume later.
        depth_img = F.landmark_relief((ih, iw), mesh)

        if self.structure:
            struct_d = sampling.structure_density(rgb)
            tone_d = sampling.density_from_image(rgb, tone="bright", gamma=1.4)
            density = 0.45 * (struct_d / max(struct_d.max(), 1e-9)) \
                    + 0.55 * (tone_d / max(tone_d.max(), 1e-9))
        else:
            tone = self.tone
            if tone == "auto":
                tone = "bright" if field.fg.mean() >= field.bg.mean() else "dark"
            density = sampling.density_from_image(rgb, tone=tone, gamma=self.gamma,
                                                  edges=self.edges, floor=self.floor)
        density = density * mask

        # Budget: the scanned face patch dominates; the shallow front shell
        # (crown, temples, cheeks — no back of head) frames it.
        n_face = max(int(field.n * 0.70), 200)
        n_shell = field.n - n_face

        pts, colors, tags, regions = facelayers.build_layers(
            rgb, mesh, mask, depth_img, density, n_face, field.rng,
            field.bg, field.fg, photo=self.color, relax_iters=self.relax,
            img_weight=img_weight,
        )

        # Fit the face patch into the padded canvas box.
        bx, by, bw, bh = _canvas_box(field, self.pad)
        fit_w, fit_h = fit_rect(iw, ih, bw, bh)
        offset = np.array([bx + (bw - fit_w) / 2, by + (bh - fit_h) / 2])
        scale = fit_w / iw
        canvas_pts = pts.copy()
        canvas_pts[:, 0] = pts[:, 0] * scale + offset[0]
        canvas_pts[:, 1] = pts[:, 1] * scale + offset[1]
        canvas_pts[:, 2] = pts[:, 2] * scale

        oval_c = oval_img.astype(np.float64) * scale + offset[None, :]
        regions_c = facelayers.scale_regions(regions, scale, offset)

        # Frontalize: undo the captured head pose so the sculpture presents the
        # face STRUCTURE forward, not the angle the camera happened to catch.
        # Exact matrix-based rotation, self-verified by re-measuring the pose —
        # if no candidate beats the unrotated face, none is applied.
        if self.frontalize:
            R, _residual = F.best_frontalization(rgb.shape[:2], mesh)
            if R is not None:
                center = canvas_pts.mean(axis=0)
                canvas_pts = (canvas_pts - center) @ R.T + center
                regions_c = facelayers.rotate_regions(regions_c, R, center)
                oval3 = np.hstack([oval_c, np.zeros((len(oval_c), 1))])
                oval_c = ((oval3 - center) @ R.T + center)[:, :2]

        # Mount the face patch on the head's face side: shallow dome curvature
        # (zero at the oval rim) so it meets the lofted shell with no seam.
        canvas_pts[:, 2] += facelayers.face_dome(canvas_pts[:, 0], canvas_pts[:, 1], oval_c)

        # The head itself: the FLAME statistical head (true human cranium,
        # ears, occiput) when its model file is installed; otherwise a head
        # lofted from THIS person's jawline/hairline contour.
        from . import flamehead

        shell = flamehead.head_shell(oval_c, n_shell, field.rng)
        if shell is None:
            shell = facelayers.predicted_head_shell(oval_c, n_shell, field.rng)
        shell_v = 0.46 + field.rng.uniform(-0.06, 0.14, (n_shell, 1))
        shell_colors = field.bg[None, :] + (field.fg - field.bg)[None, :] * shell_v
        shell_tags = np.zeros(n_shell, dtype=np.int64)

        all_pts = np.vstack([canvas_pts, shell])
        all_colors = np.vstack([colors, shell_colors])
        all_tags = np.concatenate([tags, shell_tags])

        fx, fy, fbw, fbh = main_face.box
        meta = {
            "face_box": [fx * scale + offset[0], fy * scale + offset[1], fbw * scale, fbh * scale],
            "regions": regions_c,
        }
        return Target(points=all_pts, colors=all_colors, name="face", meta=meta, tags=all_tags)

    def _crop_to_faces(self, rgb: np.ndarray) -> np.ndarray:
        """Zoom into the union of detected faces (plus margin) so portraits fill the canvas."""
        from . import faces as F

        found = F.detect_faces(rgb)
        if not found:
            return rgb
        boxes = np.array([f.box for f in found], dtype=np.float64)
        # Haar produces occasional small false positives; keep only faces
        # comparable in size to the largest one before framing the crop.
        areas = boxes[:, 2] * boxes[:, 3]
        boxes = boxes[areas >= 0.5 * areas.max()]
        x0, y0 = boxes[:, 0].min(), boxes[:, 1].min()
        x1 = (boxes[:, 0] + boxes[:, 2]).max()
        y1 = (boxes[:, 1] + boxes[:, 3]).max()
        m = self.crop_margin * max(x1 - x0, y1 - y0)
        h, w = rgb.shape[:2]
        cx0 = int(max(0, x0 - m))
        cy0 = int(max(0, y0 - m * 1.15))       # a little extra headroom for hair
        cx1 = int(min(w, x1 + m))
        cy1 = int(min(h, y1 + m * 1.25))       # and chin/shoulders
        if cx1 - cx0 < 32 or cy1 - cy0 < 32:
            return rgb
        return rgb[cy0:cy1, cx0:cx1]

    def build(self, field) -> Target:
        rgb = load_image_rgb(self.source)

        main_face = None
        mesh = None
        if self.face_boost:
            from . import faces as F

            if self.face_crop:
                rgb = self._crop_to_faces(rgb)
            mesh = F.mesh_scan(rgb)
            if mesh is not None:
                main_face = F.face_from_mesh(mesh)
                if self.depth and self.segment:
                    return self._build_mesh_sculpture(field, rgb, mesh, main_face)
            else:
                main_face = F.largest_face(F.detect_faces(rgb))

        if self.structure:
            # Structure mode: contour/edge density blended with a bright-tone
            # layer so features still articulate front-on; depth (z) and
            # per-dot luminance carry the likeness instead of RGB color.
            struct_d = sampling.structure_density(rgb)
            tone_d = sampling.density_from_image(rgb, tone="bright", gamma=1.4)
            density = 0.45 * (struct_d / max(struct_d.max(), 1e-9)) \
                    + 0.55 * (tone_d / max(tone_d.max(), 1e-9))
        else:
            tone = self.tone
            if tone == "auto":
                # Light dots on a dark canvas should trace the image's bright regions.
                tone = "bright" if field.fg.mean() >= field.bg.mean() else "dark"
            density = sampling.density_from_image(
                rgb, tone=tone, gamma=self.gamma, edges=self.edges, floor=self.floor
            )

        mask = None
        if self.face_boost:
            from . import faces

            boost = faces.face_boost_map(rgb, boost=self.face_boost)
            if boost is not None:
                density = density * boost
            if self.segment:
                # Isolate just the head: zero density outside the segmented
                # face+hair mask so no dots are spent on the background.
                mask = faces.segment_head(rgb, face=main_face)
                if mask is not None:
                    density = density * mask

        # Sample in image pixel space, then fit into the padded canvas box.
        pts = sampling.stipple(density, field.n, field.rng, relax_iters=self.relax)

        ih, iw = density.shape
        cw, ch = field.size
        bx, by, bw, bh = _canvas_box(field, self.pad)
        fw, fh = fit_rect(iw, ih, bw, bh)
        offset = np.array([bx + (bw - fw) / 2, by + (bh - fh) / 2])
        scale = fw / iw
        canvas_xy = pts * scale + offset

        xi = np.clip(pts[:, 0].astype(int), 0, iw - 1)
        yi = np.clip(pts[:, 1].astype(int), 0, ih - 1)

        # Depth: sample the estimated height field at each dot, scaled with the
        # same image->canvas factor so proportions hold.
        if self.depth and mask is not None and main_face is not None:
            from . import faces

            zmap = faces.depth_map(rgb, mask, main_face)
            z = (zmap[yi, xi] * scale)[:, None]
            canvas_pts = np.hstack([canvas_xy, z])
        else:
            canvas_pts = _with_slab_z(canvas_xy, field)

        colors = None
        if self.color:
            colors = rgb[yi, xi].astype(np.float64)
        elif self.structure:
            # Monochrome value shading: each dot takes a grayscale intensity
            # from the source, blended between canvas bg and fg. No color —
            # just enough tonal range for the face to read at any angle.
            gray = np.asarray(Image.fromarray(rgb).convert("L"), dtype=np.float64) / 255.0
            v = (0.35 + 0.65 * gray[yi, xi] ** 0.85)[:, None]
            colors = field.bg + (field.fg - field.bg) * v

        meta = None
        if main_face is not None:
            fx, fy, fw, fh = main_face.box
            meta = {"face_box": [fx * scale + offset[0], fy * scale + offset[1],
                                 fw * scale, fh * scale]}

        return Target(points=canvas_pts, colors=colors, name=self.name, meta=meta)


# ---------------------------------------------------------------- geometric shapes

class PointsSpec(TargetSpec):
    """Wrap a raw (n, 2) or (n, 3) array of canvas points (e.g. from your own
    model/pipeline — landmarks, meshes, generative output)."""

    def __init__(self, points: np.ndarray, colors: np.ndarray | None = None, name: str = "points"):
        self.points, self.colors, self.name = np.asarray(points, dtype=np.float64), colors, name

    def build(self, field) -> Target:
        pts = self.points
        if len(pts) != field.n:
            idx = field.rng.choice(len(pts), size=field.n, replace=len(pts) < field.n)
            pts = pts[idx]
            colors = None if self.colors is None else np.asarray(self.colors, dtype=np.float64)[idx]
        else:
            colors = None if self.colors is None else np.asarray(self.colors, dtype=np.float64)
        pts = pts.copy()
        if pts.shape[1] == 2:
            pts = np.hstack([pts, np.zeros((len(pts), 1))])
        return Target(points=pts, colors=colors, name=self.name)


class ShapeSpec(TargetSpec):
    def __init__(self, kind: str, pad: float = 0.14, relax: int = 8, **kw):
        self.kind, self.pad, self.relax, self.kw = kind, pad, relax, kw
        self.name = kind

    def _mask(self, field) -> np.ndarray:
        w, h = field.size
        img = Image.new("L", (w, h), 0)
        draw = ImageDraw.Draw(img)
        bx, by, bw, bh = _canvas_box(field, self.pad)
        cx, cy = bx + bw / 2, by + bh / 2
        r = min(bw, bh) / 2
        k = self.kind

        if k == "circle":
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
        elif k == "ring":
            width = self.kw.get("width", 0.28) * r
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
            draw.ellipse([cx - r + width, cy - r + width, cx + r - width, cy + r - width], fill=0)
        elif k in ("polygon", "star"):
            sides = self.kw.get("sides", 5)
            pts = []
            if k == "polygon":
                for i in range(sides):
                    a = -np.pi / 2 + i * 2 * np.pi / sides
                    pts.append((cx + r * np.cos(a), cy + r * np.sin(a)))
            else:
                inner = self.kw.get("inner", 0.45) * r
                for i in range(sides * 2):
                    a = -np.pi / 2 + i * np.pi / sides
                    rad = r if i % 2 == 0 else inner
                    pts.append((cx + rad * np.cos(a), cy + rad * np.sin(a)))
            draw.polygon(pts, fill=255)
        elif k == "heart":
            t = np.linspace(0, 2 * np.pi, 400)
            hx = 16 * np.sin(t) ** 3
            hy = 13 * np.cos(t) - 5 * np.cos(2 * t) - 2 * np.cos(3 * t) - np.cos(4 * t)
            hx = cx + hx / 17.0 * r
            hy = cy - hy / 17.0 * r + 0.08 * r
            draw.polygon(list(zip(hx, hy)), fill=255)
        elif k == "spiral":
            turns = self.kw.get("turns", 3.0)
            thickness = self.kw.get("thickness", 0.09) * r
            t = np.linspace(0, 1, 900)
            a = t * turns * 2 * np.pi
            rad = t * r
            xs, ys = cx + rad * np.cos(a), cy + rad * np.sin(a)
            for x, y in zip(xs, ys):
                draw.ellipse([x - thickness, y - thickness, x + thickness, y + thickness], fill=255)
        else:
            raise ValueError(f"unknown shape {k!r}")

        return np.asarray(img.filter(ImageFilter.GaussianBlur(1.0)), dtype=np.float64) / 255.0

    def build(self, field) -> Target:
        pts = sampling.stipple(self._mask(field), field.n, field.rng, relax_iters=self.relax)
        return Target(points=_with_slab_z(pts, field), name=self.name)


class ScatterSpec(TargetSpec):
    """A floating 3D cloud — the resting/dispersed state.

    mode='ball' (default): dots fill a soft ball around the canvas center,
    so the idle state reads as a volumetric object under perspective.
    mode='fill': dots flood the entire canvas volume edge-to-edge — the
    full-viewport dispersal."""

    def __init__(self, pad: float = 0.03, radius: float = 0.34, mode: str = "ball"):
        self.pad, self.radius, self.mode, self.name = pad, radius, mode, "scatter"

    def build(self, field) -> Target:
        w, h = field.size
        if self.mode == "fill":
            zr = 0.30 * min(w, h)
            pts = np.empty((field.n, 3))
            pts[:, 0] = field.rng.uniform(0.02 * w, 0.98 * w, field.n)
            pts[:, 1] = field.rng.uniform(0.02 * h, 0.98 * h, field.n)
            pts[:, 2] = field.rng.uniform(-zr, zr, field.n)
            return Target(points=pts, name="scatter-fill")
        R = self.radius * min(w, h)
        dirs = field.rng.normal(size=(field.n, 3))
        dirs /= np.linalg.norm(dirs, axis=1, keepdims=True) + 1e-12
        rad = R * field.rng.uniform(0, 1, (field.n, 1)) ** (1 / 3)
        pts = np.array([w / 2, h / 2, 0.0]) + dirs * rad * np.array([1.0, 0.92, 0.85])
        return Target(points=pts, name=self.name)


class ExplodeSpec(TargetSpec):
    """Push every dot radially outward from the field center (used by disperse)."""

    def __init__(self, strength: float = 0.75):
        self.strength, self.name = strength, "explode"

    def build(self, field) -> Target:
        w, h = field.size
        center = np.array([w / 2, h / 2, 0.0])
        vec = field.anchors - center
        norm = np.linalg.norm(vec, axis=1, keepdims=True)
        norm[norm < 1e-6] = 1.0
        direction = vec / norm
        dist = self.strength * min(w, h) * (0.7 + 0.6 * field.rng.uniform(0, 1, (field.n, 1)))
        pts = field.anchors + direction * dist
        pts[:, 0] = np.clip(pts[:, 0], 4, w - 4)
        pts[:, 1] = np.clip(pts[:, 1], 4, h - 4)
        pts[:, 2] = np.clip(pts[:, 2], -0.5 * min(w, h), 0.5 * min(w, h))
        return Target(points=pts, name=self.name)


# ---------------------------------------------------------------- factories

def text(s: str, font: str | None = None, pad: float = 0.12, relax: int = 12) -> TextSpec:
    return TextSpec(s, font=font, pad=pad, relax=relax)


def image(source, tone: str = "auto", gamma: float = 1.6, edges: float = 0.0,
          color: bool = False, pad: float = 0.06, relax: int = 10, floor: float = 0.0) -> ImageSpec:
    return ImageSpec(source, tone=tone, gamma=gamma, edges=edges, color=color,
                     pad=pad, relax=relax, floor=floor)


def face(source, boost: float = 2.6, tone: str = "auto", gamma: float = 1.5,
         edges: float = 0.25, color: bool = False, pad: float = 0.06, relax: int = 10,
         crop: bool = True, crop_margin: float = 0.65, segment: bool = True,
         depth: bool = True, structure: bool = False, frontalize: bool = True) -> ImageSpec:
    """Face target: zooms into the detected face (crop=True), segments out the
    head so the background gets zero dots (segment=True), and estimates per-dot
    depth so the result is a floating 3D bust rather than a flat stipple
    (depth=True). structure=True swaps tone-based density for contour/edge
    density — monochrome structure mode, where z carries the likeness instead
    of brightness. Set crop=False / segment=False to keep full framing/background."""
    return ImageSpec(source, tone=tone, gamma=gamma, edges=edges, color=color,
                     pad=pad, relax=relax, face_boost=boost,
                     face_crop=crop, crop_margin=crop_margin, segment=segment,
                     depth=depth, structure=structure, frontalize=frontalize)


def points(pts, colors=None, name: str = "points") -> PointsSpec:
    return PointsSpec(pts, colors=colors, name=name)


def circle(pad: float = 0.18) -> ShapeSpec:
    return ShapeSpec("circle", pad=pad)


def ring(width: float = 0.28, pad: float = 0.16) -> ShapeSpec:
    return ShapeSpec("ring", pad=pad, width=width)


def polygon(sides: int = 6, pad: float = 0.16) -> ShapeSpec:
    return ShapeSpec("polygon", pad=pad, sides=sides)


def star(sides: int = 5, inner: float = 0.45, pad: float = 0.14) -> ShapeSpec:
    return ShapeSpec("star", pad=pad, sides=sides, inner=inner)


def heart(pad: float = 0.14) -> ShapeSpec:
    return ShapeSpec("heart", pad=pad)


def spiral(turns: float = 3.0, pad: float = 0.12) -> ShapeSpec:
    return ShapeSpec("spiral", pad=pad, turns=turns)


def scatter(pad: float = 0.03, mode: str = "ball") -> ScatterSpec:
    return ScatterSpec(pad=pad, mode=mode)
