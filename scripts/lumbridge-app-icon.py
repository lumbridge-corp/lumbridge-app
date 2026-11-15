#!/usr/bin/env python3
# usage: scripts/lumbridge-app-icon.py   (run from the repo root; needs Pillow)
# Writes assets/lumbridge/lumbridge-app.{png,ico} and defaults/frame/welcome/lumbridge.png.
# Lumbridge app icon: the three-box L (design/mark.svg, 32x32 viewBox) in white on an ink rounded square.
# Same canvas as the old icon: 1024 px, 72 px clear margin, so macOS and Linux docks size it the same.
from PIL import Image, ImageDraw
out_png, out_ico = "assets/lumbridge/lumbridge-app.png", "assets/lumbridge/lumbridge-app.ico"
K = 4                       # supersample
N = 1024 * K
INK, WHITE = (0x11, 0x13, 0x10, 255), (255, 255, 255, 255)
im = Image.new("RGBA", (N, N), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
m = 72 * K
d.rounded_rectangle([m, m, N - m - 1, N - m - 1], radius=200 * K, fill=INK)
u = 17 * K                  # one viewBox unit; the mark is 26 units, so 442 px of the 880 px tile
x0, y0 = N // 2 - 17 * u, N // 2 - 16 * u   # mark centre is (17,16) in the viewBox
for x, y, w, h in [(4, 3, 9, 17), (4, 22, 17, 7), (23, 22, 7, 7)]:
    d.rectangle([x0 + x * u, y0 + y * u, x0 + (x + w) * u - 1, y0 + (y + h) * u - 1], fill=WHITE)
im = im.resize((1024, 1024), Image.LANCZOS)
im.save(out_png, optimize=True)
im.save(out_ico, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
im.resize((128, 128), Image.LANCZOS).save("defaults/frame/welcome/lumbridge.png", optimize=True)
