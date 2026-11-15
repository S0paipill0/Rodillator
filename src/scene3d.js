/*
 * Rodillator - Escena 3D (R.Scene3D)
 * Paisaje realista: cielo fisico (Preetham) con nubes, luz ACES, niebla de perspectiva aerea, terreno DEM con
 * textura satelital + texturas de detalle por cobertura de suelo, malla fina junto al camino, asfalto con
 * demarcacion, berma, barreras y delineadores, agua, vegetacion instanciada con viento; ciclistas y camaras.
 * Requiere three.js r149 global (window.THREE). Sin assets externos.
 *
 * Convencion de proyeccion (compartida con routes.js): equirectangular,
 *   x = este en metros, z = -norte en metros, y = elevacion (m) menos la base,
 *   origen = centro de route.terrain.bbox si existe; si no, centro del bbox de los puntos.
 * Marco local de cada ciclista: +x adelante, +y arriba, +z a la derecha.
 */
(function (R) {
  'use strict';

  var G = typeof window !== 'undefined' ? window : globalThis;

  var EARTH_R = 6371000;            // m, radio medio
  var DEG = Math.PI / 180;
  var ROAD_WIDTH = 6;               // m
  var ROAD_LIFT = 0.4;              // m sobre el terreno (evita z-fighting)
  var LANE_SPACING = 1.1;           // m entre ciclistas que comparten distM
  var LANE_HALF = 2.4;              // m maximo desde el eje (camino de 6 m)
  var CLUSTER_M = 2.5;              // m: ciclistas mas cerca que esto se reparten en el carril
  var KIND_COLORS = { user: 0xFF5A1F, ghost: 0xFFD23F, bot: 0x7FA7C9 };
  var CAMERA_MODES = ['persecucion', 'aerea', 'lateral'];
  var BASE_FOV = 58, PORTRAIT_FOV = 70, PORTRAIT_ASPECT = 0.8, COMPACT_MAX_H = 500;

  // Desplazamiento (x, y) para camera.setViewOffset(w, h, x, y, w, h) que lleva el centro optico
  // al centro de la zona libre {top, bottom, left, right} (px CSS).
  function viewOffsetFor(w, h, ins) {
    var i = ins || {};
    var t = Math.max(0, +i.top || 0), b = Math.max(0, +i.bottom || 0), l = Math.max(0, +i.left || 0), r = Math.max(0, +i.right || 0);
    var cx = (l + (w - r)) / 2, cy = (t + (h - b)) / 2;
    return { x: Math.round((w / 2 - cx) * 100) / 100 + 0, y: Math.round((h / 2 - cy) * 100) / 100 + 0 };
  }
  var QUALITIES = ['auto', 'alta', 'media', 'baja'];

  /* ------------------------------------------------------------------ */
  /* Funciones puras (sin THREE): se prueban en Node                     */
  /* ------------------------------------------------------------------ */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function base64ToBytes(b64) {
    var out, i, n;
    if (typeof atob === 'function') {
      var bin = atob(b64);
      n = bin.length;
      out = new Uint8Array(n);
      for (i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
    throw new Error('Scene3D: no hay decodificador base64');
  }

  /** base64 de Uint16 little-endian (fila 0 = norte) -> Float32Array de elevaciones en metros. */
  function decodeHeights(b64, width, height, minEle, maxEle) {
    var bytes = base64ToBytes(b64);
    var n = width * height;
    if (bytes.length !== n * 2) {
      throw new Error('Scene3D: heights tiene ' + bytes.length + ' bytes, se esperaban ' + (n * 2));
    }
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var out = new Float32Array(n);
    var span = maxEle - minEle;
    for (var i = 0; i < n; i++) out[i] = minEle + (dv.getUint16(i * 2, true) / 65535) * span;
    return out;
  }

  /** Proyeccion equirectangular local: x = este (m), z = -norte (m). */
  function projectPoint(lat, lon, originLat, originLon) {
    var k = DEG * EARTH_R;
    return {
      x: (lon - originLon) * k * Math.cos(originLat * DEG),
      z: -(lat - originLat) * k
    };
  }

  function originOf(route) {
    var t = route.terrain, bb = t && t.bbox;
    if (bb) return { lat: (bb[1] + bb[3]) / 2, lon: (bb[0] + bb[2]) / 2 };
    var p = route.points, minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (var i = 0; i < p.length; i++) {
      if (p[i][0] < minLat) minLat = p[i][0];
      if (p[i][0] > maxLat) maxLat = p[i][0];
      if (p[i][1] < minLon) minLon = p[i][1];
      if (p[i][1] > maxLon) maxLon = p[i][1];
    }
    return { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
  }

  /** Interpola points [[lat,lon,ele,distM],...] en distM (acotado a [0, total]). */
  function sampleRoute(points, distM) {
    var n = points.length;
    if (!n) return null;
    if (n === 1) return { lat: points[0][0], lon: points[0][1], ele: points[0][2], distM: points[0][3], index: 0 };
    var d = clamp(distM, points[0][3], points[n - 1][3]);
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (points[mid][3] <= d) lo = mid; else hi = mid;
    }
    var a = points[lo], b = points[hi];
    var span = b[3] - a[3];
    var t = span > 0 ? (d - a[3]) / span : 0;
    return {
      lat: a[0] + (b[0] - a[0]) * t,
      lon: a[1] + (b[1] - a[1]) * t,
      ele: a[2] + (b[2] - a[2]) * t,
      distM: d,
      index: lo
    };
  }

  /** Desplazamiento lateral (m, + = derecha) del ciclista `index` de `count` que comparten distM. */
  function laneOffset(index, count) {
    if (count <= 1) return 0;
    var spacing = Math.min(LANE_SPACING, (2 * LANE_HALF) / (count - 1));
    return (index - (count - 1) / 2) * spacing;
  }

  function srgbToLinear(c) { return Math.pow(c, 2.2); }

  var ELE_STOPS = (function () {
    // [elevacion m, hex sRGB]: verde valle -> cafe -> gris roca -> nieve (> 3000 m)
    var raw = [[0, 0x4a7c3a], [900, 0x5c8b3e], [1600, 0x8a6d46], [2300, 0x7a7774], [2900, 0x8a8885], [3000, 0xf1f4f8]];
    return raw.map(function (s) {
      return [s[0], srgbToLinear(((s[1] >> 16) & 255) / 255), srgbToLinear(((s[1] >> 8) & 255) / 255), srgbToLinear((s[1] & 255) / 255)];
    });
  })();

  /** Escribe en out[o..o+2] el color (lineal) por altura; noise en [-0.5, 0.5]. */
  function elevationColor(ele, noise, out, o) {
    var s = ELE_STOPS, i = 0;
    while (i < s.length - 2 && ele > s[i + 1][0]) i++;
    var a = s[i], b = s[i + 1];
    var t = clamp((ele - a[0]) / (b[0] - a[0]), 0, 1);
    var f = 1 + noise * 0.3;
    out[o] = (a[1] + (b[1] - a[1]) * t) * f;
    out[o + 1] = (a[2] + (b[2] - a[2]) * t) * f;
    out[o + 2] = (a[3] + (b[3] - a[3]) * t) * f;
    return out;
  }

  function baseElevation(route) {
    var t = route.terrain;
    if (t && t.heights && t.bbox) return t.minEle;
    var m = Infinity;
    for (var i = 0; i < route.points.length; i++) if (route.points[i][2] < m) m = route.points[i][2];
    return m;
  }

  /**
   * Grilla de alturas en coordenadas de mundo. Con route.terrain usa el DEM (fila 0 = norte);
   * sin terreno genera un plano ondulado que sigue la elevacion de la ruta (IDW de sus puntos).
   * data[] ya esta en metros de mundo (elevacion - base) * verticalScale.
   */
  function makeHeightGrid(route, origin, verticalScale) {
    var vs = verticalScale > 0 ? verticalScale : 1;
    var base = baseElevation(route);
    var t = route.terrain, i, j;
    if (t && t.heights && t.bbox) {
      var elev = decodeHeights(t.heights, t.width, t.height, t.minEle, t.maxEle);
      var nw = projectPoint(t.bbox[3], t.bbox[0], origin.lat, origin.lon);
      var se = projectPoint(t.bbox[1], t.bbox[2], origin.lat, origin.lon);
      var data = new Float32Array(elev.length);
      for (i = 0; i < elev.length; i++) data[i] = (elev[i] - base) * vs;
      return { w: t.width, h: t.height, x0: nw.x, z0: nw.z, x1: se.x, z1: se.z, data: data, base: base, vs: vs, real: true };
    }
    var P = route.points, step = Math.max(1, Math.ceil(P.length / 600));
    var sx = [], sz = [], sy = [], minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (i = 0; i < P.length; i += step) {
      var q = projectPoint(P[i][0], P[i][1], origin.lat, origin.lon);
      sx.push(q.x); sz.push(q.z); sy.push((P[i][2] - base) * vs);
      if (q.x < minX) minX = q.x;
      if (q.x > maxX) maxX = q.x;
      if (q.z < minZ) minZ = q.z;
      if (q.z > maxZ) maxZ = q.z;
    }
    var pad = Math.max(2500, 0.35 * Math.max(maxX - minX, maxZ - minZ));
    var W = 129, H = 129;
    var gx0 = minX - pad, gx1 = maxX + pad, gz0 = minZ - pad, gz1 = maxZ + pad;
    var out = new Float32Array(W * H);
    var eps = 40 * 40;
    for (j = 0; j < H; j++) {
      var z = gz0 + (gz1 - gz0) * j / (H - 1);
      for (i = 0; i < W; i++) {
        var x = gx0 + (gx1 - gx0) * i / (W - 1);
        var num = 0, den = 0, dmin = Infinity;
        for (var k = 0; k < sx.length; k++) {
          var dx = x - sx[k], dz = z - sz[k], dd = dx * dx + dz * dz;
          if (dd < dmin) dmin = dd;
          var w = 1 / (dd + eps);
          num += sy[k] * w; den += w;
        }
        var tt = clamp((Math.sqrt(dmin) - 150) / 750, 0, 1), sm = tt * tt * (3 - 2 * tt);
        var wave = Math.sin(x * 0.0041) * Math.cos(z * 0.0033) * 45 + Math.sin(x * 0.011 + z * 0.007) * 12;
        out[j * W + i] = num / den + wave * sm * vs;
      }
    }
    return { w: W, h: H, x0: gx0, z0: gz0, x1: gx1, z1: gz1, data: out, base: base, vs: vs, real: false };
  }

  /** Altura (y de mundo) del terreno en (x, z), bilineal; acotada a la grilla. */
  function gridHeight(grid, x, z) {
    var w = grid.w, h = grid.h;
    var fx = clamp((x - grid.x0) / (grid.x1 - grid.x0), 0, 1) * (w - 1);
    var fz = clamp((z - grid.z0) / (grid.z1 - grid.z0), 0, 1) * (h - 1);
    var i = Math.min(Math.floor(fx), w - 2), j = Math.min(Math.floor(fz), h - 2);
    var tx = fx - i, tz = fz - j, d = grid.data, o = j * w + i;
    var a = d[o] + (d[o + 1] - d[o]) * tx;
    var b = d[o + w] + (d[o + w + 1] - d[o + w]) * tx;
    return a + (b - a) * tz;
  }

  /** Camino proyectado sobre el terreno: arreglos D (distM), X, Z, Y (eje del camino, ya con +ROAD_LIFT). */
  function buildRoadPath(route, origin, grid) {
    var P = route.points, n = P.length;
    var D = new Float64Array(n), X = new Float64Array(n), Z = new Float64Array(n), Y = new Float64Array(n);
    var raw = new Float64Array(n), i, j;
    for (i = 0; i < n; i++) {
      var q = projectPoint(P[i][0], P[i][1], origin.lat, origin.lon);
      D[i] = P[i][3]; X[i] = q.x; Z[i] = q.z;
      raw[i] = gridHeight(grid, q.x, q.z);       // el camino siempre abraza la superficie del terreno
    }
    for (i = 0; i < n; i++) {           // media movil de 5 puntos (quita ruido del DEM)
      var s = 0, c = 0;
      for (j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) { s += raw[j]; c++; }
      var sm = s / c;
      Y[i] = Math.max(sm, raw[i] - 0.25) + ROAD_LIFT;
    }
    return { n: n, D: D, X: X, Z: Z, Y: Y };
  }

  /** Posicion sobre el camino a distM -> out {x,y,z,i}. Sin allocations. */
  function pathAt(path, distM, out) {
    var n = path.n, D = path.D;
    if (n === 1) { out.x = path.X[0]; out.y = path.Y[0]; out.z = path.Z[0]; out.i = 0; return out; }
    var d = clamp(distM, D[0], D[n - 1]);
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (D[mid] <= d) lo = mid; else hi = mid;
    }
    var span = D[hi] - D[lo], t = span > 0 ? (d - D[lo]) / span : 0;
    out.x = path.X[lo] + (path.X[hi] - path.X[lo]) * t;
    out.y = path.Y[lo] + (path.Y[hi] - path.Y[lo]) * t;
    out.z = path.Z[lo] + (path.Z[hi] - path.Z[lo]) * t;
    out.i = lo;
    return out;
  }

  var _pa = { x: 0, y: 0, z: 0, i: 0 }, _pb = { x: 0, y: 0, z: 0, i: 0 };

  /** Posicion + rumbo (hx,hz horizontal unitario) + tangente 3D unitaria (tx,ty,tz) a distM. */
  function pathPose(path, distM, out) {
    pathAt(path, distM, out);
    pathAt(path, distM - 5, _pa);
    pathAt(path, distM + 5, _pb);
    var dx = _pb.x - _pa.x, dy = _pb.y - _pa.y, dz = _pb.z - _pa.z;
    var hl = Math.sqrt(dx * dx + dz * dz);
    if (hl < 1e-6) { out.hx = 1; out.hz = 0; out.tx = 1; out.ty = 0; out.tz = 0; return out; }
    out.hx = dx / hl; out.hz = dz / hl;
    var tl = Math.sqrt(dx * dx + dy * dy + dz * dz);
    out.tx = dx / tl; out.ty = dy / tl; out.tz = dz / tl;
    return out;
  }


  /* ------------------------------------------------------------------ */
  /* Escenario realista: funciones puras (cobertura, calidad, vegetacion) */
  /* ------------------------------------------------------------------ */

  // Clases de cobertura (route.terrain.landcover.classes, Tarea 11)
  var LC_NAMES = ['roca', 'suelo', 'pasto', 'matorral', 'arbol', 'agua', 'nieve', 'urbano'];
  var LC = { ROCA: 0, SUELO: 1, PASTO: 2, MATORRAL: 3, ARBOL: 4, AGUA: 5, NIEVE: 6, URBANO: 7 };

  function stripAccents(s) {
    s = String(s == null ? '' : s).toLowerCase();
    return s.normalize ? s.normalize('NFD').replace(/[̀-ͯ]/g, '') : s;
  }

  /**
   * route.terrain.landcover -> { w, h, data: Uint8Array con indices canonicos LC.* } o null si falta.
   * Las clases se mapean por nombre (sin tildes); un indice desconocido cae en 'suelo'.
   */
  function decodeLandcover(lc) {
    if (!lc || typeof lc.data !== 'string' || !(lc.width > 0) || !(lc.height > 0)) return null;
    var bytes = base64ToBytes(lc.data);
    var n = lc.width * lc.height;
    if (bytes.length !== n) throw new Error('Scene3D: landcover tiene ' + bytes.length + ' bytes, se esperaban ' + n);
    var names = Array.isArray(lc.classes) && lc.classes.length ? lc.classes : LC_NAMES;
    var map = names.map(function (nm) { var k = LC_NAMES.indexOf(stripAccents(nm)); return k >= 0 ? k : LC.SUELO; });
    var out = new Uint8Array(n);
    for (var i = 0; i < n; i++) { var v = bytes[i]; out[i] = v < map.length ? map[v] : LC.SUELO; }
    return { w: lc.width, h: lc.height, data: out, synthetic: false };
  }

  /** Hash entero -> [0, 1) determinista. */
  function hash2(i, j, seed) {
    var h = (Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263) + Math.imul((seed | 0) + 0x9e3779b9, 1274126177)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
  }

  /** Ruido de valor suave en [0, 1) (lattice entera, interpolacion smoothstep). */
  function valueNoise(x, y, seed) {
    var xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    var sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    var a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed), c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
    return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
  }

  /**
   * Cobertura sintetica desde altitud y pendiente de la grilla (cuando la ruta no trae landcover):
   * > 3.400 m nieve, > 2.800 m roca, pendiente fuerte roca, ladera matorral/suelo, valle pasto/arboles.
   */
  function deriveLandcover(grid, seed) {
    var w = grid.w, h = grid.h, d = grid.data, vs = grid.vs || 1, base = grid.base || 0;
    var dx = Math.abs(grid.x1 - grid.x0) / (w - 1), dz = Math.abs(grid.z1 - grid.z0) / (h - 1);
    var out = new Uint8Array(w * h), s = seed | 0;
    for (var j = 0; j < h; j++) {
      for (var i = 0; i < w; i++) {
        var o = j * w + i;
        var ele = d[o] / vs + base;
        var il = i > 0 ? i - 1 : i, ir = i < w - 1 ? i + 1 : i, jt = j > 0 ? j - 1 : j, jb = j < h - 1 ? j + 1 : j;
        var gx = (d[j * w + ir] - d[j * w + il]) / vs / ((ir - il) * dx || 1);
        var gz = (d[jb * w + i] - d[jt * w + i]) / vs / ((jb - jt) * dz || 1);
        var slope = Math.atan(Math.sqrt(gx * gx + gz * gz)) / DEG;
        var n = 0.65 * valueNoise(i / 5, j / 5, s) + 0.35 * valueNoise(i / 1.7, j / 1.7, s + 7);
        var c;
        if (ele > 3400) c = LC.NIEVE;
        else if (ele > 2800) c = LC.ROCA;
        else if (slope > 38) c = LC.ROCA;
        else if (slope > 24) c = n > 0.5 ? LC.SUELO : LC.MATORRAL;
        else if (slope < 10 && ele < 2000) c = n > 0.6 ? LC.ARBOL : LC.PASTO;          // valle
        else if (ele < 2200) c = n > 0.45 ? LC.MATORRAL : (n > 0.25 ? LC.SUELO : LC.PASTO);   // ladera
        else c = n > 0.68 ? LC.MATORRAL : LC.SUELO;
        out[o] = c;
      }
    }
    return { w: w, h: h, data: out, synthetic: true };
  }

  /** Clase en (x, z) de mundo (vecino mas cercano; la grilla de cobertura cubre el bbox de `grid` borde a borde). */
  function landcoverAt(lc, grid, x, z) {
    var i = Math.round(clamp((x - grid.x0) / (grid.x1 - grid.x0), 0, 1) * (lc.w - 1));
    var j = Math.round(clamp((z - grid.z0) / (grid.z1 - grid.z0), 0, 1) * (lc.h - 1));
    return lc.data[j * lc.w + i];
  }

  /* ---- calidad grafica ---- */
  var QUALITY_PRESETS = {
    alta:  { shadows: true,  shadowSize: 2048, shadowRange: 110, density: 1,    vegBand: 600, treeR: 1800, nearTreeR: 250, shrubR: 650, nearShrubR: 140, grassR: 150, pixelRatioMax: 2,   hiSpacing: 5,  hiR: 1400 },
    media: { shadows: true,  shadowSize: 1024, shadowRange: 55,  density: 0.5,  vegBand: 350, treeR: 1000, nearTreeR: 100, shrubR: 420, nearShrubR: 90,  grassR: 80,  pixelRatioMax: 1.5, hiSpacing: 8,  hiR: 1000 },
    baja:  { shadows: false, shadowSize: 0,    shadowRange: 0,   density: 0.25, vegBand: 200, treeR: 800,  nearTreeR: 120, shrubR: 260, nearShrubR: 50,  grassR: 0,   pixelRatioMax: 1,   hiSpacing: 12, hiR: 700 }
  };

  /** 'auto' -> 'media' en movil (pointer: coarse o ancho < 900) y 'alta' en escritorio. */
  function resolveQuality(q, env) {
    if (q === 'alta' || q === 'media' || q === 'baja') return q;
    var e = env || {};
    return (e.coarse || (e.width > 0 && e.width < 900)) ? 'media' : 'alta';
  }
  function downgradeQuality(level) { return level === 'alta' ? 'media' : 'baja'; }
  function qualityPreset(level) { return QUALITY_PRESETS[level] || QUALITY_PRESETS.media; }

  /**
   * Monitor de rendimiento: baja un nivel si el promedio de frame supera 24 ms durante 3 s seguidos.
   * feed(dt) -> true cuando corresponde bajar (y reinicia la ventana).
   */
  function createFrameMonitor(opts) {
    var o = opts || {}, limit = o.limitS || 0.024, hold = o.holdS || 3, warm = o.warmupS || 2;
    var avg = 1 / 60, over = 0, t = 0;
    return {
      feed: function (dt) {
        if (!(dt > 0) || dt > 0.25) return false;      // pestaña oculta / pausa: no cuenta
        t += dt;
        avg += (dt - avg) * 0.08;
        if (t < warm) return false;
        over = avg > limit ? over + dt : 0;
        if (over >= hold) { over = 0; t = 0; avg = limit; return true; }
        return false;
      },
      avg: function () { return avg; }
    };
  }

  /* ---- vegetacion ---- */
  // prob por clase [roca, suelo, pasto, matorral, arbol, agua, nieve, urbano] para una celda de `spacing` m
  var VEG_LAYERS = {
    tree:  { spacing: 9,   minRoad: 9, prob: [0, 0.025, 0.05, 0.07, 0.8, 0, 0, 0.14] },
    shrub: { spacing: 5,   minRoad: 6, prob: [0, 0.07, 0.06, 0.55, 0.14, 0, 0, 0.04] },
    grass: { spacing: 1.6, minRoad: 6, prob: [0, 0.18, 0.85, 0.4, 0.25, 0, 0, 0.06] }
  };
  var VEG_MIN_ROAD = 6;   // m: minimo general al eje del camino (arboles: 9 m, ver VEG_LAYERS)

  /**
   * Instancias deterministas de una capa en el rectangulo [x0,x1) x [z0,z1) de mundo.
   * Malla global anclada en (0,0) con jitter por celda: el resultado no depende de como se trocee el mundo.
   * opts: { seed, density (0..1, por calidad), classAt(x,z), roadDist(x,z), minRoad (por defecto el de la capa), annotate(item) opcional }
   * -> [{ x, z, cls, r0, r1, r2, r3 }] (r* en [0,1) para escala, giro, tono y especie)
   */
  function placeVegetation(rect, layerName, opts) {
    var L = VEG_LAYERS[layerName], s = L.spacing, out = [];
    var seed = (opts.seed | 0) + (layerName === 'tree' ? 101 : layerName === 'shrub' ? 202 : 303);
    var dens = opts.density == null ? 1 : opts.density;
    var minRoad = opts.minRoad == null ? L.minRoad : opts.minRoad;
    var i0 = Math.floor(rect.x0 / s) - 1, i1 = Math.ceil(rect.x1 / s), j0 = Math.floor(rect.z0 / s) - 1, j1 = Math.ceil(rect.z1 / s);
    for (var j = j0; j <= j1; j++) {
      for (var i = i0; i <= i1; i++) {
        var px = (i + 0.1 + 0.8 * hash2(i, j, seed + 1)) * s;
        var pz = (j + 0.1 + 0.8 * hash2(i, j, seed + 2)) * s;
        if (px < rect.x0 || px >= rect.x1 || pz < rect.z0 || pz >= rect.z1) continue;
        var cls = opts.classAt(px, pz);
        var p = (L.prob[cls] || 0) * dens;
        if (p <= 0 || hash2(i, j, seed + 3) >= p) continue;
        if (opts.roadDist && opts.roadDist(px, pz) < minRoad) continue;
        out.push({ x: px, z: pz, cls: cls, r0: hash2(i, j, seed + 4), r1: hash2(i, j, seed + 5), r2: hash2(i, j, seed + 6), r3: hash2(i, j, seed + 7) });
        if (opts.annotate) opts.annotate(out[out.length - 1]);      // justo tras roadDist: puede reutilizar esa consulta
      }
    }
    return out;
  }

  /** Color de la linea central segun pais: amarilla en America del Norte y Brasil; blanca en el resto (Chile, Europa). */
  function centerLineColor(country) {
    var c = stripAccents(country);
    return /estados unidos|^ee\.? ?uu|^usa$|united states|canada|mexico|brasil|brazil/.test(c) ? 'amarilla' : 'blanca';
  }

  /**
   * Suaviza la polilinea del camino con Catmull-Rom (k subdivisiones por segmento).
   * Conserva los puntos originales y sus distancias (los ciclistas siguen en su distM).
   */
  function smoothPath(path, k) {
    var n = path.n;
    if (n < 3 || !(k > 1)) return path;
    var m = (n - 1) * k + 1;
    var D = new Float64Array(m), X = new Float64Array(m), Z = new Float64Array(m), Y = new Float64Array(m);
    function cr(p0, p1, p2, p3, t) {
      var t2 = t * t, t3 = t2 * t;
      return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
    }
    var o = 0;
    for (var i = 0; i < n - 1; i++) {
      var a = Math.max(0, i - 1), b = i, c = i + 1, d = Math.min(n - 1, i + 2);
      for (var s = 0; s < k; s++, o++) {
        var t = s / k;
        D[o] = path.D[b] + (path.D[c] - path.D[b]) * t;
        X[o] = cr(path.X[a], path.X[b], path.X[c], path.X[d], t);
        Z[o] = cr(path.Z[a], path.Z[b], path.Z[c], path.Z[d], t);
        // altura: interpolacion monotona (Catmull-Rom acotado entre los extremos del tramo)
        var yy = cr(path.Y[a], path.Y[b], path.Y[c], path.Y[d], t);
        var lo = Math.min(path.Y[b], path.Y[c]), hi = Math.max(path.Y[b], path.Y[c]);
        Y[o] = clamp(yy, lo, hi);
      }
    }
    D[o] = path.D[n - 1]; X[o] = path.X[n - 1]; Z[o] = path.Z[n - 1]; Y[o] = path.Y[n - 1];
    return { n: m, D: D, X: X, Z: Z, Y: Y };
  }

  /** Indice espacial de segmentos del camino (celdas de `cell` m). */
  function buildRoadIndex(path, cell) {
    var map = new Map(), c = cell || 32;
    for (var i = 0; i < path.n - 1; i++) {
      var ax = path.X[i], az = path.Z[i], bx = path.X[i + 1], bz = path.Z[i + 1];
      var cx0 = Math.floor(Math.min(ax, bx) / c), cx1 = Math.floor(Math.max(ax, bx) / c);
      var cz0 = Math.floor(Math.min(az, bz) / c), cz1 = Math.floor(Math.max(az, bz) / c);
      for (var cz = cz0; cz <= cz1; cz++) {
        for (var cx = cx0; cx <= cx1; cx++) {
          var key = (cx + 32768) * 65536 + (cz + 32768);
          var arr = map.get(key);
          if (!arr) map.set(key, arr = []);
          arr.push(i);
        }
      }
    }
    return { cell: c, map: map, path: path, stamp: new Int32Array(Math.max(1, path.n)), qid: 0 };
  }

  /**
   * Consulta del camino en (x, z) dentro de un radio R:
   * out.d = distancia al eje mas cercano (R+1 si no hay), out.sd = con signo (+ derecha del rumbo), out.y = altura del eje alli,
   * out.k = influencia [0,1] (1 hasta `plateau` m, cae a 0 en `R`), out.yb = altura del camino ponderada por cercania
   * (en horquillas pesa el tramo mas cercano, sin saltos).
   */
  function roadQuery(idx, x, z, R, plateau, out) {
    var c = idx.cell, P = idx.path, X = P.X, Z = P.Z, Y = P.Y;
    var cx0 = Math.floor((x - R) / c), cx1 = Math.floor((x + R) / c), cz0 = Math.floor((z - R) / c), cz1 = Math.floor((z + R) / c);
    var q = ++idx.qid, st = idx.stamp;
    var best = R * R, bd = -1, by = 0, bsd = 0, kMax = 0, sw = 0, sy = 0, R2 = R * R, span = R - plateau;
    for (var cz = cz0; cz <= cz1; cz++) {
      for (var cx = cx0; cx <= cx1; cx++) {
        var arr = idx.map.get((cx + 32768) * 65536 + (cz + 32768));
        if (!arr) continue;
        for (var a = 0; a < arr.length; a++) {
          var i = arr[a];
          if (st[i] === q) continue;
          st[i] = q;
          var ax = X[i], az = Z[i], ex = X[i + 1] - ax, ez = Z[i + 1] - az;
          var ll = ex * ex + ez * ez, t = ll > 0 ? ((x - ax) * ex + (z - az) * ez) / ll : 0;
          t = t < 0 ? 0 : (t > 1 ? 1 : t);
          var qx = ax + ex * t - x, qz = az + ez * t - z, d2 = qx * qx + qz * qz;
          if (d2 >= R2) continue;
          var d = Math.sqrt(d2), yy = Y[i] + (Y[i + 1] - Y[i]) * t;
          var u = (d - plateau) / span, k = d <= plateau ? 1 : 1 - u * u * (3 - 2 * u);
          if (k > kMax) kMax = k;
          var w = k * k; w *= w; w *= w;                      // k^8: domina el tramo mas cercano
          w += 1e-9;
          sw += w; sy += w * yy;
          if (d2 < best) {
            best = d2; bd = d; by = yy;
            var l = Math.sqrt(ll) || 1;
            bsd = ((x - ax) * -ez + (z - az) * ex) / l;   // + = derecha (derecha = (-hz, hx))
          }
        }
      }
    }
    out.d = bd < 0 ? R + 1 : bd;
    out.sd = bd < 0 ? R + 1 : bsd;
    out.y = by;
    out.k = kMax;
    out.yb = sw > 0 ? sy / sw : by;
    return out;
  }

  /** Radio de giro (m) en cada punto del camino, medido con el cambio de rumbo sobre +-span m de arco. */
  function curveRadii(path, span) {
    var n = path.n, out = new Float32Array(n), w = 0;
    var step = n > 1 ? (path.D[n - 1] - path.D[0]) / (n - 1) : 1;
    w = Math.max(1, Math.round((span || 12) / (step || 1)));
    for (var i = 0; i < n; i++) {
      var a = Math.max(0, i - w), b = Math.min(n - 1, i + w), m = i;
      if (b - a < 2) { out[i] = 1e6; continue; }
      var h1 = Math.atan2(path.Z[m] - path.Z[a], path.X[m] - path.X[a]);
      var h2 = Math.atan2(path.Z[b] - path.Z[m], path.X[b] - path.X[m]);
      var dh = h2 - h1;
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      var arc = path.D[b] - path.D[a];
      out[i] = Math.abs(dh) > 1e-4 ? (arc / 2 / Math.abs(dh)) * (dh > 0 ? 1 : -1) : 1e6;   // rumbos de cuerdas separados por arc/2   // signo: + gira a la derecha (z hacia abajo)
    }
    return out;
  }

  /* ---- cielo de Preetham (port JS del shader de three/examples Sky.js, MIT) para niebla y luces ---- */
  function preethamSky(dir, sun, p, out) {
    var pi = Math.PI, e = Math.E;
    var up = 1;
    var sunE = 1000 * Math.max(0, 1 - Math.pow(e, -((1.6110731556870734 - Math.acos(clamp(sun[1] * up, -1, 1))) / 1.5)));
    var sunfade = 1 - clamp(1 - Math.exp(sun[1] / 450000), 0, 1);
    var rc = p.rayleigh - (1 - sunfade);
    var tr = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
    var mc = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
    var cM = (0.2 * p.turbidity) * 10e-18;
    var zen = Math.acos(Math.max(0, dir[1]));
    var inv = 1 / (Math.cos(zen) + 0.15 * Math.pow(93.885 - (zen * 180) / pi, -1.253));
    var sR = 8.4e3 * inv, sM = 1.25e3 * inv;
    var cosT = dir[0] * sun[0] + dir[1] * sun[1] + dir[2] * sun[2];
    var rPh = 0.05968310365946075 * (1 + Math.pow(cosT * 0.5 + 0.5, 2));
    var g = p.mieDirectionalG, g2 = g * g;
    var mPh = 0.07957747154594767 * ((1 - g2) / Math.pow(1 - 2 * g * cosT + g2, 1.5));
    var mixF = clamp(Math.pow(1 - sun[1], 5), 0, 1);
    var add = [0, 0.0003, 0.00075];
    for (var c = 0; c < 3; c++) {
      var bR = tr[c] * rc, bM = 0.434 * cM * mc[c] * p.mieCoefficient;
      var Fex = Math.exp(-(bR * sR + bM * sM));
      var ratio = (bR * rPh + bM * mPh) / (bR + bM);
      var Lin = Math.pow(sunE * ratio * (1 - Fex), 1.5);
      Lin *= 1 + (Math.pow(sunE * ratio * Fex, 0.5) - 1) * mixF;
      var tex = (Lin + 0.1 * Fex) * 0.04 + add[c];
      out[c] = Math.pow(tex, 1 / (1.2 + 1.2 * sunfade));
    }
    return out;
  }

  /** ACES filmico de three r149 (lineal -> lineal en [0,1]) con exposicion. */
  function acesFilmic(rgb, exposure, out) {
    var r = rgb[0] * exposure / 0.6, g = rgb[1] * exposure / 0.6, b = rgb[2] * exposure / 0.6;
    var i0 = 0.59719 * r + 0.35458 * g + 0.04823 * b, i1 = 0.07600 * r + 0.90834 * g + 0.01566 * b, i2 = 0.02840 * r + 0.13383 * g + 0.83777 * b;
    function fit(v) { var a = v * (v + 0.0245786) - 0.000090537, d = v * (0.983729 * v + 0.4329510) + 0.238081; return a / d; }
    i0 = fit(i0); i1 = fit(i1); i2 = fit(i2);
    out[0] = clamp(1.60475 * i0 - 0.53108 * i1 - 0.07367 * i2, 0, 1);
    out[1] = clamp(-0.10208 * i0 + 1.10813 * i1 - 0.00605 * i2, 0, 1);
    out[2] = clamp(-0.00327 * i0 - 0.07276 * i1 + 1.07602 * i2, 0, 1);
    return out;
  }
  function linearToSrgb(c) { return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }

  /** Direccion (unitaria) del sol a media tarde: elev ~35 grados; al NO en el hemisferio sur, al SO en el norte. */
  function sunDirection(lat, elevDeg, azDeg) {
    var el = (elevDeg == null ? 35 : elevDeg) * DEG;
    var az = (azDeg == null ? (lat < 0 ? 300 : 245) : azDeg) * DEG;    // azimut desde el norte, horario
    return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
  }

  /** Ruido fbm tileable size x size en [0,1): suma de octavas de ruido de valor con periodo `periods[i]` celdas. */
  function fbmTile(size, periods, weights, seed) {
    var out = new Float32Array(size * size), wsum = 0, k, x, y;
    for (k = 0; k < periods.length; k++) {
      var P = periods[k], cell = size / P, wt = weights[k], lat = new Float32Array(P * P);
      for (y = 0; y < P; y++) for (x = 0; x < P; x++) lat[y * P + x] = hash2(x, y, (seed | 0) + k * 131);
      for (y = 0; y < size; y++) {
        var fy = y / cell, yi = Math.floor(fy), ty = fy - yi; ty = ty * ty * (3 - 2 * ty);
        var y0 = (yi % P) * P, y1 = ((yi + 1) % P) * P;
        for (x = 0; x < size; x++) {
          var fx = x / cell, xi = Math.floor(fx), tx = fx - xi; tx = tx * tx * (3 - 2 * tx);
          var x0 = xi % P, x1 = (xi + 1) % P;
          var a = lat[y0 + x0] + (lat[y0 + x1] - lat[y0 + x0]) * tx, b = lat[y1 + x0] + (lat[y1 + x1] - lat[y1 + x0]) * tx;
          out[y * size + x] += (a + (b - a) * ty) * wt;
        }
      }
      wsum += wt;
    }
    for (k = 0; k < out.length; k++) out[k] /= wsum;
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Soporte WebGL                                                       */
  /* ------------------------------------------------------------------ */

  var _supported = false;
  function isSupported() {
    if (_supported) return true;
    try {
      if (typeof document === 'undefined' || !G.THREE) return false;
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return false;
      var ext = gl.getExtension && gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
      _supported = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Shaders (GLSL inyectado con onBeforeCompile)                        */
  /* ------------------------------------------------------------------ */

  // Cielo de Preetham (three/examples/jsm/objects/Sky.js, MIT: Simon Wallner, Martin Upitis, zz85),
  // con direccion relativa a la camara, saturacion/escala para el tonemapping ACES y una capa de nubes.
  var SKY_VS = [
    'uniform vec3 sunPosition; uniform float rayleigh; uniform float turbidity; uniform float mieCoefficient; uniform vec3 up;',
    'varying vec3 vWorldPosition; varying vec3 vSunDirection; varying float vSunfade; varying vec3 vBetaR; varying vec3 vBetaM; varying float vSunE;',
    'const float e = 2.71828182845904523536028747135266249775724709369995957;',
    'const float pi = 3.141592653589793238462643383279502884197169;',
    'const vec3 totalRayleigh = vec3(5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5);',
    'const vec3 MieConst = vec3(1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14);',
    'const float cutoffAngle = 1.6110731556870734; const float steepness = 1.5; const float EE = 1000.0;',
    'float sunIntensity(float zenithAngleCos) { zenithAngleCos = clamp(zenithAngleCos, -1.0, 1.0); return EE * max(0.0, 1.0 - pow(e, -((cutoffAngle - acos(zenithAngleCos)) / steepness))); }',
    'vec3 totalMie(float T) { float c = (0.2 * T) * 10E-18; return 0.434 * c * MieConst; }',
    'void main() {',
    '  vec4 worldPosition = modelMatrix * vec4(position, 1.0); vWorldPosition = worldPosition.xyz;',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z = gl_Position.w;',
    '  vSunDirection = normalize(sunPosition); vSunE = sunIntensity(dot(vSunDirection, up));',
    '  vSunfade = 1.0 - clamp(1.0 - exp((sunPosition.y / 450000.0)), 0.0, 1.0);',
    '  float rayleighCoefficient = rayleigh - (1.0 * (1.0 - vSunfade));',
    '  vBetaR = totalRayleigh * rayleighCoefficient; vBetaM = totalMie(turbidity) * mieCoefficient;',
    '}'
  ].join('\n');
  var SKY_FS = [
    'varying vec3 vWorldPosition; varying vec3 vSunDirection; varying float vSunfade; varying vec3 vBetaR; varying vec3 vBetaM; varying float vSunE;',
    'uniform float mieDirectionalG; uniform vec3 up; uniform float uScale; uniform float uSat; uniform sampler2D uClouds; uniform float uTime; uniform float uCover;',
    'const float pi = 3.141592653589793238462643383279502884197169;',
    'const float rayleighZenithLength = 8.4E3; const float mieZenithLength = 1.25E3;',
    'const float sunAngularDiameterCos = 0.999956676946448443553574619906976478926848692873900859324;',
    'const float THREE_OVER_SIXTEENPI = 0.05968310365946075; const float ONE_OVER_FOURPI = 0.07957747154594767;',
    'float rayleighPhase(float cosTheta) { return THREE_OVER_SIXTEENPI * (1.0 + pow(cosTheta, 2.0)); }',
    'float hgPhase(float cosTheta, float g) { float g2 = pow(g, 2.0); float inverse = 1.0 / pow(1.0 - 2.0 * g * cosTheta + g2, 1.5); return ONE_OVER_FOURPI * ((1.0 - g2) * inverse); }',
    'void main() {',
    '  vec3 direction = normalize(vWorldPosition - cameraPosition);',
    '  float zenithAngle = acos(max(0.0, dot(up, direction)));',
    '  float inverse = 1.0 / (cos(zenithAngle) + 0.15 * pow(93.885 - ((zenithAngle * 180.0) / pi), -1.253));',
    '  float sR = rayleighZenithLength * inverse; float sM = mieZenithLength * inverse;',
    '  vec3 Fex = exp(-(vBetaR * sR + vBetaM * sM));',
    '  float cosTheta = dot(direction, vSunDirection);',
    '  float rPhase = rayleighPhase(cosTheta * 0.5 + 0.5); vec3 betaRTheta = vBetaR * rPhase;',
    '  float mPhase = hgPhase(cosTheta, mieDirectionalG); vec3 betaMTheta = vBetaM * mPhase;',
    '  vec3 Lin = pow(vSunE * ((betaRTheta + betaMTheta) / (vBetaR + vBetaM)) * (1.0 - Fex), vec3(1.5));',
    '  Lin *= mix(vec3(1.0), pow(vSunE * ((betaRTheta + betaMTheta) / (vBetaR + vBetaM)) * Fex, vec3(1.0 / 2.0)), clamp(pow(1.0 - dot(up, vSunDirection), 5.0), 0.0, 1.0));',
    '  vec3 L0 = vec3(0.1) * Fex;',
    '  float sundisk = smoothstep(sunAngularDiameterCos, sunAngularDiameterCos + 0.00002, cosTheta);',
    '  vec3 sunL = (vSunE * 19000.0 * Fex) * sundisk;',
    '  vec3 texColor = (Lin + L0) * 0.04 + vec3(0.0, 0.0003, 0.00075);',
    '  vec3 col = pow(texColor, vec3(1.0 / (1.2 + (1.2 * vSunfade))));',
    '  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));',
    '  col = max(vec3(0.0), vec3(lum) + (col - vec3(lum)) * uSat) * uScale;',
    '  vec2 cuv = direction.xz / (max(direction.y, 0.0) + 0.1) * 0.22 + vec2(uTime * 0.0021, uTime * 0.0008);',
    '  float n = texture2D(uClouds, cuv).r * 0.62 + texture2D(uClouds, cuv * 2.9 + vec2(0.31, 0.17)).r * 0.38;',   // fuera del if: derivadas validas
    '  if (direction.y > 0.0) {',
    '    float cov = smoothstep(uCover, uCover + 0.22, n) * smoothstep(0.02, 0.2, direction.y);',
    '    float lit = 0.78 + 0.32 * smoothstep(uCover, uCover + 0.5, n) + 0.35 * pow(max(cosTheta, 0.0), 6.0);',
    '    vec3 cloud = vec3(1.0, 0.99, 0.97) * 1.55 * uScale * lit;',
    '    col = mix(col, cloud, cov * 0.92);',
    '    sunL *= 1.0 - cov;',
    '  }',
    '  gl_FragColor = vec4(min(col + sunL * 0.04 * uScale, vec3(60.0)), 1.0);',   // acotado: el mapa de entorno es half float (sin Inf/NaN)
    '  #include <tonemapping_fragment>',
    '  #include <encodings_fragment>',
    '}'
  ].join('\n');

  var TERRAIN_VS_PARS = [
    'uniform vec2 uSnap; uniform vec4 uRoadFar;',
    'varying vec3 vTW; varying vec3 vTN; varying vec2 vTRel;',
    '#ifdef TERRAIN_HI',
    'attribute float aRoadD; varying float vRoadD;',
    '#endif'
  ].join('\n');
  var TERRAIN_VS_MAIN = [
    'vec4 tw4 = modelMatrix * vec4(transformed, 1.0);',
    'vTW = tw4.xyz; vTN = normalize(mat3(modelMatrix) * objectNormal); vTRel = tw4.xz - uSnap;',
    '#ifdef TERRAIN_HI',
    'vRoadD = aRoadD;',
    '#endif'
  ].join('\n');
  var TERRAIN_FS_PARS = [
    'uniform sampler2D uDetail; uniform sampler2D uDetailN; uniform sampler2D uLand;',
    'uniform vec4 uLandXf; uniform vec2 uLandTex; uniform vec2 uNearFar; uniform float uRoadClip;',
    'uniform vec3 uPal0; uniform vec3 uPal1; uniform vec3 uPal2; uniform vec3 uPal3;',
    'varying vec3 vTW; varying vec3 vTN; varying vec2 vTRel;',
    '#ifdef TERRAIN_HI',
    'varying float vRoadD;',
    '#endif',
    '#ifdef TERRAIN_COARSE',
    'uniform sampler2D uMask; uniform vec4 uMaskXf;',
    '#endif',
    'vec4 tW; vec4 tDA; float tNear;'
  ].join('\n');
  var TERRAIN_FS_DISCARD = [
    '#ifdef TERRAIN_COARSE',
    '  vec2 muv = (vTW.xz - uMaskXf.xy) * uMaskXf.zw;',
    '  if (muv.x > 0.0 && muv.x < 1.0 && muv.y > 0.0 && muv.y < 1.0 && texture2D(uMask, muv).r > 0.5) discard;',
    '#endif',
    '#ifdef TERRAIN_HI',
    '  if (vRoadD < uRoadClip) discard;',
    '#endif'
  ].join('\n');
  // color: satelite lejos; cerca, mezcla de texturas de detalle por cobertura + pendiente (con tinte satelital)
  var TERRAIN_FS_COLOR = [
    '{',
    '  vec2 luv = clamp((vTW.xz - uLandXf.xy) * uLandXf.zw, 0.0, 1.0);',
    '  luv = (luv * (uLandTex - 1.0) + 0.5) / uLandTex;',
    '  vec4 lw = texture2D(uLand, luv);',
    '  float tslope = 1.0 - clamp(normalize(vTN).y, 0.0, 1.0);',
    '  float rockS = smoothstep(0.2, 0.42, tslope);',
    '  tDA = texture2D(uDetail, vTRel * 0.25);',
    '  vec4 dB = texture2D(uDetail, vTRel * 0.0416667 + vec2(0.37, 0.11));',
    '  vec4 det = tDA * 0.6 + dB * 0.4;',
    '  vec4 w = lw; w.b = max(w.b, rockS); w.r *= 1.0 - rockS; w.g *= 1.0 - 0.6 * rockS;',
    '  w = w * (0.25 + det); w = w * w; w = w * w;',
    '  w /= max(dot(w, vec4(1.0)), 1e-4); tW = w;',
    '  float dist = distance(vTW, cameraPosition);',
    '  tNear = 1.0 - smoothstep(uNearFar.x, uNearFar.y, dist);',
    '  vec3 sat = diffuseColor.rgb;',
    '  vec3 pal = uPal0 * w.r + uPal1 * w.g + uPal2 * w.b + uPal3 * w.a;',
    '  float sl = dot(sat, vec3(0.3, 0.59, 0.11)), pl = dot(pal, vec3(0.3, 0.59, 0.11));',
    '  vec3 tinted = mix(pal, pal * (sat / max(sl, 1e-3)) * pl, 0.45);',
    '  vec3 nearC = mix(tinted, sat, 0.35) * (0.45 + 1.1 * dot(w, tDA));',
    '  vec3 farC = sat * (0.82 + 0.36 * dot(w, dB));',
    '  diffuseColor.rgb = mix(farC, nearC, tNear);',
    '  diffuseColor.rgb = mix(diffuseColor.rgb, uPal3 * (0.85 + 0.3 * det.a), w.a * (1.0 - tNear) * 0.55);',
    '}'
  ].join('\n');
  var TERRAIN_FS_NORMAL = [
    '{',
    '  vec4 nA = texture2D(uDetailN, vTRel * 0.25);',
    '  vec2 ng = (nA.rg * 2.0 - 1.0) * (tW.r + tW.g) + (nA.ba * 2.0 - 1.0) * (tW.b + tW.a * 0.3);',
    '  vec3 nw = normalize(normalize(vTN) + vec3(ng.x, 0.0, ng.y) * 0.85 * tNear);',
    '  normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz);',
    '}'
  ].join('\n');

  // Viento: balanceo proporcional a la altura (geometrias de altura 1), rafagas que viajan con el viento + temblor de hojas
  var WIND_PARS = 'uniform float uTime; uniform vec2 uWindDir; uniform vec3 uWind;';   // uWind = (amplitud, frecuencia, temblor)
  var WIND_MAIN = [
    '{',
    '#ifdef USE_INSTANCING',
    '  vec3 wI = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);',
    '  vec3 wd = vec3(uWindDir.x, 0.0, uWindDir.y);',
    '  vec3 wl = vec3(dot(wd, instanceMatrix[0].xyz), 0.0, dot(wd, instanceMatrix[2].xyz));',
    '  wl /= max(length(wl), 1e-4);',
    '#else',
    '  vec3 wI = vec3(0.0); vec3 wl = vec3(uWindDir.x, 0.0, uWindDir.y);',
    '#endif',
    '  float ph = dot(wI.xz, vec2(0.031, 0.047));',
    '  float along = dot(wI.xz, uWindDir);',
    '  float gust = 0.5 + 0.5 * sin(uTime * 0.55 - along * 0.035) * sin(uTime * 0.21 - along * 0.011 + 1.7);',
    '  float hN = max(position.y, 0.0);',
    '  float bend = uWind.x * hN * hN * (0.25 + 1.5 * gust + 0.35 * sin(uTime * uWind.y + ph));',
    '  transformed.x += wl.x * bend; transformed.z += wl.z * bend; transformed.y -= 0.35 * bend * bend;',
    '  transformed += normal * uWind.z * hN * (0.4 + gust) * sin(uTime * 7.0 + ph * 13.0 + position.x * 23.0 + position.z * 19.0);',
    '}'
  ].join('\n');

  // Camino/berma: lejos de la malla fina el borde sube sobre el DEM grueso (como antes) para no enterrarse
  var ROAD_VS_PARS = 'attribute float aLift; uniform vec4 uRoadFar;';   // (camX, camZ, d0, d1)
  var ROAD_VS_MAIN = 'transformed.y += aLift * smoothstep(uRoadFar.z, uRoadFar.w, distance(position.xz, uRoadFar.xy));';

  /* ------------------------------------------------------------------ */
  /* Escena                                                              */
  /* ------------------------------------------------------------------ */

  function create(container, route, opts) {
    if (!isSupported()) throw new Error('Scene3D: WebGL o THREE no disponible');
    if (!route || !route.points || route.points.length < 2) throw new Error('Scene3D: la ruta necesita al menos 2 puntos');
    opts = opts || {};
    var T = G.THREE;
    var qualityMode = QUALITIES.indexOf(opts.quality) >= 0 ? opts.quality : 'auto';
    function envInfo() {
      var coarse = false;
      try { coarse = !!(G.matchMedia && G.matchMedia('(pointer: coarse)').matches); } catch (e) { coarse = false; }
      return { coarse: coarse, width: G.innerWidth || container.clientWidth || 1280 };
    }
    var level = resolveQuality(qualityMode, envInfo());
    var Q = qualityPreset(level);
    var vScale = opts.verticalScale > 0 ? opts.verticalScale : 1;
    var disposed = false, contextLost = false;
    var own = [];                                   // geometrias / materiales / texturas propios
    function track(x) { own.push(x); return x; }
    function lin(hex) { return new T.Color(hex).convertSRGBToLinear(); }
    function newCanvas(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
    function canvasTex(canvas) {
      var t = track(new T.CanvasTexture(canvas));
      t.encoding = T.sRGBEncoding;
      return t;
    }
    function smooth01(a, b, v) { var t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

    /* ---- datos ---- */
    var origin = originOf(route);
    var grid = makeHeightGrid(route, origin, vScale);
    var path = smoothPath(buildRoadPath(route, origin, grid), 4);     // ~5 m entre puntos: curvas suaves
    var totalDist = path.D[path.n - 1];
    var roadIdx = buildRoadIndex(path, 24);
    var seed = 0;
    (function () { var s = String(route.id || route.name || 'ruta'); for (var i = 0; i < s.length; i++) seed = (Math.imul(seed, 31) + s.charCodeAt(i)) | 0; })();
    var lc = null;
    if (grid.real) { try { lc = decodeLandcover(route.terrain && route.terrain.landcover); } catch (e) { lc = null; } }
    if (!lc) lc = deriveLandcover(grid, seed);
    var isChile = /chile/.test(stripAccents(route.country));
    var cw = (grid.x1 - grid.x0) / (grid.w - 1), ch = (grid.z1 - grid.z0) / (grid.h - 1);

    function classAt(x, z) { return landcoverAt(lc, grid, x, z); }

    // altura de la malla gruesa (misma triangulacion que la malla: diagonal (r+1,c)-(r,c+1))
    function triHeight(x, z) {
      var w = grid.w, d = grid.data;
      var fx = clamp((x - grid.x0) / (grid.x1 - grid.x0), 0, 1) * (w - 1);
      var fz = clamp((z - grid.z0) / (grid.z1 - grid.z0), 0, 1) * (grid.h - 1);
      var c = Math.min(Math.floor(fx), w - 2), r = Math.min(Math.floor(fz), grid.h - 2);
      var tx = fx - c, tz = fz - r, o = r * w + c;
      var h00 = d[o], h01 = d[o + 1], h10 = d[o + w], h11 = d[o + w + 1];
      if (tx + tz <= 1) return h00 + (h01 - h00) * tx + (h10 - h00) * tz;
      return h11 + (h10 - h11) * (1 - tx) + (h01 - h11) * (1 - tz);
    }
    // Catmull-Rom bicubico de la grilla (solo para normales suaves)
    function gv(c, r) { c = c < 0 ? 0 : (c >= grid.w ? grid.w - 1 : c); r = r < 0 ? 0 : (r >= grid.h ? grid.h - 1 : r); return grid.data[r * grid.w + c]; }
    function crw(p0, p1, p2, p3, t) { return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0))); }
    function bicubic(x, z) {
      var fx = clamp((x - grid.x0) / (grid.x1 - grid.x0), 0, 1) * (grid.w - 1);
      var fz = clamp((z - grid.z0) / (grid.z1 - grid.z0), 0, 1) * (grid.h - 1);
      var c = Math.floor(fx), r = Math.floor(fz), tx = fx - c, tz = fz - r;
      var a = crw(gv(c - 1, r - 1), gv(c, r - 1), gv(c + 1, r - 1), gv(c + 2, r - 1), tx);
      var b = crw(gv(c - 1, r), gv(c, r), gv(c + 1, r), gv(c + 2, r), tx);
      var e = crw(gv(c - 1, r + 1), gv(c, r + 1), gv(c + 1, r + 1), gv(c + 2, r + 1), tx);
      var f = crw(gv(c - 1, r + 2), gv(c, r + 2), gv(c + 1, r + 2), gv(c + 2, r + 2), tx);
      return crw(a, b, e, f, tz);
    }

    /* ---- renderer / escena / camara ---- */
    var dpr = G.devicePixelRatio || 1;
    var pixelRatio = Math.min(dpr, Q.pixelRatioMax);
    var renderer = new T.WebGLRenderer({ antialias: level !== 'baja', powerPreference: 'high-performance' });
    renderer.outputEncoding = T.sRGBEncoding;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    var EXPOSURE = 0.6;
    renderer.toneMappingExposure = EXPOSURE;
    var maxAniso = renderer.capabilities.getMaxAnisotropy();
    var canvasEl = renderer.domElement;
    canvasEl.style.width = '100%';
    canvasEl.style.height = '100%';
    canvasEl.style.display = 'block';
    container.appendChild(canvasEl);

    var scene = new T.Scene();
    var camera = new T.PerspectiveCamera(BASE_FOV, 16 / 9, 1, 30000);

    /* ---- cielo fisico, niebla (perspectiva aerea), luces ---- */
    var SUN_V = sunDirection(origin.lat);
    var SUN_DIR = new T.Vector3(SUN_V[0], SUN_V[1], SUN_V[2]);
    var SKY_P = { turbidity: 2, rayleigh: 2, mieCoefficient: 0.003, mieDirectionalG: 0.8 };
    var SKY_SAT = 2.0, SKY_SCALE = 0.7;
    function skyLinear(dir) {        // = color del shader (sin sol ni nubes), lineal antes del tonemapping
      var c = preethamSky(dir, SUN_V, SKY_P, [0, 0, 0]);
      var L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      return [Math.max(0, L + (c[0] - L) * SKY_SAT) * SKY_SCALE, Math.max(0, L + (c[1] - L) * SKY_SAT) * SKY_SCALE, Math.max(0, L + (c[2] - L) * SKY_SAT) * SKY_SCALE];
    }
    function avgSky(elevDeg) {
      var acc = [0, 0, 0], e = elevDeg * DEG;
      for (var a = 0; a < 16; a++) {
        var az = a / 16 * Math.PI * 2, c = skyLinear([Math.cos(az) * Math.cos(e), Math.sin(e), Math.sin(az) * Math.cos(e)]);
        acc[0] += c[0] / 16; acc[1] += c[1] / 16; acc[2] += c[2] / 16;
      }
      return acc;
    }
    var horizonLin = avgSky(1.5), zenithLin = avgSky(60);
    // la niebla se mezcla despues del tonemapping y la codificacion sRGB: su color va en espacio de pantalla
    var fogDisp = acesFilmic(horizonLin, EXPOSURE, [0, 0, 0]).map(linearToSrgb);
    var FOG_DENSITY = 1 / 11500;
    scene.fog = new T.FogExp2(new T.Color(fogDisp[0], fogDisp[1], fogDisp[2]), FOG_DENSITY);

    var cloudTex = (function () {
      var S = 256, data = new Uint8Array(S * S * 4);
      var f = fbmTile(S, [4, 8, 16, 32, 64], [0.42, 0.26, 0.16, 0.1, 0.06], seed + 11);
      for (var i = 0; i < S * S; i++) { var v = Math.round(clamp(f[i], 0, 1) * 255); data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255; }
      var t = track(new T.DataTexture(data, S, S, T.RGBAFormat));
      t.wrapS = t.wrapT = T.RepeatWrapping; t.magFilter = T.LinearFilter; t.minFilter = T.LinearMipmapLinearFilter; t.generateMipmaps = true;
      t.needsUpdate = true;
      return t;
    })();
    var skyU = {
      turbidity: { value: SKY_P.turbidity }, rayleigh: { value: SKY_P.rayleigh }, mieCoefficient: { value: SKY_P.mieCoefficient },
      mieDirectionalG: { value: SKY_P.mieDirectionalG }, sunPosition: { value: SUN_DIR.clone() }, up: { value: new T.Vector3(0, 1, 0) },
      uScale: { value: SKY_SCALE }, uSat: { value: SKY_SAT }, uClouds: { value: cloudTex }, uTime: { value: 0 }, uCover: { value: 0.56 }
    };
    var skyMat = track(new T.ShaderMaterial({ uniforms: skyU, vertexShader: SKY_VS, fragmentShader: SKY_FS, side: T.BackSide, depthWrite: false, fog: false }));
    var skyGeo = track(new T.BoxGeometry(1, 1, 1));
    var sky = new T.Mesh(skyGeo, skyMat);
    sky.scale.setScalar(20000);
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    scene.add(sky);

    // mapa de entorno (reflejos del cielo en agua, barreras metalicas, cuadros)
    var envTex = null;
    // el entorno PMREM es half float: requiere WebGL2 o EXT_color_buffer_half_float (si no, sin reflejos del cielo)
    if (renderer.capabilities.isWebGL2 || renderer.extensions.has('EXT_color_buffer_half_float')) try {
      var skyScene = new T.Scene(), skyClone = new T.Mesh(skyGeo, skyMat);
      skyClone.scale.setScalar(5000); skyClone.frustumCulled = false; skyScene.add(skyClone);
      var pm = new T.PMREMGenerator(renderer);
      var envRT = track(pm.fromScene(skyScene, 0, 1, 20000));
      pm.dispose();
      envTex = envRT.texture;
    } catch (e) { envTex = null; }

    var HEMI_I = 1.05, SUN_I = 2.7;
    var zn = Math.max(zenithLin[0], zenithLin[1], zenithLin[2]) || 1;
    var hemi = new T.HemisphereLight(new T.Color(zenithLin[0] / zn, zenithLin[1] / zn, zenithLin[2] / zn).lerp(new T.Color(1, 1, 1), 0.35), lin(0x6e6248), HEMI_I);
    scene.add(hemi);
    var sun = new T.DirectionalLight(lin(0xfff0da), SUN_I);
    scene.add(sun);
    scene.add(sun.target);
    sun.position.copy(SUN_DIR).multiplyScalar(400);

    /* ---- texturas procedurales (tileables) ---- */
    var detailTex, detailNTex;
    (function buildDetail() {
      var S = 512, n = S * S;
      var grass = fbmTile(S, [64, 128, 256], [0.35, 0.35, 0.3], seed + 21);
      var grass2 = fbmTile(S, [8, 16], [0.6, 0.4], seed + 22);
      var soil = fbmTile(S, [8, 16, 32, 64, 128], [0.14, 0.24, 0.26, 0.2, 0.16], seed + 23);
      var rockA = fbmTile(S, [4, 8, 16, 32, 64], [0.34, 0.26, 0.18, 0.13, 0.09], seed + 24);
      var rockB = fbmTile(S, [16, 32], [0.6, 0.4], seed + 25);
      var snow = fbmTile(S, [4, 8, 16, 64], [0.4, 0.3, 0.2, 0.1], seed + 26);
      var lum = new Uint8Array(n * 4), hg = new Float32Array(n), hr = new Float32Array(n), i;
      for (i = 0; i < n; i++) {
        var x = i % S, y = (i / S) | 0;
        var hp = hash2(x, y, seed + 27), pebble = hp > 0.985 ? 0.25 : (hp < 0.012 ? -0.2 : 0);
        var g = 0.5 + (grass[i] - 0.5) * 2.4 + (grass2[i] - 0.5) * 1.4 + (hash2(x, y, seed + 28) - 0.5) * 0.3;
        var s = 0.5 + (soil[i] - 0.5) * 2.2 + pebble * 1.4 + (hash2(x, y, seed + 30) - 0.5) * 0.16;
        var ridge = 1 - Math.abs(rockA[i] * 2 - 1);
        var crack = Math.abs(rockB[i] - 0.5) < 0.012 ? -0.28 : 0;
        var r = 0.15 + ridge * 0.75 + (rockB[i] - 0.5) * 0.6 + crack;
        var sn = 0.78 + (snow[i] - 0.5) * 0.6 + (hash2(x, y, seed + 29) > 0.996 ? 0.15 : 0);
        lum[i * 4] = clamp(g, 0, 1) * 255; lum[i * 4 + 1] = clamp(s, 0, 1) * 255;
        lum[i * 4 + 2] = clamp(r, 0, 1) * 255; lum[i * 4 + 3] = clamp(sn * 0.5, 0, 1) * 255;
        hg[i] = (g + s) * 0.5; hr[i] = r;
      }
      var nrm = new Uint8Array(n * 4);
      for (i = 0; i < n; i++) {
        var px = i % S, py = (i / S) | 0;
        var l = py * S + ((px + S - 1) % S), rr = py * S + ((px + 1) % S), u = ((py + S - 1) % S) * S + px, d = ((py + 1) % S) * S + px;
        var gx = (hg[l] - hg[rr]) * 2.2, gy = (hg[u] - hg[d]) * 2.2, rx = (hr[l] - hr[rr]) * 3.2, ry = (hr[u] - hr[d]) * 3.2;
        var lg = Math.sqrt(gx * gx + gy * gy + 1), lr = Math.sqrt(rx * rx + ry * ry + 1);
        nrm[i * 4] = (0.5 + 0.5 * gx / lg) * 255; nrm[i * 4 + 1] = (0.5 + 0.5 * gy / lg) * 255;
        nrm[i * 4 + 2] = (0.5 + 0.5 * rx / lr) * 255; nrm[i * 4 + 3] = (0.5 + 0.5 * ry / lr) * 255;
      }
      function mk(data) {
        var t = track(new T.DataTexture(data, S, S, T.RGBAFormat));
        t.wrapS = t.wrapT = T.RepeatWrapping; t.magFilter = T.LinearFilter; t.minFilter = T.LinearMipmapLinearFilter;
        t.generateMipmaps = true; t.anisotropy = Math.min(4, maxAniso); t.needsUpdate = true;
        return t;
      }
      detailTex = mk(lum); detailNTex = mk(nrm);
    })();

    // pesos de mezcla por cobertura: R pasto, G suelo, B roca, A nieve
    var LAND_W = [[0, 40, 215, 0], [25, 220, 10, 0], [215, 40, 0, 0], [110, 135, 10, 0], [150, 105, 0, 0], [0, 220, 35, 0], [0, 0, 25, 230], [25, 150, 80, 0]];
    var landTex = (function () {
      var data = new Uint8Array(lc.w * lc.h * 4);
      for (var i = 0; i < lc.w * lc.h; i++) { var wv = LAND_W[lc.data[i]] || LAND_W[1]; data[i * 4] = wv[0]; data[i * 4 + 1] = wv[1]; data[i * 4 + 2] = wv[2]; data[i * 4 + 3] = wv[3]; }
      var t = track(new T.DataTexture(data, lc.w, lc.h, T.RGBAFormat));
      t.magFilter = T.LinearFilter; t.minFilter = T.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true;
      return t;
    })();

    /* ---- terreno: malla gruesa (DEM) + teselas finas cerca del camino + anillo lejano ---- */
    var hasTexture = !!(route.terrain && route.terrain.texture && grid.real);
    var TK = Math.max(1, Math.round(340 / Math.max(cw, ch)));
    var tilesX = Math.ceil((grid.w - 1) / TK), tilesZ = Math.ceil((grid.h - 1) / TK);
    var tileW = TK * cw, tileH = TK * ch, tileDiag = Math.sqrt(tileW * tileW + tileH * tileH);
    var maskData = new Uint8Array(tilesX * tilesZ * 4);
    var maskTex = track(new T.DataTexture(maskData, tilesX, tilesZ, T.RGBAFormat));
    maskTex.magFilter = T.NearestFilter; maskTex.minFilter = T.NearestFilter; maskTex.generateMipmaps = false; maskTex.needsUpdate = true;

    var ROAD_SINK = 0.12;           // m: la superficie bajo el camino queda apenas debajo del asfalto
    var BERM_OUT = 4.75;            // m desde el eje: borde exterior de la berma de grava
    var plateau = 0, roadInfl = 0;
    function setRoadShape() { plateau = BERM_OUT + Q.hiSpacing * 0.9; roadInfl = plateau + 32; }
    setRoadShape();

    var terrainU = {
      uSnap: { value: new T.Vector2() }, uDetail: { value: detailTex }, uDetailN: { value: detailNTex }, uLand: { value: landTex },
      uLandXf: { value: new T.Vector4(grid.x0, grid.z0, 1 / (grid.x1 - grid.x0), 1 / (grid.z1 - grid.z0)) },
      uLandTex: { value: new T.Vector2(lc.w, lc.h) }, uNearFar: { value: new T.Vector2(40, 420) }, uRoadClip: { value: 2.5 },
      uPal0: { value: new T.Color(0.105, 0.13, 0.05) }, uPal1: { value: new T.Color(0.2, 0.155, 0.105) },
      uPal2: { value: new T.Color(0.2, 0.19, 0.18) }, uPal3: { value: new T.Color(0.82, 0.85, 0.9) },
      uMask: { value: maskTex }, uMaskXf: { value: new T.Vector4(grid.x0, grid.z0, 1 / (tileW * tilesX), 1 / (tileH * tilesZ)) },
      uRoadFar: { value: new T.Vector4(0, 0, 1e6, 1e6 + 1) }
    };
    function terrainMaterial(hi) {
      var m = track(new T.MeshStandardMaterial(hasTexture ? { color: lin(0x6b7a52), roughness: 0.95, metalness: 0 } : { vertexColors: true, roughness: 0.95, metalness: 0 }));
      m.defines = hi ? { TERRAIN_HI: '' } : { TERRAIN_COARSE: '' };
      m.onBeforeCompile = function (sh) {
        for (var k in terrainU) sh.uniforms[k] = terrainU[k];
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\n' + TERRAIN_VS_PARS)
          .replace('#include <project_vertex>', '#include <project_vertex>\n' + TERRAIN_VS_MAIN);
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\n' + TERRAIN_FS_PARS)
          .replace('void main() {', 'void main() {\n' + TERRAIN_FS_DISCARD)
          .replace('#include <color_fragment>', '#include <color_fragment>\n' + TERRAIN_FS_COLOR)
          .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.55, tW.a);')
          .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + TERRAIN_FS_NORMAL);
      };
      m.customProgramCacheKey = function () { return hi ? 'rd-terrain-hi' : 'rd-terrain-lo'; };
      return m;
    }
    var terrainMat = terrainMaterial(false), terrainHiMat = terrainMaterial(true);

    function gridNormal(c, r, out, o) {            // diferencias centrales del DEM (coherente con el bicubico)
      var gx = (gv(c + 1, r) - gv(c - 1, r)) / ((Math.min(c + 1, grid.w - 1) - Math.max(c - 1, 0)) * cw);
      var gz = (gv(c, r + 1) - gv(c, r - 1)) / ((Math.min(r + 1, grid.h - 1) - Math.max(r - 1, 0)) * ch);
      var l = Math.sqrt(gx * gx + 1 + gz * gz);
      out[o] = -gx / l; out[o + 1] = 1 / l; out[o + 2] = -gz / l;
    }
    (function buildTerrain() {
      var nc = grid.w, nr = grid.h, nv = nc * nr;
      var pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
      var col = hasTexture ? null : new Float32Array(nv * 3);
      for (var r = 0, v = 0; r < nr; r++) {
        for (var c = 0; c < nc; c++, v++) {
          var y = grid.data[r * nc + c];
          pos[v * 3] = grid.x0 + cw * c; pos[v * 3 + 1] = y; pos[v * 3 + 2] = grid.z0 + ch * r;
          gridNormal(c, r, nrm, v * 3);
          uv[v * 2] = c / (nc - 1); uv[v * 2 + 1] = 1 - r / (nr - 1);
          if (col) { var nz = Math.sin(c * 12.9898 + r * 78.233) * 43758.5453; elevationColor(y / grid.vs + grid.base, (nz - Math.floor(nz)) - 0.5, col, v * 3); }
        }
      }
      var idx = new (nv > 65535 ? Uint32Array : Uint16Array)((nc - 1) * (nr - 1) * 6), k = 0;
      for (var a = 0; a < nr - 1; a++) {
        for (var b = 0; b < nc - 1; b++) {
          var i0 = a * nc + b, i1 = i0 + nc, i2 = i0 + 1, i3 = i1 + 1;
          idx[k++] = i0; idx[k++] = i1; idx[k++] = i2;
          idx[k++] = i2; idx[k++] = i1; idx[k++] = i3;
        }
      }
      var g = track(new T.BufferGeometry());
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      g.setAttribute('normal', new T.BufferAttribute(nrm, 3));
      g.setAttribute('uv', new T.BufferAttribute(uv, 2));
      if (col) g.setAttribute('color', new T.BufferAttribute(col, 3));
      g.setIndex(new T.BufferAttribute(idx, 1));
      g.computeBoundingSphere();
      var mesh = new T.Mesh(g, terrainMat);
      mesh.receiveShadow = true;
      scene.add(mesh);
    })();

    // anillo lejano: prolonga el borde del DEM con cordones montañosos hasta ~24 km (sin bordes visibles)
    var ringGeo = null, ringEdge = null;
    (function buildRing() {
      var w = grid.w, h = grid.h, border = [], c, r;
      for (c = 0; c < w; c++) border.push([c, 0]);
      for (r = 1; r < h; r++) border.push([w - 1, r]);
      for (c = w - 2; c >= 0; c--) border.push([c, h - 1]);
      for (r = h - 2; r >= 1; r--) border.push([0, r]);
      var M = border.length, NR = 18, RO = 24000;
      var cx = (grid.x0 + grid.x1) / 2, cz = (grid.z0 + grid.z1) / 2;
      var relief = Math.max(150, (route.terrain && route.terrain.maxEle != null ? route.terrain.maxEle - route.terrain.minEle : 600));
      var A = clamp(relief * 0.75, 220, 1700) * grid.vs, bsum = 0;
      for (var i = 0; i < M; i++) bsum += grid.data[border[i][1] * w + border[i][0]];
      var baseH = bsum / M;
      var nv = M * (NR + 1), pos = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
      var borderSmooth = new Float32Array(M), BW = 12;
      for (i = 0; i < M; i++) {
        var acc = 0;
        for (var q0 = -BW; q0 <= BW; q0++) { var bq = border[(i + q0 + M) % M]; acc += grid.data[bq[1] * w + bq[0]]; }
        borderSmooth[i] = acc / (2 * BW + 1);
      }
      ringEdge = new Float32Array(M * 2);
      for (i = 0; i < M; i++) {
        var bc = border[i][0], br = border[i][1];
        var ix = grid.x0 + cw * bc, iz = grid.z0 + ch * br, ih = grid.data[br * w + bc];
        var dx = ix - cx, dz = iz - cz, dl = Math.sqrt(dx * dx + dz * dz) || 1;
        ringEdge[i * 2] = bc / (w - 1); ringEdge[i * 2 + 1] = br / (h - 1);
        for (var k = 0; k <= NR; k++) {
          var t = k / NR, rr = dl + (RO - dl) * Math.pow(t, 1.7);
          var x = cx + dx / dl * rr, z = cz + dz / dl * rr;
          var u = x / 5200, vv = z / 5200;
          var ridged = 0, amp = 1, fr = 1, norm = 0;
          for (var o = 0; o < 4; o++) { var nn = 1 - Math.abs(valueNoise(u * fr, vv * fr, seed + 40 + o) * 2 - 1); ridged += nn * nn * amp; norm += amp; amp *= 0.5; fr *= 2.1; }
          ridged /= norm;
          var mount = baseH + A * (ridged - 0.3);
          var blend = smooth01(0, 5000, rr - dl);          // transicion suave (~5 km) desde el borde del DEM
          // altura del borde suavizada a lo largo del perimetro (evita paredes y vetas)
          var ihs = k === 0 ? ih : borderSmooth[i];
          var y = k === 0 ? ih : ihs + (mount - ihs) * blend;
          var vi = i * (NR + 1) + k;
          pos[vi * 3] = x; pos[vi * 3 + 1] = y; pos[vi * 3 + 2] = z;
          elevationColor(y / grid.vs + grid.base, (valueNoise(x / 900, z / 900, seed + 44) - 0.5) * 0.6, col, vi * 3);
        }
      }
      var idx = new Uint32Array(M * NR * 6), q = 0;
      for (i = 0; i < M; i++) {
        var i2 = (i + 1) % M;
        for (k = 0; k < NR; k++) {
          var a0 = i * (NR + 1) + k, a1 = a0 + 1, b0 = i2 * (NR + 1) + k, b1 = b0 + 1;
          idx[q++] = a0; idx[q++] = a1; idx[q++] = b0;
          idx[q++] = b0; idx[q++] = a1; idx[q++] = b1;
        }
      }
      var g = track(new T.BufferGeometry());
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      g.setAttribute('color', new T.BufferAttribute(col, 3));
      g.setIndex(new T.BufferAttribute(idx, 1));
      g.computeVertexNormals();
      // el orden del borde puede dar normales hacia abajo: se corrigen
      var nA = g.attributes.normal.array, flip = 0;
      for (i = 1; i < nA.length; i += 3) flip += nA[i];
      if (flip < 0) {
        for (i = 0; i < idx.length; i += 3) { var tmp = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = tmp; }
        g.computeVertexNormals();
      }
      g.computeBoundingSphere();
      ringGeo = g;
      var m = track(new T.MeshLambertMaterial({ vertexColors: true }));
      var mesh = new T.Mesh(g, m);
      mesh.userData.ring = { M: M, NR: NR };
      scene.add(mesh);
    })();

    if (hasTexture) {
      var img = new Image();
      img.onload = function () {
        if (disposed) return;
        var tex = track(new T.Texture(img));
        tex.encoding = T.sRGBEncoding;
        tex.anisotropy = Math.min(8, maxAniso);
        tex.needsUpdate = true;
        [terrainMat, terrainHiMat].forEach(function (m) { m.map = tex; m.color.set(0xffffff); m.needsUpdate = true; });
        // el anillo toma el color del borde de la imagen satelital (sin costuras de color)
        try {
          var S = 128, cv = newCanvas(S, S), cx2 = cv.getContext('2d');
          cx2.drawImage(img, 0, 0, S, S);
          var px = cx2.getImageData(0, 0, S, S).data, colA = ringGeo.attributes.color, ca = colA.array;
          var RM = ringEdge.length / 2, NR = 18;
          for (var i = 0; i < RM; i++) {
            var rr = 0, gg = 0, bb = 0, cnt = 0;
            for (var q1 = -10; q1 <= 10; q1++) {
              var e2 = ((i + q1) % RM + RM) % RM;
              var sx = Math.min(S - 1, Math.round(ringEdge[e2 * 2] * (S - 1))), sy = Math.min(S - 1, Math.round(ringEdge[e2 * 2 + 1] * (S - 1)));
              var o = (sy * S + sx) * 4;
              rr += Math.pow(px[o] / 255, 2.2); gg += Math.pow(px[o + 1] / 255, 2.2); bb += Math.pow(px[o + 2] / 255, 2.2); cnt++;
            }
            rr /= cnt; gg /= cnt; bb /= cnt;
            for (var k = 0; k <= NR; k++) {
              var f = 1 - smooth01(0, 0.6, k / NR), vi = (i * (NR + 1) + k) * 3;
              ca[vi] = ca[vi] * (1 - f) + rr * f; ca[vi + 1] = ca[vi + 1] * (1 - f) + gg * f; ca[vi + 2] = ca[vi + 2] * (1 - f) + bb * f;
            }
          }
          colA.needsUpdate = true;
        } catch (e) { /* lectura de pixeles no disponible: queda la paleta por altura */ }
      };
      img.src = route.terrain.texture;
    }

    // teselas elegibles para malla fina: a <= 80 m del camino
    var tileElig = new Uint8Array(tilesX * tilesZ);
    (function () {
      var m = 80;
      for (var i = 0; i < path.n; i++) {
        var tx0 = Math.floor((path.X[i] - m - grid.x0) / tileW), tx1 = Math.floor((path.X[i] + m - grid.x0) / tileW);
        var tz0 = Math.floor((path.Z[i] - m - grid.z0) / tileH), tz1 = Math.floor((path.Z[i] + m - grid.z0) / tileH);
        for (var tz = Math.max(0, tz0); tz <= Math.min(tilesZ - 1, tz1); tz++) {
          for (var tx = Math.max(0, tx0); tx <= Math.min(tilesX - 1, tx1); tx++) tileElig[tz * tilesX + tx] = 1;
        }
      }
    })();

    var _rq = { d: 0, sd: 0, y: 0, k: 0, yb: 0 };
    // superficie final (DEM grueso aplanado junto al camino): la que ven ciclistas, arboles y pasto
    function surfaceHeight(x, z) {
      var th = triHeight(x, z);
      roadQuery(roadIdx, x, z, roadInfl, plateau, _rq);
      return _rq.k > 0 ? th + _rq.k * (_rq.yb - ROAD_SINK - th) : th;
    }

    var hiTiles = new Map(), hiQueue = [], maskDirty = false;
    function buildHiTile(tx, tz) {
      var c0 = tx * TK, c1 = Math.min(c0 + TK, grid.w - 1), r0 = tz * TK, r1 = Math.min(r0 + TK, grid.h - 1);
      var X0 = grid.x0 + c0 * cw, X1 = grid.x0 + c1 * cw, Z0 = grid.z0 + r0 * ch, Z1 = grid.z0 + r1 * ch;
      var nx = Math.max(2, Math.ceil((X1 - X0) / Q.hiSpacing) + 1), nz = Math.max(2, Math.ceil((Z1 - Z0) / Q.hiSpacing) + 1);
      var sx = (X1 - X0) / (nx - 1), sz = (Z1 - Z0) / (nz - 1);
      var bw = nx + 2, bh = nz + 2, delta = new Float32Array(bw * bh), th = new Float32Array(bw * bh), dd = new Float32Array(bw * bh);
      var ii, jj, o;
      for (jj = 0; jj < bh; jj++) {
        for (ii = 0; ii < bw; ii++) {
          var x = X0 + (ii - 1) * sx, z = Z0 + (jj - 1) * sz;
          o = jj * bw + ii;
          th[o] = triHeight(x, z);
          roadQuery(roadIdx, x, z, roadInfl, plateau, _rq);
          delta[o] = _rq.k > 0 ? _rq.k * (_rq.yb - ROAD_SINK - th[o]) : 0;
          dd[o] = _rq.d;
        }
      }
      var nb = 2 * (nx + nz) - 4, nv = nx * nz + nb;
      var pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), rd = new Float32Array(nv);
      var col = hasTexture ? null : new Float32Array(nv * 3);
      var e = Math.max(1.5, Q.hiSpacing * 0.5), v = 0;
      for (jj = 0; jj < nz; jj++) {
        for (ii = 0; ii < nx; ii++, v++) {
          var px = X0 + ii * sx, pz = Z0 + jj * sz, bo = (jj + 1) * bw + (ii + 1);
          var y = th[bo] + delta[bo];
          pos[v * 3] = px; pos[v * 3 + 1] = y; pos[v * 3 + 2] = pz;
          var gx = (bicubic(px + e, pz) - bicubic(px - e, pz)) / (2 * e) + (delta[bo + 1] - delta[bo - 1]) / (2 * sx);
          var gz = (bicubic(px, pz + e) - bicubic(px, pz - e)) / (2 * e) + (delta[bo + bw] - delta[bo - bw]) / (2 * sz);
          var l = Math.sqrt(gx * gx + 1 + gz * gz);
          nrm[v * 3] = -gx / l; nrm[v * 3 + 1] = 1 / l; nrm[v * 3 + 2] = -gz / l;
          uv[v * 2] = (px - grid.x0) / (grid.x1 - grid.x0); uv[v * 2 + 1] = 1 - (pz - grid.z0) / (grid.z1 - grid.z0);
          rd[v] = dd[bo];
          if (col) elevationColor(y / grid.vs + grid.base, hash2(Math.round(px), Math.round(pz), 3) - 0.5, col, v * 3);
        }
      }
      // faldon bajo el borde de la tesela (tapa grietas con la malla gruesa vecina)
      var ring = [];
      for (ii = 0; ii < nx; ii++) ring.push(ii);
      for (jj = 1; jj < nz; jj++) ring.push(jj * nx + nx - 1);
      for (ii = nx - 2; ii >= 0; ii--) ring.push((nz - 1) * nx + ii);
      for (jj = nz - 2; jj >= 1; jj--) ring.push(jj * nx);
      var skirt0 = v;
      for (var q = 0; q < ring.length; q++, v++) {
        var s = ring[q];
        pos[v * 3] = pos[s * 3]; pos[v * 3 + 1] = pos[s * 3 + 1] - 4; pos[v * 3 + 2] = pos[s * 3 + 2];
        nrm[v * 3] = nrm[s * 3]; nrm[v * 3 + 1] = nrm[s * 3 + 1]; nrm[v * 3 + 2] = nrm[s * 3 + 2];
        uv[v * 2] = uv[s * 2]; uv[v * 2 + 1] = uv[s * 2 + 1]; rd[v] = 99;
        if (col) { col[v * 3] = col[s * 3]; col[v * 3 + 1] = col[s * 3 + 1]; col[v * 3 + 2] = col[s * 3 + 2]; }
      }
      var idx = new (nv > 65535 ? Uint32Array : Uint16Array)((nx - 1) * (nz - 1) * 6 + ring.length * 12), k = 0;
      for (jj = 0; jj < nz - 1; jj++) {
        for (ii = 0; ii < nx - 1; ii++) {
          var i0 = jj * nx + ii, i1 = i0 + nx, i2 = i0 + 1, i3 = i1 + 1;
          idx[k++] = i0; idx[k++] = i1; idx[k++] = i2;
          idx[k++] = i2; idx[k++] = i1; idx[k++] = i3;
        }
      }
      for (q = 0; q < ring.length; q++) {
        var a = ring[q], b = ring[(q + 1) % ring.length], a2 = skirt0 + q, b2 = skirt0 + (q + 1) % ring.length;
        idx[k++] = a; idx[k++] = b; idx[k++] = a2; idx[k++] = b; idx[k++] = b2; idx[k++] = a2;     // ambas caras
        idx[k++] = a; idx[k++] = a2; idx[k++] = b; idx[k++] = b; idx[k++] = a2; idx[k++] = b2;
      }
      var g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      g.setAttribute('normal', new T.BufferAttribute(nrm, 3));
      g.setAttribute('uv', new T.BufferAttribute(uv, 2));
      g.setAttribute('aRoadD', new T.BufferAttribute(rd, 1));
      if (col) g.setAttribute('color', new T.BufferAttribute(col, 3));
      g.setIndex(new T.BufferAttribute(idx, 1));
      g.computeBoundingSphere();
      var mesh = new T.Mesh(g, terrainHiMat);
      mesh.receiveShadow = true;
      scene.add(mesh);
      return mesh;
    }
    function setMask(key, on) { maskData[key * 4] = on ? 255 : 0; maskDirty = true; }
    function clearHiTiles() {
      hiTiles.forEach(function (mesh, key) { scene.remove(mesh); mesh.geometry.dispose(); setMask(key, false); });
      hiTiles.clear(); hiQueue.length = 0;
    }
    var hiLast = { x: 1e12, z: 1e12 };
    function updateHiTiles(cx, cz, budgetMs) {
      var R = Q.hiR, t0 = now();
      if ((cx - hiLast.x) * (cx - hiLast.x) + (cz - hiLast.z) * (cz - hiLast.z) > 400 || hiLast.x > 1e11) {
        hiLast.x = cx; hiLast.z = cz;
        hiQueue.length = 0;
        var tx0 = Math.max(0, Math.floor((cx - R - grid.x0) / tileW)), tx1 = Math.min(tilesX - 1, Math.floor((cx + R - grid.x0) / tileW));
        var tz0 = Math.max(0, Math.floor((cz - R - grid.z0) / tileH)), tz1 = Math.min(tilesZ - 1, Math.floor((cz + R - grid.z0) / tileH));
        for (var tz = tz0; tz <= tz1; tz++) {
          for (var tx = tx0; tx <= tx1; tx++) {
            var key = tz * tilesX + tx;
            if (!tileElig[key] || hiTiles.has(key)) continue;
            var dx = grid.x0 + (tx + 0.5) * tileW - cx, dz = grid.z0 + (tz + 0.5) * tileH - cz, d2 = dx * dx + dz * dz;
            if (d2 < R * R) hiQueue.push([d2, tx, tz, key]);
          }
        }
        hiQueue.sort(function (a, b) { return b[0] - a[0]; });      // el mas cercano al final (pop)
        var far2 = (R * 1.15) * (R * 1.15);
        hiTiles.forEach(function (mesh, key) {
          var tx = key % tilesX, tz = (key / tilesX) | 0;
          var dx = grid.x0 + (tx + 0.5) * tileW - cx, dz = grid.z0 + (tz + 0.5) * tileH - cz;
          if (dx * dx + dz * dz > far2) { scene.remove(mesh); mesh.geometry.dispose(); hiTiles.delete(key); setMask(key, false); }
        });
      }
      while (hiQueue.length) {
        var it = hiQueue.pop();
        if (!hiTiles.has(it[3])) { hiTiles.set(it[3], buildHiTile(it[1], it[2])); setMask(it[3], true); }
        if (now() - t0 > budgetMs) break;
      }
      if (maskDirty) { maskTex.needsUpdate = true; maskDirty = false; }
    }
    function now() { return (G.performance && G.performance.now) ? G.performance.now() : Date.now(); }

    /* ---- agua (clase 5 de la cobertura) ---- */
    var waterNTex = null, waterMesh = null;
    (function buildWater() {
      var w = lc.w, h = lc.h, d = lc.data, i, j, n = w * h, any = false;
      for (i = 0; i < n; i++) if (d[i] === LC.AGUA) { any = true; break; }
      if (!any || !grid.real) return;
      function nx(i) { return grid.x0 + (grid.x1 - grid.x0) * i / (w - 1); }
      function nz(j) { return grid.z0 + (grid.z1 - grid.z0) * j / (h - 1); }
      var lvl = new Float32Array(n).fill(NaN);
      for (j = 0; j < h; j++) {
        for (i = 0; i < w; i++) {
          if (d[j * w + i] !== LC.AGUA) continue;
          var m = Infinity;
          for (var b = -1; b <= 1; b++) for (var a = -1; a <= 1; a++) m = Math.min(m, triHeight(nx(clamp(i + a, 0, w - 1)), nz(clamp(j + b, 0, h - 1))));
          lvl[j * w + i] = m + 0.5 * grid.vs;
        }
      }
      var lvl2 = new Float32Array(lvl);
      for (j = 0; j < h; j++) {
        for (i = 0; i < w; i++) {
          if (!isNaN(lvl[j * w + i])) continue;
          var mm = Infinity;
          for (b = -1; b <= 1; b++) for (a = -1; a <= 1; a++) {
            var ii = i + a, jj = j + b;
            if (ii >= 0 && jj >= 0 && ii < w && jj < h && !isNaN(lvl[jj * w + ii])) mm = Math.min(mm, lvl[jj * w + ii]);
          }
          if (mm < Infinity) lvl2[j * w + i] = mm;
        }
      }
      var vid = new Int32Array(n).fill(-1), pos = [], uvs = [], idx = [];
      function vert(i, j) {
        var o = j * w + i;
        if (vid[o] < 0) { vid[o] = pos.length / 3; var x = nx(i), z = nz(j); pos.push(x, lvl2[o], z); uvs.push(x / 24, z / 24); }
        return vid[o];
      }
      for (j = 0; j < h - 1; j++) {
        for (i = 0; i < w - 1; i++) {
          var o0 = j * w + i;
          if (isNaN(lvl2[o0]) || isNaN(lvl2[o0 + 1]) || isNaN(lvl2[o0 + w]) || isNaN(lvl2[o0 + w + 1])) continue;
          if (d[o0] !== LC.AGUA && d[o0 + 1] !== LC.AGUA && d[o0 + w] !== LC.AGUA && d[o0 + w + 1] !== LC.AGUA) continue;
          var v0 = vert(i, j), v1 = vert(i, j + 1), v2 = vert(i + 1, j), v3 = vert(i + 1, j + 1);
          idx.push(v0, v1, v2, v2, v1, v3);
        }
      }
      if (!idx.length) return;
      var g = track(new T.BufferGeometry());
      g.setAttribute('position', new T.BufferAttribute(new Float32Array(pos), 3));
      g.setAttribute('uv', new T.BufferAttribute(new Float32Array(uvs), 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      g.computeBoundingSphere();
      waterNTex = (function () {
        var S = 256, f = fbmTile(S, [8, 16, 32], [0.5, 0.3, 0.2], seed + 61), data = new Uint8Array(S * S * 4);
        for (var p = 0; p < S * S; p++) {
          var x = p % S, y = (p / S) | 0;
          var gx = (f[y * S + (x + S - 1) % S] - f[y * S + (x + 1) % S]) * 6, gy = (f[((y + S - 1) % S) * S + x] - f[((y + 1) % S) * S + x]) * 6;
          var l = Math.sqrt(gx * gx + gy * gy + 1);
          data[p * 4] = (0.5 + 0.5 * gx / l) * 255; data[p * 4 + 1] = (0.5 + 0.5 * gy / l) * 255; data[p * 4 + 2] = (0.5 + 0.5 / l) * 255; data[p * 4 + 3] = 255;
        }
        var t = track(new T.DataTexture(data, S, S, T.RGBAFormat));
        t.wrapS = t.wrapT = T.RepeatWrapping; t.minFilter = T.LinearMipmapLinearFilter; t.magFilter = T.LinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
        return t;
      })();
      var m = track(new T.MeshStandardMaterial({ color: lin(0x1b3f4a), roughness: 0.07, metalness: 0.05, envMap: envTex, envMapIntensity: 1.0, normalMap: waterNTex, normalScale: new T.Vector2(0.35, 0.35), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
      waterMesh = new T.Mesh(g, m);
      waterMesh.receiveShadow = true;
      scene.add(waterMesh);
    })();

    /* ---- camino: asfalto con textura, berma de grava, barreras y delineadores ---- */
    var lineColor = centerLineColor(route.country) === 'amarilla' ? '#e8b400' : '#f2f2ee';
    var roadTex, roadNTex, gravelTex;
    (function buildRoadTextures() {
      var W = 256, H = 1024, pxm = W / 6;                     // 6 m x 24 m
      var c = newCanvas(W, H), x = c.getContext('2d'), hc = newCanvas(W, H), hx = hc.getContext('2d'), i;
      x.fillStyle = '#4b4e53'; x.fillRect(0, 0, W, H);
      hx.fillStyle = '#808080'; hx.fillRect(0, 0, W, H);
      function rnd(k) { return hash2(k, 77, seed + 91); }
      // variacion grande: parches reparados y zonas gastadas (huellas)
      // manchas suaves (envejecimiento desigual) y solo dos parches reparados, tenues
      for (i = 0; i < 34; i++) {
        var rr0 = 20 + rnd(i * 5) * 90, cxp = rnd(i * 5 + 2) * W, cyp = rnd(i * 5 + 3) * H, dk = rnd(i * 5 + 4) > 0.45;
        var rg = x.createRadialGradient(cxp, cyp, 0, cxp, cyp, rr0);
        rg.addColorStop(0, dk ? 'rgba(28,30,33,0.16)' : 'rgba(125,125,122,0.09)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
        x.fillStyle = rg; x.save(); x.translate(cxp, cyp); x.scale(1, 2.2); x.translate(-cxp, -cyp); x.fillRect(cxp - rr0, cyp - rr0, rr0 * 2, rr0 * 2); x.restore();
      }
      for (i = 0; i < 2; i++) {
        var pw = 50 + rnd(90 + i) * 60, ph = 90 + rnd(95 + i) * 120, pxx = 20 + rnd(97 + i) * (W - pw - 40), pyy = rnd(99 + i) * (H - ph);
        x.fillStyle = 'rgba(32,34,37,0.16)'; x.fillRect(pxx, pyy, pw, ph);
        hx.fillStyle = 'rgba(140,140,140,0.35)'; hx.fillRect(pxx, pyy, pw, ph);
      }
      var g = x.createLinearGradient(0, 0, W, 0);
      [[0.18, 0.1], [0.3, 0], [0.42, 0.1], [0.58, 0.1], [0.7, 0], [0.82, 0.1]].forEach(function (s) { g.addColorStop(s[0], 'rgba(20,20,22,' + s[1] + ')'); });
      x.fillStyle = g; x.fillRect(0, 0, W, H);
      // grano (aridos)
      var id = x.getImageData(0, 0, W, H), dd = id.data, hd = hx.getImageData(0, 0, W, H), hdd = hd.data;
      for (i = 0; i < W * H; i++) {
        var px = i % W, py = (i / W) | 0, r1 = hash2(px, py, seed + 92), r2 = hash2(px, py, seed + 93);
        var dv = (r1 - 0.5) * 34 + (r2 > 0.93 ? 26 : 0) - (r2 < 0.04 ? 22 : 0);
        dd[i * 4] = clamp(dd[i * 4] + dv, 0, 255); dd[i * 4 + 1] = clamp(dd[i * 4 + 1] + dv, 0, 255); dd[i * 4 + 2] = clamp(dd[i * 4 + 2] + dv * 1.05, 0, 255);
        var hv = (r1 - 0.5) * 90 + (r2 > 0.93 ? 70 : 0);
        hdd[i * 4] = clamp(hdd[i * 4] + hv, 0, 255);
      }
      x.putImageData(id, 0, 0);
      // grietas finas
      x.strokeStyle = 'rgba(18,18,20,0.55)'; x.lineWidth = 1;
      for (i = 0; i < 14; i++) {
        x.beginPath();
        var cx0 = rnd(200 + i) * W, cy0 = rnd(300 + i) * H;
        x.moveTo(cx0, cy0);
        for (var sgm = 0; sgm < 6; sgm++) { cx0 += (rnd(400 + i * 9 + sgm) - 0.5) * 30; cy0 += 8 + rnd(500 + i * 9 + sgm) * 26; x.lineTo(cx0, cy0); }
        x.stroke();
      }
      // demarcacion: bordes continuos blancos (0,12 m a 0,2 m del borde) y central discontinua 4 m / 8 m
      function paint(px0, wpx, y0, y1, colr) {
        x.fillStyle = colr; x.fillRect(px0, y0, wpx, y1 - y0);
        hx.fillStyle = 'rgba(200,200,200,0.6)'; hx.fillRect(px0, y0, wpx, y1 - y0);
      }
      var ew = Math.max(2, Math.round(0.12 * pxm)), eo = Math.round(0.2 * pxm);
      paint(eo, ew, 0, H, 'rgba(236,236,232,0.88)');
      paint(W - eo - ew, ew, 0, H, 'rgba(236,236,232,0.88)');
      var cwp = Math.max(2, Math.round(0.11 * pxm)), dash = H / 24 * 4;
      paint(W / 2 - cwp / 2, cwp, 0, dash, lineColor);
      paint(W / 2 - cwp / 2, cwp, H / 2, H / 2 + dash, lineColor);
      // desgaste de la pintura
      var id2 = x.getImageData(0, 0, W, H), d2 = id2.data;
      for (i = 0; i < W * H; i++) {
        if (d2[i * 4] > 150 && hash2(i % W, (i / W) | 0, seed + 94) < 0.22) { d2[i * 4] *= 0.72; d2[i * 4 + 1] *= 0.72; d2[i * 4 + 2] *= 0.72; }
      }
      x.putImageData(id2, 0, 0);
      roadTex = canvasTex(c);
      roadTex.wrapT = T.RepeatWrapping; roadTex.anisotropy = Math.min(8, maxAniso);
      // normal map desde la altura
      var hh = hx.getImageData(0, 0, W, H).data, nc = newCanvas(W, H), nx2 = nc.getContext('2d'), nid = nx2.createImageData(W, H), nd = nid.data;
      for (i = 0; i < W * H; i++) {
        var qx = i % W, qy = (i / W) | 0;
        var l = hh[(qy * W + Math.max(0, qx - 1)) * 4], r = hh[(qy * W + Math.min(W - 1, qx + 1)) * 4];
        var u = hh[(((qy + H - 1) % H) * W + qx) * 4], dn = hh[(((qy + 1) % H) * W + qx) * 4];
        var gx = (l - r) / 255 * 2.5, gy = (u - dn) / 255 * 2.5, ln = Math.sqrt(gx * gx + gy * gy + 1);
        nd[i * 4] = (0.5 + 0.5 * gx / ln) * 255; nd[i * 4 + 1] = (0.5 - 0.5 * gy / ln) * 255; nd[i * 4 + 2] = (0.5 + 0.5 / ln) * 255; nd[i * 4 + 3] = 255;
      }
      nx2.putImageData(nid, 0, 0);
      roadNTex = track(new T.CanvasTexture(nc));
      roadNTex.wrapT = T.RepeatWrapping; roadNTex.anisotropy = Math.min(8, maxAniso);
      // grava de la berma (tileable)
      var GS = 256, gc = newCanvas(GS, GS), gx2 = gc.getContext('2d'), gid = gx2.createImageData(GS, GS), gd = gid.data;
      var gf = fbmTile(GS, [8, 32, 128], [0.4, 0.35, 0.25], seed + 95);
      for (i = 0; i < GS * GS; i++) {
        var vv = 0.5 + (gf[i] - 0.5) * 0.9 + (hash2(i % GS, (i / GS) | 0, seed + 96) - 0.5) * 0.45;
        gd[i * 4] = clamp(118 * vv * 1.9, 0, 255); gd[i * 4 + 1] = clamp(108 * vv * 1.9, 0, 255); gd[i * 4 + 2] = clamp(94 * vv * 1.9, 0, 255); gd[i * 4 + 3] = 255;
      }
      gx2.putImageData(gid, 0, 0);
      gravelTex = canvasTex(gc);
      gravelTex.wrapS = gravelTex.wrapT = T.RepeatWrapping; gravelTex.anisotropy = Math.min(4, maxAniso);
    })();

    var roadU = terrainU.uRoadFar;
    function roadMaterial(params) {
      var m = track(new T.MeshStandardMaterial(params));
      m.onBeforeCompile = function (sh) {
        sh.uniforms.uRoadFar = roadU;
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + ROAD_VS_PARS)
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + ROAD_VS_MAIN);
      };
      m.customProgramCacheKey = function () { return 'rd-road-' + (params.map === roadTex ? 'a' : 'g'); };
      return m;
    }
    (function buildRoad() {
      var n = path.n, hw = ROAD_WIDTH / 2, i, s;
      // asfalto
      var pos = new Float32Array(n * 6), uv = new Float32Array(n * 4), lift = new Float32Array(n * 2);
      // berma + talud: por lado 3 vertices (interior, exterior, pie)
      var bpos = new Float32Array(n * 18), buv = new Float32Array(n * 12), blift = new Float32Array(n * 6);
      for (i = 0; i < n; i++) {
        var a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
        var dx = path.X[b] - path.X[a], dz = path.Z[b] - path.Z[a];
        var l = Math.sqrt(dx * dx + dz * dz) || 1, rx = -dz / l, rz = dx / l, Y = path.Y[i], v = path.D[i];
        for (s = 0; s < 2; s++) {
          var sg = s ? 1 : -1, ex = path.X[i] + rx * hw * sg, ez = path.Z[i] + rz * hw * sg;
          pos[i * 6 + s * 3] = ex; pos[i * 6 + s * 3 + 1] = Y; pos[i * 6 + s * 3 + 2] = ez;
          uv[i * 4 + s * 2] = s; uv[i * 4 + s * 2 + 1] = v / 24;
          lift[i * 2 + s] = Math.max(0, gridHeight(grid, ex, ez) + 0.2 - Y);
          var offs = [hw - 0.05, BERM_OUT, BERM_OUT + 0.35], ys = [Y - 0.025, Y - 0.09, Y - 1.8];
          for (var k = 0; k < 3; k++) {
            var o = (i * 6 + s * 3 + k);
            var bx = path.X[i] + rx * offs[k] * sg, bz = path.Z[i] + rz * offs[k] * sg;
            bpos[o * 3] = bx; bpos[o * 3 + 1] = ys[k]; bpos[o * 3 + 2] = bz;
            buv[o * 2] = offs[k] / 1.6; buv[o * 2 + 1] = v / 1.6 + (k === 2 ? 1.1 : 0);
            blift[o] = Math.max(0, gridHeight(grid, bx, bz) + 0.2 - ys[k]);
          }
        }
      }
      var idx = new (n * 2 > 65535 ? Uint32Array : Uint16Array)((n - 1) * 6);
      for (i = 0; i < n - 1; i++) {
        var l0 = i * 2, r0 = l0 + 1, l1 = l0 + 2, r1 = l0 + 3, q = i * 6;
        idx[q] = l0; idx[q + 1] = r0; idx[q + 2] = l1; idx[q + 3] = r0; idx[q + 4] = r1; idx[q + 5] = l1;
      }
      var g = track(new T.BufferGeometry());
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      g.setAttribute('uv', new T.BufferAttribute(uv, 2));
      g.setAttribute('aLift', new T.BufferAttribute(lift, 1));
      g.setIndex(new T.BufferAttribute(idx, 1));
      g.computeVertexNormals();
      g.computeBoundingSphere();
      var m = roadMaterial({ map: roadTex, normalMap: roadNTex, normalScale: new T.Vector2(0.7, 0.7), roughness: 0.86, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
      var mesh = new T.Mesh(g, m);
      mesh.receiveShadow = true;
      scene.add(mesh);
      // berma
      var bidx = new (n * 6 > 65535 ? Uint32Array : Uint16Array)((n - 1) * 24), q2 = 0;
      for (i = 0; i < n - 1; i++) {
        for (s = 0; s < 2; s++) {
          for (var k2 = 0; k2 < 2; k2++) {
            var a0 = i * 6 + s * 3 + k2, a1 = a0 + 1, c0 = a0 + 6, c1 = a1 + 6;
            if (s) { bidx[q2++] = a0; bidx[q2++] = a1; bidx[q2++] = c0; bidx[q2++] = a1; bidx[q2++] = c1; bidx[q2++] = c0; }
            else { bidx[q2++] = a0; bidx[q2++] = c0; bidx[q2++] = a1; bidx[q2++] = a1; bidx[q2++] = c0; bidx[q2++] = c1; }
          }
        }
      }
      var bg = track(new T.BufferGeometry());
      bg.setAttribute('position', new T.BufferAttribute(bpos, 3));
      bg.setAttribute('uv', new T.BufferAttribute(buv, 2));
      bg.setAttribute('aLift', new T.BufferAttribute(blift, 1));
      bg.setIndex(new T.BufferAttribute(bidx, 1));
      bg.computeVertexNormals();
      bg.computeBoundingSphere();
      var bm = roadMaterial({ map: gravelTex, roughness: 1, metalness: 0, side: T.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
      var bmesh = new T.Mesh(bg, bm);
      bmesh.receiveShadow = true;
      scene.add(bmesh);
    })();

    var instMeshes = [];   // InstancedMesh fijos (barreras, delineadores) para dispose/estadisticas
    (function buildRoadside() {
      var n = path.n, radii = curveRadii(path, 15), side = new Int8Array(n), i, j;
      for (i = 0; i < n; i++) if (Math.abs(radii[i]) < 45) side[i] = radii[i] > 0 ? -1 : 1;     // lado exterior de la curva
      var side2 = new Int8Array(side), ext = 4;
      for (i = 0; i < n; i++) if (side[i]) for (j = Math.max(0, i - ext); j <= Math.min(n - 1, i + ext); j++) if (!side2[j]) side2[j] = side[i];
      side = side2;
      var dummy = new T.Object3D(), rails = [], posts = [];
      function frame(i) {
        var a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1), dx = path.X[b] - path.X[a], dz = path.Z[b] - path.Z[a], l = Math.sqrt(dx * dx + dz * dz) || 1;
        return { hx: dx / l, hz: dz / l, rx: -dz / l, rz: dx / l };
      }
      var RAIL_OFF = BERM_OUT - 0.1;
      for (i = 0; i < n - 1; i++) {
        if (!side[i] || side[i] !== side[i + 1]) continue;
        var f0 = frame(i), f1 = frame(i + 1), s = side[i];
        var ax = path.X[i] + f0.rx * RAIL_OFF * s, az = path.Z[i] + f0.rz * RAIL_OFF * s, ay = path.Y[i] - 0.09;
        var bx = path.X[i + 1] + f1.rx * RAIL_OFF * s, bz = path.Z[i + 1] + f1.rz * RAIL_OFF * s, by = path.Y[i + 1] - 0.09;
        rails.push([ax, ay, az, bx, by, bz, s]);
        posts.push([ax, ay, az, Math.atan2(-(bz - az), bx - ax)]);
      }
      if (rails.length) {
        var railGeo = track(new T.BoxGeometry(1, 0.31, 0.05));
        railGeo.translate(0.5, 0, 0);
        var railMat = track(new T.MeshStandardMaterial({ color: lin(0xc3c8cc), metalness: 0.75, roughness: 0.38, envMap: envTex }));
        var rm = new T.InstancedMesh(railGeo, railMat, rails.length);
        rails.forEach(function (r, k) {
          var dx = r[3] - r[0], dy = r[4] - r[1], dz = r[5] - r[2], L = Math.sqrt(dx * dx + dy * dy + dz * dz);
          dummy.position.set(r[0], r[1] + 0.62, r[2]);
          dummy.rotation.set(0, Math.atan2(-dz, dx), Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)), 'YZX');
          dummy.scale.set(L + 0.05, 1, 1);
          dummy.updateMatrix();
          rm.setMatrixAt(k, dummy.matrix);
        });
        rm.castShadow = true; rm.receiveShadow = true;
        scene.add(rm); instMeshes.push(rm);
        var postGeo2 = track(new T.BoxGeometry(0.09, 0.9, 0.12));
        postGeo2.translate(0, 0.35, 0);
        var pmesh = new T.InstancedMesh(postGeo2, railMat, posts.length);
        posts.forEach(function (p, k) {
          dummy.position.set(p[0], p[1], p[2]); dummy.rotation.set(0, p[3], 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
          pmesh.setMatrixAt(k, dummy.matrix);
        });
        pmesh.castShadow = true;
        scene.add(pmesh); instMeshes.push(pmesh);
      }
      // delineadores cada 25 m a ambos lados (no donde hay barrera)
      var dl = [], at = { x: 0, y: 0, z: 0, i: 0 };
      for (var dist = 12.5; dist < totalDist; dist += 25) {
        pathAt(path, dist, at);
        var fr = frame(at.i);
        for (var sgn = -1; sgn <= 1; sgn += 2) {
          if (side[at.i] === sgn) continue;
          dl.push([at.x + fr.rx * 5.3 * sgn, at.y - ROAD_SINK - 0.05, at.z + fr.rz * 5.3 * sgn, Math.atan2(-fr.hz, fr.hx)]);
        }
      }
      if (dl.length) {
        var body = new T.BoxGeometry(0.11, 1.05, 0.11).toNonIndexed();
        body.translate(0, 0.525, 0);
        var bp = body.attributes.position.array, bc = new Float32Array(bp.length);
        for (i = 0; i < bp.length; i += 3) { var top = bp[i + 1] > 0.8; bc[i] = bc[i + 1] = bc[i + 2] = top ? 0.02 : 0.8; }
        body.setAttribute('color', new T.BufferAttribute(bc, 3));
        track(body);
        var dMat = track(new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0 }));
        var dm = new T.InstancedMesh(body, dMat, dl.length);
        var refl = track(new T.BoxGeometry(0.035, 0.16, 0.07));
        refl.translate(0, 0.9, 0);
        var rMat = track(new T.MeshStandardMaterial({ color: lin(0xffb000), emissive: lin(0xff9a00), emissiveIntensity: 0.35, roughness: 0.3 }));
        var rmm = new T.InstancedMesh(refl, rMat, dl.length * 2);
        dl.forEach(function (p, k) {
          dummy.position.set(p[0], p[1], p[2]); dummy.rotation.set(0, p[3], 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
          dm.setMatrixAt(k, dummy.matrix);
          for (var f = 0; f < 2; f++) {
            dummy.position.set(p[0] + Math.cos(p[3]) * (f ? 0.065 : -0.065), p[1], p[2] - Math.sin(p[3]) * (f ? 0.065 : -0.065));
            dummy.updateMatrix();
            rmm.setMatrixAt(k * 2 + f, dummy.matrix);
          }
        });
        dm.castShadow = true;
        scene.add(dm); scene.add(rmm); instMeshes.push(dm, rmm);
      }
    })();

    /* ---- vegetacion instanciada con viento ---- */
    var windU = { uTime: { value: 0 }, uWindDir: { value: new T.Vector2(0.83, 0.56).normalize() } };
    function windify(m, w, upNormal) {
      var wv = { value: new T.Vector3(w[0], w[1], w[2]) };
      m.onBeforeCompile = function (sh) {
        sh.uniforms.uTime = windU.uTime; sh.uniforms.uWindDir = windU.uWindDir; sh.uniforms.uWind = wv;
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + WIND_PARS)
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + WIND_MAIN);
        // pasto: ambas caras con normal hacia arriba (se ilumina como el suelo, sin briznas negras)
        if (upNormal) sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);');
      };
      m.customProgramCacheKey = function () { return 'rd-wind-' + m.type + '-' + w.join(','); };
      return m;
    }
    // acumulador de geometria no indexada (posicion, normal, color)
    function Acc() { this.p = []; this.n = []; this.c = []; }
    Acc.prototype.finish = function () {
      var g = track(new T.BufferGeometry());
      g.setAttribute('position', new T.BufferAttribute(new Float32Array(this.p), 3));
      g.setAttribute('normal', new T.BufferAttribute(new Float32Array(this.n), 3));
      g.setAttribute('color', new T.BufferAttribute(new Float32Array(this.c), 3));
      g.computeBoundingSphere();
      return g;
    };
    function shadeCol(acc, base, y, yLo, yHi, jit) {
      var t = clamp((y - yLo) / ((yHi - yLo) || 1), 0, 1), s = (0.5 + 0.6 * t) * (1 + jit);
      acc.c.push(base[0] * s, base[1] * s * (1 + 0.06 * t), base[2] * s);
    }
    function addBlob(acc, detail, cx, cy, cz, r, sx, sy, sz, deform, ph, base, yLo, yHi) {
      var g = new T.IcosahedronGeometry(1, detail), p = g.attributes.position.array;
      for (var i = 0; i < p.length; i += 3) {
        var l = Math.sqrt(p[i] * p[i] + p[i + 1] * p[i + 1] + p[i + 2] * p[i + 2]) || 1;
        var x = p[i] / l, y = p[i + 1] / l, z = p[i + 2] / l;
        var f = 1 + deform * (Math.sin(x * 4.1 + ph) * Math.sin(y * 3.7 + ph * 1.7) * Math.sin(z * 4.3 + ph * 0.6) * 1.2 + 0.35 * Math.sin(x * 9.3 + y * 7.1 + z * 5.3 + ph * 2.3));
        var X = cx + x * r * sx * f, Y = cy + y * r * sy * f, Z = cz + z * r * sz * f;
        acc.p.push(X, Y, Z);
        var nx = x / sx, ny = y / sy + 0.25, nz = z / sz, nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
        acc.n.push(nx / nl, ny / nl, nz / nl);
        var j = Math.sin(X * 91.7 + Y * 47.3 + Z * 63.1) * 43758.5453;
        shadeCol(acc, base, Y + 0.12 * y * r, yLo, yHi, ((j - Math.floor(j)) - 0.5) * 0.22 + 0.12 * Math.max(0, y));
      }
      g.dispose();
    }
    function addCyl(acc, rTop, rBot, h, seg, y0, base, cone, ph) {
      var g = cone ? new T.ConeGeometry(rBot, h, seg, 1, true) : new T.CylinderGeometry(rTop, rBot, h, seg, 1, true);
      var ng = g.toNonIndexed(); g.dispose();
      var p = ng.attributes.position.array, n = ng.attributes.normal.array;
      for (var i = 0; i < p.length; i += 3) {
        var x = p[i], y = p[i + 1] + y0 + h / 2, z = p[i + 2];
        if (cone) { var a = Math.atan2(z, x), k = 1 + 0.12 * Math.sin(a * 5 + ph) * (1 - (p[i + 1] + h / 2) / h); x *= k; z *= k; }
        acc.p.push(x, y, z); acc.n.push(n[i], n[i + 1] + (cone ? 0.25 : 0), n[i + 2]);
        if (cone) shadeCol(acc, base, y, y0 - 0.15, 1.0, (Math.sin(x * 50 + z * 70) * 0.5) * 0.15);
        else acc.c.push(base[0] * (0.7 + 0.3 * (y / (y0 + h))), base[1] * (0.7 + 0.3 * (y / (y0 + h))), base[2] * (0.7 + 0.3 * (y / (y0 + h))));
      }
      ng.dispose();
    }
    var TRUNK = [0.085, 0.062, 0.043];
    var LEAF = { broad: [0.05, 0.085, 0.028], conifer: [0.026, 0.055, 0.032], poplar: [0.07, 0.12, 0.03], shrub: [0.075, 0.085, 0.042] };
    var vegGeo = {
      broadN: (function () {
        var a = new Acc();
        addCyl(a, 0.022, 0.04, 0.56, 6, 0, TRUNK);
        addBlob(a, 1, 0, 0.66, 0, 0.27, 1, 0.82, 1, 0.16, 0.3, LEAF.broad, 0.42, 0.98);
        addBlob(a, 1, 0.14, 0.57, 0.07, 0.2, 1, 0.85, 1, 0.18, 1.9, LEAF.broad, 0.42, 0.98);
        addBlob(a, 1, -0.12, 0.6, -0.1, 0.21, 1, 0.85, 1, 0.18, 3.1, LEAF.broad, 0.42, 0.98);
        addBlob(a, 1, 0.03, 0.82, -0.04, 0.17, 1, 0.9, 1, 0.2, 4.4, LEAF.broad, 0.42, 0.98);
        return a.finish();
      })(),
      broadF: (function () {
        var a = new Acc();
        addCyl(a, 0.03, 0.045, 0.5, 3, 0, TRUNK);
        addBlob(a, 0, 0, 0.66, 0, 0.33, 1, 0.82, 1, 0, 0, LEAF.broad, 0.4, 0.98);
        return a.finish();
      })(),
      coniferN: (function () {
        var a = new Acc();
        addCyl(a, 0.018, 0.035, 0.3, 5, 0, TRUNK);
        [[0.3, 0.42, 0.2], [0.24, 0.36, 0.37], [0.17, 0.3, 0.54], [0.1, 0.24, 0.74]].forEach(function (t, i) { addCyl(a, 0, t[0], t[1], 9, t[2], LEAF.conifer, true, i * 1.7); });
        return a.finish();
      })(),
      coniferF: (function () { var a = new Acc(); addCyl(a, 0, 0.27, 0.86, 5, 0.12, LEAF.conifer, true, 0); return a.finish(); })(),
      poplarN: (function () {
        var a = new Acc();
        addCyl(a, 0.015, 0.03, 0.3, 5, 0, TRUNK);
        addBlob(a, 1, 0, 0.6, 0, 0.42, 0.34, 1, 0.34, 0.14, 0.7, LEAF.poplar, 0.2, 1.0);
        addBlob(a, 1, 0.04, 0.45, 0.03, 0.26, 0.42, 1, 0.42, 0.16, 2.2, LEAF.poplar, 0.2, 1.0);
        return a.finish();
      })(),
      poplarF: (function () { var a = new Acc(); addBlob(a, 0, 0, 0.58, 0, 0.42, 0.36, 1, 0.36, 0, 0, LEAF.poplar, 0.15, 1.0); return a.finish(); })(),
      shrubN: (function () {
        var a = new Acc();
        addBlob(a, 1, 0, 0.42, 0, 0.55, 1, 0.72, 1, 0.2, 0.5, LEAF.shrub, 0, 0.85);
        addBlob(a, 1, 0.3, 0.3, 0.12, 0.34, 1, 0.8, 1, 0.22, 2.4, LEAF.shrub, 0, 0.85);
        return a.finish();
      })(),
      shrubF: (function () { var a = new Acc(); addBlob(a, 0, 0, 0.4, 0, 0.6, 1, 0.68, 1, 0, 0, LEAF.shrub, 0, 0.8); return a.finish(); })(),
      grass: (function () {
        var g = track(new T.BufferGeometry()), p = [], n = [], c = [], u = [];
        for (var k = 0; k < 3; k++) {
          var a = k * Math.PI / 3 + 0.2, ca = Math.cos(a) * 0.5, sa = Math.sin(a) * 0.5;
          var q = [[-ca, 0, -sa, 0, 0], [ca, 0, sa, 1, 0], [ca, 1, sa, 1, 1], [-ca, 0, -sa, 0, 0], [ca, 1, sa, 1, 1], [-ca, 1, -sa, 0, 1]];
          for (var v = 0; v < 6; v++) { p.push(q[v][0], q[v][1], q[v][2]); n.push(0, 1, 0); u.push(q[v][3], q[v][4]); var s = 0.45 + 0.55 * q[v][1]; c.push(s, s, s); }
        }
        g.setAttribute('position', new T.BufferAttribute(new Float32Array(p), 3));
        g.setAttribute('normal', new T.BufferAttribute(new Float32Array(n), 3));
        g.setAttribute('color', new T.BufferAttribute(new Float32Array(c), 3));
        g.setAttribute('uv', new T.BufferAttribute(new Float32Array(u), 2));
        g.computeBoundingSphere();
        return g;
      })()
    };
    var grassTex = (function () {
      var S = 128, c = newCanvas(S, S), x = c.getContext('2d');
      x.clearRect(0, 0, S, S);
      for (var i = 0; i < 90; i++) {
        var r = function (k) { return hash2(i, k, seed + 71); };
        var bx = 6 + r(1) * (S - 12), h = S * (0.45 + 0.55 * r(2)), lean = (r(3) - 0.5) * 34, wd = 1.6 + r(4) * 2.6;
        var dry = r(5);
        var g0 = dry > 0.55 ? [128 + 40 * r(6), 116 + 30 * r(6), 72 + 20 * r(7)] : [72 + 34 * r(6), 92 + 36 * r(6), 42 + 18 * r(7)];
        x.fillStyle = 'rgb(' + (g0[0] | 0) + ',' + (g0[1] | 0) + ',' + (g0[2] | 0) + ')';
        x.beginPath();
        x.moveTo(bx - wd, S);
        x.quadraticCurveTo(bx - wd * 0.6 + lean * 0.3, S - h * 0.55, bx + lean, S - h);
        x.quadraticCurveTo(bx + wd * 0.6 + lean * 0.3, S - h * 0.55, bx + wd, S);
        x.closePath(); x.fill();
      }
      var t = canvasTex(c);
      t.anisotropy = Math.min(4, maxAniso);
      return t;
    })();
    var WIND = { broad: [0.03, 1.3, 0.006], conifer: [0.022, 1.0, 0.003], poplar: [0.045, 1.1, 0.005], shrub: [0.05, 1.8, 0.012], grass: [0.24, 2.8, 0] };
    var SPECIES = ['broad', 'conifer', 'poplar', 'shrub'];
    var vegMats = {}, vegDepth = {};
    SPECIES.forEach(function (sp) {
      vegMats[sp] = windify(track(new T.MeshLambertMaterial({ vertexColors: true })), WIND[sp]);
      vegDepth[sp] = windify(track(new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking })), WIND[sp]);
    });
    var grassMat = windify(track(new T.MeshLambertMaterial({ map: grassTex, vertexColors: true, alphaTest: 0.5, side: T.DoubleSide })), WIND.grass, true);

    function makePool(geo, mat, depth, cast) { var p = { geo: geo, mat: mat, depth: depth, cast: cast, cap: 0, mesh: null, count: 0 }; growPool(p, 256); return p; }
    function growPool(p, cap) {
      var m = new T.InstancedMesh(p.geo, p.mat, cap);
      m.instanceMatrix.setUsage(T.DynamicDrawUsage);
      m.instanceColor = new T.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      m.instanceColor.setUsage(T.DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = p.cast; m.receiveShadow = p.cast;
      if (p.depth) m.customDepthMaterial = p.depth;
      m.count = 0;
      if (p.mesh) {
        m.instanceMatrix.array.set(p.mesh.instanceMatrix.array.subarray(0, p.count * 16));
        m.instanceColor.array.set(p.mesh.instanceColor.array.subarray(0, p.count * 3));
        scene.remove(p.mesh); p.mesh.dispose();
      }
      scene.add(m);
      p.mesh = m; p.cap = cap;
    }
    function poolPush(p, x, y, z, s, wf, rot, r, g, b) {
      if (p.count >= p.cap) growPool(p, Math.ceil(p.cap * 1.6));
      var e = p.mesh.instanceMatrix.array, o = p.count * 16, c = Math.cos(rot), sn = Math.sin(rot), sx = s * wf;
      e[o] = c * sx; e[o + 1] = 0; e[o + 2] = -sn * sx; e[o + 3] = 0;
      e[o + 4] = 0; e[o + 5] = s; e[o + 6] = 0; e[o + 7] = 0;
      e[o + 8] = sn * sx; e[o + 9] = 0; e[o + 10] = c * sx; e[o + 11] = 0;
      e[o + 12] = x; e[o + 13] = y; e[o + 14] = z; e[o + 15] = 1;
      var ca = p.mesh.instanceColor.array, oc = p.count * 3;
      ca[oc] = r; ca[oc + 1] = g; ca[oc + 2] = b;
      p.count++;
    }
    function poolCommit(p) {
      p.mesh.count = p.count;
      p.mesh.instanceMatrix.needsUpdate = true;
      p.mesh.instanceColor.needsUpdate = true;
    }
    // tres niveles por especie: muy cerca (proyecta sombra), cerca (detalle, sin sombra) y lejos (LOD simple)
    var shadowPools = SPECIES.map(function (sp) { return makePool(vegGeo[sp + 'N'], vegMats[sp], vegDepth[sp], true); });
    var nearPools = SPECIES.map(function (sp) { return makePool(vegGeo[sp + 'N'], vegMats[sp], null, false); });
    var farPools = SPECIES.map(function (sp) { return makePool(vegGeo[sp + 'F'], vegMats[sp], null, false); });
    var grassPool = makePool(vegGeo.grass, grassMat, null, false);
    var allPools = shadowPools.concat(nearPools, farPools, [grassPool]);

    // celdas (chunks) de 200 m a lo largo del camino; distancia al camino en anillos de celdas
    var VC = 200, GC = 32;
    var vcx0 = Math.floor(grid.x0 / VC), vcz0 = Math.floor(grid.z0 / VC);
    var vNX = Math.floor(grid.x1 / VC) - vcx0 + 1, vNZ = Math.floor(grid.z1 / VC) - vcz0 + 1;
    var vRing = new Uint8Array(vNX * vNZ).fill(255);
    (function () {
      var i, r, a, b;
      for (i = 0; i < path.n; i++) {
        var cx = Math.floor(path.X[i] / VC) - vcx0, cz = Math.floor(path.Z[i] / VC) - vcz0;
        if (cx >= 0 && cz >= 0 && cx < vNX && cz < vNZ) vRing[cz * vNX + cx] = 0;
      }
      for (r = 1; r <= 4; r++) {
        for (b = 0; b < vNZ; b++) for (a = 0; a < vNX; a++) {
          if (vRing[b * vNX + a] !== r - 1) continue;
          for (var dz = -1; dz <= 1; dz++) for (var dx = -1; dx <= 1; dx++) {
            var aa = a + dx, bb = b + dz;
            if (aa >= 0 && bb >= 0 && aa < vNX && bb < vNZ && vRing[bb * vNX + aa] === 255) vRing[bb * vNX + aa] = r;
          }
        }
      }
    })();
    function ringAt(x, z) {
      var ia = Math.floor(x / VC) - vcx0, ib = Math.floor(z / VC) - vcz0;
      return (ia < 0 || ib < 0 || ia >= vNX || ib >= vNZ) ? 255 : vRing[ib * vNX + ia];
    }

    // una sola consulta del camino por instancia: la distancia (exclusion) y la altura (aplanado) salen de la misma
    var _rqv = { d: 0, sd: 0, y: 0, k: 0, yb: 0 }, rqX = NaN, rqZ = NaN;
    function vegRoadDist(x, z) { roadQuery(roadIdx, x, z, roadInfl, plateau, _rqv); rqX = x; rqZ = z; return _rqv.d; }
    function vegHeight(x, z, nearRoad) {
      var th = triHeight(x, z);
      if (!nearRoad) return th;                                      // chunk lejos del camino: sin aplanado
      if (x !== rqX || z !== rqZ) vegRoadDist(x, z);
      return _rqv.k > 0 ? th + _rqv.k * (_rqv.yb - ROAD_SINK - th) : th;
    }
    var optNear = { seed: seed, density: 1, classAt: classAt, roadDist: vegRoadDist, annotate: function (it) { it.y = vegHeight(it.x, it.z, true); } };
    var optFar = { seed: seed, density: 1, classAt: classAt, roadDist: null, annotate: function (it) { it.y = triHeight(it.x, it.z); } };

    var KOFF = 32768, K32 = 4294967296;
    function ckey(a, b) { return (a + KOFF) * 65536 + (b + KOFF); }
    function ckA(k) { return Math.floor(k / 65536) - KOFF; }
    function ckB(k) { return (k % 65536) - KOFF; }
    function numDesc(p, q) { return q - p; }

    // capa de chunks con cola por distancia y generacion reanudable (por franjas de filas, con control de tiempo)
    function ChunkLayer(size, layers, stride) {
      this.size = size; this.layers = layers; this.stride = stride;
      this.map = new Map(); this.queue = []; this.job = null; this.gen = 0;
      this.lx = 1e12; this.lz = 1e12; this.rx = 1e12; this.rz = 1e12; this.dirty = false; this.lastRebuild = -1e9;
    }
    var vegLayer = new ChunkLayer(VC, ['tree', 'shrub'], 10), grassLayer = new ChunkLayer(GC, ['grass'], 8);
    var _cl = null, _ccx = 0, _ccz = 0, _cfar2 = 0;
    function dropFar(ch, key) {
      var ex = (ckA(key) + 0.5) * _cl.size - _ccx, ez = (ckB(key) + 0.5) * _cl.size - _ccz;
      if (ex * ex + ez * ez > _cfar2) { _cl.map.delete(key); _cl.dirty = true; }
    }
    function enqueue(L, cx, cz, R, ringMax) {
      var S = L.size, a0 = Math.floor((cx - R) / S), a1 = Math.floor((cx + R) / S), b0 = Math.floor((cz - R) / S), b1 = Math.floor((cz + R) / S);
      L.queue.length = 0;
      for (var b = b0; b <= b1; b++) {
        for (var a = a0; a <= a1; a++) {
          var mx = (a + 0.5) * S, mz = (b + 0.5) * S;
          if (mx < grid.x0 - S || mx > grid.x1 + S || mz < grid.z0 - S || mz > grid.z1 + S) continue;
          if (ringMax != null && ringAt(mx, mz) > ringMax) continue;
          var dx = mx - cx, dz = mz - cz, d2 = dx * dx + dz * dz;
          if (d2 >= R * R) continue;
          var key = ckey(a, b), ch = L.map.get(key);
          if (ch && ch.gen === L.gen) continue;
          if (L.job && L.job.key === key) continue;
          var pri = Math.min(8191, Math.sqrt(d2)) + (ch ? 8192 : 0);        // primero los que faltan; luego los obsoletos
          L.queue.push(Math.floor(pri) * K32 + key);
        }
      }
      L.queue.sort(numDesc);                                             // el mas cercano al final (pop)
      _cl = L; _ccx = cx; _ccz = cz; _cfar2 = (R + S) * (R + S);
      L.map.forEach(dropFar);
    }
    function startJob(L, key) {
      var S = L.size, a = ckA(key), b = ckB(key);
      var rect = { x0: Math.max(grid.x0, a * S), x1: Math.min(grid.x1, (a + 1) * S), z0: Math.max(grid.z0, b * S), z1: Math.min(grid.z1, (b + 1) * S) };
      var near = ringAt((a + 0.5) * S, (b + 0.5) * S) <= 1;
      return { key: key, rect: rect, near: near, li: 0, z: rect.z0, items: [], layerOf: [], k: 0, n: 0, data: null, gen: L.gen };
    }
    // avanza el trabajo hasta `deadline`; true = terminado
    function stepJob(L, job, deadline) {
      var r = job.rect, o = job.near ? optNear : optFar, it, k;
      if (r.x1 <= r.x0 || r.z1 <= r.z0) { job.data = new Float32Array(0); return true; }
      o.density = Q.density;
      while (job.li < L.layers.length) {
        var ln = L.layers[job.li], strip = VEG_LAYERS[ln].spacing * 6;
        while (job.z < r.z1) {
          var z1 = Math.min(r.z1, job.z + strip);
          var got = placeVegetation({ x0: r.x0, x1: r.x1, z0: job.z, z1: z1 }, ln, o);
          for (k = 0; k < got.length; k++) { job.items.push(got[k]); job.layerOf.push(job.li); }
          job.z = z1;
          if (now() > deadline) return false;
        }
        job.li++; job.z = r.z0;
      }
      if (!job.data) job.data = new Float32Array(job.items.length * L.stride);
      var grass = L === grassLayer;
      while (job.k < job.items.length) {
        it = job.items[job.k];
        var y = it.y, d = job.data, o2 = job.n * L.stride;
        if (grass) {
          var dry = it.cls === LC.PASTO ? 0.15 : 0.75, kg = 0.75 + 0.5 * it.r2;
          d[o2] = it.x; d[o2 + 1] = y - 0.05; d[o2 + 2] = it.z; d[o2 + 3] = 0.28 + it.r0 * 0.42; d[o2 + 4] = it.r1 * Math.PI * 2;
          d[o2 + 5] = kg * (1 + 0.25 * dry); d[o2 + 6] = kg * (1 + 0.05 * dry); d[o2 + 7] = kg * (1 - 0.3 * dry);
        } else {
          var isTree = job.layerOf[job.k] === 0, ele = y / grid.vs + grid.base, sp, s, wf;
          if (isTree) {
            var pPop = it.cls === LC.URBANO ? 0.7 : (it.cls === LC.PASTO && ele < 1100 ? 0.45 : 0.06);
            var pCon = (isChile ? 0.08 : 0.8) * clamp((ele - 700) / 900, 0, 1);
            sp = it.r3 < pPop ? 2 : ((it.r2 * 7.31) % 1 < pCon ? 1 : 0);
            s = sp === 2 ? 14 + it.r0 * 9 : (sp === 1 ? 9 + it.r0 * 10 : 5.5 + it.r0 * 6);
            wf = sp === 2 ? 0.85 + it.r1 * 0.3 : 0.85 + it.r2 * 0.35;
          } else { sp = 3; s = 0.8 + it.r0 * it.r0 * 1.9; wf = 0.9 + it.r1 * 0.6; }
          var kk = 0.78 + 0.44 * it.r2, hue = (it.r0 - 0.5) * 0.25;
          d[o2] = it.x; d[o2 + 1] = y - (sp === 3 ? 0.15 : 0.35); d[o2 + 2] = it.z; d[o2 + 3] = s; d[o2 + 4] = wf;
          d[o2 + 5] = it.r1 * Math.PI * 2; d[o2 + 6] = kk * (1 + hue); d[o2 + 7] = kk; d[o2 + 8] = kk * (1 - hue * 0.6); d[o2 + 9] = sp;
        }
        job.n++; job.k++;
        if ((job.k & 63) === 0 && now() > deadline) return false;
      }
      return true;
    }
    function pumpLayer(L, deadline) {
      while (now() < deadline) {
        if (!L.job) {
          if (!L.queue.length) return;
          var v = L.queue.pop();
          L.job = startJob(L, v - Math.floor(v / K32) * K32);
        }
        if (!stepJob(L, L.job, deadline)) return;
        var j = L.job;
        L.job = null;
        if (j.gen === L.gen) { L.map.set(j.key, { n: j.n, data: j.data, gen: j.gen }); L.dirty = true; }
      }
    }
    function clearVegetation() {
      [vegLayer, grassLayer].forEach(function (L) { L.map.clear(); L.queue.length = 0; L.job = null; L.lx = 1e12; L.dirty = true; });
    }
    // cambio de calidad: los chunks quedan obsoletos y se regeneran de a poco (se siguen viendo los actuales)
    function staleVegetation() {
      [vegLayer, grassLayer].forEach(function (L) { L.gen++; L.job = null; L.lx = 1e12; L.dirty = true; });
    }
    var _px = 0, _pz = 0, _r = {};
    function fillVeg(ch) {
      var d = ch.data, cx = _px, cz = _pz;
      for (var k = 0; k < ch.n; k++) {
        var o = k * 10, sp = d[o + 9], ex = d[o] - cx, ez = d[o + 2] - cz, d2 = ex * ex + ez * ez, pool;
        if (sp === 3) { if (d2 > _r.sR2) continue; pool = d2 < _r.cast2 ? shadowPools[3] : (d2 < _r.sN2 ? nearPools[3] : farPools[3]); }
        else { if (d2 > _r.tR2) continue; pool = d2 < _r.cast2 ? shadowPools[sp] : (d2 < _r.tN2 ? nearPools[sp] : farPools[sp]); }
        poolPush(pool, d[o], d[o + 1], d[o + 2], d[o + 3], d[o + 4], d[o + 5], d[o + 6], d[o + 7], d[o + 8]);
      }
    }
    function fillGrass(ch) {
      var d = ch.data;
      for (var k = 0; k < ch.n; k++) {
        var o = k * 8, ex = d[o] - _px, ez = d[o + 2] - _pz;
        if (ex * ex + ez * ez > _r.g2) continue;
        poolPush(grassPool, d[o], d[o + 1], d[o + 2], d[o + 3], 2.4, d[o + 4], d[o + 5], d[o + 6], d[o + 7]);
      }
    }
    function rebuildVegPools(cx, cz) {
      var i;
      for (i = 0; i < 4; i++) { shadowPools[i].count = 0; nearPools[i].count = 0; farPools[i].count = 0; }
      var cast = Q.shadows ? Q.shadowRange + 25 : 0;
      _px = cx; _pz = cz;
      _r.tR2 = Q.treeR * Q.treeR; _r.tN2 = Q.nearTreeR * Q.nearTreeR; _r.sR2 = Q.shrubR * Q.shrubR; _r.sN2 = Q.nearShrubR * Q.nearShrubR; _r.cast2 = cast * cast;
      vegLayer.map.forEach(fillVeg);
      for (i = 0; i < 4; i++) { poolCommit(shadowPools[i]); poolCommit(nearPools[i]); poolCommit(farPools[i]); }
    }
    function rebuildGrassPool(cx, cz) {
      grassPool.count = 0; _px = cx; _pz = cz; _r.g2 = Q.grassR * Q.grassR;
      grassLayer.map.forEach(fillGrass);
      poolCommit(grassPool);
    }
    function vegRingMax() { return Math.floor((Q.vegBand + VC / 2) / VC); }
    // reconstruye los pools cuando la cola se vacio, o como mucho cada 250 ms mientras se carga
    function maybeRebuild(L, cx, cz, moveM, rebuild) {
      var mv = (cx - L.rx) * (cx - L.rx) + (cz - L.rz) * (cz - L.rz) > moveM * moveM;
      if (!L.dirty && !mv) return;
      var idle = !L.job && !L.queue.length, t = now();
      if (!idle && t - L.lastRebuild < 250) return;
      if (idle && !L.dirty && t - L.lastRebuild < 250) return;
      L.dirty = false; L.rx = cx; L.rz = cz; L.lastRebuild = t;
      rebuild(cx, cz);
    }
    function updateVegetation(cx, cz, budgetMs) {
      var deadline = now() + budgetMs;
      var L = vegLayer;
      if ((cx - L.lx) * (cx - L.lx) + (cz - L.lz) * (cz - L.lz) > 625) { L.lx = cx; L.lz = cz; enqueue(L, cx, cz, Q.treeR + VC * 0.71, vegRingMax()); }
      pumpLayer(L, deadline);
      maybeRebuild(L, cx, cz, 30, rebuildVegPools);
      var G2 = grassLayer;
      if (Q.grassR <= 0) {
        if (grassPool.count || G2.map.size) { G2.map.clear(); G2.queue.length = 0; G2.job = null; grassPool.count = 0; poolCommit(grassPool); }
        return;
      }
      if ((cx - G2.lx) * (cx - G2.lx) + (cz - G2.lz) * (cz - G2.lz) > 64) { G2.lx = cx; G2.lz = cz; enqueue(G2, cx, cz, Q.grassR + GC * 0.71, null); }
      pumpLayer(G2, deadline);
      maybeRebuild(G2, cx, cz, 6, rebuildGrassPool);
    }
    /* ---- marcadores: arcos de salida/meta y postes de km ---- */
    var _pose = { x: 0, y: 0, z: 0, i: 0, hx: 1, hz: 0, tx: 1, ty: 0, tz: 0 };
    // Grupo orientado: +x = rumbo, +z = derecha
    function orientedGroup(distM, rightOffset) {
      pathPose(path, distM, _pose);
      var g = new T.Group();
      g.position.set(_pose.x - _pose.hz * rightOffset, _pose.y, _pose.z + _pose.hx * rightOffset);
      g.rotation.y = Math.atan2(-_pose.hz, _pose.hx);
      scene.add(g);
      return g;
    }
    function textTexture(w, h, draw) {
      var c = newCanvas(w, h);
      draw(c.getContext('2d'), w, h);
      return canvasTex(c);
    }
    var FONT = '"Barlow Condensed", "Arial Narrow", Arial, sans-serif';
    var postMat = track(new T.MeshStandardMaterial({ color: lin(0xb4b9c0), roughness: 0.55, metalness: 0.1, envMap: envTex }));
    var postGeo = track(new T.BoxGeometry(0.14, 1, 0.14));
    var signGeo = track(new T.PlaneGeometry(0.95, 0.6));
    var bannerGeo = track(new T.PlaneGeometry(ROAD_WIDTH + 1.6, 1.3));

    function makeArch(text, distM) {
      var g = orientedGroup(distM, 0);
      var tex = textTexture(1024, 200, function (x, w, h) {
        x.fillStyle = '#15181d'; x.fillRect(0, 0, w, h);
        x.fillStyle = '#FF5A1F'; x.fillRect(0, 0, w, 14); x.fillRect(0, h - 14, w, 14);
        x.fillStyle = '#ffffff'; x.font = '700 150px ' + FONT; x.textAlign = 'center'; x.textBaseline = 'middle';
        x.fillText(text, w / 2, h / 2 + 6);
      });
      var bm = track(new T.MeshBasicMaterial({ map: tex, side: T.DoubleSide, fog: false, toneMapped: false }));
      var banner = new T.Mesh(bannerGeo, bm);
      banner.position.set(0, 10, 0);                                  // por encima de la cámara de persecución (~5 m)
      banner.rotation.y = -Math.PI / 2;                              // cara hacia quien llega
      g.add(banner);
      for (var s = -1; s <= 1; s += 2) {
        var p = new T.Mesh(postGeo, postMat);
        p.scale.set(2, 10.7, 2);
        p.position.set(0, 5.35, s * (ROAD_WIDTH / 2 + 0.7));
        g.add(p);
      }
    }
    makeArch('SALIDA', 0);
    makeArch('META', totalDist);

    function makeKmPost(km) {
      var kg = orientedGroup(km * 1000, ROAD_WIDTH / 2 + 1.6);
      var post = new T.Mesh(postGeo, postMat);
      post.scale.set(1, 2.3, 1); post.position.y = 1.15;
      kg.add(post);
      var stex = textTexture(160, 100, function (x, w, h) {
        x.fillStyle = '#15181d'; x.fillRect(0, 0, w, h);
        x.strokeStyle = '#FF5A1F'; x.lineWidth = 6; x.strokeRect(3, 3, w - 6, h - 6);
        x.fillStyle = '#ffffff'; x.textAlign = 'center'; x.textBaseline = 'middle';
        x.font = '700 62px ' + FONT; x.fillText(String(km), w / 2, h / 2 - 8);
        x.fillStyle = '#FF5A1F'; x.font = '600 24px ' + FONT; x.fillText('KM', w / 2, h - 20);
      });
      var sign = new T.Mesh(signGeo, track(new T.MeshBasicMaterial({ map: stex, side: T.DoubleSide, toneMapped: false })));
      sign.position.set(0, 2.1, 0);
      sign.rotation.y = -Math.PI / 2;
      kg.add(sign);
    }
    for (var km = 1; km * 1000 < totalDist - 40; km++) makeKmPost(km);

    /* ---- ciclistas (geometria compartida; materiales por tipo) ---- */
    var WHEEL_R = 0.335, WHEEL_TUBE = 0.02;
    var HIP_X = -0.15, HIP_Y = 0.86, BB_X = 0, BB_Y = 0.30, CRANK = 0.1725, SEG = 0.43;
    var geo = {
      wheel: track(new T.TorusGeometry(WHEEL_R, WHEEL_TUBE, 6, 22)),
      spoke: track(new T.BoxGeometry(WHEEL_R * 2, 0.012, 0.012)),
      tube: track(new T.CylinderGeometry(0.014, 0.014, 1, 6)),
      torso: track(new T.CylinderGeometry(0.11, 0.09, 1, 8)),
      arm: track(new T.CylinderGeometry(0.036, 0.03, 1, 6)),
      thigh: track(new T.CylinderGeometry(0.07, 0.056, 1, 8)),
      shin: track(new T.CylinderGeometry(0.05, 0.04, 1, 8)),
      ball: track(new T.SphereGeometry(1, 10, 8)),
      saddle: track(new T.BoxGeometry(0.24, 0.045, 0.12)),
      foot: track(new T.BoxGeometry(0.22, 0.05, 0.09))
    };
    var kindMats = {};
    function matsFor(kind) {
      if (kindMats[kind]) return kindMats[kind];
      var ghost = kind === 'ghost', col = KIND_COLORS[kind];
      function mk(hex, emissive, metal) {
        var m = new T.MeshStandardMaterial({ color: lin(hex), roughness: metal ? 0.32 : 0.62, metalness: metal ? 0.55 : 0, envMap: metal ? envTex : null });
        if (ghost) {
          m.transparent = true; m.opacity = 0.55; m.depthWrite = false;
          if (emissive) { m.emissive = lin(KIND_COLORS.ghost); m.emissiveIntensity = 0.45; }
        }
        return track(m);
      }
      var halo = track(new T.MeshBasicMaterial({ color: lin(KIND_COLORS.ghost), transparent: true, opacity: 0.16, blending: T.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false }));
      kindMats[kind] = {
        jersey: mk(col, true), helmet: mk(col, true), frame: mk(col, true, true),
        shorts: mk(0x1c1f24, false), skin: mk(0xd9a37a, false), tire: mk(0x15171a, false), halo: halo
      };
      return kindMats[kind];
    }

    var _v1 = new T.Vector3(), _yAxis = new T.Vector3(0, 1, 0), _m4 = new T.Matrix4();
    var _bx = new T.Vector3(), _by = new T.Vector3(), _bz = new T.Vector3();
    // cilindro unitario (eje y) entre dos puntos 3D del marco del ciclista
    function limb(mesh, x1, y1, z1, x2, y2, z2) {
      _v1.set(x2 - x1, y2 - y1, z2 - z1);
      var len = _v1.length();
      mesh.position.set((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2);
      mesh.quaternion.setFromUnitVectors(_yAxis, _v1.divideScalar(len));
      mesh.scale.y = len;
    }
    // cilindro unitario en el plano xy (z fijo)
    function limb2D(mesh, x1, y1, x2, y2, z) {
      var dx = x2 - x1, dy = y2 - y1;
      mesh.position.set((x1 + x2) / 2, (y1 + y2) / 2, z);
      mesh.rotation.z = Math.atan2(-dx, dy);
      mesh.scale.y = Math.sqrt(dx * dx + dy * dy);
    }
    function placeLeg(thigh, shin, foot, z, phase) {
      var px = BB_X + CRANK * Math.cos(phase), py = BB_Y + CRANK * Math.sin(phase);
      var ax = px - 0.03, ay = py + 0.09;                          // tobillo
      var dx = ax - HIP_X, dy = ay - HIP_Y;
      var d = Math.sqrt(dx * dx + dy * dy);
      var ux = dx / d, uy = dy / d, half = d / 2;
      var h = Math.sqrt(Math.max(0, SEG * SEG - half * half));
      var kx = HIP_X + ux * half - uy * h, ky = HIP_Y + uy * half + ux * h;   // rodilla hacia adelante
      limb2D(thigh, HIP_X, HIP_Y, kx, ky, z);
      limb2D(shin, kx, ky, ax, ay, z);
      foot.position.set(px + 0.04, py + 0.02, z);
    }
    function placeLegs(st) {
      placeLeg(st.thighs[0], st.shins[0], st.feet[0], -0.11, st.phase);
      placeLeg(st.thighs[1], st.shins[1], st.feet[1], 0.11, st.phase + Math.PI);
    }

    var riderList = [], riderById = {}, seenToken = 0, simTime = 0;
    function normKind(k) { return KIND_COLORS[k] !== undefined ? k : 'bot'; }

    function makeLabelSprite(st) {
      var w = st.kind === 'user' ? 3.4 : (st.kind === 'ghost' ? 2.9 : 2.0);
      var canvas = newCanvas(512, 128);
      var tex = canvasTex(canvas);
      var mat = track(new T.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
      var sp = new T.Sprite(mat);
      sp.renderOrder = 10;
      sp.scale.set(w, w / 4, 1);
      st.labelW = w; st.labelCanvas = canvas; st.labelTex = tex; st.labelMat = mat;
      return sp;
    }
    function drawLabel(st, text) {
      var c = st.labelCanvas, x = c.getContext('2d'), size = st.kind === 'bot' ? 54 : 66;
      x.clearRect(0, 0, c.width, c.height);
      x.textAlign = 'center'; x.textBaseline = 'middle';
      do { x.font = '700 ' + size + 'px ' + FONT; size -= 4; } while (x.measureText(text).width > 440 && size > 20);
      var tw = x.measureText(text).width + 44;
      var rx = (c.width - tw) / 2, ry = 20, rh = c.height - 40, rad = rh / 2;
      x.beginPath();
      x.moveTo(rx + rad, ry); x.lineTo(rx + tw - rad, ry); x.arc(rx + tw - rad, ry + rad, rad, -Math.PI / 2, Math.PI / 2);
      x.lineTo(rx + rad, ry + rh); x.arc(rx + rad, ry + rad, rad, Math.PI / 2, -Math.PI / 2); x.closePath();
      x.fillStyle = 'rgba(12,14,18,0.78)'; x.fill();
      x.lineWidth = 5; x.strokeStyle = '#' + ('000000' + KIND_COLORS[st.kind].toString(16)).slice(-6); x.stroke();
      x.fillStyle = '#ffffff'; x.fillText(text, c.width / 2, c.height / 2 + 3);
      st.labelTex.needsUpdate = true;
      st.labelText = text;
    }

    function createRider(r) {
      var kind = normKind(r.kind);
      var m = matsFor(kind);
      var root = new T.Group();
      var body = new T.Group();
      root.add(body);
      var st = {
        id: r.id, kind: kind, root: root, token: 0, distM: r.distM, lastD: r.distM, lastT: simTime, speed: 0,
        phase: Math.random() * Math.PI * 2, tx: 0, ty: 0, tz: 0, tq: new T.Quaternion(), hx: 1, hz: 0, fresh: true,
        wheels: [], thighs: [], shins: [], feet: [], labelText: null, label: null
      };
      function part(g, mat) { var me = new T.Mesh(g, mat); me.castShadow = kind !== 'ghost'; body.add(me); return me; }
      var i, w;
      for (i = 0; i < 2; i++) {                                    // ruedas
        w = part(geo.wheel, m.tire);
        w.position.set(i ? 0.5 : -0.5, WHEEL_R + WHEEL_TUBE, 0);
        w.add(new T.Mesh(geo.spoke, m.frame));
        st.wheels.push(w);
      }
      // cuadro (BB, asiento, direccion, bujes)
      var seat = [-0.13, 0.74], head = [0.42, 0.70], rear = [-0.5, 0.355], front = [0.5, 0.355];
      var tubes = [[BB_X, BB_Y, seat[0], seat[1]], [seat[0], seat[1], head[0], head[1]], [BB_X, BB_Y, head[0] - 0.02, head[1] - 0.04],
        [BB_X, BB_Y, rear[0], rear[1]], [seat[0], seat[1], rear[0], rear[1]], [head[0], head[1] + 0.03, front[0], front[1]]];
      for (i = 0; i < tubes.length; i++) {
        limb(part(geo.tube, m.frame), tubes[i][0], tubes[i][1], 0, tubes[i][2], tubes[i][3], 0);
      }
      var bar = part(geo.tube, m.tire); bar.scale.set(1.2, 1, 1.2);
      limb(bar, 0.46, 0.76, -0.2, 0.46, 0.76, 0.2);
      limb(part(geo.tube, m.tire), head[0], head[1] + 0.03, 0, 0.46, 0.76, 0);
      part(geo.saddle, m.shorts).position.set(-0.15, 0.755, 0);
      // ciclista
      limb(part(geo.torso, m.jersey), HIP_X, HIP_Y, 0, 0.30, 1.16, 0);
      var headMesh = part(geo.ball, m.skin); headMesh.scale.setScalar(0.09); headMesh.position.set(0.41, 1.27, 0);
      var helmet = part(geo.ball, m.helmet); helmet.scale.set(0.14, 0.095, 0.11); helmet.position.set(0.39, 1.32, 0);
      for (i = -1; i <= 1; i += 2) {
        limb(part(geo.arm, m.jersey), 0.30, 1.14, i * 0.17, 0.46, 0.77, i * 0.2);
        st.thighs.push(part(geo.thigh, m.shorts));
        st.shins.push(part(geo.shin, m.skin));
        st.feet.push(part(geo.foot, m.tire));
      }
      if (kind === 'ghost') {
        var halo = new T.Mesh(geo.ball, m.halo);
        halo.scale.set(1.15, 0.95, 0.55); halo.position.set(0.05, 0.85, 0);
        body.add(halo);
      }
      st.label = makeLabelSprite(st);
      st.label.position.y = 2.4;
      root.add(st.label);
      scene.add(root);
      placeLegs(st);
      return st;
    }

    function removeRider(st) {
      scene.remove(st.root);
      st.labelTex.dispose(); st.labelMat.dispose();
      delete riderById[st.id];
    }

    function setRiders(list) {
      if (disposed) return;
      var token = ++seenToken, i, j, st, r;
      for (i = 0; i < list.length; i++) {
        r = list[i];
        st = riderById[r.id];
        if (st && st.kind !== normKind(r.kind)) {
          removeRider(st);
          riderList.splice(riderList.indexOf(st), 1);
          st = null;
        }
        if (!st) {
          st = createRider(r);
          riderById[r.id] = st;
          riderList.push(st);
        }
        st.token = token;
        st.distM = r.distM;
        var text = r.label != null ? String(r.label) : (r.name != null ? String(r.name) : '');
        if (st.kind === 'ghost' && compactView()) text = 'PB';
        if (text !== st.labelText) drawLabel(st, text);
      }
      for (i = riderList.length - 1; i >= 0; i--) {
        if (riderList[i].token !== token) { removeRider(riderList[i]); riderList.splice(i, 1); }
      }
      // objetivos de pose, con reparto en el carril para quienes comparten distM
      var n = riderList.length, A;
      for (i = 0; i < n; i++) {
        A = riderList[i];
        var idx = 0, cnt = 1;
        for (j = 0; j < n; j++) {
          if (j === i) continue;
          if (Math.abs(riderList[j].distM - A.distM) < CLUSTER_M) { cnt++; if (j < i) idx++; }
        }
        pathPose(path, A.distM, _pose);
        var off = laneOffset(idx, cnt);
        A.tx = _pose.x - _pose.hz * off; A.tz = _pose.z + _pose.hx * off; A.ty = _pose.y;
        A.hx = _pose.hx; A.hz = _pose.hz;
        // base: x = tangente, z = derecha (tangente x arriba), y = z x x
        _bx.set(_pose.tx, _pose.ty, _pose.tz);
        _bz.crossVectors(_bx, _yAxis).normalize();
        _by.crossVectors(_bz, _bx);
        _m4.makeBasis(_bx, _by, _bz);
        A.tq.setFromRotationMatrix(_m4);
        // velocidad estimada para animar pedaleo y ruedas
        var el = simTime - A.lastT;
        if (el > 1e-4) {
          var v = (A.distM - A.lastD) / el;
          if (v >= 0 && v < 40) A.speed += (v - A.speed) * 0.35;
          A.lastD = A.distM; A.lastT = simTime;
        }
        if (A.fresh) {
          A.root.position.set(A.tx, A.ty, A.tz); A.root.quaternion.copy(A.tq); A.fresh = false;
        }
      }
    }

    /* ---- camara ---- */
    var cameraMode = 'persecucion';
    var camPos = new T.Vector3(), camLook = new T.Vector3(), wantPos = new T.Vector3(), wantLook = new T.Vector3();
    var camReady = false, _ahead = { x: 0, y: 0, z: 0, i: 0 };

    function userState() {
      for (var i = 0; i < riderList.length; i++) if (riderList[i].kind === 'user') return riderList[i];
      return riderList.length ? riderList[0] : null;
    }

    function updateCamera(dt) {
      var u = userState(), px, py, pz, hx, hz, d;
      if (u) {
        px = u.root.position.x; py = u.root.position.y; pz = u.root.position.z; hx = u.hx; hz = u.hz; d = u.distM;
      } else {
        pathPose(path, 0, _pose); px = _pose.x; py = _pose.y; pz = _pose.z; hx = _pose.hx; hz = _pose.hz; d = 0;
      }
      var kPos = 5, kLook = 7;
      if (cameraMode === 'aerea') {
        wantPos.set(px, py + 400, pz + 160); wantLook.set(px, py, pz);
        kPos = 2.5; kLook = 4;
      } else if (cameraMode === 'lateral') {
        wantPos.set(px - hz * 9, py + 1.9, pz + hx * 9);           // 9 m a la derecha del rumbo
        wantLook.set(px + hx * 2, py + 1, pz + hz * 2);
      } else if (compactView()) {
        // vertical (celular): mas atras y mas alto, y mira casi al ciclista para que quede en el centro de la zona libre
        wantPos.set(px - hx * 15, py + 6.5, pz - hz * 15);
        pathAt(path, d + 6, _ahead);
        wantLook.set(_ahead.x, _ahead.y + 1.2, _ahead.z);
      } else {
        wantPos.set(px - hx * 12, py + 5, pz - hz * 12);           // 12 m atras, 5 m arriba
        pathAt(path, d + 20, _ahead);                              // mira 20 m adelante
        wantLook.set(_ahead.x, _ahead.y + 1.2, _ahead.z);
      }
      var gy = Math.max(gridHeight(grid, wantPos.x, wantPos.z), surfaceHeight(wantPos.x, wantPos.z)) + 2;
      if (wantPos.y < gy) wantPos.y = gy;
      if (!camReady) {
        camPos.copy(wantPos); camLook.copy(wantLook); camReady = true;
      } else {
        camPos.lerp(wantPos, 1 - Math.exp(-dt * kPos));
        camLook.lerp(wantLook, 1 - Math.exp(-dt * kLook));
      }
      camera.position.copy(camPos);
      camera.lookAt(camLook);
    }

    function setCameraMode(mode) {
      if (CAMERA_MODES.indexOf(mode) < 0) throw new TypeError('Scene3D: modo de camara invalido: ' + mode);
      cameraMode = mode;
    }

    /* ---- tamano, calidad (manual o automatica) ---- */
    var viewInsets = { top: 0, bottom: 0, left: 0, right: 0 };
    var viewW = 640, viewH = 360;
    // Vista compacta (celular vertical u horizontal bajo): mismo criterio para camara, FOV y etiquetas.
    function compactView() { return viewW / viewH < PORTRAIT_ASPECT || viewH <= COMPACT_MAX_H; }
    function applyProjection() {
      camera.aspect = viewW / viewH;
      camera.fov = compactView() ? PORTRAIT_FOV : BASE_FOV;
      var o = viewOffsetFor(viewW, viewH, viewInsets);
      if (o.x !== 0 || o.y !== 0) camera.setViewOffset(viewW, viewH, o.x, o.y, viewW, viewH);
      else camera.clearViewOffset();
      camera.updateProjectionMatrix();
    }
    function resize() {
      if (disposed) return;
      viewW = container.clientWidth || 640; viewH = container.clientHeight || 360;
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(viewW, viewH, false);
      applyProjection();
    }
    // Margenes (px CSS) ocupados por el HUD: el centro optico se desplaza al centro de la zona libre.
    function setViewInsets(ins) {
      var i = ins || {};
      viewInsets = { top: Math.max(0, +i.top || 0), bottom: Math.max(0, +i.bottom || 0), left: Math.max(0, +i.left || 0), right: Math.max(0, +i.right || 0) };
      if (!disposed) applyProjection();
    }
    var ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(function () { resize(); });
      ro.observe(container);
    }
    function onLost(e) { e.preventDefault(); contextLost = true; }
    function onRestored() { contextLost = false; }
    canvasEl.addEventListener('webglcontextlost', onLost);
    canvasEl.addEventListener('webglcontextrestored', onRestored);

    function configureShadows() {
      renderer.shadowMap.enabled = Q.shadows;
      renderer.shadowMap.type = T.PCFShadowMap;            // un solo tipo: cambiar de nivel no recompila por el tipo de sombra
      sun.castShadow = Q.shadows;
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      if (Q.shadows) {
        var R = Q.shadowRange, sc = sun.shadow.camera;
        sun.shadow.mapSize.set(Q.shadowSize, Q.shadowSize);
        sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.near = 20; sc.far = 1400;
        sc.updateProjectionMatrix();
        sun.shadow.bias = -0.0004;
        sun.shadow.normalBias = 0.12 * (2 * R / Q.shadowSize) / 0.1;
      }
      renderer.shadowMap.needsUpdate = true;
    }
    function refreshMaterials() {
      scene.traverse(function (o) {
        if (!o.material) return;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.needsUpdate = true; });
      });
      SPECIES.forEach(function (sp) { vegDepth[sp].needsUpdate = true; });
    }
    var burst = true;                 // solo en la creacion: llena el entorno inicial de una vez
    function applyLevel(next) {
      var prevShadows = Q.shadows;
      level = next; Q = qualityPreset(level);
      setRoadShape();
      pixelRatio = Math.min(dpr, Q.pixelRatioMax);
      resize();
      configureShadows();
      // las teselas finas existentes se conservan (las nuevas usan el paso del nivel) y la vegetacion se
      // regenera de a poco con la nueva densidad: sin congelar la rodada
      hiLast.x = 1e12;
      staleVegetation();
      if (prevShadows !== Q.shadows) refreshMaterials();     // solo encender/apagar sombras exige recompilar
    }
    configureShadows();
    resize();

    var monitor = createFrameMonitor();
    function setQuality(q) {
      if (disposed) return;
      qualityMode = QUALITIES.indexOf(q) >= 0 ? q : 'auto';
      monitor = createFrameMonitor();
      var next = resolveQuality(qualityMode, envInfo());
      if (next !== level) applyLevel(next);
    }
    function instanceCount() {
      var n = 0, i;
      for (i = 0; i < allPools.length; i++) n += allPools[i].mesh.count;
      for (i = 0; i < instMeshes.length; i++) n += instMeshes[i].count;
      return n;
    }
    function getStats() {
      var info = renderer.info.render;
      return {
        fps: Math.round(10 / monitor.avg()) / 10, drawCalls: info.calls, triangles: info.triangles,
        instances: instanceCount(), quality: level, mode: qualityMode,
        hiTiles: hiTiles.size, vegChunks: vegLayer.map.size, grassChunks: grassLayer.map.size, landcover: lc.synthetic ? 'sintetica' : 'ruta'
      };
    }

    /* ---- render ---- */
    function render(dtS) {
      if (disposed || contextLost) return;
      var dt = clamp(dtS > 0 ? dtS : 0, 0, 0.1);
      simTime += dt;

      if (monitor.feed(dtS) && qualityMode === 'auto' && level !== 'baja') applyLevel(downgradeQuality(level));

      var kr = 1 - Math.exp(-dt * 18), i, st;
      var cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
      // vertical (celular): se evita el amontonamiento de etiquetas sobre el ciclista del usuario
      var portrait = compactView(), uSt = userState(), nearBot = null, nearBotD = 1e9;
      if (portrait && uSt) {
        for (i = 0; i < riderList.length; i++) {
          st = riderList[i];
          if (st.kind === 'bot' && st.distM >= uSt.distM && st.distM - uSt.distM < nearBotD) { nearBot = st; nearBotD = st.distM - uSt.distM; }
        }
      }
      for (i = 0; i < riderList.length; i++) {
        st = riderList[i];
        var p = st.root.position;
        var ddx = st.tx - p.x, ddy = st.ty - p.y, ddz = st.tz - p.z;
        if (ddx * ddx + ddy * ddy + ddz * ddz > 900) {              // salto grande: sin suavizado
          p.set(st.tx, st.ty, st.tz); st.root.quaternion.copy(st.tq);
        } else {
          p.x += ddx * kr; p.y += ddy * kr; p.z += ddz * kr;
          st.root.quaternion.slerp(st.tq, kr);
        }
        if (st.speed > 0.05) {
          var rev = clamp(st.speed / 8 * 1.4, 0, 2.2);              // rev/s de cadencia segun velocidad
          st.phase += rev * 2 * Math.PI * dt;
          if (st.phase > 62831) st.phase -= 62831;
          var roll = st.speed / WHEEL_R * dt;
          st.wheels[0].rotation.z -= roll; st.wheels[1].rotation.z -= roll;
          placeLegs(st);
        }
        // etiqueta: tamano aparente constante a partir de 16 m de la camara
        var lx = p.x - cx, ly = p.y - cy, lz = p.z - cz;
        var s = Math.sqrt(lx * lx + ly * ly + lz * lz) / 16;
        if (s < 1) s = 1;
        st.label.scale.set(st.labelW * s, st.labelW * s / 4, 1);
        st.label.position.y = 2.4 + 0.6 * (s - 1);
        var vis = true;
        if (portrait && uSt && st !== uSt) {
          // vista compacta: solo el bot mas cercano por delante lleva etiqueta; el fantasma, un "PB" minimo
          // el "PB" se oculta si el fantasma va pegado por detras: su etiqueta caeria sobre el ciclista
          vis = st.kind === 'bot' ? st === nearBot : !(uSt.distM - st.distM >= 0 && uSt.distM - st.distM < 15);
          if (vis) st.label.scale.multiplyScalar(st.kind === 'ghost' ? 0.55 : 0.7);
        }
        if (st.label.visible !== vis) st.label.visible = vis;
      }
      if (kindMats.ghost) kindMats.ghost.halo.opacity = 0.16 + 0.07 * Math.sin(simTime * 3);

      updateCamera(dt);
      var px = camera.position.x, pz = camera.position.z;
      sky.position.copy(camera.position);
      skyU.uTime.value = simTime;
      windU.uTime.value = simTime;
      terrainU.uSnap.value.set(Math.floor(px / 24) * 24, Math.floor(pz / 24) * 24);
      roadU.value.set(px, pz, Q.hiR - tileDiag, Q.hiR - tileDiag * 0.5);
      if (waterNTex) waterNTex.offset.set(simTime * 0.011, simTime * 0.007);

      // streaming: malla fina del terreno y vegetacion alrededor de la camara
      updateHiTiles(px, pz, burst ? 2500 : 4);
      updateVegetation(px, pz, burst ? 2500 : 4);
      burst = false;

      if (Q.shadows) {
        var u = userState(), ux = camPos.x, uy = 0, uz = camPos.z;
        if (u) { ux = u.root.position.x; uy = u.root.position.y; uz = u.root.position.z; }
        // ajuste a la grilla de texeles para que las sombras no titilen al avanzar
        var tex = 2 * Q.shadowRange / Q.shadowSize;
        ux = Math.round(ux / tex) * tex; uz = Math.round(uz / tex) * tex;
        sun.target.position.set(ux, uy, uz);
        sun.position.set(ux + SUN_DIR.x * 500, uy + SUN_DIR.y * 500, uz + SUN_DIR.z * 500);
      }
      renderer.render(scene, camera);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (ro) ro.disconnect();
      canvasEl.removeEventListener('webglcontextlost', onLost);
      canvasEl.removeEventListener('webglcontextrestored', onRestored);
      clearHiTiles();
      clearVegetation();
      for (var i = 0; i < allPools.length; i++) allPools[i].mesh.dispose();
      for (i = 0; i < instMeshes.length; i++) instMeshes[i].dispose();
      for (i = 0; i < own.length; i++) own[i].dispose();
      own.length = 0;
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      riderList.slice().forEach(removeRider);
      riderList.length = 0; riderById = {};
      if (scene.clear) scene.clear();
      renderer.dispose();
      if (renderer.forceContextLoss) renderer.forceContextLoss();
      if (canvasEl.parentNode) canvasEl.parentNode.removeChild(canvasEl);
    }

    var api = {
      setRiders: setRiders, setCameraMode: setCameraMode, setViewInsets: setViewInsets, render: render, resize: resize, dispose: dispose,
      setQuality: setQuality, getStats: getStats
    };
    return api;
  }

  R.Scene3D = {
    isSupported: isSupported,
    create: create,
    _internals: {
      decodeHeights: decodeHeights,
      projectPoint: projectPoint,
      originOf: originOf,
      sampleRoute: sampleRoute,
      laneOffset: laneOffset,
      elevationColor: elevationColor,
      makeHeightGrid: makeHeightGrid,
      gridHeight: gridHeight,
      buildRoadPath: buildRoadPath,
      pathAt: pathAt,
      pathPose: pathPose,
      viewOffsetFor: viewOffsetFor,
      LC: LC,
      LC_NAMES: LC_NAMES,
      decodeLandcover: decodeLandcover,
      deriveLandcover: deriveLandcover,
      landcoverAt: landcoverAt,
      hash2: hash2,
      QUALITY_PRESETS: QUALITY_PRESETS,
      resolveQuality: resolveQuality,
      downgradeQuality: downgradeQuality,
      qualityPreset: qualityPreset,
      createFrameMonitor: createFrameMonitor,
      VEG_LAYERS: VEG_LAYERS,
      VEG_MIN_ROAD: VEG_MIN_ROAD,
      placeVegetation: placeVegetation,
      centerLineColor: centerLineColor,
      smoothPath: smoothPath,
      buildRoadIndex: buildRoadIndex,
      roadQuery: roadQuery,
      curveRadii: curveRadii,
      preethamSky: preethamSky,
      acesFilmic: acesFilmic,
      sunDirection: sunDirection,
      fbmTile: fbmTile
    }
  };
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
