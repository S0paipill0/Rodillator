#!/usr/bin/env python3
"""Hornea las rutas de Rodillator: trazado + DEM + textura satelital -> data/routes/<id>.json.

Uso:  python3 tools/bake_routes.py [id ...]      (sin argumentos hornea todas)
      python3 tools/bake_routes.py --landcover-only [id ...]   (solo terrain.landcover, sin descargas)

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
import heapq
import time
import urllib.request

import numpy as np
import tifffile
from PIL import Image, ImageDraw
from scipy.ndimage import (binary_dilation, convolve, gaussian_filter, gaussian_filter1d, map_coordinates,
                           maximum_filter, uniform_filter1d)
from scipy.sparse import csr_matrix
from scipy.spatial import cKDTree
from scipy.sparse.csgraph import dijkstra
from skimage.filters import apply_hysteresis_threshold
from skimage.measure import label
from skimage.morphology import skeletonize

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "cache")
OUT_DIR = os.path.join(ROOT, "data", "routes")
GPX_PATH = os.path.join(ROOT, "tools", "alpe_d_huez_source.gpx")

EARTH_R = 6371000.0
M_PER_DEG = math.pi / 180.0 * EARTH_R
STEP_M = 20.0
SMOOTH_WINDOW_PTS = 5            # 5 puntos x 20 m = 100 m
SYNTH_WINDOW_PTS = 7             # rutas sintéticas: 140 m; las curvas cerradas del trazado necesitan algo más de suavizado
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
# costo de una arista = dist * (1 + pendiente + descenso) * (1 - ROAD_GAIN * camino)
SLOPE_SOFT, SLOPE_K = 0.08, 150.0          # penalización cuadrática sobre 8 %
SLOPE_STRONG, SLOPE_STRONG_K = 0.10, 3000.0  # penalización fuerte sobre 10 %
SLOPE_MAX, SLOPE_MAX_K = 0.12, 1.0e4       # tope duro: sobre 12 % el costo es prohibitivo
DESCENT_K = 4.0          # penaliza bajar (el camino es de subida; evita ir y venir por quebradas)
ROAD_GAIN = 0.8          # un píxel con "parecido a camino" = 1 abarata el costo hasta 80 %
DEM_SMOOTH_M = 30.0      # suavizado del DEM usado para el costo (el DSM de 30 m es ruidoso)
PATH_SMOOTH_M = 10.0     # sigma del suavizado gaussiano del trazado (ligero, para conservar las curvas)
ROAD_ZOOM = 14

ROUTES = [
    dict(id="alpe-dhuez", name="Alpe d'Huez", region="Isère", country="Francia", synthetic=False,
         description="Subida mítica del Tour de Francia desde Bourg-d'Oisans hasta la estación de Alpe d'Huez, "
                     "con sus 21 curvas de herradura. Traza real de un recorrido GPS; la elevación proviene del "
                     "modelo digital de terreno.",
         source="Traza GPS de Strava incluida en el paquete R rayshaderanimate (GPL>=2); elevación Copernicus DEM "
                "GLO-30 © ESA/DLR; imagen Sentinel-2 cloudless by EOX (CC BY-NC-SA 4.0)"),
    dict(id="farellones", name="Camino a Farellones", region="Región Metropolitana", country="Chile", synthetic=True,
         waypoints=[(-33.3640, -70.4560), (-33.3540, -70.3080)], grid_m=20, climb=True, geo_despike=True, slopes=(0.075, 0.095, 0.11), window_pts=25,
         description="Ascenso desde el sector La Ermita hasta Farellones por la cordillera de Santiago. "
                     "El trazado es aproximado, generado sobre el relieve real."),
    dict(id="caracoles-portillo", name="Caracoles de Portillo", region="Valparaíso", country="Chile", synthetic=True,
         waypoints=[(-32.8780, -70.1500), (-32.8360, -70.1290)], grid_m=15, climb=True, geo_despike=True, slopes=(0.04, 0.06, 0.08), window_pts=25,
         description="Los famosos caracoles de la ruta internacional hacia Portillo, desde las cercanías de Juncal. "
                     "El trazado es aproximado, generado sobre el relieve real."),
    dict(id="el-yeso", name="Embalse El Yeso", region="Cajón del Maipo", country="Chile", synthetic=True,
         # El inicio no es el punto del brief (estaba a 3326 m, en la cordillera): se deduce con el DEM siguiendo el
         # valle del río Yeso aguas abajo desde el embalse hasta ~1350 m.
         flow_origin=(-33.6760, -70.0880), flow_start_ele=1350.0, grid_m=30, climb=True,
         description="Camino de montaña por el Cajón del Maipo desde San Gabriel hasta el embalse El Yeso. "
                     "El trazado es aproximado, generado sobre el relieve real."),
    dict(id="talagante-valle", name="Valle de Talagante", region="Región Metropolitana", country="Chile",
         synthetic=True,
         waypoints=[(-33.6650, -70.9280), (-33.7520, -70.8970), (-33.6800, -71.0170), (-33.6650, -70.9280)],
         grid_m=30, road_gain=0.4,   # terreno llano: con más ganancia el trazado se alarga siguiendo cada camino de parcela
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

    def smoothed(self, sigma_px):
        """DEM suavizado (gaussiano, sigma en píxeles), cacheado."""
        cache = self.__dict__.setdefault("_smoothed", {})
        if sigma_px not in cache:
            cache[sigma_px] = gaussian_filter(self.arr, sigma_px)
        return cache[sigma_px]

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


# ---------------------------------------------------------------- "parecido a camino" desde la imagen
def line_kernels(n_orient=12, half=7, flank=3.5, sigma=0.9):
    """Núcleos de línea orientados: línea central menos las dos líneas laterales (realce de líneas claras finas)."""
    yy, xx = np.mgrid[-half:half + 1, -half:half + 1].astype(np.float32)
    kernels = []
    for k in range(n_orient):
        th = math.pi * k / n_orient
        u = xx * math.cos(th) + yy * math.sin(th)
        v = -xx * math.sin(th) + yy * math.cos(th)
        along = np.abs(u) <= half - 0.5
        center = np.exp(-v ** 2 / (2 * sigma ** 2)) * along
        side = np.exp(-(np.abs(v) - flank) ** 2 / (2 * sigma ** 2)) * along
        kernels.append(center / center.sum() - side / side.sum())
    return kernels


def road_likeness(rgb):
    """rgb float32 HxWx3 en [0,1] -> HxW en [0,1]. Alto = línea clara fina, continua y en zona lisa (camino).

    La respuesta de línea se divide por el contraste local (así los bordes de sombra y roca, de contraste alto,
    se atenúan y los caminos, de poco contraste pero lisos, destacan); luego se conservan solo los trazos largos.
    """
    lum = rgb.mean(axis=2)
    top = lum - gaussian_filter(lum, 5)
    resp = np.max([convolve(top, k, mode="nearest") for k in line_kernels()], axis=0).clip(0)
    resp = resp / (gaussian_filter(np.abs(top), 12) + 0.004)
    resp = np.clip(resp / np.percentile(resp, 99.5), 0, 1)
    smooth = gaussian_filter(resp, 0.7)
    mask = apply_hysteresis_threshold(smooth, np.percentile(smooth, 92), np.percentile(smooth, 98))
    skel = skeletonize(mask)
    lab = label(skel, connectivity=2)
    sizes = np.bincount(lab.ravel())
    keep = sizes >= 50
    keep[0] = False
    long_traces = binary_dilation(keep[lab], iterations=1)
    return np.maximum(long_traces.astype(np.float32), 0.3 * resp)


def road_on_grid(lon, lat, grid_m):
    """Muestrea road_likeness sobre una grilla de puntos lon/lat (misma forma). Dilata a la huella de la celda."""
    bbox = [float(lon.min()), float(lat.min()), float(lon.max()), float(lat.max())]
    mos, z, tx0, ty0 = load_mosaic(bbox, ROAD_ZOOM)
    road = road_likeness(np.asarray(mos, dtype=np.float32) / 255.0)
    foot = int(round(grid_m / 9.0))                  # ~9 m por píxel de la imagen a z14
    if foot > 1:
        road = maximum_filter(road, size=foot)
    px, py = merc_px(lon, lat, z)
    return map_coordinates(road, [py - ty0 * 256 - 0.5, px - tx0 * 256 - 0.5], order=1, mode="nearest")


# ---------------------------------------------------------------- camino de mínimo costo
OFFSETS = [(di, dj) for di in range(-2, 3) for dj in range(-2, 3)
           if (di, dj) != (0, 0) and math.gcd(abs(di), abs(dj)) == 1]   # 16 vecinos


def slope_multiplier(s, soft=SLOPE_SOFT, strong=SLOPE_STRONG, cap=SLOPE_MAX):
    a = np.abs(s)
    return (1.0 + SLOPE_K * np.maximum(0.0, a - soft) ** 2
            + SLOPE_STRONG_K * np.maximum(0.0, a - strong)
            + SLOPE_MAX_K * (a > cap)
            + DESCENT_K * np.maximum(0.0, -s))


def least_cost_path(dem, p_from, p_to, grid_m, slopes=(SLOPE_SOFT, SLOPE_STRONG, SLOPE_MAX), road_gain=ROAD_GAIN):
    """Dijkstra sobre una grilla métrica local (paso grid_m). p = (lat, lon). Devuelve lon, lat."""
    lat0, lon0 = (p_from[0] + p_to[0]) / 2, (p_from[1] + p_to[1]) / 2
    xa, ya = to_xy(p_from[1], p_from[0], lon0, lat0)
    xb, yb = to_xy(p_to[1], p_to[0], lon0, lat0)
    pad = max(2500.0, 0.2 * max(abs(xa - xb), abs(ya - yb)))
    xmin, xmax = min(xa, xb) - pad, max(xa, xb) + pad
    ymin, ymax = min(ya, yb) - pad, max(ya, yb) + pad
    w, h = int((xmax - xmin) / grid_m) + 1, int((ymax - ymin) / grid_m) + 1
    gx, gy = xmin + grid_m * np.arange(w), ymax - grid_m * np.arange(h)
    lon, lat = from_xy(*np.meshgrid(gx, gy), lon0, lat0)
    z = gaussian_filter(dem.sample(lon.ravel(), lat.ravel()).reshape(h, w).astype(np.float64), DEM_SMOOTH_M / grid_m)
    road = road_on_grid(lon, lat, grid_m)

    def node(x, y):
        return int(round((ymax - y) / grid_m)) * w + int(round((x - xmin) / grid_m))

    src, dst = node(xa, ya), node(xb, yb)
    chain = _grid_chain(z, road, grid_m, slopes, road_gain, src, dst)
    x, y = gx[chain % w], gy[chain // w]
    x[0], y[0], x[-1], y[-1] = xa, ya, xb, yb
    return from_xy(x, y, lon0, lat0)


def _edge_cost(z, road, sa, sb, dist, slopes, road_gain):
    s = (z[sb] - z[sa]) / dist
    return dist * slope_multiplier(s, *slopes) * (1.0 - road_gain * road[sb])


def _grid_chain(z, road, grid_m, slopes, road_gain, src, dst):
    """Dijkstra sobre celdas con 16 vecinos. Devuelve los índices de celda de src a dst."""
    h, w = z.shape
    idx = np.arange(h * w).reshape(h, w)
    rows, cols, costs = [], [], []
    for di, dj in OFFSETS:
        sa = (slice(max(0, -di), h - max(0, di)), slice(max(0, -dj), w - max(0, dj)))
        sb = (slice(max(0, di), h - max(0, -di)), slice(max(0, dj), w - max(0, -dj)))
        c = _edge_cost(z, road, sa, sb, math.hypot(di, dj) * grid_m, slopes, road_gain)
        rows.append(idx[sa].ravel()); cols.append(idx[sb].ravel()); costs.append(c.ravel())
    graph = csr_matrix((np.concatenate(costs), (np.concatenate(rows), np.concatenate(cols))), shape=(h * w, h * w))
    _, pred = dijkstra(graph, directed=True, indices=src, return_predecessors=True)
    if pred[dst] < 0 and dst != src:
        raise RuntimeError("sin camino")
    chain = [dst]
    while chain[-1] != src:
        chain.append(pred[chain[-1]])
    return np.array(chain[::-1])


def despike(lon, lat, dem, radius=15.0, min_loop=40.0, max_loop_grade=0.02, step=5.0):
    """Elimina espigas y lazos: si el camino vuelve a pasar a < radius de un punto anterior (con > min_loop de
    recorrido entre ambos) y el lazo no sube nada (desnivel/recorrido < max_loop_grade), se recorta todo lo que
    hay entre los dos. Cubre los retrocesos ida-y-vuelta (el rumbo gira ~180 grados con ambos brazos a < radius).
    La condición de desnivel distingue una espiga (vuelve al mismo punto y cota) de una horquilla real, cuyos
    brazos próximos están a distinta cota porque el camino sube entre ellos."""
    lon0, lat0 = float(np.mean(lon)), float(np.mean(lat))
    x, y = to_xy(lon, lat, lon0, lat0)
    x, y, _ = resample_polyline(x, y, step)
    pts = np.column_stack([x, y])
    tree = cKDTree(pts)
    ele = dem.sample(*from_xy(x, y, lon0, lat0), arr=dem.smoothed(1.0))
    skip = int(min_loop / step)
    keep, i = [], 0
    while i < len(pts):
        keep.append(i)
        later = [j for j in tree.query_ball_point(pts[i], radius) if j > i + skip and abs(ele[j] - ele[i]) < max_loop_grade * (j - i) * step]
        i = max(later) if later else i + 1
    return from_xy(x[keep], y[keep], lon0, lat0)


def round_corners(x, y, half_m=30.0, max_turn=100.0, step=5.0):
    """Redondea las esquinas agudas: donde el rumbo gira más de max_turn entre half_m antes y half_m después
    de un vértice, reemplaza ese tramo por una curva de Bézier cuadrática (el vértice como punto de control).
    Deja un radio de curva realizable y evita giros > 120 grados entre segmentos de 20 m."""
    x, y, _ = resample_polyline(x, y, step)
    k = int(half_m / step)
    pts = np.column_stack([x, y])
    t = np.linspace(0.0, 1.0, 2 * k + 1)[:, None]
    for _ in range(8):                       # varias pasadas: las esquinas cercanas pueden interferir
        changed, i, out = False, 0, []
        while i < len(pts):
            if k <= i < len(pts) - k:
                a, b = pts[i] - pts[i - k], pts[i + k] - pts[i]
                cos = a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9)
                if np.degrees(np.arccos(np.clip(cos, -1, 1))) > max_turn:
                    out = out[:len(out) - k] if len(out) >= k else out
                    out.extend(((1 - t) ** 2 * pts[i - k] + 2 * (1 - t) * t * pts[i] + t ** 2 * pts[i + k]).tolist())
                    i += k + 1
                    changed = True
                    continue
            out.append(pts[i].tolist())
            i += 1
        pts = np.array(out)
        if not changed:
            break
        pts = np.column_stack(resample_polyline(pts[:, 0], pts[:, 1], step)[:2])
    return pts[:, 0], pts[:, 1]


def remove_spikes(x, y, max_turn=120.0, gap_m=25.0, step=5.0):
    """Post-proceso geométrico: mientras exista un vértice con giro > max_turn (punta de espiga o diente de sierra),
    se elimina ese vértice y los vecinos que forman el retroceso, hasta que el camino de ida y el de vuelta
    queden a > gap_m. Trabaja sobre la polilínea remuestreada a step m (una punta de espiga es un solo vértice)."""
    x, y, _ = resample_polyline(x, y, step)
    pts = np.column_stack([x, y])
    for _ in range(20000):
        turns = turn_angles(pts[:, 0], pts[:, 1])
        if len(turns) == 0 or turns.max() <= max_turn:
            break
        i = int(np.argmax(turns)) + 1
        k = 1
        while i - k > 0 and i + k < len(pts) - 1 and np.linalg.norm(pts[i - k] - pts[i + k]) <= gap_m:
            k += 1
        pts = np.delete(pts, np.arange(i - k + 1, i + k), axis=0)
    return pts[:, 0], pts[:, 1]


def chaikin(x, y, iterations=2):
    """Chaikin (corte de esquinas 1/4 - 3/4) conservando los extremos."""
    for _ in range(iterations):
        nx, ny = [x[0]], [y[0]]
        for i in range(len(x) - 1):
            nx += [0.75 * x[i] + 0.25 * x[i + 1], 0.25 * x[i] + 0.75 * x[i + 1]]
            ny += [0.75 * y[i] + 0.25 * y[i + 1], 0.25 * y[i] + 0.75 * y[i + 1]]
        nx.append(x[-1]); ny.append(y[-1])
        x, y = np.array(nx), np.array(ny)
    return x, y


def synthetic_track(waypoints, dem, grid_m, slopes=(SLOPE_SOFT, SLOPE_STRONG, SLOPE_MAX), road_gain=ROAD_GAIN,
                    geo_despike=False):
    lons, lats = [], []
    for a, b in zip(waypoints[:-1], waypoints[1:]):
        lo, la = least_cost_path(dem, a, b, grid_m, slopes, road_gain)
        if not geo_despike:
            lo, la = despike(lo, la, dem)
        lons.append(lo if not lons else lo[1:]); lats.append(la if not lats else la[1:])
    lon, lat = np.concatenate(lons), np.concatenate(lats)
    lon0, lat0 = float(lon.mean()), float(lat.mean())
    x, y = to_xy(lon, lat, lon0, lat0)
    if geo_despike:                                  # farellones y caracoles: ver remove_spikes
        x, y = remove_spikes(x, y)
        x, y, _ = resample_polyline(x, y, STEP_M)
        x, y = chaikin(x, y, 2)
    else:
        x, y = round_corners(x, y)
        x, y = smooth_path(x, y, PATH_SMOOTH_M)
    return from_xy(x, y, lon0, lat0)


def valley_start(dem, origin, target_ele):
    """Sigue el valle aguas abajo desde origin=(lat, lon) (descenso más pronunciado D8 sobre el DEM suavizado,
    con inundación por prioridad en pozos y planos) hasta bajar de target_ele. Devuelve (lat, lon)."""
    z = gaussian_filter(dem.arr.astype(np.float64), 1.5)
    h, w = z.shape
    r, c = [int(round(float(v))) for v in dem.pix(origin[1], origin[0])]
    n8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    seen = {(r, c)}
    while z[r, c] > target_ele:
        best, best_s = None, 0.0
        for di, dj in n8:
            v = (r + di, c + dj)
            if 0 <= v[0] < h and 0 <= v[1] < w and v not in seen:
                sl = (z[r, c] - z[v]) / math.hypot(di, dj)
                if sl > best_s:
                    best, best_s = v, sl
        if best is None:                       # pozo o plano: inundación por prioridad hasta el punto de derrame
            queue, parent, found = [(z[r, c], r, c)], {(r, c): None}, None
            while queue and found is None:
                _, ur, uc = heapq.heappop(queue)
                for di, dj in n8:
                    v = (ur + di, uc + dj)
                    if 0 <= v[0] < h and 0 <= v[1] < w and v not in parent and v not in seen:
                        parent[v] = (ur, uc)
                        if z[v] < z[r, c] - 1.0:
                            found = v
                            break
                        heapq.heappush(queue, (z[v], v[0], v[1]))
            if found is None:
                raise RuntimeError("el valle no baja de %.0f m dentro de la ventana DEM" % target_ele)
            best = found
        seen.add(best)
        r, c = best
    lon = (c + 0.5 + dem.c0) / dem.PER_DEG - 180.0
    lat = 90.0 - (r + 0.5 + dem.r0) / dem.PER_DEG
    return (lat, lon)


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
def turn_angles(x, y):
    """Giro (grados) en cada vértice interior entre segmentos consecutivos."""
    vx, vy = np.diff(x), np.diff(y)
    cos = (vx[:-1] * vx[1:] + vy[:-1] * vy[1:]) / (np.hypot(vx[:-1], vy[:-1]) * np.hypot(vx[1:], vy[1:]) + 1e-9)
    return np.degrees(np.arccos(np.clip(cos, -1, 1)))


def build_points(lon, lat, dem, dem_sigma_px=0.0, window_pts=SMOOTH_WINDOW_PTS, max_turn=None):
    lon0, lat0 = float(np.mean(lon)), float(np.mean(lat))
    x, y = to_xy(lon, lat, lon0, lat0)
    x, y, dist = resample_polyline(x, y, STEP_M)
    for _ in range(8 if max_turn else 0):    # garantía: ningún giro > max_turn entre segmentos de 20 m
        if turn_angles(x, y).max() <= max_turn:
            break
        x, y = remove_spikes(x, y, max_turn=max_turn - 15.0)
        x, y = chaikin(*resample_polyline(x, y, STEP_M)[:2], 1)
        x, y, dist = resample_polyline(x, y, STEP_M)
    lo, la = from_xy(x, y, lon0, lat0)
    # se redondea aquí (1 decimal) para que gainM/minEleM/maxEleM coincidan exactamente con los puntos escritos
    arr = gaussian_filter(dem.arr, dem_sigma_px) if dem_sigma_px else None
    ele = np.round(uniform_filter1d(dem.sample(lo, la, arr=arr), window_pts, mode="nearest"), 1)
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


def load_mosaic(bbox, z):
    """Mosaico RGB (uint8) de las teselas z que cubren bbox. Devuelve (array, z, tx0, ty0)."""
    tx0, ty0, tx1, ty1 = tile_range(bbox, z)
    nx, ny = tx1 - tx0 + 1, ty1 - ty0 + 1
    mosaic = Image.new("RGB", (nx * 256, ny * 256))
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            p = os.path.join(CACHE, "eox", str(z), str(ty), "%d.jpg" % tx)
            fetched = not os.path.exists(p)
            fetch_cached(TILE_URL.format(z=z, y=ty, x=tx), p, pause=0.15 if fetched else 0.0)
            mosaic.paste(Image.open(p).convert("RGB"), ((tx - tx0) * 256, (ty - ty0) * 256))
    return np.asarray(mosaic), z, tx0, ty0


def satellite_texture(bbox, log=print):
    z = 14
    tx0, ty0, tx1, ty1 = tile_range(bbox, z)
    if (tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 144:
        z = 13
        tx0, ty0, tx1, ty1 = tile_range(bbox, z)
    log("  satélite z%d: %dx%d teselas" % (z, tx1 - tx0 + 1, ty1 - ty0 + 1))
    mos, z, tx0, ty0 = load_mosaic(bbox, z)
    mos = mos.astype(np.float32)

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
        wps = route.get("waypoints")
        if wps is None:                      # el inicio se deduce del valle (ver valley_start)
            o_lat, o_lon = route["flow_origin"]
            dem = Dem([o_lon - 0.30, o_lat - 0.20, o_lon + 0.10, o_lat + 0.10], pad_deg=0.0)
            start = valley_start(dem, route["flow_origin"], route["flow_start_ele"])
            log("  inicio por flujo: lat %.4f lon %.4f" % start)
            wps = [start, route["flow_origin"]]
        else:
            wl, wa = np.array([q[1] for q in wps]), np.array([q[0] for q in wps])
            seed = bbox_with_margin(wl, wa)
            pad = 0.05
            dem = Dem([seed[0] - pad, seed[1] - pad, seed[2] + pad, seed[3] + pad])
        lon, lat = synthetic_track(wps, dem, route["grid_m"], route.get("slopes", (SLOPE_SOFT, SLOPE_STRONG, SLOPE_MAX)),
                                    route.get("road_gain", ROAD_GAIN), route.get("geo_despike", False))
        if route.get("climb"):               # como en Alpe d'Huez: la subida parte del punto más bajo del trazado
            i0 = int(np.argmin(gaussian_filter1d(dem.sample(lon, lat), 5.0)))
            lon, lat = lon[i0:], lat[i0:]
    else:
        lon, lat = gpx_climb()
        dem = Dem(bbox_with_margin(lon, lat), pad_deg=0.02)
    # rutas sintéticas: el DEM se suaviza (1 px = 30 m) igual que en el costo, así el perfil respeta el tope de pendiente
    lo, la, ele, dist = build_points(lon, lat, dem, *((1.0, route.get("window_pts", SYNTH_WINDOW_PTS), 115.0 if route.get("geo_despike") else None) if route["synthetic"] else (0.0, SMOOTH_WINDOW_PTS)))
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
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import landcover
    data["terrain"]["landcover"] = landcover.build_landcover(data)
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


def landcover_only(ids, log=print):
    """Actualiza solo terrain.landcover en data/routes/*.json (sin descargar nada)."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import landcover
    for r in ROUTES:
        if ids and r["id"] not in ids:
            continue
        path = os.path.join(OUT_DIR, r["id"] + ".json")
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        out, cls, _, tex = landcover.build_landcover(data, return_class=True)
        data["terrain"]["landcover"] = out
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        landcover.preview(data, cls, tex, "/tmp/landcover-%s.png" % r["id"])
        log("[%s] landcover %s" % (r["id"], landcover.stats(cls)))


def main(argv):
    if "--landcover-only" in argv:
        landcover_only(set(a for a in argv if a != "--landcover-only"))
        return
    wanted = set(argv)
    routes = [r for r in ROUTES if not wanted or r["id"] in wanted]
    if wanted and len(routes) != len(wanted):
        raise SystemExit("ids desconocidos: %s" % (wanted - {r["id"] for r in ROUTES}))
    for r in routes:
        bake(r)


if __name__ == "__main__":
    main(sys.argv[1:])
