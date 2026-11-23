#!/usr/bin/env python3
"""Builds a PPSSPP HD texture pack from textures PPSSPP dumped (SaveNewTextures), by upscaling each
one with an AI upscaler and keeping its hash file name.

    python tools/texture_pack.py <dumped new/ dir> <model .pth> <out dir> [--game ULUS10466]
           [--min-size 16] [--max-side 2048] [--zip]

<out dir> becomes a pack: hash-named PNGs + textures.ini (copy it to PSP/TEXTURES/<GAMEID>/), or with
--zip a single textures.zip (PPSSPP reads it directly; fewer files to sync). Real-ESRGAN weights load
through spandrel (pip install torch spandrel pillow numpy). The textures are derived from the game:
keep the pack out of git and only give it to people who own the game.
"""
import argparse
import os
import sys
import time
import zipfile

import numpy as np
import torch
from PIL import Image
from spandrel import ModelLoader

INI = """# PPSSPP texture replacement pack, built with tools/texture_pack.py ({model}, {scale}x).
[options]
version = 1
hash = quick
ignoreMipmap = true

[games]
{game} = textures.ini

[hashes]
"""


def upscale(model, scale, img):
    """RGB through the model; alpha (if any) through the model as grey, so edges stay aligned."""
    def run(rgb):
        t = torch.from_numpy(np.asarray(rgb, dtype=np.float32) / 255.0).permute(2, 0, 1).unsqueeze(0)
        with torch.inference_mode():
            out = model(t).clamp(0, 1)
        return Image.fromarray((out.squeeze(0).permute(1, 2, 0).numpy() * 255.0 + 0.5).astype(np.uint8))
    has_alpha = img.mode in ('RGBA', 'LA', 'P') and 'A' in img.convert('RGBA').getbands()
    rgba = img.convert('RGBA')
    up = run(rgba.convert('RGB'))
    if has_alpha:
        a = rgba.getchannel('A')
        if a.getextrema() != (255, 255):
            a_up = run(Image.merge('RGB', (a, a, a))).getchannel('R')
            up.putalpha(a_up)
    return up


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('src'); ap.add_argument('model'); ap.add_argument('out')
    ap.add_argument('--game', default='ULUS10466')
    ap.add_argument('--min-size', type=int, default=16, help='skip textures smaller than this on both sides')
    ap.add_argument('--max-side', type=int, default=2048, help='skip textures whose upscaled side would exceed this')
    ap.add_argument('--zip', action='store_true', help='write textures.zip instead of loose files')
    a = ap.parse_args()

    torch.set_num_threads(os.cpu_count() or 4)
    model = ModelLoader().load_from_file(a.model).eval()
    scale = model.scale
    os.makedirs(a.out, exist_ok=True)
    files = sorted(f for f in os.listdir(a.src) if f.lower().endswith('.png'))
    done = skipped = 0
    in_bytes = out_bytes = 0
    t0 = time.time()
    written = []
    for i, name in enumerate(files):
        src = os.path.join(a.src, name)
        img = Image.open(src)
        w, h = img.size
        extrema = img.convert('RGBA').getextrema()
        flat = all(lo == hi for lo, hi in extrema)
        if (w < a.min_size and h < a.min_size) or flat or max(w, h) * scale > a.max_side:
            skipped += 1
            continue
        up = upscale(model, scale, img)
        dst = os.path.join(a.out, name)
        up.save(dst, optimize=True)
        written.append(name)
        done += 1
        in_bytes += os.path.getsize(src)
        out_bytes += os.path.getsize(dst)
        if done % 25 == 0:
            rate = done / (time.time() - t0)
            print(f'{i + 1}/{len(files)} upscaled {done}, skipped {skipped}, {rate:.2f}/s, {out_bytes / 1048576:.1f} MB', flush=True)

    ini = INI.format(model=os.path.basename(a.model), scale=scale, game=a.game)
    with open(os.path.join(a.out, 'textures.ini'), 'w', encoding='utf-8') as f:
        f.write(ini)
    if a.zip:
        zpath = os.path.join(a.out, 'textures.zip')
        with zipfile.ZipFile(zpath, 'w', zipfile.ZIP_STORED) as z:  # PNGs are already compressed
            z.write(os.path.join(a.out, 'textures.ini'), 'textures.ini')
            for name in written:
                z.write(os.path.join(a.out, name), name)
                os.remove(os.path.join(a.out, name))
        os.remove(os.path.join(a.out, 'textures.ini'))
        out_bytes = os.path.getsize(zpath)
    print(f'done: {done} upscaled {scale}x, {skipped} skipped (tiny, flat or too big), '
          f'{in_bytes / 1048576:.1f} MB in -> {out_bytes / 1048576:.1f} MB out, {time.time() - t0:.0f} s')


if __name__ == '__main__':
    sys.exit(main())
