#!/usr/bin/env python3
"""Hornea las rutas de Rodillator: trazado + DEM + textura satelital -> data/routes/<id>.json.

Uso:  python3 tools/bake_routes.py [id ...]      (sin argumentos hornea todas)

Fuentes (únicas permitidas):
  - Elevación: Copernicus DEM GLO-30 (AWS open data, COG 1x1 grado, 1 arcseg).
  - Imagen: Sentinel-2 cloudless 2020 de EOX (teselas XYZ Web Mercator).
  - Traza real de alpe-dhuez: tools/alpe_d_huez_source.gpx (Strava, paquete R rayshaderanimate, GPL>=2).

Convenciones:
  - Distancias horizontales (planas) sobre esfera R=6371000 con proyección equirectangular local.
  - Grilla de alturas 256x256: nodos de vértice, es decir la fila 0 / columna 0 caen exactamente
    en el borde norte / oeste del bbox y la fila 255 / columna 255 en el borde sur / este.
    Fila 0 = norte. valor = (ele - minEle)/(maxEle - minEle)*65535, Uint16 little-endian.
  - Se escriben vistas previas en /tmp/preview-<id>.png (textura con la ruta dibujada).
"""
import base64
import io
import json
import math
import os
import re
import sys
import time
import urllib.request

import numpy as np
import tifffile
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter, gaussian_filter1d, map_coordinates, uniform_filter1d
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "cache")
OUT_DIR = os.path.join(ROOT, "data", "routes")
GPX_PATH = os.path.join(ROOT, "tools", "alpe_d_huez_source.gpx")

EARTH_R = 6371000.0
M_PER_DEG = math.pi / 180.0 * EARTH_R
STEP_M = 20.0
SMOOTH_WINDOW_PTS = 5            # 5 puntos x 20 m = 100 m
GRID = 256
MAX_TEXTURE_PX = 2048
MIN_TEXTURE_PX = 1024
JPEG_QUALITY = 80
MARGIN_FRAC = 0.35
MIN_MARGIN_M = 1500.0
UA = "rodillator-bake/1.0 (offline bake of cycling routes; Copernicus DEM + EOX Sentinel-2 cloudless)"
DEM_URL = "https://copernicus-dem-30m.s3.amazonaws.com/{n}/{n}.tif"
TILE_URL = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg"
ATTRIBUTION = "Copernicus DEM GLO-30 © ESA/DLR; Sentinel-2 cloudless by EOX (CC BY-NC-SA 4.0)"

# Parámetros del camino de mínimo costo (rutas sintéticas).
COST_FLAT_SLOPE = 0.07   # sobre esta pendiente comienza la penalización
COST_K = 60.0           # fuerza de la penalización cuadrática
PATH_SMOOTH_M = 15.0     # sigma del suavizado gaussiano del trazado sintético
COST_DESCENT = 4.0       # penaliza bajar (el camino es de subida; evita ir y venir por quebradas)

ROUTES = [
    dict(id="alpe-dhuez", name="Alpe d'Huez", region="Isère", country="Francia", synthetic=False,
         description="Subida mítica del Tour de Francia desde Bourg-d'Oisans hasta la estación de Alpe d'Huez, "
                     "con sus 21 curvas de herradura. Traza real de un recorrido GPS; la elevación proviene del "
                     "modelo digital de terreno.",
         source="Traza GPS de Strava incluida en el paquete R rayshaderanimate (GPL>=2); elevación Copernicus DEM "
                "GLO-30 © ESA/DLR; imagen Sentinel-2 cloudless by EOX (CC BY-NC-SA 4.0)"),
    dict(id="farellones", name="Camino a Farellones", region="Región Metropolitana", country="Chile", synthetic=True,
         waypoints=[(-33.3640, -70.4560), (-33.3540, -70.3080)],
         description="Ascenso desde el sector La Ermita hasta Farellones por la cordillera de Santiago. "
                     "El trazado es aproximado, generado sobre el relieve real."),
    dict(id="caracoles-portillo", name="Caracoles de Portillo", region="Valparaíso", country="Chile", synthetic=True,
         waypoints=[(-32.8780, -70.1500), (-32.8360, -70.1290)],
         cost_k=10.0, flat_slope=0.10,   # terreno muy empinado: con la penalización por defecto el trazado se alarga demasiado
         description="Los famosos caracoles de la ruta internacional hacia Portillo, desde las cercanías de Juncal. "
                     "El trazado es aproximado, generado sobre el relieve real."),
    dict(id="el-yeso", name="Embalse El Yeso", region="Cajón del Maipo", country="Chile", synthetic=True,
         waypoints=[(-33.6380, -70.1080), (-33.6760, -70.0880)],
         description="Camino de montaña por el Cajón del Maipo desde San Gabriel hasta el embalse El Yeso. "
                     "El trazado es aproximado, generado sobre el relieve real."),
    dict(id="talagante-valle", name="Valle de Talagante", region="Región Metropolitana", country="Chile",
         synthetic=True,
         waypoints=[(-33.6650, -70.9280), (-33.7520, -70.8970), (-33.6800, -71.0170), (-33.6650, -70.9280)],
         description="Circuito llano por el valle: Talagante, Isla de Maipo, El Monte y de vuelta a Talagante. "
                     "El trazado es aproximado, generado sobre el relieve real."),
]


# ---------------------------------------------------------------- red / caché
def fetch_cached(url, path, pause=0.0):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    tmp = path + ".part"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    if pause:
        time.sleep(pause)
    return path


# ---------------------------------------------------------------- DEM
class Dem:
    """Ventana del Copernicus GLO-30 (rejilla global de 1 arcseg) que cubre un bbox con holgura."""

    PER_DEG = 3600

    def __init__(self, bbox, pad_deg=0.01):
        min_lon, min_lat, max_lon, max_lat = bbox
        pd = self.PER_DEG
        self.r0 = int(math.floor((90.0 - (max_lat + pad_deg)) * pd))
        self.r1 = int(math.ceil((90.0 - (min_lat - pad_deg)) * pd))
        self.c0 = int(math.floor((min_lon - pad_deg + 180.0) * pd))
        self.c1 = int(math.ceil((max_lon + pad_deg + 180.0) * pd))
        self.arr = np.full((self.r1 - self.r0, self.c1 - self.c0), np.nan, dtype=np.float32)
        for lat in range(int(math.floor(min_lat - pad_deg)), int(math.floor(max_lat + pad_deg)) + 1):
            for lon in range(int(math.floor(min_lon - pad_deg)), int(math.floor(max_lon + pad_deg)) + 1):
                self._paste_tile(lat, lon)
        if np.isnan(self.arr).any():
            raise RuntimeError("DEM con huecos en la ventana %s" % (bbox,))

    def covers(self, bbox):
        pd = self.PER_DEG
        return (bbox[0] >= self.c0 / pd - 180 and bbox[2] <= self.c1 / pd - 180
                and bbox[3] <= 90 - self.r0 / pd and bbox[1] >= 90 - self.r1 / pd)

    @staticmethod
    def tile_name(lat, lon):
        ns = "N" if lat >= 0 else "S"
        ew = "E" if lon >= 0 else "W"
        return "Copernicus_DSM_COG_10_%s%02d_00_%s%03d_00_DEM" % (ns, abs(lat), ew, abs(lon))

    def _paste_tile(self, lat, lon):
        n = self.tile_name(lat, lon)
        path = fetch_cached(DEM_URL.format(n=n), os.path.join(CACHE, n + ".tif"))
        tile = tifffile.imread(path)
        pd = self.PER_DEG
        if tile.shape != (pd, pd):
            raise RuntimeError("tesela %s con forma inesperada %s" % (n, tile.shape))
        tr0 = (90 - (lat + 1)) * pd          # fila global de la esquina noroeste de la tesela
        tc0 = (lon + 180) * pd
        r_a, r_b = max(self.r0, tr0), min(self.r1, tr0 + pd)
        c_a, c_b = max(self.c0, tc0), min(self.c1, tc0 + pd)
        if r_a >= r_b or c_a >= c_b:
            return
        self.arr[r_a - self.r0:r_b - self.r0, c_a - self.c0:c_b - self.c0] = \
            tile[r_a - tr0:r_b - tr0, c_a - tc0:c_b - tc0]

    def pix(self, lon, lat):
        """Coordenadas (fila, col) fraccionarias en la ventana; el centro del píxel (0,0) es (0,0)."""
        pd = self.PER_DEG
        return (90.0 - np.asarray(lat)) * pd - 0.5 - self.r0, (np.asarray(lon) + 180.0) * pd - 0.5 - self.c0

    def sample(self, lon, lat, arr=None):
        r, c = self.pix(lon, lat)
        return map_coordinates(self.arr if arr is None else arr, [r, c], order=1, mode="nearest")


# ---------------------------------------------------------------- geometría
def to_xy(lon, lat, lon0, lat0):
    return ((np.asarray(lon) - lon0) * math.cos(math.radians(lat0)) * M_PER_DEG,
            (np.asarray(lat) - lat0) * M_PER_DEG)


def from_xy(x, y, lon0, lat0):
    return (np.asarray(x) / (math.cos(math.radians(lat0)) * M_PER_DEG) + lon0,
            np.asarray(y) / M_PER_DEG + lat0)


def resample_polyline(x, y, step=STEP_M):
    """Remuestrea a paso uniforme (~step) incluyendo ambos extremos. Devuelve x, y, dist acumulada."""
    seg = np.hypot(np.diff(x), np.diff(y))
    keep = np.concatenate([[True], seg > 1e-6])
    x, y = x[keep], y[keep]
    cum = np.concatenate([[0.0], np.cumsum(np.hypot(np.diff(x), np.diff(y)))])
    n = max(1, int(round(cum[-1] / step)))
    d = np.linspace(0.0, cum[-1], n + 1)
    return np.interp(d, cum, x), np.interp(d, cum, y), d


def smooth_path(x, y, sigma_m):
    """Suaviza la polilínea (fijando extremos) para eliminar la escalera de la grilla."""
    x, y, d = resample_polyline(x, y, 10.0)
    s = sigma_m / 10.0
    xs, ys = gaussian_filter1d(x, s, mode="nearest"), gaussian_filter1d(y, s, mode="nearest")
    # fundido de los extremos para que el trazado empiece y termine exactamente en los puntos dados
    w = np.clip(np.minimum(d, d[-1] - d) / (3 * sigma_m), 0, 1)
    return x * (1 - w) + xs * w, y * (1 - w) + ys * w


# ---------------------------------------------------------------- camino de mínimo costo
OFFSETS = [(di, dj) for di in range(-2, 3) for dj in range(-2, 3)
           if (di, dj) != (0, 0) and math.gcd(abs(di), abs(dj)) == 1]   # 16 vecinos


def least_cost_path(dem, p_from, p_to, pad_m=3000.0, k=COST_K, flat_slope=COST_FLAT_SLOPE):
    """Dijkstra sobre la grilla DEM con costo = d*(1 + k*max(0,|s|-s0)^2 + kd*max(0,-s)). p = (lat, lon)."""
    lats = [p_from[0], p_to[0]]
    lons = [p_from[1], p_to[1]]
    lat0 = float(np.mean(lats))
    ext = max(abs(lats[0] - lats[1]) * M_PER_DEG, abs(lons[0] - lons[1]) * M_PER_DEG * math.cos(math.radians(lat0)))
    pad = pad_m + 0.25 * ext
    pad_lat = pad / M_PER_DEG
    pad_lon = pad / (M_PER_DEG * math.cos(math.radians(lat0)))
    r_lo, c_lo = dem.pix(min(lons) - pad_lon, max(lats) + pad_lat)
    r_hi, c_hi = dem.pix(max(lons) + pad_lon, min(lats) - pad_lat)
    r_lo, c_lo = max(0, int(r_lo)), max(0, int(c_lo))
    r_hi, c_hi = min(dem.arr.shape[0] - 1, int(r_hi) + 1), min(dem.arr.shape[1] - 1, int(c_hi) + 1)
    z = gaussian_filter(dem.arr[r_lo:r_hi + 1, c_lo:c_hi + 1].astype(np.float64), 1.0)
    h, w = z.shape
    dy = M_PER_DEG / dem.PER_DEG
    dx = dy * math.cos(math.radians(lat0))
    idx = np.arange(h * w).reshape(h, w)
    rows, cols, costs = [], [], []
    for di, dj in OFFSETS:
        a = idx[max(0, -di):h - max(0, di), max(0, -dj):w - max(0, dj)]
        b = idx[max(0, di):h - max(0, -di), max(0, dj):w - max(0, -dj)]
        za = z[max(0, -di):h - max(0, di), max(0, -dj):w - max(0, dj)]
        zb = z[max(0, di):h - max(0, -di), max(0, dj):w - max(0, -dj)]
        dist = math.hypot(di * dy, dj * dx)
        s = (zb - za) / dist
        c = dist * (1.0 + k * np.maximum(0.0, np.abs(s) - flat_slope) ** 2
                    + COST_DESCENT * np.maximum(0.0, -s))
        rows.append(a.ravel()); cols.append(b.ravel()); costs.append(c.ravel())
    g = csr_matrix((np.concatenate(costs), (np.concatenate(rows), np.concatenate(cols))), shape=(h * w, h * w))

    def node(p):
        r, c = dem.pix(p[1], p[0])
        return int(round(float(r))) - r_lo, int(round(float(c))) - c_lo

    (ra, ca), (rb, cb) = node(p_from), node(p_to)
    for rr, cc in ((ra, ca), (rb, cb)):
        if not (0 <= rr < h and 0 <= cc < w):
            raise RuntimeError("punto fuera de la ventana de búsqueda")
    src, dst = ra * w + ca, rb * w + cb
    _, pred = dijkstra(g, directed=True, indices=src, return_predecessors=True)
    if pred[dst] < 0 and dst != src:
        raise RuntimeError("sin camino")
    chain = [dst]
    while chain[-1] != src:
        chain.append(pred[chain[-1]])
    chain = np.array(chain[::-1])
    rr, cc = chain // w + r_lo, chain % w + c_lo
    lon = (cc + 0.5 + dem.c0) / dem.PER_DEG - 180.0
    lat = 90.0 - (rr + 0.5 + dem.r0) / dem.PER_DEG
    lon[0], lat[0] = p_from[1], p_from[0]
    lon[-1], lat[-1] = p_to[1], p_to[0]
    return lon, lat


def synthetic_track(waypoints, dem, **cost):
    lons, lats = [], []
    for a, b in zip(waypoints[:-1], waypoints[1:]):
        lo, la = least_cost_path(dem, a, b, **cost)
        lons.append(lo if not lons else lo[1:]); lats.append(la if not lats else la[1:])
    lon, lat = np.concatenate(lons), np.concatenate(lats)
    lon0, lat0 = float(lon.mean()), float(lat.mean())
    x, y = to_xy(lon, lat, lon0, lat0)
    x, y = smooth_path(x, y, PATH_SMOOTH_M)
    return from_xy(x, y, lon0, lat0)


# ---------------------------------------------------------------- traza real (GPX)
def gpx_climb():
    txt = open(GPX_PATH, encoding="utf-8").read()
    pts = np.array([(float(a), float(b), float(c)) for a, b, c in
                    re.findall(r'<trkpt lat="([\d.\-]+)" lon="([\d.\-]+)">\s*<ele>([\d.\-]+)</ele>', txt)])
    if len(pts) == 0:
        raise RuntimeError("GPX sin puntos")
    i0 = int(np.argmin(pts[:, 2]))   # punto más bajo (Bourg-d'Oisans); la traza es un circuito que termina en la cima
    climb = pts[i0:]
    if climb[-1, 2] < climb[0, 2]:   # si estuviera invertida (cima primero), se invierte
        climb = climb[::-1]
    lon0, lat0 = float(climb[:, 1].mean()), float(climb[:, 0].mean())
    x, y = to_xy(climb[:, 1], climb[:, 0], lon0, lat0)
    x, y, _ = resample_polyline(x, y, 10.0)
    x, y = smooth_path(x, y, 15.0)   # quita el ruido GPS conservando las horquillas
    return from_xy(x, y, lon0, lat0)


# ---------------------------------------------------------------- perfil
def build_points(lon, lat, dem):
    lon0, lat0 = float(np.mean(lon)), float(np.mean(lat))
    x, y = to_xy(lon, lat, lon0, lat0)
    x, y, dist = resample_polyline(x, y, STEP_M)
    lo, la = from_xy(x, y, lon0, lat0)
    # se redondea aquí (1 decimal) para que gainM/minEleM/maxEleM coincidan exactamente con los puntos escritos
    ele = np.round(uniform_filter1d(dem.sample(lo, la), SMOOTH_WINDOW_PTS, mode="nearest"), 1)
    return lo, la, ele, dist


# ---------------------------------------------------------------- terreno
def bbox_with_margin(lon, lat):
    lat0 = float(np.mean(lat))
    kx = math.cos(math.radians(lat0)) * M_PER_DEG
    w, h = (lon.max() - lon.min()) * kx, (lat.max() - lat.min()) * M_PER_DEG
    mx, my = max(MARGIN_FRAC * w, MIN_MARGIN_M), max(MARGIN_FRAC * h, MIN_MARGIN_M)
    return [float(lon.min() - mx / kx), float(lat.min() - my / M_PER_DEG),
            float(lon.max() + mx / kx), float(lat.max() + my / M_PER_DEG)]


def height_grid(dem, bbox):
    min_lon, min_lat, max_lon, max_lat = bbox
    lons = np.linspace(min_lon, max_lon, GRID)
    lats = np.linspace(max_lat, min_lat, GRID)       # fila 0 = norte
    cell_cols = (max_lon - min_lon) * dem.PER_DEG / (GRID - 1)
    cell_rows = (max_lat - min_lat) * dem.PER_DEG / (GRID - 1)
    filt = gaussian_filter(dem.arr, (max(cell_rows / 2, 0.01), max(cell_cols / 2, 0.01)))
    LO, LA = np.meshgrid(lons, lats)
    return dem.sample(LO.ravel(), LA.ravel(), arr=filt).reshape(GRID, GRID)


def encode_heights(grid):
    mn, mx = float(np.floor(grid.min())), float(np.ceil(grid.max()))
    q = np.round((grid - mn) / (mx - mn) * 65535.0).astype("<u2")
    return mn, mx, base64.b64encode(q.tobytes()).decode("ascii")


# ---------------------------------------------------------------- satélite
def merc_px(lon, lat, z):
    n = 256.0 * 2 ** z
    lat = np.clip(np.asarray(lat), -85.05, 85.05)
    x = (np.asarray(lon) + 180.0) / 360.0 * n
    y = (1.0 - np.log(np.tan(np.radians(lat)) + 1.0 / np.cos(np.radians(lat))) / math.pi) / 2.0 * n
    return x, y


def tile_range(bbox, z):
    min_lon, min_lat, max_lon, max_lat = bbox
    x0, y0 = merc_px(min_lon, max_lat, z)
    x1, y1 = merc_px(max_lon, min_lat, z)
    return int(x0 // 256), int(y0 // 256), int(x1 // 256), int(y1 // 256)


def satellite_texture(bbox, log=print):
    z = 14
    tx0, ty0, tx1, ty1 = tile_range(bbox, z)
    if (tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 144:
        z = 13
        tx0, ty0, tx1, ty1 = tile_range(bbox, z)
    nx, ny = tx1 - tx0 + 1, ty1 - ty0 + 1
    log("  satélite z%d: %dx%d teselas" % (z, nx, ny))
    mosaic = Image.new("RGB", (nx * 256, ny * 256))
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            p = os.path.join(CACHE, "eox", str(z), str(ty), "%d.jpg" % tx)
            fetched = not os.path.exists(p)
            fetch_cached(TILE_URL.format(z=z, y=ty, x=tx), p, pause=0.15 if fetched else 0.0)
            mosaic.paste(Image.open(p).convert("RGB"), ((tx - tx0) * 256, (ty - ty0) * 256))
    mos = np.asarray(mosaic, dtype=np.float32)

    min_lon, min_lat, max_lon, max_lat = bbox
    lat0 = (min_lat + max_lat) / 2
    wm = (max_lon - min_lon) * math.cos(math.radians(lat0)) * M_PER_DEG
    hm = (max_lat - min_lat) * M_PER_DEG
    native = (max(wm, hm) / (40075016.686 * math.cos(math.radians(lat0)) / (256 * 2 ** z)))
    long_px = int(min(MAX_TEXTURE_PX, max(MIN_TEXTURE_PX, round(native))))
    out_w, out_h = (long_px, max(1, round(long_px * hm / wm))) if wm >= hm else (max(1, round(long_px * wm / hm)), long_px)

    lons = np.linspace(min_lon, max_lon, out_w, endpoint=False) + (max_lon - min_lon) / out_w / 2
    lats = np.linspace(max_lat, min_lat, out_h, endpoint=False) - (max_lat - min_lat) / out_h / 2
    px, _ = merc_px(lons, np.full_like(lons, lats[0]), z)
    _, py = merc_px(np.full_like(lats, lons[0]), lats, z)
    cc, rr = np.meshgrid(px - tx0 * 256 - 0.5, py - ty0 * 256 - 0.5)
    chans = [map_coordinates(mos[:, :, k], [rr, cc], order=1, mode="nearest") for k in range(3)]
    img = Image.fromarray(np.clip(np.stack(chans, axis=-1), 0, 255).astype(np.uint8), "RGB")
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=JPEG_QUALITY, optimize=True)
    return img, "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def write_preview(img, bbox, lon, lat, path):
    prev = img.copy()
    w, h = prev.size
    xs = (np.asarray(lon) - bbox[0]) / (bbox[2] - bbox[0]) * w
    ys = (bbox[3] - np.asarray(lat)) / (bbox[3] - bbox[1]) * h
    d = ImageDraw.Draw(prev)
    d.line(list(zip(xs.tolist(), ys.tolist())), fill=(255, 90, 31), width=max(3, w // 400))
    for (px, py), col in ((( xs[0], ys[0]), (60, 220, 90)), ((xs[-1], ys[-1]), (255, 255, 255))):
        r = max(6, w // 200)
        d.ellipse([px - r, py - r, px + r, py + r], fill=col, outline=(0, 0, 0))
    prev.thumbnail((1024, 1024))
    prev.save(path, "PNG")


# ---------------------------------------------------------------- ruta completa
def bake(route, log=print):
    log("[%s]" % route["id"])
    if route["synthetic"]:
        wl = [p[1] for p in route["waypoints"]]
        wa = [p[0] for p in route["waypoints"]]
        seed_bbox = bbox_with_margin(np.array(wl), np.array(wa))
        pad = 0.05
        seed_bbox = [seed_bbox[0] - pad, seed_bbox[1] - pad, seed_bbox[2] + pad, seed_bbox[3] + pad]
        dem = Dem(seed_bbox)
        lon, lat = synthetic_track(route["waypoints"], dem, k=route.get("cost_k", COST_K),
                                   flat_slope=route.get("flat_slope", COST_FLAT_SLOPE))
    else:
        lon, lat = gpx_climb()
        dem = Dem(bbox_with_margin(lon, lat), pad_deg=0.02)
    lo, la, ele, dist = build_points(lon, lat, dem)
    bbox = bbox_with_margin(lo, la)
    if not dem.covers(bbox):
        dem = Dem(bbox)
    grid = height_grid(dem, bbox)
    min_e, max_e, heights = encode_heights(grid)
    img, texture = satellite_texture(bbox, log)

    gain = float(np.sum(np.maximum(np.diff(ele), 0.0)))
    data = dict(
        id=route["id"], name=route["name"], region=route["region"], country=route["country"],
        description=route["description"], source=route.get("source", ATTRIBUTION + "; trazado sintético sobre relieve real"),
        synthetic=route["synthetic"],
        distanceM=round(float(dist[-1]), 1), gainM=round(gain, 1),
        maxEleM=round(float(ele.max()), 1), minEleM=round(float(ele.min()), 1),
        points=[[round(float(a), 6), round(float(b), 6), round(float(c), 1), round(float(d), 1)]
                for a, b, c, d in zip(la, lo, ele, dist)],
        terrain=dict(bbox=[round(v, 6) for v in bbox], width=GRID, height=GRID, minEle=min_e, maxEle=max_e,
                     heights=heights, texture=texture, attribution=ATTRIBUTION),
    )
    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, route["id"] + ".json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    prev = "/tmp/preview-%s.png" % route["id"]
    write_preview(img, bbox, lo, la, prev)
    size = os.path.getsize(out)
    log("  dist %.2f km  desnivel %.0f m  pendiente media %.2f %%  JSON %.2f MB  preview %s" % (
        dist[-1] / 1000, gain, (ele[-1] - ele[0]) / dist[-1] * 100, size / 1e6, prev))
    return data


def main(argv):
    wanted = set(argv)
    routes = [r for r in ROUTES if not wanted or r["id"] in wanted]
    if wanted and len(routes) != len(wanted):
        raise SystemExit("ids desconocidos: %s" % (wanted - {r["id"] for r in ROUTES}))
    for r in routes:
        bake(r)


if __name__ == "__main__":
    main(sys.argv[1:])
