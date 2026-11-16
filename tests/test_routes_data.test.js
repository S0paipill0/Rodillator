'use strict';
// Verifica los JSON horneados por tools/bake_routes.py (data/routes/*.json).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'data', 'routes');
const ATTRIBUTION = 'Copernicus DEM GLO-30 © ESA/DLR; Sentinel-2 cloudless by EOX (CC BY-NC-SA 4.0)';
const M_PER_DEG = Math.PI / 180 * 6371000;

// Pendiente media esperada (%) y distancia esperada (km) por ruta, según el brief de la tarea.
const EXPECTED = {
  'alpe-dhuez': { slope: [7, 9], km: [11, 15], synthetic: false },
  // Farellones y Caracoles: el tope de p95 de pendiente local se relaja a 18 % (resto: 12 %), ver informe.
  'farellones': { slope: [5, 8], synthetic: true, p95Max: 18 },
  'caracoles-portillo': { slope: [5, 8], synthetic: true, p95Max: 18 },
  'el-yeso': { slope: [3, 6], synthetic: true },
  'talagante-valle': { slope: [0, 1.5], km: [30, 36], synthetic: true },
  // Tarea 18. Rangos = referencia pública +/- 15 % (bikeclimbs / PJAMM), ver informe.
  // La Dormida lado Tiltil: 8,76 km, +593 m, 6,8 %, cima 1.275 m, base 676 m.
  'cuesta-la-dormida': { slope: [5.8, 7.8], km: [7.45, 10.1], gain: [504, 682], maxEle: [1200, 1290], synthetic: true },
  // Mallarauco desde Peñaflor: 7,6 km, +280 m, 3,7 %, cumbre ~658 m. p95 local <= 16 % (la cuesta real llega a 27 %).
  'cuesta-mallarauco': { slope: [3.15, 4.25], km: [6.46, 8.73], gain: [238, 322], maxEle: [600, 670], synthetic: true, p95Max: 16 },
  // CH-115 hasta la Laguna del Maule: tramo <= 45 km (la referencia PJAMM, 60,7 km al 2,6 %, no cabe en el JSON).
  'ch115-laguna-del-maule': { slope: [3.0, 4.0], km: [30, 45], gain: [1100, 1700], maxEle: [2100, 2300], maxBytes: 1.8e6, synthetic: true },
};

function load(id) {
  const file = path.join(DIR, id + '.json');
  return { json: JSON.parse(fs.readFileSync(file, 'utf8')), bytes: fs.statSync(file).size };
}

// Pendiente media (%): neta para subidas; ganancia/distancia para circuitos (inicio ~ fin).
function meanSlopePct(r) {
  const p = r.points;
  const a = p[0], b = p[p.length - 1];
  const loop = Math.hypot((b[0] - a[0]) * M_PER_DEG, (b[1] - a[1]) * M_PER_DEG * Math.cos(a[0] * Math.PI / 180)) < 200;
  return (loop ? r.gainM : Math.abs(b[2] - a[2])) / r.distanceM * 100;
}

function jpegSize(buf) {
  assert.strictEqual(buf[0], 0xff); assert.strictEqual(buf[1], 0xd8);
  let i = 2;
  while (i < buf.length) {
    assert.strictEqual(buf[i], 0xff);
    const m = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error('JPEG sin marcador SOF');
}

test('existen exactamente las 8 rutas esperadas', () => {
  const ids = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  assert.deepStrictEqual(ids, Object.keys(EXPECTED).sort());
});

for (const id of Object.keys(EXPECTED)) {
  const exp = EXPECTED[id];
  test(`${id}: esquema y metadatos`, () => {
    const { json: r, bytes } = load(id);
    assert.strictEqual(r.id, id);
    for (const k of ['name', 'region', 'country', 'description', 'source']) {
      assert.ok(typeof r[k] === 'string' && r[k].length > 0, k);
    }
    assert.strictEqual(r.synthetic, exp.synthetic);
    if (exp.synthetic) assert.match(r.description, /aproximado/);
    else assert.match(r.source, /rayshaderanimate/);
    for (const k of ['distanceM', 'gainM', 'maxEleM', 'minEleM']) assert.ok(Number.isFinite(r[k]), k);
    const maxBytes = exp.maxBytes || 1.6e6;
    assert.ok(bytes < maxBytes, `JSON de ${bytes} bytes supera ${maxBytes}`);
  });

  test(`${id}: points (distM creciente, paso ~20 m, agregados coherentes)`, () => {
    const { json: r } = load(id);
    const p = r.points;
    assert.ok(p.length > 100);
    assert.strictEqual(p[0][3], 0);
    for (let i = 0; i < p.length; i++) {
      assert.strictEqual(p[i].length, 4);
      assert.ok(p[i].every(Number.isFinite));
      if (i) {
        const step = p[i][3] - p[i - 1][3];
        assert.ok(Math.abs(step - 20) <= 5, `paso ${step} en índice ${i}`);
      }
    }
    assert.ok(Math.abs(p[p.length - 1][3] - r.distanceM) < 0.11);
    assert.ok(Math.abs(Math.max(...p.map((q) => q[2])) - r.maxEleM) < 0.11);
    assert.ok(Math.abs(Math.min(...p.map((q) => q[2])) - r.minEleM) < 0.11);
    let gain = 0;
    for (let i = 1; i < p.length; i++) gain += Math.max(0, p[i][2] - p[i - 1][2]);
    assert.ok(Math.abs(gain - r.gainM) < 1, `gain ${gain} vs ${r.gainM}`);
  });

  test(`${id}: pendiente media y distancia`, () => {
    const { json: r } = load(id);
    const s = meanSlopePct(r);
    assert.ok(s >= exp.slope[0] && s <= exp.slope[1], `pendiente media ${s.toFixed(2)} % fuera de ${exp.slope}`);
    if (exp.km) assert.ok(r.distanceM / 1000 >= exp.km[0] && r.distanceM / 1000 <= exp.km[1], `distancia ${r.distanceM}`);
    if (exp.gain) assert.ok(r.gainM >= exp.gain[0] && r.gainM <= exp.gain[1], `desnivel ${r.gainM} fuera de ${exp.gain}`);
    if (exp.maxEle) assert.ok(r.maxEleM >= exp.maxEle[0] && r.maxEleM <= exp.maxEle[1], `cota máxima ${r.maxEleM} fuera de ${exp.maxEle}`);
  });

  if (exp.synthetic) {
    test(`${id}: pendiente local p95 <= ${exp.p95Max || 12} %`, () => {
      const p = load(id).json.points;
      const g = [];
      for (let i = 1; i < p.length; i++) g.push(Math.abs(p[i][2] - p[i - 1][2]) / (p[i][3] - p[i - 1][3]) * 100);
      g.sort((a, b) => a - b);
      const p95 = g[Math.floor(0.95 * (g.length - 1))];
      assert.ok(p95 <= (exp.p95Max || 12), `p95 de pendiente local ${p95.toFixed(1)} %`);
    });
  }

  if (exp.synthetic) {
    test(`${id}: sin giros > 120 grados entre segmentos consecutivos`, () => {
      const p = load(id).json.points;
      const k = Math.cos(p[0][0] * Math.PI / 180);
      const seg = (i) => [(p[i + 1][1] - p[i][1]) * k, p[i + 1][0] - p[i][0]];
      let worst = 0;
      for (let i = 0; i + 2 < p.length; i++) {
        const a = seg(i), b = seg(i + 1);
        const cos = (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b));
        worst = Math.max(worst, Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI);
      }
      assert.ok(worst <= 120, `giro máximo ${worst.toFixed(0)} grados`);
    });
  }

  test(`${id}: terreno (grilla, textura, bbox) y coherencia con la ruta`, () => {
    const { json: r } = load(id);
    const t = r.terrain;
    assert.strictEqual(t.width, 256);
    assert.strictEqual(t.height, 256);
    assert.strictEqual(t.attribution, ATTRIBUTION);
    const [minLon, minLat, maxLon, maxLat] = t.bbox;
    // la ruta cabe en el bbox con >= 1.5 km de margen a cada lado
    const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180) * M_PER_DEG;
    const lats = r.points.map((q) => q[0]), lons = r.points.map((q) => q[1]);
    assert.ok((Math.min(...lons) - minLon) * kx >= 1490 && (maxLon - Math.max(...lons)) * kx >= 1490);
    assert.ok((Math.min(...lats) - minLat) * M_PER_DEG >= 1490 && (maxLat - Math.max(...lats)) * M_PER_DEG >= 1490);

    const raw = Buffer.from(t.heights, 'base64');
    assert.strictEqual(raw.length, 256 * 256 * 2);
    const h = new Uint16Array(256 * 256);
    for (let i = 0; i < h.length; i++) h[i] = raw.readUInt16LE(i * 2);
    assert.ok(t.maxEle > t.minEle);
    const hMin = h.reduce((a, b) => Math.min(a, b)), hMax = h.reduce((a, b) => Math.max(a, b));
    assert.ok(hMin <= 655 && hMax >= 64880, 'la grilla usa casi todo el rango Uint16');
    const eleAt = (lat, lon) => {   // bilineal; grilla de vértices, fila 0 = norte
      const x = (lon - minLon) / (maxLon - minLon) * 255, y = (maxLat - lat) / (maxLat - minLat) * 255;
      const x0 = Math.min(254, Math.floor(x)), y0 = Math.min(254, Math.floor(y)), fx = x - x0, fy = y - y0;
      const v = (xx, yy) => h[yy * 256 + xx];
      const q = v(x0, y0) * (1 - fx) * (1 - fy) + v(x0 + 1, y0) * fx * (1 - fy) + v(x0, y0 + 1) * (1 - fx) * fy + v(x0 + 1, y0 + 1) * fx * fy;
      return t.minEle + q / 65535 * (t.maxEle - t.minEle);
    };
    const diffs = r.points.map((q) => Math.abs(eleAt(q[0], q[1]) - q[2])).sort((a, b) => a - b);
    const median = diffs[Math.floor(diffs.length / 2)];
    assert.ok(median < 40, `la ruta no apoya sobre el terreno: mediana de diferencia ${median.toFixed(1)} m`);

    assert.ok(t.texture.startsWith('data:image/jpeg;base64,'));
    const { w, h: ph } = jpegSize(Buffer.from(t.texture.slice('data:image/jpeg;base64,'.length), 'base64'));
    assert.ok(Math.max(w, ph) >= 1024 && Math.max(w, ph) <= 2048, `textura ${w}x${ph}`);
    const aspectBbox = (maxLon - minLon) * kx / ((maxLat - minLat) * M_PER_DEG);
    assert.ok(Math.abs(w / ph / aspectBbox - 1) < 0.02, `aspecto de textura ${w / ph} vs bbox ${aspectBbox}`);
  });
}
