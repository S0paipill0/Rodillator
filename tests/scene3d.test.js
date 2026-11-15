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
