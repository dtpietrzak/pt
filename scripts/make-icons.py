"""Render PNG icons (same design as public/icons/icon.svg). Usage: python3 scripts/make-icons.py"""
from PIL import Image, ImageDraw

def render(size, out):
    S = 4096  # supersample
    k = S / 512
    im = Image.new("RGB", (S, S), "#2b6e8a")
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([116*k, 116*k, 396*k, 396*k], radius=64*k, outline="white", width=int(28*k))
    r = 28 * k
    d.ellipse([256*k - r, 208*k - r, 256*k + r, 208*k + r], fill="white")
    d.rounded_rectangle([244*k, 244*k, 268*k, 356*k], radius=12*k, fill="white")
    w = int(20 * k)
    arms = [(244*k, 268*k), (196*k, 308*k), (268*k, 268*k), (316*k, 308*k)]
    d.line(arms[0:2], fill="white", width=w)
    d.line(arms[2:4], fill="white", width=w)
    for x, y in arms:
        d.ellipse([x - w/2, y - w/2, x + w/2, y + w/2], fill="white")
    im.resize((size, size), Image.LANCZOS).save(out)

for size, name in ((192, "icon-192.png"), (512, "icon-512.png"), (180, "apple-touch-icon.png")):
    render(size, f"public/icons/{name}")
