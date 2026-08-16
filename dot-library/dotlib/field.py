"""DotField: the particle field and its animation timeline.

The field is natively 3D: every dot has (x, y, z) and formations are point
clouds with depth — a scanned face becomes a floating bust, the idle state is
a volumetric cloud, and any formation can slowly rotate (`spin`) about the
vertical axis through the canvas center. Rendering projects with perspective:
closer dots draw larger and brighter.

You build a timeline by chaining calls (morph_to / hold / disperse), then
evaluate it at any time with positions(t) / frame(t), or export it with
save() / timeline_dict(). Everything is deterministic for a given seed.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

import numpy as np

from . import assign, targets as T
from ._util import parse_color, progress_line
from .easing import get_easing
from .noise import Drift
from .render import render_frame, save_frames


@dataclass
class Segment:
    kind: str
    t0: float
    t1: float
    p0: np.ndarray            # (n, 3)
    p1: np.ndarray            # (n, 3)
    c0: np.ndarray
    c1: np.ndarray
    a0: float
    a1: float
    amp0: float
    amp1: float
    spin: float = 0.0         # rad/s about the vertical center axis
    theta0: float = 0.0       # accumulated rotation angle at t0 (continuity)
    sway0: float = 0.0        # oscillating-rotation amplitude (rad) at t0
    sway1: float = 0.0        # ... and at t1 (lerped across the segment)
    easing: str = "cubic"
    delays: np.ndarray | None = None
    arcs: np.ndarray | None = None    # (n, 3) per-dot curved-flight bow vectors
    name: str = ""

    @property
    def duration(self) -> float:
        return self.t1 - self.t0


class DotField:
    def __init__(
        self,
        n: int = 2000,
        size: tuple[int, int] = (800, 800),
        seed: int | None = None,
        dot_radius: float = 2.2,
        radius_jitter: float = 0.18,
        bg="#0c0d11",
        fg="#f2f3f7",
        drift: float = 1.4,
        drift_speed: float = 0.55,
        camera: float | None = None,
        sway_speed: float = 0.45,
    ):
        self.n = int(n)
        self.size = (int(size[0]), int(size[1]))
        self.rng = np.random.default_rng(seed)
        self.bg = parse_color(bg)
        self.fg = parse_color(fg)
        self.base_drift = float(drift)
        # Perspective camera distance from the z=0 plane, in canvas px.
        self.camera = float(camera) if camera else 2.4 * min(self.size)

        self._drift = Drift(self.n, self.rng, speed=drift_speed)
        self.radii = dot_radius * (1 + radius_jitter * self.rng.uniform(-1, 1, self.n))

        # Current end-of-timeline state.
        start = T.scatter().build(self)
        self.anchors = start.points                       # (n, 3)
        self.colors = np.tile(self.fg, (self.n, 1))
        self.alpha = 1.0
        self.drift_amp = self.base_drift * 2.2            # resting cloud drifts a bit more
        self.spin = 0.0                                   # rad/s at end of timeline
        self._theta_end = 0.0                             # accumulated angle at end of timeline
        # Sway: oscillating rotation theta += sway * sin(sway_speed * t). A
        # relief (single-view face) shown swaying +-20 deg reads as a full 3D
        # object without ever exposing its degenerate edge-on profile.
        self.sway = 0.0                                   # amplitude (rad) at end of timeline
        self.sway_speed = float(sway_speed)               # rad/s, global (phase continuity)

        self.segments: list[Segment] = []
        self._t = 0.0
        self.last_target_meta: dict | None = None   # meta of the most recent morph target
        self.last_target_tags: np.ndarray | None = None  # per-dot layer tags (dot order)

    # ------------------------------------------------------------- timeline building

    def set_positions(self, pts) -> "DotField":
        """Seed the starting dot positions (e.g. from a live client's current
        dot state) so the first morph departs from exactly where dots are now.
        Accepts (n, 2) — z is padded with 0 — or (n, 3). Must be called before
        any segments are added."""
        pts = np.asarray(pts, dtype=np.float64)
        if pts.shape == (self.n, 2):
            pts = np.hstack([pts, np.zeros((self.n, 1))])
        if pts.shape != (self.n, 3):
            raise ValueError(f"expected positions of shape {(self.n, 2)} or {(self.n, 3)}, got {pts.shape}")
        if self.segments:
            raise RuntimeError("set_positions must be called before adding timeline segments")
        self.anchors = pts.copy()
        return self

    def _push(self, kind: str, duration: float, p1: np.ndarray, c1: np.ndarray,
              a1: float, amp1: float, easing: str, stagger: float, name: str,
              spin: float | None = None, sway: float | None = None,
              arc: float = 0.0) -> "DotField":
        duration = max(float(duration), 1e-6)
        spin = self.spin if spin is None else float(spin)
        sway = self.sway if sway is None else float(sway)
        delays = None
        if stagger > 0:
            delays = self.rng.uniform(0, min(stagger, 0.95), self.n)
        arcs = None
        if arc > 0:
            # Curved flight: each dot bows sideways (and in z) off its straight
            # line by a random amount scaled to its travel distance, peaking at
            # mid-flight — fluid swooping instead of mechanical straight runs.
            delta = p1 - self.anchors
            dist = np.linalg.norm(delta[:, :2], axis=1, keepdims=True)
            safe = np.maximum(dist, 1e-6)
            perp = np.column_stack([-delta[:, 1], delta[:, 0]]) / safe
            amps = np.clip(self.rng.normal(0.0, arc, (self.n, 1)), -0.5, 0.5) * dist
            zamps = np.clip(self.rng.normal(0.0, 0.6 * arc, (self.n, 1)), -0.35, 0.35) * dist
            arcs = np.hstack([perp * amps, zamps])
        seg = Segment(
            kind=kind, t0=self._t, t1=self._t + duration,
            p0=self.anchors.copy(), p1=p1.copy(),
            c0=self.colors.copy(), c1=c1.copy(),
            a0=self.alpha, a1=a1, amp0=self.drift_amp, amp1=amp1,
            spin=spin, theta0=self._theta_end, sway0=self.sway, sway1=sway,
            easing=easing, delays=delays, arcs=arcs, name=name,
        )
        self.segments.append(seg)
        self._t = seg.t1
        self._theta_end += spin * duration
        self.anchors, self.colors, self.alpha, self.drift_amp = p1, c1, a1, amp1
        self.spin, self.sway = spin, sway
        return self

    def morph_to(self, spec: T.TargetSpec, duration: float = 2.0, easing: str = "cubic",
                 stagger: float = 0.35, drift: float | None = None,
                 spin: float | None = None, sway: float | None = None,
                 arc: float = 0.22, match_method: str = "auto") -> "DotField":
        """Arrange the dots into a target (text/image/face/shape/points).

        `spin` (rad/s) continuously rotates the formation about the vertical
        center axis; `sway` (rad) makes it oscillate +-that angle instead —
        the right choice for single-view reliefs like scanned faces, which
        read as full 3D under parallax but degenerate edge-on. None keeps the
        current rates. `arc` curves each dot's flight path (0 = straight)."""
        target = spec.build(self)
        self.last_target_meta = target.meta
        perm = assign.match(self.anchors, target.points, method=match_method)
        # Tags travel with their target points: dot i takes the tag of the
        # target point it was assigned to.
        self.last_target_tags = None if target.tags is None else np.asarray(target.tags)[perm]
        p1 = target.points[perm]
        c1 = target.colors[perm] if target.colors is not None else np.tile(self.fg, (self.n, 1))
        amp1 = self.base_drift if drift is None else float(drift)
        return self._push("morph", duration, p1, c1, 1.0, amp1, easing, stagger,
                          target.name, spin=spin, sway=sway, arc=arc)

    def hold(self, duration: float = 1.0, drift: float | None = None,
             spin: float | None = None, sway: float | None = None) -> "DotField":
        """Keep the current arrangement (dots keep their gentle drift, and the
        formation keeps rotating/swaying)."""
        amp1 = self.drift_amp if drift is None else float(drift)
        return self._push("hold", duration, self.anchors, self.colors,
                          self.alpha, amp1, "linear", 0.0, "hold", spin=spin, sway=sway)

    def disperse(self, duration: float = 1.6, style: str = "drift", easing: str | None = None,
                 stagger: float = 0.3, fade: bool = False, drift: float | None = None,
                 spin: float | None = None, sway: float | None = None) -> "DotField":
        """Break the arrangement: 'drift' melts back into a floating cloud,
        'fill' floods the entire canvas edge-to-edge, 'explode' bursts outward."""
        if style == "drift":
            spec, ease = T.scatter(), easing or "cubic"
        elif style == "fill":
            spec, ease = T.scatter(mode="fill"), easing or "cubic"
        elif style == "explode":
            spec, ease = T.ExplodeSpec(), easing or "expo"
        else:
            raise ValueError(f"unknown disperse style {style!r} (use 'drift', 'fill', or 'explode')")
        target = spec.build(self)
        perm = assign.match(self.anchors, target.points)
        amp1 = self.base_drift * 2.2 if drift is None else float(drift)
        return self._push("disperse", duration, target.points[perm], self.colors.copy(),
                          0.0 if fade else 1.0, amp1, ease, stagger, target.name,
                          spin=spin, sway=sway, arc=0.14)

    # ------------------------------------------------------------- evaluation

    @property
    def duration(self) -> float:
        return self._t

    def _segment_at(self, t: float) -> Segment | None:
        for seg in self.segments:
            if t < seg.t1:
                return seg
        return self.segments[-1] if self.segments else None

    def _sway_wave(self, t: float) -> float:
        """Two incommensurate sines: an organic wander, not a metronome."""
        w = self.sway_speed
        return 0.72 * np.sin(w * t) + 0.28 * np.sin(1.417 * w * t + 1.1)

    def _rotate_y(self, pts: np.ndarray, theta: float) -> np.ndarray:
        """Rotate points about the vertical axis through the canvas center."""
        if abs(theta) < 1e-12:
            return pts
        cx = self.size[0] / 2.0
        c, s = np.cos(theta), np.sin(theta)
        x = pts[:, 0] - cx
        z = pts[:, 2]
        out = pts.copy()
        out[:, 0] = cx + x * c + z * s
        out[:, 2] = -x * s + z * c
        return out

    def state(self, t: float) -> tuple[np.ndarray, np.ndarray, float]:
        """(positions (n,3), colors, alpha) at absolute time t — drift and
        rotation included; positions are world coordinates."""
        seg = self._segment_at(t)
        if seg is None:
            pos = self.anchors + self.drift_amp * self._drift(t)
            theta = self._theta_end + self.spin * t + self.sway * self._sway_wave(t)
            return self._rotate_y(pos, theta), self.colors, self.alpha

        p = np.clip((t - seg.t0) / seg.duration, 0.0, 1.0)
        ease = get_easing(seg.easing)
        if seg.delays is not None:
            pe = np.clip((p - seg.delays) / (1.0 - seg.delays), 0.0, 1.0)
            e = np.asarray(ease(pe), dtype=np.float64)[:, None]
        else:
            e = float(np.asarray(ease(p)))

        pos = seg.p0 + (seg.p1 - seg.p0) * e
        if seg.arcs is not None:
            # Curved flight: bow peaks mid-travel, zero at both endpoints.
            pos = pos + seg.arcs * np.sin(np.pi * np.asarray(e))
        col = seg.c0 + (seg.c1 - seg.c0) * e
        pl = float(np.asarray(ease(p)))
        alpha = seg.a0 + (seg.a1 - seg.a0) * pl
        amp = seg.amp0 + (seg.amp1 - seg.amp0) * p
        pos = pos + amp * self._drift(t)
        # Rotation runs on unclamped time so a formed object keeps turning /
        # swaying even after the timeline's last segment ends. The sway wave
        # uses absolute time so its phase is continuous across segments.
        sway_amp = seg.sway0 + (seg.sway1 - seg.sway0) * p
        theta = seg.theta0 + seg.spin * (t - seg.t0) + sway_amp * self._sway_wave(t)
        return self._rotate_y(pos, theta), col, alpha

    def positions(self, t: float) -> np.ndarray:
        """(n, 3) world dot positions at time t — for driving an external renderer."""
        return self.state(t)[0]

    def frame(self, t: float, supersample: int = 2):
        """Render one PIL image at time t (perspective projection)."""
        pos, col, alpha = self.state(t)
        return render_frame(pos, col, self.radii, self.size, self.bg, alpha,
                            supersample, camera=self.camera)

    # ------------------------------------------------------------- output

    def frames(self, fps: int = 30, supersample: int = 2):
        total = max(int(round(self.duration * fps)), 1) + 1
        for i in range(total):
            yield self.frame(i / fps, supersample=supersample)

    def save(self, path: str, fps: int = 30, supersample: int = 2, quiet: bool = False) -> str:
        """Write the whole timeline to .gif / .mp4 / a directory of .png frames."""
        total = max(int(round(self.duration * fps)), 1) + 1

        def gen():
            for i in range(total):
                if not quiet:
                    progress_line(i + 1, total, f"rendering {path}")
                yield self.frame(i / fps, supersample=supersample)

        return save_frames(gen(), path, fps=fps)

    def timeline_dict(self, round_px: int = 1) -> dict:
        """The compiled timeline (keyframes + easing metadata) as a plain dict,
        for another engine (JS/GL/native) to replay the exact same animation.
        Points are (x, y, z); replayers apply per-segment spin about the
        vertical center axis, then project with the given camera distance."""
        return {
            "version": 2,
            "n": self.n,
            "size": list(self.size),
            "duration": self.duration,
            "camera": round(self.camera, 2),
            "swaySpeed": round(self.sway_speed, 4),
            "bg": self.bg.tolist(),
            "fg": self.fg.tolist(),
            "radii": np.round(self.radii, 2).tolist(),
            "segments": [
                {
                    "kind": s.kind, "name": s.name, "t0": round(s.t0, 4), "t1": round(s.t1, 4),
                    "easing": s.easing,
                    "alpha": [s.a0, s.a1], "driftAmp": [s.amp0, s.amp1],
                    "spin": round(s.spin, 5), "theta0": round(s.theta0, 5),
                    "sway": [round(s.sway0, 5), round(s.sway1, 5)],
                    "delays": None if s.delays is None else np.round(s.delays, 3).tolist(),
                    "arcs": None if s.arcs is None else np.round(s.arcs, 1).tolist(),
                    "from": np.round(s.p0, round_px).tolist(),
                    "to": np.round(s.p1, round_px).tolist(),
                    "colorsFrom": np.round(s.c0, 0).tolist(),
                    "colorsTo": np.round(s.c1, 0).tolist(),
                }
                for s in self.segments
            ],
        }

    def export_json(self, path: str, round_px: int = 1) -> str:
        """Write timeline_dict() to a JSON file."""
        with open(path, "w") as f:
            json.dump(self.timeline_dict(round_px), f)
        return path

    def __repr__(self) -> str:
        names = " -> ".join(s.name for s in self.segments) or "(empty)"
        return f"DotField(n={self.n}, size={self.size}, {self.duration:.2f}s: {names})"
