"""Sanity checks, runnable directly: python tests/test_sanity.py"""

import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import dotlib as dl
from dotlib.assign import hilbert_index, match


def test_assignment_is_permutation():
    rng = np.random.default_rng(0)
    for method in ("exact", "hilbert"):
        src = rng.uniform(0, 100, (400, 2))
        dst = rng.uniform(0, 100, (400, 2))
        perm = match(src, dst, method=method)
        assert sorted(perm.tolist()) == list(range(400)), f"{method}: not a permutation"
    print("ok: assignment produces a valid permutation (exact + hilbert)")


def test_exact_beats_random_pairing():
    rng = np.random.default_rng(1)
    src = rng.uniform(0, 100, (300, 2))
    dst = rng.uniform(0, 100, (300, 2))
    perm = match(src, dst, method="exact")
    opt = np.linalg.norm(src - dst[perm], axis=1).sum()
    rand = np.linalg.norm(src - dst[rng.permutation(300)], axis=1).sum()
    assert opt < rand, "optimal assignment should beat a random pairing"
    print(f"ok: exact assignment travel {opt:.0f}px < random {rand:.0f}px")


def test_hilbert_locality():
    n = 4096
    side = 64
    xs, ys = np.meshgrid(np.arange(side), np.arange(side))
    idx = hilbert_index(xs.ravel(), ys.ravel(), order=6)
    order = np.argsort(idx)
    pts = np.stack([xs.ravel(), ys.ravel()], axis=1)[order]
    steps = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    assert steps.max() <= 1.0 + 1e-9, "hilbert walk should step to adjacent cells only"
    print("ok: hilbert curve visits adjacent cells (perfect locality)")


def test_stipple_respects_mask():
    density = np.zeros((200, 200))
    density[50:150, 80:120] = 1.0  # vertical bar
    rng = np.random.default_rng(2)
    pts = dl.stipple(density, 300, rng, relax_iters=6)
    assert len(pts) == 300
    inside = (
        (pts[:, 0] >= 75) & (pts[:, 0] <= 125) & (pts[:, 1] >= 45) & (pts[:, 1] <= 155)
    ).mean()
    assert inside > 0.97, f"stipple leaked outside the mask ({inside:.2%} inside)"
    print(f"ok: stipple stays inside its mask ({inside:.2%})")


def test_field_timeline_and_render():
    f = dl.DotField(n=250, size=(200, 160), seed=5)
    f.hold(0.3, drift=2)
    f.morph_to(dl.text("A"), duration=0.8)
    f.hold(0.3)
    f.morph_to(dl.circle(), duration=0.7)
    f.disperse(duration=0.5)
    assert abs(f.duration - 2.6) < 1e-6
    for t in (0.0, 0.31, 0.9, 1.5, 2.2, 2.6, 3.0):
        pos = f.positions(t)
        assert pos.shape == (250, 3) and np.isfinite(pos).all()
    img = f.frame(1.0)
    assert img.size == (200, 160)
    with tempfile.TemporaryDirectory() as td:
        path = f.save(os.path.join(td, "t.gif"), fps=10, quiet=True)
        assert os.path.getsize(path) > 1000
        f.export_json(os.path.join(td, "t.json"))
        assert os.path.getsize(os.path.join(td, "t.json")) > 1000
    print(f"ok: timeline evaluates + renders + saves ({f})")


def test_image_target_colors():
    rgb = np.zeros((100, 100, 3), dtype=np.uint8)
    rgb[:, :50] = (255, 40, 40)   # bright red left half
    rgb[:, 50:] = (10, 10, 10)    # near-black right half
    f = dl.DotField(n=200, size=(200, 200), seed=8)
    f.morph_to(dl.image(rgb, color=True, relax=4), duration=1.0)
    seg = f.segments[-1]
    reds = (seg.c1[:, 0] > 200).mean()
    assert reds > 0.9, f"dots should land on (and take the color of) the bright half ({reds:.2%})"
    print(f"ok: image target puts {reds:.2%} of dots on the bright half with sampled colors")


def test_set_positions_and_timeline_dict():
    f = dl.DotField(n=120, size=(200, 200), seed=1)
    pts = np.full((120, 2), 100.0)
    f.set_positions(pts)                       # (n, 2) input -> z padded to 0
    assert f.anchors.shape == (120, 3)
    assert np.allclose(f.anchors[:, :2], 100.0) and np.allclose(f.anchors[:, 2], 0.0)
    f.morph_to(dl.circle(), duration=1.0, spin=0.5)
    d = f.timeline_dict()
    assert d["n"] == 120 and len(d["segments"]) == 1 and "camera" in d
    seg = d["segments"][0]
    fr = np.asarray(seg["from"])
    assert fr.shape == (120, 3), "timeline points should be 3D"
    assert np.allclose(fr[:, :2], 100.0), "timeline 'from' should equal seeded positions"
    assert seg["spin"] == 0.5 and seg["theta0"] == 0.0
    assert len(seg["to"]) == 120 and len(seg["colorsTo"]) == 120
    try:
        f.set_positions(pts)
        raise AssertionError("set_positions after segments should raise")
    except RuntimeError:
        pass
    print("ok: set_positions seeds the timeline start; timeline_dict is 3D + spin-aware")


def test_spin_rotates_formation():
    f = dl.DotField(n=60, size=(400, 400), seed=2, drift=0.0)   # drift off: exact check
    f.morph_to(dl.circle(), duration=1.0, spin=0.0)
    f.hold(duration=np.pi, spin=1.0)           # exactly pi radians of rotation
    end = f.positions(1.0)                     # formation formed, theta = 0
    half = f.positions(1.0 + np.pi)            # after pi rad: mirrored about center x
    cx = 200.0
    assert np.allclose(half[:, 0] - cx, -(end[:, 0] - cx), atol=0.01), "x should mirror after pi"
    assert np.allclose(half[:, 1], end[:, 1], atol=0.01), "y unchanged by y-axis spin"
    print("ok: spin rotates the formation about the vertical center axis")


def test_scatter_fill_floods_canvas():
    f = dl.DotField(n=400, size=(900, 500), seed=3)
    from dotlib.targets import ScatterSpec

    p = ScatterSpec(mode="fill").build(f).points
    assert p.shape == (400, 3)
    assert p[:, 0].min() >= 0.02 * 900 - 1 and p[:, 0].max() <= 0.98 * 900 + 1
    assert p[:, 1].min() >= 0.02 * 500 - 1 and p[:, 1].max() <= 0.98 * 500 + 1
    assert (p[:, 0].max() - p[:, 0].min()) > 0.8 * 900, "fill should span the full width"
    assert p[:, 2].std() > 5, "fill should have depth"
    f.disperse(style="fill")   # style accepted end-to-end
    print("ok: scatter fill floods the full canvas volume")


def test_face_target_meta():
    try:
        import cv2  # noqa: F401
    except ImportError:
        print("skip: opencv not installed, face meta untested")
        return
    sample = os.path.join(os.path.dirname(__file__), "..", "web", "sample.jpg")
    if not os.path.exists(sample):
        print("skip: web/sample.jpg missing")
        return
    f = dl.DotField(n=300, size=(400, 400), seed=4)
    f.morph_to(dl.face(sample, structure=True, relax=2), duration=1.0)
    m = f.last_target_meta
    assert m and "face_box" in m and len(m["face_box"]) == 4
    x, y, w, h = m["face_box"]
    assert 0 <= x < 400 and 0 <= y < 400 and w > 20 and h > 20
    print(f"ok: face target exposes its canvas face box for region tagging ({[round(v) for v in m['face_box']]})")


def test_mesh_sculpture_layers():
    from dotlib import faces as F

    sample = os.path.join(os.path.dirname(__file__), "..", "web", "sample.jpg")
    if not os.path.exists(sample):
        print("skip: web/sample.jpg missing")
        return
    from PIL import Image as PILImage

    rgb = np.asarray(PILImage.open(sample).convert("RGB"))
    mesh = F.mesh_scan(rgb)
    if mesh is None:
        print("skip: mediapipe mesh unavailable (no wheel or models/face_landmarker.task)")
        return
    assert mesh["points"].shape == (478, 3)
    assert len(mesh["blendshapes"]) >= 50

    from dotlib import facelayers as FL

    f = dl.DotField(n=900, size=(500, 500), seed=6)
    f.morph_to(dl.face(sample, structure=True, relax=3), duration=1.0)
    tags = f.last_target_tags
    regions = (f.last_target_meta or {}).get("regions")
    assert tags is not None and len(tags) == 900
    assert regions and regions["v"] == 2 and "mouth" in regions and "eyeA" in regions
    for tag in (FL.TAG_TEETHU, FL.TAG_TEETHL, FL.TAG_TONGUE, FL.TAG_CAVITY,
                FL.TAG_PUPA, FL.TAG_PUPB, FL.TAG_LIPU, FL.TAG_LIPL):
        assert (tags == tag).sum() > 0, f"layer tag {tag} missing"
    # Face-only sculpture: shallow front shell, NO back of head.
    seg_pts = f.segments[-1].p1
    fw_c = regions["faceW"]
    deep_back = (seg_pts[:, 2] < -0.30 * fw_c).sum()
    assert deep_back == 0, f"back of head should be culled (got {deep_back} deep dots)"
    # Mouth-interior layers ship dimmed toward bg: fully hidden for a closed
    # mouth, proportionally visible for a parted-lips source (restOpen).
    seg = f.segments[-1]
    hidden = np.isin(tags, FL.HIDDEN_TAGS)
    rest = regions.get("restOpen", 0.0)
    assert 0.0 <= rest <= 1.0
    full_teeth = f.bg + (f.fg - f.bg) * FL.TAG_VALUES[FL.TAG_TEETHU]
    assert (seg.c1[hidden] >= f.bg - 1.0).all()
    assert seg.c1[hidden].mean() <= full_teeth.mean() * max(rest, 0.05) + f.bg.mean() + 1.0, \
        "mouth interior should ship dimmed by resting openness"
    pose = F.head_pose(rgb)
    assert pose["backend"] == "mediapipe" and pose["yaw"] is not None
    print(f"ok: mesh sculpture — 478 landmarks, layered tags, hidden interior, "
          f"pose yaw {pose['yaw']}° pitch {pose['pitch']}° roll {pose['roll']}°")


def test_symmetry_and_crown_fill():
    from dotlib import faces as F, facelayers as FL

    sample = os.path.join(os.path.dirname(__file__), "..", "web", "sample.jpg")
    if not os.path.exists(sample):
        print("skip: web/sample.jpg missing")
        return
    from PIL import Image as PILImage

    rgb = np.asarray(PILImage.open(sample).convert("RGB"))
    mesh = F.mesh_scan(rgb)
    if mesh is None:
        print("skip: mediapipe mesh unavailable")
        return
    # Relief must be bilaterally symmetric about the face midline.
    relief = F.landmark_relief(rgb.shape[:2], mesh)
    oval = mesh["points"][F.FACE_OVAL]
    xm = F.mirror_x_map(rgb.shape[1], float(oval[:, 0].mean()))
    assert np.allclose(relief, relief[:, xm], atol=1e-6), "relief should be symmetrized"

    # The lofted head must fill the crown, not stop scanty at the forehead.
    rng = np.random.default_rng(5)
    ring = np.stack([200 + 90 * np.cos(np.linspace(0, 2 * np.pi, 36, endpoint=False)),
                     220 + 115 * np.sin(np.linspace(0, 2 * np.pi, 36, endpoint=False))], axis=1)
    shell = FL.predicted_head_shell(ring, 1200, rng)
    y0 = ring[:, 1].min()
    fh = ring[:, 1].max() - y0
    fw_r = ring[:, 0].max() - ring[:, 0].min()
    crown = ((shell[:, 1] < y0 - 0.03 * fh)).sum()
    back = (shell[:, 2] < -0.30 * fw_r).sum()
    assert crown > 120, f"crown should be filled (got {crown} dots above the hairline)"
    assert back == 0, f"back of head should be culled (got {back} deep-back dots)"
    print(f"ok: symmetrized relief; crown filled ({crown} dots), face-only shell (no back)")


def test_flame_integration():
    from dotlib import flamehead

    tpl = flamehead.load_template()
    if tpl is None:
        print("skip: FLAME model not installed (register at flame.is.tue.mpg.de, "
              "put flame2023.pkl in models/flame/) — loft fallback covers the head")
        return
    ring = np.stack([300 + 100 * np.cos(np.linspace(0, 2 * np.pi, 36, endpoint=False)),
                     300 + 128 * np.sin(np.linspace(0, 2 * np.pi, 36, endpoint=False))], axis=1)
    shell = flamehead.head_shell(ring, 1000, np.random.default_rng(4))
    assert shell is not None and shell.shape == (1000, 3)
    fw = 200.0
    assert (shell[:, 2] < -0.30 * fw).sum() == 0, "back of head should be culled (face-only)"
    assert np.isfinite(shell).all()
    print(f"ok: FLAME face shell active (no back) — {len(tpl['verts'])} verts from {tpl['path']}")


def test_frontalize_removes_captured_pose():
    from dotlib import faces as F

    sample = os.path.join(os.path.dirname(__file__), "..", "web", "sample.jpg")
    if not os.path.exists(sample):
        print("skip: web/sample.jpg missing")
        return
    try:
        import cv2
    except ImportError:
        print("skip: opencv missing")
        return
    from PIL import Image as PILImage

    rgb = np.asarray(PILImage.open(sample).convert("RGB"))
    h, w = rgb.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2, h / 2), 14, 1.0)   # inject 14° roll
    rolled = cv2.warpAffine(rgb, M, (w, h))
    mesh = F.mesh_scan(rolled)
    if mesh is None or mesh.get("matrix") is None:
        print("skip: mediapipe mesh unavailable")
        return
    pose = F._pose_from_matrix(mesh["matrix"])
    assert pose["roll"] > 8, f"injected roll should be detected (got {pose['roll']})"
    R, after = F.best_frontalization(rolled.shape[:2], mesh)
    assert R is not None, "frontalization should engage on a clearly rolled face"
    assert abs(after["roll"]) < 3.0, f"roll should be removed (got {after['roll']})"
    # Self-verification guarantee: whatever rotation is chosen must strictly
    # improve frontality; a bogus rotation can never be applied.
    base = F._pose_from_mesh(cv2, rolled.shape, mesh["points"][:, :2])
    total = lambda p: abs(p["yaw"] or 0) + abs(p["pitch"] or 0) + abs(p["roll"] or 0)
    assert total(after) < total(base)
    print(f"ok: frontalization (matrix-exact, self-verified) roll {pose['roll']}° -> {after['roll']}°")


def test_curved_flight_arcs():
    f = dl.DotField(n=80, size=(300, 300), seed=9, drift=0.0)
    f.morph_to(dl.circle(), duration=1.0, stagger=0.0, arc=0.3)
    seg = f.segments[-1]
    assert seg.arcs is not None and seg.arcs.shape == (80, 3)
    assert f.timeline_dict()["segments"][-1]["arcs"] is not None
    assert np.allclose(f.positions(0.0), seg.p0, atol=1e-6), "arc must vanish at start"
    assert np.allclose(f.positions(1.0), seg.p1, atol=1e-6), "arc must vanish at end"
    straight = seg.p0 + (seg.p1 - seg.p0) * 0.5
    dev = np.linalg.norm(f.positions(0.5) - straight, axis=1)
    assert (dev > 1.0).mean() > 0.6, "mid-flight should bow off the straight chord"
    print(f"ok: curved flight — median mid-flight bow {np.median(dev):.1f}px, endpoints exact")


def test_frontalize_mixed_angles():
    """The failure mode that hit the real camera: roll + pitch + yaw at once.
    Euler recomposition breaks here; the matrix-exact path must recover."""
    from dotlib import faces as F

    sample = os.path.join(os.path.dirname(__file__), "..", "web", "sample.jpg")
    if not os.path.exists(sample):
        print("skip: web/sample.jpg missing")
        return
    try:
        import cv2  # noqa: F401
    except ImportError:
        print("skip: opencv missing")
        return
    from PIL import Image as PILImage

    rgb = np.asarray(PILImage.open(sample).convert("RGB"))
    mesh = F.mesh_scan(rgb)
    if mesh is None or mesh.get("matrix") is None:
        print("skip: mediapipe mesh unavailable")
        return

    def rot(axis, deg):
        a = np.radians(deg)
        c, s = np.cos(a), np.sin(a)
        if axis == "x":
            return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])
        if axis == "y":
            return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
        return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])

    # Big compound head turn in canvas space (like the real bad capture).
    R_c = rot("z", 24) @ rot("x", 16) @ rot("y", 28)
    pts = mesh["points"]
    c = pts.mean(axis=0)
    pts_rot = (pts - c) @ R_c.T + c
    S = F._S_FLIP
    M_syn = mesh["matrix"].copy()
    M_syn[:3, :3] = (S @ R_c @ S) @ mesh["matrix"][:3, :3]
    mesh2 = {"points": pts_rot, "matrix": M_syn, "blendshapes": {}}

    total = lambda p: abs(p.get("yaw") or 0) + abs(p.get("pitch") or 0) + abs(p.get("roll") or 0)
    base = F._pose_from_mesh(cv2, rgb.shape, pts_rot[:, :2])
    R, after = F.best_frontalization(rgb.shape[:2], mesh2)
    assert R is not None, "compound rotation must trigger frontalization"
    assert total(after) < total(base) * 0.35, f"compound pose should mostly vanish ({base} -> {after})"
    assert total(after) < 12.0, f"residual too large: {after}"
    print(f"ok: mixed-angle frontalization — compound {total(base):.0f}° residual -> {total(after):.1f}°")


def test_small_field_face_does_not_crash():
    """Regression: n below (and just above) the 200-dot face floor used to make
    the shell budget negative/zero and crash the head-shell samplers."""
    sample = os.path.join(os.path.dirname(__file__), "..", "web", "sample.jpg")
    if not os.path.exists(sample):
        print("skip: web/sample.jpg missing")
        return
    try:
        import cv2  # noqa: F401
    except ImportError:
        print("skip: opencv missing")
        return
    for n in (40, 150, 201, 260):
        f = dl.DotField(n=n, size=(400, 400), seed=3)
        f.morph_to(dl.face(sample, structure=True, relax=2), duration=1.0)
        pts = f.segments[-1].p1
        assert pts.shape == (n, 3), f"n={n} produced {pts.shape}"
        assert np.isfinite(pts).all(), f"n={n} produced non-finite points"
    print("ok: face builds at tiny dot counts (40/150/201/260) without crashing")


def test_arc_never_inverts_under_overshoot_easing():
    """Regression: back/elastic overshoot past e=1, which flipped the flight
    bow to the wrong side of the chord."""
    from dotlib.easing import get_easing

    for easing in ("back", "elastic"):
        f = dl.DotField(n=120, size=(400, 400), seed=11, drift=0.0)
        f.morph_to(dl.circle(), duration=1.0, stagger=0.0, arc=0.30, easing=easing)
        seg = f.segments[-1]
        ease = get_easing(easing)
        norm2 = (seg.arcs ** 2).sum(axis=1) + 1e-12
        worst = 0.0
        for t in np.linspace(0.02, 0.98, 25):
            e = float(np.asarray(ease(np.clip((t - seg.t0) / seg.duration, 0.0, 1.0))))
            chord = seg.p0 + (seg.p1 - seg.p0) * e
            proj = ((f.positions(t) - chord) * seg.arcs).sum(axis=1) / norm2
            worst = min(worst, float(proj.min()))
        assert worst >= -1e-6, f"{easing}: bow inverted (worst projection {worst:.4f})"
    print("ok: curved flight never inverts, even under back/elastic overshoot")


def test_segment_head_forced_box():
    try:
        import cv2  # noqa: F401
    except ImportError:
        print("skip: opencv not installed, segmentation untested")
        return
    from dotlib.faces import Face, segment_head

    rng = np.random.default_rng(3)
    img = (rng.uniform(15, 45, (240, 240, 3))).astype(np.uint8)      # dark noisy bg
    yy, xx = np.mgrid[0:240, 0:240]
    disk = (xx - 120) ** 2 + (yy - 110) ** 2 < 55**2                  # bright "head"
    img[disk] = (205, 170, 140)
    mask = segment_head(img, face=Face((78, 68, 84, 84)))
    assert mask is not None and mask.shape == (240, 240)
    inside = float(mask[disk].mean())
    corners = float(mask[:40, :40].mean() + mask[:40, -40:].mean()) / 2
    assert inside > 0.8, f"head should be foreground (got {inside:.2f})"
    assert corners < 0.15, f"background should be removed (got {corners:.2f})"
    print(f"ok: segment_head isolates the head (inside {inside:.2f}, corners {corners:.2f})")


def test_face_module_loads():
    try:
        import cv2  # noqa: F401
    except ImportError:
        print("skip: opencv not installed, face module untested")
        return
    from dotlib.faces import detect_faces

    blank = np.full((240, 240, 3), 128, dtype=np.uint8)
    assert detect_faces(blank) == []  # cascade loads and runs; no face in a blank image
    print("ok: face cascade loads and runs")


if __name__ == "__main__":
    test_assignment_is_permutation()
    test_exact_beats_random_pairing()
    test_hilbert_locality()
    test_stipple_respects_mask()
    test_field_timeline_and_render()
    test_image_target_colors()
    test_set_positions_and_timeline_dict()
    test_spin_rotates_formation()
    test_scatter_fill_floods_canvas()
    test_face_target_meta()
    test_mesh_sculpture_layers()
    test_symmetry_and_crown_fill()
    test_flame_integration()
    test_frontalize_removes_captured_pose()
    test_frontalize_mixed_angles()
    test_curved_flight_arcs()
    test_arc_never_inverts_under_overshoot_easing()
    test_small_field_face_does_not_crash()
    test_segment_head_forced_box()
    test_face_module_loads()
    print("\nall sanity checks passed")
