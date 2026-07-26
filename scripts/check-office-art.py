from pathlib import Path

from PIL import Image


ART = Path(__file__).parents[1] / "office" / "art"
ASSETS = [
    "leader-room-white.webp",
    "desk-white.webp",
    "chair-white.webp",
    "amenity-coffee-white.webp",
    "amenity-workout-white.webp",
    "amenity-restroom-white.webp",
    "minimal-figure-sheet.webp",
]

for name in ASSETS:
    image = Image.open(ART / name).convert("RGBA")
    pixels = list(image.getdata())
    transparent = sum(alpha < 5 for _, _, _, alpha in pixels)
    neutral = sum(
        alpha > 220 and max(red, green, blue) - min(red, green, blue) <= 12
        for red, green, blue, alpha in pixels
    )
    magenta = sum(
        alpha > 12
        and red > green * 1.3
        and blue > green * 1.3
        and red > 100
        for red, green, blue, alpha in pixels
    )
    assert transparent > 0, f"{name}: missing real transparent pixels"
    assert neutral > len(pixels) * 0.15, f"{name}: surviving art is not neutral"
    assert magenta == 0, f"{name}: surviving magenta-dominant pixels"

print(f"checked {len(ASSETS)} keyed Office assets")
