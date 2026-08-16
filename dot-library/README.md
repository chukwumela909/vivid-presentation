# dotlib

A particle-field engine in Python: a **3D cloud of dots** that arranges itself
into text, shapes, or faces — as floating depth objects, not flat pictures —
holds the pose, and disperses again. The same idea as the dot-morphing on
[cloudstudio.es](https://cloudstudio.es/), generalized so the dots can become
anything you can express as an image or a point set.

> Lives in the **vivid-presentation** repo as `dot-library/`. It is a
> standalone Python package — nothing in the Vivid page imports it yet. The
> integration seam is `field.timeline_dict()` (replay the exact animation in
> JS/WebGL, as `web/static/app.js` already does) and `dl.points()` (feed it
> point sets from any model).

Every dot carries (x, y, z). A scanned face becomes a face **sculpture**: the
478-landmark mesh supplies true depth (nose out, sockets in), the FLAME
statistical head model supplies the surrounding form, and the back of the head
is culled — it is the face, not a skull. The renderer projects with
perspective (closer dots draw larger and brighter, painter-sorted). Formations
can `spin` continuously or `sway`; in the web app rotation belongs to the
user, who drags the head directly.

Every dot is tracked individually: targets are stippled into clean point
arrangements, and an optimal-assignment step gives each dot exactly one
destination (no skipped targets, no doubled-up dots, minimal criss-crossing),
so formations resolve cleanly and disperse just as cleanly.

## Install

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[all]"        # opencv (faces) + mediapipe (mesh) + imageio (mp4) + flask (web)

# one-time: the two MediaPipe models (Google's official model bucket)
curl -L -o models/face_landmarker.task \
  https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task   # 3.7 MB
curl -L -o models/selfie_multiclass_256x256.tflite \
  https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite  # 16 MB
```

**FLAME head (recommended):** dotlib uses the FLAME statistical head model —
the reference full-human-head model (cranium, occiput, ears) — as the head
shell when its file is installed. It is license-gated, so one manual step:
register free at https://flame.is.tue.mpg.de, download **FLAME 2023**, unzip,
and place `flame2023.pkl` at `models/flame/flame2023.pkl`. Check with
`python -m dotlib.flamehead`. Without it, dotlib lofts a head from your own
jawline (automatic fallback). Only the neutral template surface is read —
plain pickle+numpy, no torch.

Core needs only `numpy`, `scipy`, `pillow`. Extras: `[face]` OpenCV detection,
`[mesh]` MediaPipe FaceLandmarker — 478 3D landmarks, 52 expression
blendshapes, true head pose, and the layered face sculpture (teeth, tongue,
eyeballs). Without it everything still works via the OpenCV fallback path.
Note: mediapipe is pinned `<0.11` — the 1.x macOS wheels crash requesting a
GPU service.

## Quickstart

```python
import dotlib as dl

field = dl.DotField(n=2200, size=(720, 720), seed=7)

field.hold(0.7, drift=3.0)                                 # idle cloud, breathing
field.morph_to(dl.text("SPOT"), duration=2.0)              # dots form the word
field.hold(1.0)
field.morph_to(dl.face("me.jpg", color=True), duration=2.4) # arrange into a portrait
field.hold(1.5, drift=0.8)
field.disperse(duration=1.6)                               # melt back into the cloud

field.save("spot.gif", fps=30)      # or .mp4, or a folder of PNG frames
```

## Targets

| Target | What it does |
| --- | --- |
| `dl.text("HI", font=None)` | Renders the string (any system font), fills the glyphs with evenly arranged dots |
| `dl.image(src, color=False, tone="auto", gamma=1.6, edges=0.0)` | Stipples a photo/array: dot density follows brightness, `color=True` samples the image's colors per dot, `edges` blends in outline emphasis |
| `dl.face(src, boost=2.6, color=False, crop=True, segment=True)` | `image` + face detection: zooms into the detected face (`crop=False` keeps full framing), **segments out the head so the background gets zero dots** (`segment=False` keeps it), and boosts density on the face — eyes/mouth especially — so portraits read clearly |
| `dl.points(arr, colors=None)` | Your own `(n, 2)` point set — the hook for external models (landmarks, meshes, generative output) |
| `dl.circle() / ring() / polygon(6) / star() / heart() / spiral()` | Geometric formations |
| `dl.scatter()` | Uniform cloud (the resting state) |

## Timeline verbs

- `field.morph_to(target, duration, easing="cubic", stagger=0.35, match_method="auto")`
- `field.hold(duration, drift=...)` — keep formation; dots keep a gentle organic drift
- `field.disperse(duration, style="drift" | "explode", fade=False)`

Easings: `linear, quad, cubic, quint, expo, back (overshoot), elastic`.
`stagger` staggers per-dot start times so formations ripple in instead of
moving as one rigid sheet.

## How it works

1. **Density map** — the target (text mask, image luminance, face-boosted
   luminance, shape mask) becomes a 2D probability map.
2. **Stippling** — dots are importance-sampled from the map, then tightened
   with weighted Lloyd relaxation into an even, print-quality arrangement
   (no clumps, no gaps) that recreates the source.
3. **Assignment** — current dot positions are matched to target points with
   the Hungarian algorithm (optimal, ≤ ~2.6k dots) or a Hilbert-curve rank
   pairing (near-optimal, scales to 100k+). The result is a strict
   permutation: every target point gets exactly one dot.
4. **Animation** — anchors interpolate with easing + per-dot stagger, and a
   smooth per-dot drift (continuous across segments) keeps the field alive
   even while holding a pose.

## Camera web app

A full working consumer of the library: a page where your webcam face is
scanned, segmented, and rebuilt out of dots in the middle of a blank space —
then dispersed again.

```bash
pip install -e ".[web]"
python web/server.py        # open http://127.0.0.1:5177
```

- **Enable camera** → auto-scans once: your face forms out of the idle cloud
  as a monochrome 3D head — a predefined closed egg of dots (it has a back;
  it can turn fully and disperses gracefully) carrying your scanned **face
  structure** on its front: landmark-true relief, presented forward no matter
  what angle the camera caught (`frontalize`), swaying ±22°. Nothing else
  from the image — no background, neck, or shoulders — enters the sculpture.
- **Live** → re-scans every ~2.4 s, so the dots keep tracking you as you move.
- **Word / Shape** → the same dots morph into any typed word or a cycling
  shape (heart, star, ring, spiral, polygon), then back.
- **Talk** → the mouth and jaw dots animate with syllable-like pulses — the
  bust talks. Eyes blink on their own, and the pupils (plus a subtle head
  turn) follow your cursor.
- **Disperse** → the dots flood the entire viewport edge-to-edge, then any
  target (including your face, cached server-side) pulls them back.
- **Auto** → ambient mode: cycles word → shape → full-screen disperse → face.
- **Sample** → runs the whole pipeline on `web/sample.jpg`, no camera needed.

Expressions are driven client-side on a **layered anatomy**: with the mesh
extra installed, face scans sample 18 tagged dot layers — skin, upper/lower
lips, eyelids, jaw, brows, upper/lower teeth, tongue, mouth cavity, and
per-eye sclera/iris/pupil. The mouth opens onto teeth and tongue instead of a
hole (interior layers ship hidden and are revealed with openness — or stay
partially visible if you scanned a smile); blinks sweep the lid dots down
over the eyeballs; pupils track your cursor with natural saccades when idle;
the whole sculpture breathes, and brows rise occasionally. All offsets are
applied in face space before the sway rotation, so expressions ride the
moving head correctly. Scan-time blendshapes (jawOpen, smiles, blinks — 52
coefficients) arrive in `meta.expression`, and the talk level is a single
scalar you can later drive from real audio or visemes instead of the
procedural syllable pattern.

All particle math happens server-side in dotlib (`/api/scan`: detect →
segment head → stipple → assign from the browser's current dot positions);
the browser replays `timeline_dict()` with identical easing/stagger/drift
semantics (`web/static/app.js`). The HUD shows head angles from
`dotlib.faces.head_pose()` — yaw/pitch/roll with MediaPipe when installed,
5-point YuNet (set `DOTLIB_YUNET_MODEL`), or roll-only via Haar eyes
otherwise. Note: MediaPipe wheels for Python 3.13/arm64 currently ship
without the bundled-model `solutions` API — use a 3.12 venv if you want the
full 468-landmark pose path today.

## Driving your own renderer (Vivid AI / web / native)

The Python renderer (GIF/MP4) is just one consumer. For a live engine:

- `field.positions(t)` / `field.state(t)` — evaluate dot positions, colors,
  and alpha at any time `t` for a realtime loop.
- `field.export_json("timeline.json")` — the compiled timeline (per-segment
  from/to keyframes, easing names, stagger delays, drift amplitudes) so a
  JS/WebGL/native front end can replay the identical animation.
- `dl.points(...)` — feed point sets from any upstream model (face landmarks,
  segmentation masks, generative outputs) straight into the morph pipeline.

## Examples

```bash
python examples/demo_text.py                 # HELLO in/out
python examples/demo_sequence.py             # cloud -> SPOT -> heart -> color image -> disperse
python examples/demo_face.py photo.jpg       # portrait with face-aware detail
python tests/test_sanity.py                  # sanity checks
```

Outputs land in `out/`.
