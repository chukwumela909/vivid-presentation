"""dotlib — a particle field that arranges dots into text, shapes, and images
(face-aware), holds them, and disperses them again. cloudstudio.es-style
morphing, generalized to arbitrary targets.

Quickstart:

    import dotlib as dl

    f = dl.DotField(n=2200, size=(720, 720), seed=7)
    f.hold(0.6, drift=3)
    f.morph_to(dl.text("HELLO"), duration=2.0)
    f.hold(1.0)
    f.morph_to(dl.face("me.jpg", color=True), duration=2.4)
    f.hold(1.4)
    f.disperse(duration=1.6)
    f.save("hello.gif", fps=30)
"""

from .field import DotField
from .targets import (
    Target,
    TargetSpec,
    circle,
    face,
    heart,
    image,
    points,
    polygon,
    ring,
    scatter,
    spiral,
    star,
    text,
)
from .assign import match
from .sampling import density_from_image, lloyd_relax, sample_density, stipple

__version__ = "0.1.0"

__all__ = [
    "DotField",
    "Target",
    "TargetSpec",
    "text",
    "image",
    "face",
    "points",
    "circle",
    "ring",
    "polygon",
    "star",
    "heart",
    "spiral",
    "scatter",
    "match",
    "stipple",
    "sample_density",
    "lloyd_relax",
    "density_from_image",
    "__version__",
]
