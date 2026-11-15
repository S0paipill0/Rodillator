#!/usr/bin/env python3
"""Cobertura de suelo 256x256 a partir de la textura Sentinel-2 horneada + pendiente/altitud del DEM.

Contrato (ver tarea 11): terrain.landcover = {width:256, height:256, classes:[...], data: base64 Uint8},
valor = índice de clase, fila 0 = norte, nodos de vértice borde a borde (igual que heights).

Clasificación por reglas sobre RGB visible (sin NIR). Los umbrales son comunes y se ajustan por ruta en PARAMS.
"""
import base64
import io
import math

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter, map_coordinates, uniform_filter, generic_filter, binary_opening, label, binary_closing

GRID = 256
CLASSES = ["roca", "suelo", "pasto", "matorral", "arbol", "agua", "nieve", "urbano"]
ROCA, SUELO, PASTO, MATORRAL, ARBOL, AGUA, NIEVE, URBANO = range(8)
M_PER_DEG = 111194.9266
BERMA_M = 15.0

PARAMS = {
    "talagante-valle": dict(gr_shrub=-0.01, gr_pasto=0.01, gr_tree=0.01, pasto_v=0.24, tree_v=0.24, rock_slope=40.0,
                            urb_tex=0.04, urb_sat=0.42, urb_v=0.34, urb_slope=8.0, urb_gr=0.0),
    "alpe-dhuez": dict(gr_shrub=0.03, gr_pasto=0.08, gr_tree=0.08, pasto_v=0.25, tree_v=0.25, snow_min_ele=1900.0,
                       urb_tex=0.02, urb_sat=0.34, urb_v=0.27, urb_slope=14.0, urb_gr=0.05),
    "el-yeso": dict(gr_shrub=0.0, tree_ele_max=2600.0, rock_slope=35.0, water_slope=3.0, snow_v=0.62),
    "farellones": dict(gr_shrub=-0.105, shrub_ele_max=2600.0, tree_ele_max=2600.0, rock_slope=35.0, snow_v=0.62),
    "caracoles-portillo": dict(gr_shrub=0.0, tree_ele_max=2600.0, rock_slope=35.0, snow_v=0.62),
}


def decode_texture(uri):
    return np.asarray(Image.open(io.BytesIO(base64.b64decode(uri.split(",", 1)[1]))).convert("RGB"), dtype=np.float32) / 255.0


def decode_heights(terrain):
    q = np.frombuffer(base64.b64decode(terrain["heights"]), dtype="<u2").reshape(GRID, GRID).astype(np.float64)
    return terrain["minEle"] + q / 65535.0 * (terrain["maxEle"] - terrain["minEle"])


def slope_deg(ele, bbox):
    lat0 = (bbox[1] + bbox[3]) / 2
    dx = (bbox[2] - bbox[0]) * M_PER_DEG * math.cos(math.radians(lat0)) / (GRID - 1)
    dy = (bbox[3] - bbox[1]) * M_PER_DEG / (GRID - 1)
    gy, gx = np.gradient(ele, dy, dx)
    return np.degrees(np.arctan(np.hypot(gx, gy)))


def features(tex, ele, bbox):
    """Atributos por celda de la grilla (muestreo en nodos, borde a borde)."""
    H, W, _ = tex.shape
    ky, kx = H / GRID, W / GRID                       # px de textura por celda
    sig = max(0.5, max(ky, kx) / 2.2)
    sm = np.stack([gaussian_filter(tex[:, :, k], sig) for k in range(3)], axis=-1)
    lum_full = tex @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    # textura local: desviación estándar 3x3 a resolución nativa, promediada en la celda
    m1 = uniform_filter(lum_full, 3)
    m2 = uniform_filter(lum_full * lum_full, 3)
    std = np.sqrt(np.maximum(m2 - m1 * m1, 0.0))
    # el brillo local manda: normaliza por la media para no confundir sombra con textura (sin dividir en oscuros)
    std = gaussian_filter(std, sig)
    cols = np.arange(GRID) / (GRID - 1) * W - 0.5
    rows = np.arange(GRID) / (GRID - 1) * H - 0.5
    cc, rr = np.meshgrid(cols, rows)
    samp = lambda a: map_coordinates(a, [rr, cc], order=1, mode="nearest")
    r, g, b = (samp(sm[:, :, k]) for k in range(3))
    tx = samp(std)
    s = r + g + b + 1e-6
    rn, gn, bn = r / s, g / s, b / s
    mx, mn = np.maximum(np.maximum(r, g), b), np.minimum(np.minimum(r, g), b)
    return dict(
        r=r, g=g, b=b, v=mx, sat=(mx - mn) / (mx + 1e-6),
        lum=0.299 * r + 0.587 * g + 0.114 * b,
        exg=2 * gn - rn - bn,
        vari=(g - r) / (g + r - b + 1e-6),
        gr=(g - r) / (g + r + 1e-6),
        tex=tx, slope=slope_deg(ele, bbox), ele=ele,
    )


def mode3(cls):
    """Filtro de moda 3x3 (empate: conserva la clase original)."""
    pad = np.pad(cls, 1, mode="edge")
    stack = np.stack([pad[i:i + GRID, j:j + GRID] for i in range(3) for j in range(3)], axis=0)
    counts = np.stack([(stack == k).sum(axis=0) for k in range(8)], axis=0)
    best = counts.argmax(axis=0)
    keep = counts[cls, np.arange(GRID)[:, None], np.arange(GRID)[None, :]] == counts.max(axis=0)
    return np.where(keep, cls, best).astype(np.uint8)


def classify(f, p):
    h = f["v"].shape
    cls = np.full(h, SUELO, dtype=np.uint8)
    exg, gr, v, sat, tex, sl, ele = f["exg"], f["gr"], f["v"], f["sat"], f["tex"], f["slope"], f["ele"]
    green = gr > p["gr_veg"]
    # --- base mineral: roca vs suelo
    gray = sat < p["sat_rock"]
    cls[(gray & (v > p["rock_v"])) | (sl > p["rock_slope"]) | (ele > p["rock_ele"])] = ROCA
    # --- vegetación
    veg = green
    cls[veg & (gr > p["gr_shrub"]) & (ele < p["shrub_ele_max"])] = MATORRAL
    cls[veg & (gr > p["gr_pasto"]) & (v >= p["pasto_v"])] = PASTO
    cls[veg & (gr > p["gr_tree"]) & (v < p["tree_v"])] = ARBOL
    cls[veg & (gr > p["gr_shrub"]) & (v < p["tree_v"] * 0.8) & (gr > p["gr_tree"] - 0.1)] = ARBOL
    # en laderas muy empinadas y por sobre la cota de vegetación, no hay bosque
    cls[(cls == ARBOL) & (ele > p["tree_ele_max"])] = MATORRAL
    # --- urbano: alta frecuencia, baja saturación, zonas bajas y planas
    urb = (tex > p["urb_tex"]) & (sat < p["urb_sat"]) & (sl < p["urb_slope"]) & (ele < p["urb_ele_max"]) & (v > p["urb_v"]) & (gr < p["urb_gr"])
    urb = binary_opening(urb, np.ones((2, 2), bool))
    cls[urb] = URBANO
    # --- agua: oscuro, azulado/verdoso y plano
    water = (v < p["water_v"]) & (sl < p["water_slope"]) & (f["b"] >= f["r"] * p["water_br"]) & (tex < p["water_tex"])
    water = binary_opening(water, np.ones((3, 3), bool))      # descarta franjas finas (autopistas, sombras alargadas)
    lab, n = label(water)
    for i in range(1, n + 1):
        if (lab == i).sum() < p["water_min_cells"]:
            water[lab == i] = False
    cls[water] = AGUA
    # --- nieve
    snow = (v > p["snow_v"]) & (sat < p["snow_s"]) & (ele > p["snow_min_ele"]) & (tex < p["snow_tex"])
    cls[snow] = NIEVE
    return cls


BASE = dict(
    gr_veg=-0.5, shrub_ele_max=1e9, gr_shrub=0.045, gr_pasto=0.10, gr_tree=0.15,
    pasto_v=0.30, tree_v=0.28, tree_ele_max=3300.0,
    sat_rock=0.20, rock_v=0.40, rock_slope=32.0, rock_ele=3700.0,
    urb_tex=0.05, urb_sat=0.22, urb_slope=14.0, urb_ele_max=1e9, urb_v=0.30, urb_gr=0.05,
    water_v=0.34, water_slope=6.0, water_br=0.95, water_gr=0.15, water_tex=0.03, water_min_cells=6,
    snow_v=0.80, snow_s=0.16, snow_min_ele=2400.0, snow_tex=0.2,
)


def route_cells(points, bbox, buffer_m=BERMA_M):
    """Celdas (i, j) tocadas por la franja de buffer_m a cada lado del trazado (superconjunto conservador)."""
    lat0 = (bbox[1] + bbox[3]) / 2
    cx = (bbox[2] - bbox[0]) * M_PER_DEG * math.cos(math.radians(lat0)) / (GRID - 1)
    cy = (bbox[3] - bbox[1]) * M_PER_DEG / (GRID - 1)
    pts = np.asarray(points, dtype=np.float64)
    lat, lon = pts[:, 0], pts[:, 1]
    # densifica a ~5 m
    xs, ys = [], []
    for k in range(len(lat) - 1):
        d = math.hypot((lon[k + 1] - lon[k]) * M_PER_DEG * math.cos(math.radians(lat0)), (lat[k + 1] - lat[k]) * M_PER_DEG)
        n = max(1, int(d / 5.0))
        t = np.arange(n) / n
        xs.append(lon[k] + (lon[k + 1] - lon[k]) * t)
        ys.append(lat[k] + (lat[k + 1] - lat[k]) * t)
    xs.append(lon[-1:]); ys.append(lat[-1:])
    xs, ys = np.concatenate(xs), np.concatenate(ys)
    gx = (xs - bbox[0]) / (bbox[2] - bbox[0]) * (GRID - 1)     # coordenada de nodo (fracción)
    gy = (bbox[3] - ys) / (bbox[3] - bbox[1]) * (GRID - 1)
    mark = np.zeros((GRID, GRID), bool)
    rx, ry = buffer_m / cx, buffer_m / cy
    # una celda es el nodo (i, j) y "cubre" [j-0.5, j+0.5]: se marca todo nodo cuyo cuadrado toque el disco
    for x, y in zip(gx, gy):
        j0, j1 = int(math.floor(x - rx - 0.5 + 1e-9)) + 1 - 1, int(math.ceil(x + rx + 0.5 - 1e-9))
        i0, i1 = int(math.floor(y - ry - 0.5 + 1e-9)) + 1 - 1, int(math.ceil(y + ry + 0.5 - 1e-9))
        mark[max(i0, 0):min(i1, GRID - 1) + 1, max(j0, 0):min(j1, GRID - 1) + 1] = True
    return mark


def build_landcover(route_data, route_id=None, return_class=False):
    t = route_data["terrain"]
    p = dict(BASE)
    p.update(PARAMS.get(route_id or route_data["id"], {}))
    tex = decode_texture(t["texture"])
    ele = decode_heights(t)
    f = features(tex, ele, t["bbox"])
    cls = classify(f, p)
    cls = mode3(cls)
    cls[route_cells(route_data["points"], t["bbox"])] = SUELO
    out = dict(width=GRID, height=GRID, classes=list(CLASSES), data=base64.b64encode(cls.astype(np.uint8).tobytes()).decode("ascii"))
    return (out, cls, f, tex) if return_class else out


COLORS = [(150, 150, 150), (176, 132, 84), (190, 214, 90), (140, 150, 60), (20, 90, 30), (40, 100, 220), (255, 255, 255), (230, 70, 150)]


def preview(route_data, cls, tex, path):
    from PIL import ImageDraw
    h = 512
    t = Image.fromarray((tex * 255).astype(np.uint8)).resize((int(h * tex.shape[1] / tex.shape[0]), h), Image.LANCZOS)
    lut = np.array(COLORS, dtype=np.uint8)
    c = Image.fromarray(lut[cls]).resize(t.size, Image.NEAREST)
    leg_w = 130
    im = Image.new("RGB", (t.width * 2 + leg_w, h), (20, 20, 20))
    im.paste(t, (0, 0)); im.paste(c, (t.width, 0))
    d = ImageDraw.Draw(im)
    for k, name in enumerate(CLASSES):
        y = 10 + k * 22
        d.rectangle([t.width * 2 + 8, y, t.width * 2 + 24, y + 14], fill=COLORS[k], outline=(255, 255, 255))
        d.text((t.width * 2 + 30, y + 1), "%d %s" % (k, name), fill=(255, 255, 255))
    im.save(path, "PNG")


def stats(cls):
    n = cls.size
    return {CLASSES[k]: round(float((cls == k).sum()) / n * 100, 1) for k in range(8)}
