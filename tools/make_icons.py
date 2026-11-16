"""The app icon: the blue-to-purple gradient tile with the FifTeam mark (an F, two rising level bars).
   python make_icons.py <out dir>      (needs numpy and OpenImageIO, e.g. Blender's bundled Python)"""
import sys, os, numpy as np, OpenImageIO as oiio

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)

def seg_dist(px, py, a, b):
    ax, ay = a; bx, by = b
    dx, dy = bx - ax, by - ay
    t = np.clip(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy + 1e-12), 0, 1)
    return np.hypot(px - (ax + t * dx), py - (ay + t * dy))

def render(size, full_bleed, mark_scale):
    ss = 4
    n = size * ss
    y, x = (np.mgrid[0:n, 0:n] + 0.5) / n          # 0..1
    # the gradient: blue top-left, violet, purple bottom-right, with a soft light from the top
    t = np.clip((x * 0.55 + y * 0.45), 0, 1)
    c0, c1, c2 = np.array([0.239, 0.482, 1.0]), np.array([0.482, 0.361, 1.0]), np.array([0.698, 0.361, 1.0])
    col = np.where(t[..., None] < 0.55, c0 + (c1 - c0) * (t[..., None] / 0.55), c1 + (c2 - c1) * ((t[..., None] - 0.55) / 0.45))
    col = col * (0.92 + 0.16 * np.exp(-((x - 0.3) ** 2 + (y - 0.1) ** 2) / 0.12))[..., None]
    # rounded square (or the full square for maskable icons)
    if full_bleed:
        alpha = np.ones((n, n))
    else:
        r = 0.225
        qx, qy = np.abs(x - 0.5) - (0.5 - r), np.abs(y - 0.5) - (0.5 - r)
        d = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - r
        alpha = np.clip(-d * n / 1.5, 0, 1)
    # the mark, centred, drawn as round-capped strokes (the same shape as the in-app logo)
    s = mark_scale
    def P(u, v): return (0.5 + (u - 12) / 24 * s, 0.5 + (v - 12) / 24 * s)
    w = 2.6 / 24 * s / 2
    d = np.minimum.reduce([
        seg_dist(x, y, P(6, 19), P(6, 5)), seg_dist(x, y, P(6, 5), P(13, 5)), seg_dist(x, y, P(6, 12), P(11, 12)),
        seg_dist(x, y, P(15, 19), P(15, 14)), seg_dist(x, y, P(18.5, 19), P(18.5, 10)),
    ])
    m = np.clip((w - d) * n / 1.5, 0, 1)
    shadow = np.clip((w * 1.6 - seg_dist(x, y, P(6, 19.6), P(6, 5.6))) * n / 20, 0, 1) * 0
    rgb = col * (1 - m[..., None]) + np.ones(3) * m[..., None]
    img = np.concatenate([rgb, alpha[..., None]], axis=2)
    img = img.reshape(size, ss, size, ss, 4).mean(axis=(1, 3))
    return img

def save(img, name):
    p = os.path.join(OUT, name)
    o = oiio.ImageOutput.create(p); o.open(p, oiio.ImageSpec(img.shape[1], img.shape[0], 4, "uint8"))
    o.write_image((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)); o.close()
    print("wrote", p)

save(render(192, False, 0.62), "icon-192.png")
save(render(512, False, 0.62), "icon-512.png")
save(render(512, True, 0.5), "maskable-512.png")        # the mark inside the maskable safe zone
a = render(180, True, 0.6); save(a, "apple-touch-icon.png")   # iOS rounds the corners itself
