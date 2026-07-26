from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).parents[1]
SOURCE = Path("/home/ubuntu/office-art")
ART = ROOT / "office" / "art"


def key(path: Path, dest: Path, crop=None, trim=True, figure=False):
    image = Image.open(path).convert("RGB")
    pixels = np.asarray(image).astype(np.float32)
    if crop:
        x0, y0, x1, y1 = crop
        pixels = pixels[y0:y1, x0:x1]

    spread = pixels.max(2) - pixels.min(2)
    neutral = (spread <= 18) & (pixels[:, :, 1] > 30)
    alpha = np.where(neutral, 1, np.clip((pixels[:, :, 1] - 3) / 252, 0, 1))
    alpha[alpha < 0.18] = 0

    magenta = np.array([250, 3, 245], dtype=np.float32)
    edge = alpha < 0.98
    recovered = (pixels - (1 - alpha[:, :, None]) * magenta) / np.maximum(
        alpha[:, :, None], 0.08
    )
    rgb = np.clip(pixels, 0, 255).astype(np.uint8)
    rgb[edge] = np.clip(recovered[edge], 0, 255).astype(np.uint8)

    if figure:
        luminance = rgb.mean(2)
        light = (alpha > 0.35) & (luminance > 220)
        tone = np.full(light.sum(), 185, dtype=np.uint8)
        rgb[light] = np.stack([tone, tone, tone], axis=1)

    rgba = np.dstack([rgb, (alpha * 255).round().astype(np.uint8)])
    if trim:
        bbox = Image.fromarray(rgba).getchannel("A").getbbox()
        if bbox:
            rgba = rgba[bbox[1] : bbox[3], bbox[0] : bbox[2]]

    magenta_survivors = (
        (rgba[:, :, 0] > rgba[:, :, 1] * 1.3)
        & (rgba[:, :, 2] > rgba[:, :, 1] * 1.3)
        & (rgba[:, :, 0] > 100)
        & (rgba[:, :, 3] > 12)
    )
    assert not magenta_survivors.any(), f"{dest}: magenta-dominant pixels"

    Image.fromarray(rgba, "RGBA").save(dest, format="WEBP", quality=82, method=6)


key(SOURCE / "leader-room-white.png", ART / "leader-room-white.webp")
key(
    SOURCE / "desk-and-chair-white.png",
    ART / "desk-white.webp",
    crop=(0, 0, 768, 1024),
)
key(
    SOURCE / "desk-and-chair-white.png",
    ART / "chair-white.webp",
    crop=(768, 0, 1536, 1024),
)
for index, name in enumerate(("coffee", "workout", "restroom")):
    key(
        SOURCE / "amenities-white.png",
        ART / f"amenity-{name}-white.webp",
        crop=(index * 512, 0, (index + 1) * 512, 1024),
        trim=False,
    )
key(
    SOURCE / "minimal-figure-sheet-magenta.png",
    ART / "minimal-figure-sheet.webp",
    figure=True,
)
