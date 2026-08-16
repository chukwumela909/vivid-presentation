"""Full showcase: cloud -> SPOT -> heart -> full-color image -> disperse.

Generates a synthetic colorful test image so it runs with no assets; swap
`make_test_image()` for any photo path to stipple your own picture.
"""

import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import dotlib as dl

out_dir = os.path.join(os.path.dirname(__file__), "..", "out")
os.makedirs(out_dir, exist_ok=True)


def make_test_image(size: int = 512) -> Image.Image:
    """A bright sun-over-hills scene: enough color/structure to show image mode."""
    img = Image.new("RGB", (size, size), (8, 8, 14))
    d = ImageDraw.Draw(img)
    # Sky gradient bands
    for i in range(size):
        t = i / size
        d.line([(0, i), (size, i)], fill=(int(30 + 60 * t), int(18 + 30 * t), int(60 + 90 * t)))
    # Sun
    d.ellipse([size * 0.30, size * 0.16, size * 0.70, size * 0.56], fill=(255, 190, 60))
    d.ellipse([size * 0.36, size * 0.22, size * 0.64, size * 0.50], fill=(255, 230, 120))
    # Hills
    d.polygon([(0, size * 0.78), (size * 0.34, size * 0.52), (size * 0.62, size * 0.80), (0, size * 0.98)],
              fill=(50, 170, 120))
    d.polygon([(size * 0.42, size * 0.86), (size * 0.72, size * 0.55), (size, size * 0.82), (size, size)],
              fill=(35, 130, 150))
    return img.filter(ImageFilter.GaussianBlur(2))


test_img = make_test_image()
test_img.save(os.path.join(out_dir, "test_image.png"))

field = dl.DotField(n=2200, size=(640, 640), seed=11, dot_radius=2.0,
                    bg="#0c0d11", fg="#f2f3f7")
field.hold(0.7, drift=3.2)
field.morph_to(dl.text("SPOT"), duration=2.0)
field.hold(0.9, drift=1.0)
field.morph_to(dl.heart(), duration=1.8, easing="back")
field.hold(0.8)
field.morph_to(dl.image(np.asarray(test_img), color=True, gamma=1.2), duration=2.2)
field.hold(1.3, drift=0.9)
field.disperse(duration=1.7)

print(field)
field.save(os.path.join(out_dir, "demo.gif"), fps=24)
try:
    field.save(os.path.join(out_dir, "demo.mp4"), fps=30)
except ImportError as e:
    print(f"(skipped mp4: {e})")
field.export_json(os.path.join(out_dir, "demo_timeline.json"))
