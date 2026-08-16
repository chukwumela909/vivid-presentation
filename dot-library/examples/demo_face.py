"""Face demo: dots arrange into a portrait with face-aware detail, then disperse.

Usage:
    python examples/demo_face.py path/to/photo.jpg

Works best with a clear, front-facing portrait. Face detection boosts dot
density on the face (eyes/mouth especially); if no face is found it falls
back to a plain image stipple.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import dotlib as dl

if len(sys.argv) < 2:
    print("usage: python examples/demo_face.py path/to/photo.jpg")
    sys.exit(1)

photo = sys.argv[1]
out_dir = os.path.join(os.path.dirname(__file__), "..", "out")
os.makedirs(out_dir, exist_ok=True)

field = dl.DotField(n=3200, size=(720, 720), seed=7, dot_radius=1.9)
field.hold(0.7, drift=3.0)
# Monochrome 3D bust: head segmented out, depth from the face structure,
# swaying +-22 degrees so the parallax sells the volume.
field.morph_to(dl.face(photo, structure=True), duration=2.6, sway=0.38)
field.hold(7.0, drift=0.8)
field.disperse(duration=1.8, style="explode", sway=0.0)

print(field)
field.save(os.path.join(out_dir, "face.gif"), fps=24)
field.export_json(os.path.join(out_dir, "face_timeline.json"))
