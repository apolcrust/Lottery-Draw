#!/usr/bin/env python3
"""Rebuilds public/assets/lottery-machine-frames.webp from the supplied GIF.

The sprite sheet is a horizontal strip of the GIF 9 frames, pixel-identical to the
original animation. LotteryMachine.tsx uses it for frame-accurate, state-driven playback.
Usage: pip install pillow && python3 scripts/extract-frames.py
"""
from PIL import Image
im = Image.open("public/assets/lottery-machine.gif")
n, (w, h) = im.n_frames, im.size
sheet = Image.new("RGB", (w * n, h))
for i in range(n):
    im.seek(i)
    sheet.paste(im.convert("RGB"), (i * w, 0))
sheet.save("public/assets/lottery-machine-frames.webp", quality=92, method=6)
print(f"{n} frames, {w}x{h} each -> {sheet.size}")
