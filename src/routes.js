(function (R) {
  'use strict';

  const EARTH_R = 6371000; // m; misma constante que la escena 3D
  const DEG = Math.PI / 180;
  const CHILE_COUNTRY = 'Chile';

  // ---------- registro ----------
  const registry = {};
  function register(route) {
    if (!route || !route.id) throw new Error('La ruta necesita un id');
    registry[route.id] = route;
    return route;
  }
  function get(id) { return registry[id] || null; }
  function list() {
    const all = Object.keys(registry).map((k) => registry[k]);
    const isCl = (r) => r.country === CHILE_COUNTRY;
    return all.filter(isCl).concat(all.filter((r) => !isCl(r)));
  }

  // ---------- geodesia ----------
  function haversine(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * DEG;
    const dLon = (lon2 - lon1) * DEG;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // ---------- GPX ----------
  function attr(s, name) {
    const m = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')').exec(s);
    return m ? parseFloat(m[1] !== undefined ? m[1] : m[2]) : NaN;
  }

  function parseGPXPoints(text) {
    const re = /<(trkpt|rtept)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;
    const pts = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const lat = attr(m[2], 'lat');
      const lon = attr(m[2], 'lon');
      if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      let ele = null;
      if (m[3]) {
        const e = /<ele>\s*([^<\s]+)\s*<\/ele>/.exec(m[3]);
        if (e && isFinite(parseFloat(e[1]))) ele = parseFloat(e[1]);
      }
      pts.push({ lat, lon, ele });
    }
    return pts;
  }

  function slugify(s) {
    return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ruta';
  }

  function fromGPX(text, opts) {
    opts = opts || {};
    const raw = parseGPXPoints(String(text || ''));
    if (!raw.length) throw new Error('El archivo GPX no tiene puntos de recorrido');
    const hasEle = raw.some((p) => p.ele !== null);
    // rellenar elevaciones faltantes con la última conocida (o la primera conocida)
    let last = hasEle ? raw.find((p) => p.ele !== null).ele : 0;
    raw.forEach((p) => { if (p.ele === null) p.ele = last; else last = p.ele; });
    if (!hasEle) raw.forEach((p) => { p.ele = 0; });

    // distancia acumulada, sin tramos de largo cero
    const src = [];
    let acc = 0;
    raw.forEach((p, i) => {
      if (i > 0) {
        const d = haversine(raw[i - 1].lat, raw[i - 1].lon, p.lat, p.lon);
        if (d < 0.01) return;
        acc += d;
      }
      src.push({ lat: p.lat, lon: p.lon, ele: p.ele, d: acc });
    });
    if (src.length < 2 || acc < 20) throw new Error('El archivo GPX no tiene recorrido suficiente (mínimo 20 m)');

    // remuestreo cada 20 m
    const STEP = 20;
    const total = acc;
    const n = Math.max(2, Math.round(total / STEP) + 1);
    const out = [];
    let j = 0;
    for (let i = 0; i < n; i++) {
      const d = i === n - 1 ? total : i * STEP;
      while (j < src.length - 2 && src[j + 1].d < d) j++;
      const a = src[j], b = src[j + 1];
      const t = b.d > a.d ? Math.min(1, Math.max(0, (d - a.d) / (b.d - a.d))) : 0;
      out.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, ele: a.ele + (b.ele - a.ele) * t, d });
    }

    // suavizado de elevación, ventana de 5 puntos
    const sm = out.map((p, i) => {
      let s = 0, c = 0;
      for (let k = Math.max(0, i - 2); k <= Math.min(out.length - 1, i + 2); k++) { s += out[k].ele; c++; }
      return s / c;
    });
    let gain = 0, mn = Infinity, mx = -Infinity;
    sm.forEach((e, i) => {
      if (i > 0 && e > sm[i - 1]) gain += e - sm[i - 1];
      mn = Math.min(mn, e); mx = Math.max(mx, e);
    });
    const points = out.map((p, i) => [p.lat, p.lon, sm[i], p.d]);
    const name = opts.name || (/<name>\s*([^<]+?)\s*<\/name>/.exec(text) || [])[1] || 'Ruta GPX';
    const route = {
      id: opts.id || 'gpx-' + slugify(name),
      name,
      region: '', country: '',
      description: hasEle ? 'Ruta importada desde un archivo GPX.' : 'Ruta importada desde un archivo GPX sin datos de elevación (terreno plano).',
      source: 'GPX cargado por el usuario',
      synthetic: false,
      distanceM: total, gainM: gain, maxEleM: mx, minEleM: mn,
      points,
      terrain: null,
    };
    if (!hasEle) route.flat = true;
    return route;
  }

  // ---------- muestreo ----------
  function bearing(lat1, lon1, lat2, lon2) {
    const dx = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * DEG);
    const dy = lat2 - lat1;
    return Math.atan2(dx, dy); // 0 = norte, π/2 = este
  }

  function interp(route, d) {
    const pts = route.points;
    d = Math.min(Math.max(d, 0), route.distanceM);
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid][3] <= d) lo = mid; else hi = mid;
    }
    const a = pts[lo], b = pts[hi];
    const t = b[3] > a[3] ? (d - a[3]) / (b[3] - a[3]) : 0;
    return { lat: a[0] + (b[0] - a[0]) * t, lon: a[1] + (b[1] - a[1]) * t, ele: a[2] + (b[2] - a[2]) * t, index: lo, t, d };
  }

  function sampleAt(route, distM) {
    const d = Math.min(Math.max(distM, 0), route.distanceM);
    const p = interp(route, d);
    const d0 = Math.max(0, d - 40), d1 = Math.min(route.distanceM, d + 40);
    const p0 = interp(route, d0), p1 = interp(route, d1);
    const span = d1 - d0;
    const gradePct = span > 0 ? ((p1.ele - p0.ele) / span) * 100 : 0;
    const h0 = interp(route, Math.max(0, d - 20)), h1 = interp(route, Math.min(route.distanceM, d + 20));
    const headingRad = bearing(h0.lat, h0.lon, h1.lat, h1.lon);
    return { lat: p.lat, lon: p.lon, ele: p.ele, gradePct, headingRad, index: p.index, t: p.t };
  }

  function profile(route, n) {
    n = n || 300;
    const res = [];
    for (let i = 0; i < n; i++) {
      const d = n > 1 ? (i / (n - 1)) * route.distanceM : 0;
      const s = sampleAt(route, d);
      res.push({ distM: d, ele: s.ele, gradePct: s.gradePct });
    }
    return res;
  }

  // ---------- proyección local ----------
  function pointsBBox(route) {
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    route.points.forEach((p) => {
      minLat = Math.min(minLat, p[0]); maxLat = Math.max(maxLat, p[0]);
      minLon = Math.min(minLon, p[1]); maxLon = Math.max(maxLon, p[1]);
    });
    return [minLon, minLat, maxLon, maxLat];
  }

  function toLocalXY(route) {
    const bb = route.terrain && route.terrain.bbox ? route.terrain.bbox : pointsBBox(route);
    const lat0 = (bb[1] + bb[3]) / 2, lon0 = (bb[0] + bb[2]) / 2;
    const cosLat = Math.cos(lat0 * DEG);
    return {
      origin: { lat: lat0, lon: lon0 },
      project(lat, lon) {
        return { x: (lon - lon0) * DEG * EARTH_R * cosLat, z: -(lat - lat0) * DEG * EARTH_R };
      },
    };
  }

  // ---------- terreno procedural ----------
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function lattice(ix, iy, seed) {
    let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed | 0, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
  }
  function valueNoise(x, y, seed) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = lattice(ix, iy, seed), b = lattice(ix + 1, iy, seed);
    const c = lattice(ix, iy + 1, seed), d = lattice(ix + 1, iy + 1, seed);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }
  function fbm(x, y, seed) {
    let amp = 0.5, f = 1, s = 0, norm = 0;
    for (let o = 0; o < 5; o++) { s += amp * valueNoise(x * f, y * f, seed + o * 101); norm += amp; amp *= 0.5; f *= 2; }
    return s / norm - 0.5; // ~[-0.5, 0.5]
  }

  function toBase64(u8) {
    if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function proceduralTerrain(route, opts) {
    opts = opts || {};
    const size = opts.size || 192;
    const seed = opts.seed !== undefined ? opts.seed : hashStr(route.id || route.name || 'ruta');
    const bb = pointsBBox(route);
    const midLat = (bb[1] + bb[3]) / 2;
    const mPerLat = DEG * EARTH_R, mPerLon = mPerLat * Math.cos(midLat * DEG);
    let wM = (bb[2] - bb[0]) * mPerLon, hM = (bb[3] - bb[1]) * mPerLat;
    wM = Math.max(wM * 1.7, 1500); hM = Math.max(hM * 1.7, 1500); // margen 35 % por lado, mínimo 1.5 km
    const cLon = (bb[0] + bb[2]) / 2, cLat = (bb[1] + bb[3]) / 2;
    const bbox = [cLon - wM / 2 / mPerLon, cLat - hM / 2 / mPerLat, cLon + wM / 2 / mPerLon, cLat + hM / 2 / mPerLat];

    // puntos de referencia en metros locales (submuestreados a ~100 m)
    const stride = Math.max(1, Math.round(100 / 20));
    const ref = [];
    for (let i = 0; i < route.points.length; i += stride) {
      const p = route.points[i];
      ref.push([(p[1] - cLon) * mPerLon, (p[0] - cLat) * mPerLat, p[2]]);
    }
    const last = route.points[route.points.length - 1];
    ref.push([(last[1] - cLon) * mPerLon, (last[0] - cLat) * mPerLat, last[2]]);

    const eleRange = Math.max(60, (route.maxEleM || 0) - (route.minEleM || 0));
    const noiseAmp = eleRange * 0.9;       // amplitud máxima del ruido lejos del camino
    const nearScale = Math.max(300, Math.min(wM, hM) * 0.35);
    const noiseFreq = 5;                    // celdas de ruido a lo ancho
    const vals = new Float32Array(size * size);
    let mn = Infinity, mx = -Infinity;
    for (let j = 0; j < size; j++) {
      const yM = (0.5 - j / (size - 1)) * hM; // fila 0 = norte
      for (let i = 0; i < size; i++) {
        const xM = (i / (size - 1) - 0.5) * wM;
        let sw = 0, se = 0, dmin = Infinity;
        for (let k = 0; k < ref.length; k++) {
          const dx = xM - ref[k][0], dy = yM - ref[k][1];
          const d2 = dx * dx + dy * dy + 25;
          if (d2 < dmin) dmin = d2;
          const w = 1 / (d2 * d2); // distancia inversa^4 (muy local)
          sw += w; se += w * ref[k][2];
        }
        dmin = Math.sqrt(dmin);
        const u = Math.min(1, dmin / nearScale);
        const grow = u * u * (3 - 2 * u);
        const e = se / sw + fbm((i / size) * noiseFreq, (j / size) * noiseFreq, seed) * 2 * noiseAmp * grow;
        vals[j * size + i] = e;
        if (e < mn) mn = e; if (e > mx) mx = e;
      }
    }
    if (mx - mn < 1) mx = mn + 1;
    const bytes = new Uint8Array(size * size * 2);
    for (let k = 0; k < vals.length; k++) {
      const q = Math.round(((vals[k] - mn) / (mx - mn)) * 65535);
      bytes[2 * k] = q & 255; bytes[2 * k + 1] = q >> 8;
    }
    return {
      bbox, width: size, height: size, minEle: mn, maxEle: mx,
      heights: toBase64(bytes), texture: null, procedural: true,
      attribution: 'Terreno procedural generado a partir de la elevación de la ruta',
    };
  }

  R.routes = { registry, register, get, list, fromGPX, sampleAt, profile, toLocalXY, proceduralTerrain, haversine };
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
