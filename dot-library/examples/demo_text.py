"""Minimal demo: cloud -> word -> cloud."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import dotlib as dl

out_dir = os.path.join(os.path.dirname(__file__), "..", "out")
os.makedirs(out_dir, exist_ok=True)

field = dl.DotField(n=1800, size=(640, 400), seed=3)
field.hold(0.6, drift=3.0)
field.morph_to(dl.text("HELLO"), duration=1.8)
field.hold(1.0)
field.disperse(duration=1.4)

print(field)
field.save(os.path.join(out_dir, "hello.gif"), fps=24)
