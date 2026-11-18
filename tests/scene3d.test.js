'use strict';
const test = require('node:test');
const assert = require('node:assert');

// Node no tiene THREE ni DOM: el modulo debe cargar y degradar sin lanzar.
delete globalThis.THREE;
require('../src/scene3d.js');
const S = globalThis.R.Scene3D;
const I = S._internals;

function u16b64(values) {
  const buf = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => buf.writeUInt16LE(v, i * 2));
  return buf.toString('base64');
}

test('isSupported() devuelve false sin WebGL/THREE y no lanza', () => {
  assert.strictEqual(S.isSupported(), false);
});

test('create() sin WebGL lanza un error claro (el llamador debe consultar isSupported)', () => {
  assert.throws(() => S.create({}, { points: [[0, 0, 0, 0], [0, 0.001, 0, 100]] }), /WebGL/);
});

test('decodeHeights: grilla 2x2 conocida, little-endian, fila 0 = norte', () => {
  const b64 = u16b64([0, 65535, 32768, 16384]);
  const h = I.decodeHeights(b64, 2, 2, 100, 200);
  assert.strictEqual(h.length, 4);
  assert.strictEqual(h[0], 100);
  assert.strictEqual(h[1], 200);
  assert.ok(Math.abs(h[2] - (100 + 32768 / 65535 * 100)) < 1e-3);
  assert.ok(Math.abs(h[3] - (100 + 16384 / 65535 * 100)) < 1e-3);
  // byte bajo primero: 0x0100 = 256
  const le = I.decodeHeights(Buffer.from([0x00, 0x01]).toString('base64'), 1, 1, 0, 65535);
  assert.ok(Math.abs(le[0] - 256) < 1e-3);
});

test('decodeHeights rechaza tamano inconsistente', () => {
  assert.throws(() => I.decodeHeights(u16b64([1, 2, 3]), 2, 2, 0, 1), /bytes/);
});

test('projectPoint: x = este, z = -norte, escala equirectangular', () => {
  const o = I.projectPoint(-33, -70, -33, -70);
  assert.strictEqual(o.x, 0);
  assert.ok(Object.is(o.z, -0) || o.z === 0);
  const n = I.projectPoint(-32, -70, -33, -70);            // 1 grado al norte
  assert.ok(Math.abs(n.z + 111194.93) < 1, 'z = -111195 m');
  assert.ok(Math.abs(n.x) < 1e-6);
  const e = I.projectPoint(-33, -69, -33, -70);            // 1 grado al este, x escalada por cos(lat)
  assert.ok(Math.abs(e.x - 111194.93 * Math.cos(33 * Math.PI / 180)) < 1);
  assert.ok(Math.abs(e.z) < 1e-6);
  assert.ok(I.projectPoint(-34, -70, -33, -70).z > 0, 'sur => z positivo');
});

test('originOf: centro del bbox del terreno, o de los puntos si no hay terreno', () => {
  const pts = [[-33.0, -70.0, 0, 0], [-33.2, -69.8, 0, 100]];
  assert.deepStrictEqual(I.originOf({ points: pts, terrain: null }), { lat: -33.1, lon: -69.9 });
  const o = I.originOf({ points: pts, terrain: { bbox: [-71, -34, -70, -33] } });
  assert.deepStrictEqual(o, { lat: -33.5, lon: -70.5 });
});

const PTS = [[-33, -70, 100, 0], [-33, -69.999, 120, 100], [-33, -69.998, 100, 300]];

test('sampleRoute: interpola linealmente por distancia', () => {
  const s = I.sampleRoute(PTS, 50);
  assert.ok(Math.abs(s.ele - 110) < 1e-9);
  assert.ok(Math.abs(s.lon - (-69.9995)) < 1e-9);
  assert.strictEqual(s.index, 0);
  const s2 = I.sampleRoute(PTS, 200);                      // mitad del segundo tramo
  assert.ok(Math.abs(s2.ele - 110) < 1e-9);
  assert.strictEqual(s2.index, 1);
  assert.strictEqual(I.sampleRoute(PTS, 100).ele, 120);
});

test('sampleRoute: acota a [0, total] y maneja entradas degeneradas', () => {
  assert.strictEqual(I.sampleRoute(PTS, -50).distM, 0);
  assert.strictEqual(I.sampleRoute(PTS, 1e9).distM, 300);
  assert.strictEqual(I.sampleRoute(PTS, 1e9).ele, 100);
  assert.strictEqual(I.sampleRoute([], 10), null);
  assert.strictEqual(I.sampleRoute([[1, 2, 3, 0]], 10).ele, 3);
});

test('laneOffset: 1 ciclista va al eje; varios se reparten simetricos dentro del camino', () => {
  assert.strictEqual(I.laneOffset(0, 1), 0);
  assert.ok(Math.abs(I.laneOffset(0, 2) + I.laneOffset(1, 2)) < 1e-12);
  assert.notStrictEqual(I.laneOffset(0, 2), I.laneOffset(1, 2));
  for (const count of [2, 3, 5, 9]) {
    const offs = [];
    for (let i = 0; i < count; i++) offs.push(I.laneOffset(i, count));
    assert.strictEqual(new Set(offs).size, count, 'todos distintos');
    offs.forEach((o) => assert.ok(Math.abs(o) <= 2.4 + 1e-9, 'dentro del carril (6 m de ancho)'));
    for (let i = 1; i < count; i++) assert.ok(offs[i] - offs[i - 1] >= 0.5, 'sin solaparse (>= 0.5 m)');
  }
});

test('elevationColor: verde en valle, cafe, gris roca y nieve sobre 3000 m', () => {
  const c = (e) => Array.from(I.elevationColor(e, 0, [0, 0, 0], 0));
  const low = c(100), mid = c(1700), rock = c(2600), snow = c(3200);
  assert.ok(low[1] > low[0] && low[1] > low[2], 'valle verde');
  assert.ok(mid[0] > mid[2], 'cafe');
  assert.ok(Math.abs(rock[0] - rock[1]) < 0.03 && Math.abs(rock[1] - rock[2]) < 0.03, 'roca gris');
  assert.ok(snow.every((v) => v > 0.75), 'nieve clara');
  assert.deepStrictEqual(c(3000), c(5000), 'sobre 3000 m todo es nieve');
});

// Ruta recta hacia el este con terreno 2x2 que sube hacia el este.
function eastRoute(withTerrain) {
  const pts = [];
  for (let i = 0; i <= 10; i++) pts.push([-33, -70 + i * 0.0002, 100 + i * 10, i * 18.6]);
  const route = { points: pts, terrain: null };
  if (withTerrain) {
    route.terrain = {
      bbox: [-70.001, -33.001, -69.997, -32.999], width: 2, height: 2, minEle: 0, maxEle: 65535,
      // fila 0 (norte): 100, 200 ; fila 1 (sur): 300, 400  (de oeste a este)
      heights: u16b64([100, 200, 300, 400]), texture: null
    };
  }
  return route;
}

test('makeHeightGrid: usa el DEM con fila 0 = norte (z mas negativa) y elevaciones reales', () => {
  const route = eastRoute(true);
  const o = I.originOf(route);
  const g = I.makeHeightGrid(route, o, 1);
  assert.strictEqual(g.real, true);
  assert.ok(g.z0 < g.z1 && g.x0 < g.x1, 'norte-oeste en (x0,z0)');
  assert.strictEqual(g.base, 0);
  assert.deepStrictEqual(Array.from(g.data), [100, 200, 300, 400]);
  assert.strictEqual(I.gridHeight(g, g.x0, g.z0), 100);     // esquina NO
  assert.strictEqual(I.gridHeight(g, g.x1, g.z0), 200);     // NE
  assert.strictEqual(I.gridHeight(g, g.x0, g.z1), 300);     // SO
  assert.strictEqual(I.gridHeight(g, (g.x0 + g.x1) / 2, (g.z0 + g.z1) / 2), 250);
  assert.strictEqual(I.gridHeight(g, g.x1 + 1e5, g.z1 + 1e5), 400, 'fuera: acotado al borde');
  const g2 = I.makeHeightGrid(route, o, 2);                 // exageracion vertical
  assert.strictEqual(g2.data[3], 800);
});

test('makeHeightGrid sin terreno: plano que sigue la ruta (finito y cercano a su elevacion)', () => {
  const route = eastRoute(false);
  const o = I.originOf(route);
  const g = I.makeHeightGrid(route, o, 1);
  assert.strictEqual(g.real, false);
  assert.ok(Array.from(g.data).every(Number.isFinite));
  const path = I.buildRoadPath(route, o, g);
  const q = {};
  I.pathAt(path, 93, q);
  const expected = 150 - 100;                              // elevacion relativa a la base (100 m) a ~93 m
  assert.ok(Math.abs(q.y - 0.4 - expected) < 8, 'camino sigue la elevacion de la ruta (y=' + q.y + ')');
});

test('buildRoadPath/pathPose: y de mundo, +0.4 m sobre el terreno, rumbo este y pendiente positiva', () => {
  const route = eastRoute(true);
  const o = I.originOf(route);
  const g = I.makeHeightGrid(route, o, 1);
  const path = I.buildRoadPath(route, o, g);
  assert.strictEqual(path.n, 11);
  const pose = {};
  I.pathPose(path, 90, pose);
  assert.ok(pose.hx > 0.99 && Math.abs(pose.hz) < 0.05, 'rumbo este (+x)');
  assert.ok(Math.abs(Math.hypot(pose.tx, pose.ty, pose.tz) - 1) < 1e-9);
  const terr = I.gridHeight(g, pose.x, pose.z);
  assert.ok(pose.y >= terr + 0.15 && pose.y <= terr + 3, 'camino apenas sobre el terreno');
  assert.ok(pose.ty > 0, 'sube hacia el este');
  I.pathPose(path, -100, pose);                             // acotado al inicio
  assert.ok(Math.abs(pose.x - path.X[0]) < 1e-9);
});

test('viewOffsetFor desplaza el centro óptico al centro de la zona libre', () => {
  const f = globalThis.R.Scene3D._internals.viewOffsetFor;
  assert.deepEqual(f(390, 844, {}), { x: 0, y: 0 });
  assert.deepEqual(f(390, 844, { top: 130, bottom: 95 }), { x: 0, y: -17.5 });
  assert.deepEqual(f(844, 390, { top: 50, bottom: 40, right: 100 }), { x: 50, y: -5 });
  // el centro de la imagen queda en (w/2 - x, h/2 - y) = centro de la zona libre
  const o = f(400, 800, { top: 100, bottom: 300, left: 20, right: 60 });
  assert.equal(400 / 2 - o.x, (20 + 340) / 2);
  assert.equal(800 / 2 - o.y, (100 + 500) / 2);
});

/* ---------------- Escenario realista (Tarea 12) ---------------- */

function mkGrid(w, h, fn, cell = 70) {
  const data = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = fn(i, j);
  return { w, h, x0: 0, z0: 0, x1: (w - 1) * cell, z1: (h - 1) * cell, data, base: 0, vs: 1, real: true };
}
function straightPath(len = 400, step = 5) {
  const n = Math.floor(len / step) + 1;
  const p = { n, D: new Float64Array(n), X: new Float64Array(n), Z: new Float64Array(n), Y: new Float64Array(n) };
  for (let i = 0; i < n; i++) { p.D[i] = i * step; p.X[i] = i * step; p.Z[i] = 0; p.Y[i] = 10; }
  return p;
}

test('decodeLandcover: mapea clases por nombre (con o sin tildes), indice desconocido -> suelo, valida tamano', () => {
  const L = I.LC;
  assert.strictEqual(I.decodeLandcover(null), null);
  assert.strictEqual(I.decodeLandcover({ width: 2, height: 2 }), null);
  const b64 = Buffer.from([0, 1, 2, 9]).toString('base64');
  // orden distinto al canonico: el decodificador usa los nombres
  const lc = I.decodeLandcover({ width: 2, height: 2, classes: ['Árbol', 'agua', 'NIEVE'], data: b64 });
  assert.deepStrictEqual(Array.from(lc.data), [L.ARBOL, L.AGUA, L.NIEVE, L.SUELO]);
  assert.strictEqual(lc.synthetic, false);
  const canon = I.decodeLandcover({ width: 2, height: 2, data: Buffer.from([0, 3, 5, 7]).toString('base64') });
  assert.deepStrictEqual(Array.from(canon.data), [L.ROCA, L.MATORRAL, L.AGUA, L.URBANO]);
  assert.throws(() => I.decodeLandcover({ width: 3, height: 3, data: b64 }), /bytes/);
});

test('deriveLandcover: nieve > 3400 m, roca > 2800 m o pendiente fuerte, valle con pasto/arboles, determinista', () => {
  const L = I.LC;
  const flatLow = I.deriveLandcover(mkGrid(16, 16, () => 600), 7);
  assert.ok(Array.from(flatLow.data).every((c) => c === L.PASTO || c === L.ARBOL), 'valle: pasto o arboles');
  assert.ok(Array.from(flatLow.data).some((c) => c === L.ARBOL) && Array.from(flatLow.data).some((c) => c === L.PASTO));
  assert.ok(Array.from(I.deriveLandcover(mkGrid(8, 8, () => 3600), 1).data).every((c) => c === L.NIEVE));
  assert.ok(Array.from(I.deriveLandcover(mkGrid(8, 8, () => 3000), 1).data).every((c) => c === L.ROCA));
  const cliff = I.deriveLandcover(mkGrid(8, 8, (i) => 1000 + i * 70), 1);      // 45 grados
  assert.ok(Array.from(cliff.data).every((c) => c === L.ROCA));
  const slope = I.deriveLandcover(mkGrid(8, 8, (i) => 1000 + i * 70 * 0.55), 1); // ~29 grados: ladera
  assert.ok(Array.from(slope.data).every((c) => c === L.SUELO || c === L.MATORRAL));
  assert.deepStrictEqual(I.deriveLandcover(mkGrid(16, 16, () => 600), 7).data, flatLow.data, 'misma semilla, mismo resultado');
  assert.strictEqual(flatLow.synthetic, true);
  // landcoverAt: vecino mas cercano en coordenadas de mundo
  const g = mkGrid(2, 2, () => 0, 100);
  const lc = { w: 2, h: 2, data: new Uint8Array([L.ROCA, L.SUELO, L.AGUA, L.NIEVE]) };
  assert.strictEqual(I.landcoverAt(lc, g, 10, 10), L.ROCA);
  assert.strictEqual(I.landcoverAt(lc, g, 90, 5), L.SUELO);
  assert.strictEqual(I.landcoverAt(lc, g, 5, 95), L.AGUA);
  assert.strictEqual(I.landcoverAt(lc, g, 1e6, 1e6), L.NIEVE, 'acotado al borde');
});

test('calidad: auto = media en movil y alta en escritorio; presupuestos por nivel; bajada de un nivel', () => {
  assert.strictEqual(I.resolveQuality('auto', { coarse: true, width: 1400 }), 'media');
  assert.strictEqual(I.resolveQuality('auto', { coarse: false, width: 800 }), 'media');
  assert.strictEqual(I.resolveQuality('auto', { coarse: false, width: 1280 }), 'alta');
  assert.strictEqual(I.resolveQuality('baja', { coarse: false, width: 1280 }), 'baja');
  assert.strictEqual(I.resolveQuality('ultra', { width: 1280 }), 'alta', 'valor invalido = auto');
  assert.strictEqual(I.downgradeQuality('alta'), 'media');
  assert.strictEqual(I.downgradeQuality('media'), 'baja');
  assert.strictEqual(I.downgradeQuality('baja'), 'baja');
  const P = I.QUALITY_PRESETS;
  assert.deepStrictEqual([P.alta.density, P.media.density, P.baja.density], [1, 0.5, 0.25]);
  assert.deepStrictEqual([P.alta.shadowSize, P.media.shadowSize], [2048, 1024]);
  assert.ok(P.alta.shadows && P.media.shadows && !P.baja.shadows);
  assert.ok(P.media.nearTreeR <= 100, 'media: arboles detallados solo cerca');
  assert.deepStrictEqual([P.alta.grassR, P.media.grassR, P.baja.grassR], [150, 80, 0]);
  assert.deepStrictEqual([P.alta.vegBand, P.media.vegBand, P.baja.vegBand], [600, 350, 200]);
  assert.strictEqual(P.baja.pixelRatioMax, 1);
  assert.ok(P.media.shadowRange < P.alta.shadowRange, 'media: sombras solo cerca');
});

test('createFrameMonitor: baja solo tras 3 s seguidos con frames > 24 ms; ignora pausas', () => {
  const run = (dt, secs, m = I.createFrameMonitor()) => { let fired = 0; for (let t = 0; t < secs; t += dt) if (m.feed(dt)) fired++; return fired; };
  assert.strictEqual(run(1 / 60, 30), 0, '60 fps nunca baja');
  assert.strictEqual(run(0.022, 30), 0, '22 ms tampoco');
  const m = I.createFrameMonitor();
  let firstAt = -1, t = 0;
  for (; t < 10; t += 0.03) if (m.feed(0.03)) { firstAt = t; break; }
  assert.ok(firstAt > 3 && firstAt < 6.5, 'baja tras calentamiento + 3 s (t=' + firstAt.toFixed(2) + ')');
  const m2 = I.createFrameMonitor();
  for (let k = 0; k < 400; k++) assert.strictEqual(m2.feed(0.5), false, 'dt > 0,25 s (pestaña oculta) no cuenta');
});

test('placeVegetation: determinista, independiente del troceo, sin nada a < 9 m (arboles) o 6 m (arbustos, pasto) del camino ni sobre agua/roca/nieve', () => {
  const L = I.LC;
  const path = straightPath(400);
  const idx = I.buildRoadIndex(path, 24);
  const q = {};
  const roadDist = (x, z) => I.roadQuery(idx, x, z, 20, 0.1, q).d;
  const classAt = (x, z) => (z < -60 ? L.AGUA : z < -30 ? L.ROCA : z > 60 ? L.NIEVE : (x < 200 ? L.ARBOL : L.MATORRAL));
  const opts = { seed: 42, density: 1, classAt, roadDist };
  const rect = { x0: 0, x1: 400, z0: -100, z1: 100 };
  for (const layer of ['tree', 'shrub', 'grass']) {
    const a = I.placeVegetation(rect, layer, opts);
    assert.ok(a.length > 0, layer + ' genera instancias');
    assert.deepStrictEqual(I.placeVegetation(rect, layer, opts), a, layer + ' determinista');
    const halves = I.placeVegetation({ x0: 0, x1: 170, z0: -100, z1: 100 }, layer, opts).concat(I.placeVegetation({ x0: 170, x1: 400, z0: -100, z1: 100 }, layer, opts));
    assert.strictEqual(halves.length, a.length, layer + ': la union de trozos = el total');
    for (const it of a) {
      const minR = layer === 'tree' ? 9 : 6;
      assert.strictEqual(I.VEG_LAYERS[layer].minRoad, minR);
      assert.ok(roadDist(it.x, it.z) >= minR, layer + ' a ' + roadDist(it.x, it.z).toFixed(2) + ' m del camino');
      assert.ok(Math.abs(it.z) >= minR - 1e-9);
      assert.ok(![L.AGUA, L.ROCA, L.NIEVE].includes(it.cls), layer + ' sobre clase ' + it.cls);
      assert.ok(it.x >= rect.x0 && it.x < rect.x1 && it.z >= rect.z0 && it.z < rect.z1);
      for (const k of ['r0', 'r1', 'r2', 'r3']) assert.ok(it[k] >= 0 && it[k] < 1);
    }
  }
  const trees = I.placeVegetation(rect, 'tree', opts);
  assert.ok(trees.filter((t) => t.cls === L.ARBOL).length > 3 * trees.filter((t) => t.cls === L.MATORRAL).length, 'el bosque es mas denso que el matorral');
  assert.notDeepStrictEqual(I.placeVegetation(rect, 'tree', Object.assign({}, opts, { seed: 43 })), trees, 'otra semilla, otra disposicion');
});

test('placeVegetation: densidad por calidad (alta 100 %, media ~50 %, baja ~25 %)', () => {
  const L = I.LC;
  const opts = (density) => ({ seed: 9, density, classAt: () => L.PASTO, roadDist: () => 1e9 });
  const rect = { x0: -400, x1: 400, z0: -400, z1: 400 };
  const P = I.QUALITY_PRESETS;
  for (const layer of ['tree', 'shrub', 'grass']) {
    const n1 = I.placeVegetation(rect, layer, opts(P.alta.density)).length;
    const n2 = I.placeVegetation(rect, layer, opts(P.media.density)).length;
    const n4 = I.placeVegetation(rect, layer, opts(P.baja.density)).length;
    assert.ok(n1 > 0);
    assert.ok(Math.abs(n2 / n1 - 0.5) < 0.12, layer + ' media ' + (n2 / n1).toFixed(2));
    assert.ok(Math.abs(n4 / n1 - 0.25) < 0.08, layer + ' baja ' + (n4 / n1).toFixed(2));
  }
  // la densidad esperada coincide con la probabilidad por celda
  const g = I.placeVegetation(rect, 'grass', opts(1)).length, cells = (800 / I.VEG_LAYERS.grass.spacing) ** 2;
  assert.ok(Math.abs(g / cells - I.VEG_LAYERS.grass.prob[L.PASTO]) < 0.02);
});

test('roadQuery: distancia, lado, meseta e influencia que se anula en R', () => {
  const path = straightPath(400);
  const idx = I.buildRoadIndex(path, 24);
  const q = {};
  I.roadQuery(idx, 100, 3, 40, 6, q);
  assert.ok(Math.abs(q.d - 3) < 1e-9 && q.k === 1 && Math.abs(q.yb - 10) < 1e-9);
  // derecha del rumbo (+x) = +z (convencion del modulo: derecha = (-hz, hx))
  assert.ok(q.sd > 0);
  I.roadQuery(idx, 100, -3, 40, 6, q);
  assert.ok(q.sd < 0);
  I.roadQuery(idx, 100, 23, 40, 6, q);
  assert.ok(q.k > 0 && q.k < 1);
  I.roadQuery(idx, 100, 39.9, 40, 6, q);
  assert.ok(q.k < 0.01);
  I.roadQuery(idx, 100, 80, 40, 6, q);
  assert.strictEqual(q.k, 0);
  assert.ok(q.d > 40, 'fuera del radio: d = R + 1');
});

test('smoothPath conserva puntos y distancias originales; curveRadii mide el radio de una curva', () => {
  const r = 50, n = 40, p = { n, D: new Float64Array(n), X: new Float64Array(n), Z: new Float64Array(n), Y: new Float64Array(n) };
  for (let i = 0; i < n; i++) { const a = i * 0.1; p.X[i] = r * Math.sin(a); p.Z[i] = r - r * Math.cos(a); p.D[i] = r * a; p.Y[i] = i; }
  const s = I.smoothPath(p, 4);
  assert.strictEqual(s.n, (n - 1) * 4 + 1);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(s.X[i * 4] - p.X[i]) < 1e-9 && Math.abs(s.Z[i * 4] - p.Z[i]) < 1e-9 && s.D[i * 4] === p.D[i]);
  }
  for (let i = 1; i < s.n; i++) assert.ok(s.D[i] > s.D[i - 1] && s.Y[i] >= s.Y[i - 1], 'distancia y altura monotonas');
  // puntos intermedios sobre el circulo (spline suave, no cuerda)
  const mid = 4 * 10 + 2, dc = Math.hypot(s.X[mid], s.Z[mid] - r);
  assert.ok(Math.abs(dc - r) < 0.05, 'radio ' + dc);
  const rad = I.curveRadii(s, 12);
  assert.ok(Math.abs(Math.abs(rad[60]) - r) < 3, 'radio medido ' + rad[60]);
  assert.ok(rad[60] > 0, 'gira a la derecha (+z con rumbo +x)');
  const straight = I.curveRadii(straightPath(200), 12);
  assert.ok(straight[20] > 1e5, 'recta: radio enorme');
});

test('centerLineColor: blanca en Chile y Europa, amarilla en America del Norte y Brasil', () => {
  assert.strictEqual(I.centerLineColor('Chile'), 'blanca');
  assert.strictEqual(I.centerLineColor('Francia'), 'blanca');
  assert.strictEqual(I.centerLineColor(undefined), 'blanca');
  assert.strictEqual(I.centerLineColor('Estados Unidos'), 'amarilla');
  assert.strictEqual(I.centerLineColor('México'), 'amarilla');
  assert.strictEqual(I.centerLineColor('Brasil'), 'amarilla');
});

test('cielo y luz: sol de tarde al NO (sur) o SO (norte), Preetham azul arriba, ACES en [0,1]', () => {
  const s = I.sunDirection(-33);
  assert.ok(Math.abs(Math.hypot(...s) - 1) < 1e-9);
  assert.ok(Math.abs(Math.asin(s[1]) * 180 / Math.PI - 35) < 1e-6);
  assert.ok(s[0] < 0 && s[2] < 0, 'noroeste: x oeste, z = -norte');
  const n = I.sunDirection(45);
  assert.ok(n[0] < 0 && n[2] > 0, 'suroeste en el hemisferio norte');
  const p = { turbidity: 2, rayleigh: 2, mieCoefficient: 0.003, mieDirectionalG: 0.8 };
  const zen = I.preethamSky([0, 1, 0], s, p, [0, 0, 0]);
  const hor = I.preethamSky([1, 0.02, 0], s, p, [0, 0, 0]);
  assert.ok(zen[2] > zen[0] * 1.8, 'cenit azul');
  assert.ok(hor[0] / hor[2] > zen[0] / zen[2], 'horizonte mas blanco que el cenit');
  let prev = -1;
  for (const v of [0, 0.1, 0.5, 1, 2, 5, 20]) {
    const o = I.acesFilmic([v, v, v], 0.6, [0, 0, 0]);
    assert.ok(o.every((c) => c >= 0 && c <= 1));
    assert.ok(o[1] >= prev); prev = o[1];
  }
});

test('fbmTile: valores en [0,1) y textura repetible sin costura', () => {
  const S = 64, f = I.fbmTile(S, [4, 8], [0.6, 0.4], 3);
  assert.strictEqual(f.length, S * S);
  assert.ok(Array.from(f).every((v) => v >= 0 && v < 1));
  // borde derecho vs izquierdo: diferencia similar a la de pixeles vecinos interiores
  let edge = 0, inner = 0;
  for (let y = 0; y < S; y++) { edge += Math.abs(f[y * S] - f[y * S + S - 1]); inner += Math.abs(f[y * S + 31] - f[y * S + 32]); }
  assert.ok(edge < inner * 3 + 0.05, 'sin costura (borde ' + edge.toFixed(3) + ' vs interior ' + inner.toFixed(3) + ')');
});

/* ---- Tarea 19: camara "Cerca" y etiquetas ---- */
const DEGR = Math.PI / 180;

test('chaseCamera: llano, rumbo +X: 5 m atras, 2,4 m arriba, mira 9 m adelante y 1,1 m sobre el camino', () => {
  const c = I.chaseCamera({ x: 100, y: 10, z: 50, heading: 0, grade: 0 });
  assert.ok(Math.abs(c.x - 95) < 1e-9 && Math.abs(c.z - 50) < 1e-9);
  assert.ok(Math.abs(c.y - 12.4) < 1e-9);
  assert.ok(Math.abs(c.lx - 109) < 1e-9 && Math.abs(c.ly - 11.1) < 1e-9);
});

test('chaseCamera: rumbo +Z y pendiente 10 % (la camara sigue el camino, no flota)', () => {
  const c = I.chaseCamera({ x: 0, y: 0, z: 0, heading: Math.PI / 2, grade: 0.1 });
  assert.ok(Math.abs(c.x) < 1e-9 && Math.abs(c.z + 5) < 1e-9);
  assert.ok(Math.abs(c.y - (2.4 - 0.5)) < 1e-9);
  assert.ok(Math.abs(c.lz - 9) < 1e-9 && Math.abs(c.ly - (0.9 + 1.1)) < 1e-9);
});

test('chaseBackDistance: 4,5..7 m; escritorio ~5 m, vertical con zona libre pequena se acota', () => {
  const dsk = I.chaseBackDistance(800, 800, 55);
  assert.ok(dsk >= 4.5 && dsk <= 5.5, 'escritorio ' + dsk);
  assert.strictEqual(I.chaseBackDistance(844, 300, 62), I.CHASE.backMax);
  assert.strictEqual(I.chaseBackDistance(800, 800, 120), I.CHASE.backMin);
});

test('el ciclista ocupa 30-40 % de la zona libre y queda en la mitad inferior (escritorio y vertical)', () => {
  const cases = [{ vh: 800, top: 0, bottom: 0, fov: 55 }, { vh: 844, top: 120, bottom: 200, fov: 62 }];
  for (const k of cases) {
    const free = k.vh - k.top - k.bottom;
    const back = I.chaseBackDistance(k.vh, free, k.fov);
    const c = I.chaseCamera({ x: 0, y: 0, z: 0, heading: 0, grade: 0 }, { back });
    const cam = { x: c.x, y: c.y, z: c.z }, look = { x: c.lx, y: c.ly, z: c.lz };
    const top = I.ndcY(cam, look, { x: 0, y: 1.75, z: 0 }, k.fov), bot = I.ndcY(cam, look, { x: 0, y: 0, z: 0 }, k.fov);
    const frac = (top - bot) / 2 * k.vh / free;      // NDC abarca 2 = viewH px
    assert.ok(frac > 0.3 && frac < 0.5, 'fraccion ' + frac);
    assert.ok((top + bot) / 2 < 0, 'centro del ciclista bajo el centro de la zona libre');
  }
});

test('smoothHeading: constante 0,6 s, camino corto por el cruce de +-pi, sin saltos', () => {
  const h = I.smoothHeading(0, Math.PI / 2, 0.6, 0.6);
  assert.ok(Math.abs(h - (Math.PI / 2) * (1 - Math.exp(-1))) < 1e-9);
  const w = I.smoothHeading(170 * DEGR, -170 * DEGR, 0.1, 0.6);   // 20 grados por el lado corto
  assert.ok(Math.abs(I.wrapPi(w - 170 * DEGR)) < 20 * DEGR && I.wrapPi(w - 170 * DEGR) > 0);
  assert.strictEqual(I.smoothHeading(1, 2, 0, 0.6), 1);
  let a = 0;
  for (let i = 0; i < 600; i++) a = I.smoothHeading(a, Math.PI / 2, 1 / 60, 0.6);
  assert.ok(Math.abs(a - Math.PI / 2) < 1e-3);
});

test('occlusionScale: libre = 1; bloqueo acerca la camara; nunca menos del minimo', () => {
  const rider = { x: 0, y: 1, z: 0 }, cam = { x: -10, y: 3, z: 0 };
  assert.strictEqual(I.occlusionScale(rider, cam, () => false, 10), 1);
  const s = I.occlusionScale(rider, cam, (x) => x < -5, 10);
  assert.ok(s < 0.6 && s >= I.CHASE.minScale, 'escala ' + s);
  assert.strictEqual(I.occlusionScale(rider, cam, () => true, 10), I.CHASE.minScale);
});

test('labelVisibility: usuario, fantasma y solo los 4 bots mas cercanos', () => {
  const riders = [{ kind: 'user', d: 0 }, { kind: 'ghost', d: 90 }];
  for (let i = 0; i < 20; i++) riders.push({ kind: 'bot', d: 100 - i });   // el ultimo es el mas cercano
  const v = I.labelVisibility(riders, 4);
  assert.ok(v[0] && v[1]);
  const bots = v.slice(2);
  assert.strictEqual(bots.filter(Boolean).length, 4);
  assert.deepStrictEqual(bots.slice(-4), [true, true, true, true]);
  assert.strictEqual(I.labelVisibility([{ kind: 'bot', d: 1 }, { kind: 'bot', d: 1 }], 1).filter(Boolean).length, 1);
});

test('modos de camara: Cerca primero, conserva lateral y aerea', () => {
  assert.strictEqual(I.CAMERA_MODES[0], 'cerca');
  for (const m of ['persecucion', 'aerea', 'lateral']) assert.ok(I.CAMERA_MODES.includes(m));
});

test('mergeParts: normales finitas y unitarias (incluye escala no uniforme y sin normales), indices desplazados', () => {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  // escala (2, 1, 1) + traslacion (5, 0, 0), columna-mayor
  const scaled = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1];
  const tri = { pos: [0, 0, 0, 1, 0, 0, 0, 1, 0], nor: [0, 0, 1, 0, 0, 1, 0, 0, 1], index: [0, 1, 2], color: [0.1, 0.2, 0.3], m: identity };
  const slab = { pos: [0, 0, 0, 1, 0, 0, 0, 1, 0], nor: [1, 1, 0, 1, 1, 0, 1, 1, 0], index: null, color: [1, 0, 0], m: scaled };
  const noNor = { pos: [0, 0, 0, 1, 0, 0, 0, 1, 0], nor: null, index: [2, 1, 0], color: [0, 1, 0], m: identity };
  const g = I.mergeParts([tri, slab, noNor]);
  assert.strictEqual(g.position.length, 27);
  for (const arr of [g.position, g.normal, g.color]) for (const v of arr) assert.ok(Number.isFinite(v));
  for (let i = 0; i < 9; i++) {
    const l = Math.hypot(g.normal[i * 3], g.normal[i * 3 + 1], g.normal[i * 3 + 2]);
    assert.ok(Math.abs(l - 1) < 1e-6, 'normal unitaria ' + l);
  }
  // normal (1,1,0) con escala x2: la inversa transpuesta la inclina hacia y -> (1/2, 1, 0) normalizada
  const n = [g.normal[9], g.normal[10], g.normal[11]];
  assert.ok(Math.abs(n[0] - 0.5 / Math.hypot(0.5, 1)) < 1e-6 && Math.abs(n[1] - 1 / Math.hypot(0.5, 1)) < 1e-6);
  assert.ok(Math.abs(g.position[12] - 7) < 1e-6, 'x = 2*1 + 5');
  assert.deepStrictEqual(Array.from(g.index), [0, 1, 2, 3, 4, 5, 8, 7, 6]);
  assert.deepStrictEqual(Array.from(g.color.slice(0, 3)).map((v) => Math.round(v * 10)), [1, 2, 3]);
});

test('camara Cerca con 28 % reservado: rueda trasera dentro de la zona libre en subida de 6 % con viewH 650', () => {
  const viewH = 650, reserve = I.chaseReserve(viewH), free = viewH - reserve, fov = 55;
  assert.ok(reserve / viewH >= 0.27);
  const grade = 0.06;
  const back = I.chaseBackDistance(viewH, free, fov);
  const c = I.chaseCamera({ x: 0, y: 0, z: 0, heading: 0, grade }, { back });
  const cam = { x: c.x, y: c.y, z: c.z }, look = { x: c.lx, y: c.ly, z: c.lz };
  // la altura del camino bajo la rueda trasera (1 m atras) es -grade
  const wheelNdc = I.ndcY(cam, look, { x: -0.5, y: -0.5 * grade, z: 0 }, fov);
  const px = free / 2 - wheelNdc * viewH / 2;            // y en pantalla (0 = arriba) con el centro optico en el centro de la zona libre
  assert.ok(px < free - 8, 'rueda en y=' + px + ' de ' + free);
  const headNdc = I.ndcY(cam, look, { x: 0, y: 1.75, z: 0 }, fov);
  assert.ok(free / 2 - headNdc * viewH / 2 > 0, 'cabeza dentro');
});

// ---- carriles con dinámica lateral (fluidez del pelotón) ----
test('laneStep: el usuario queda fijo y los bots no saltan de carril (velocidad lateral acotada)', () => {
  const L = I.LANE, dt = 1 / 60;
  const rs = [{ id: 'user', kind: 'user', distM: 100, speed: 8 }];
  for (let k = 0; k < 14; k++) rs.push({ id: 'bot-' + (k + 1), kind: 'bot', distM: 90 + k * 1.3, speed: 8 + (k % 3) * 0.4 });
  let prev = null, maxStep = 0;
  for (let f = 0; f < 60 * 60; f++) {
    rs.forEach((r) => { r.distM += r.speed * dt; });
    I.laneStep(rs, dt, f * dt);
    if (prev) rs.forEach((r, i) => { maxStep = Math.max(maxStep, Math.abs(r.lat - prev[i])); });
    prev = rs.map((r) => r.lat);
    rs.forEach((r) => assert.ok(Math.abs(r.lat) <= 2.4 + 1e-9, 'fuera del camino ' + r.lat));
    assert.strictEqual(rs[0].lat, L.userLat);
  }
  assert.ok(maxStep <= L.maxV * dt + 1e-9, 'salto lateral ' + maxStep);
});

test('laneStep: un bot que alcanza a otro en su carril se abre con anticipación y lo adelanta al lado', () => {
  const dt = 1 / 60;
  const slow = { id: 'bot-a', kind: 'bot', distM: 30, speed: 8, home: 0.3 };
  const fast = { id: 'bot-b', kind: 'bot', distM: 0, speed: 9.5, home: 0.3 };
  const user = { id: 'user', kind: 'user', distM: -200, speed: 8 };
  const rs = [user, slow, fast];
  let minSep = Infinity;
  for (let f = 0; f < 60 * 60; f++) {
    rs.forEach((r) => { r.distM += r.speed * dt; });
    I.laneStep(rs, dt, 0);
    if (Math.abs(fast.distM - slow.distM) < 1.5) minSep = Math.min(minSep, Math.abs(fast.lat - slow.lat));
  }
  assert.ok(minSep >= 0.6, 'separación al adelantar ' + minSep);
  assert.ok(Math.abs(fast.lat - fast.home) < 0.3, 'vuelve a su carril: ' + fast.lat);
});

test('laneHome: determinista y dentro del camino; fantasma al costado del usuario', () => {
  assert.strictEqual(I.laneHome('bot-3', 'bot'), I.laneHome('bot-3', 'bot'));
  for (let k = 1; k <= 20; k++) assert.ok(Math.abs(I.laneHome('bot-' + k, 'bot')) <= 2.0);
  assert.ok(Math.abs(I.laneHome('ghost', 'ghost') - I.laneHome('user', 'user')) >= 0.8);
});
