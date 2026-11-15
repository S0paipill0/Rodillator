'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
require('../src/routes.js');
const RT = globalThis.R.routes;

const GPX_ELE = `<?xml version="1.0"?><gpx version="1.1" creator="t"><trk><name>Cuesta</name><trkseg>
<trkpt lat="-33.4000" lon="-70.6000"><ele>500</ele></trkpt>
<trkpt lon='-70.6000' lat='-33.3910'><ele>600</ele></trkpt>
<trkpt lat="-33.3820" lon="-70.6000"><ele>700</ele></trkpt>
</trkseg></trk></gpx>`; // ~1 km, 200 m de subida en ~2 km => 10 %
const GPX_NOELE = `<gpx><trk><trkseg><trkpt lat="-33.40" lon="-70.60"/><trkpt lat="-33.39" lon="-70.60"></trkpt><trkpt lat="-33.38" lon="-70.60"/></trkseg></trk></gpx>`;
const GPX_RTE = `<gpx><rte><rtept lat="10.00" lon="20.00"><ele>10</ele></rtept><rtept lat="10.01" lon="20.00"><ele>20</ele></rtept></rte></gpx>`;

test('fromGPX con ele, comillas simples/dobles, atributos en otro orden', () => {
  const r = RT.fromGPX(GPX_ELE, {});
  assert.strictEqual(r.name, 'Cuesta');
  assert.ok(r.distanceM > 1900 && r.distanceM < 2100, r.distanceM);
  assert.strictEqual(r.synthetic, false);
  assert.strictEqual(r.terrain, null);
  assert.strictEqual(r.source, 'GPX cargado por el usuario');
  assert.ok(!r.flat);
  assert.ok(r.gainM > 150 && r.gainM < 220, r.gainM);
  assert.ok(r.minEleM >= 500 && r.maxEleM <= 700);
  assert.strictEqual(r.points[0][3], 0);
  assert.ok(Math.abs(r.points[r.points.length - 1][3] - r.distanceM) < 1e-6);
  for (let i = 1; i < r.points.length - 1; i++) assert.ok(Math.abs(r.points[i][3] - r.points[i - 1][3] - 20) < 1e-6);
});
test('fromGPX sin ele => plano', () => {
  const r = RT.fromGPX(GPX_NOELE, { name: 'Plana' });
  assert.strictEqual(r.flat, true);
  assert.strictEqual(r.gainM, 0);
  assert.strictEqual(r.maxEleM, 0);
  assert.strictEqual(r.name, 'Plana');
});
test('fromGPX rtept', () => {
  const r = RT.fromGPX(GPX_RTE, { name: 'R' });
  assert.ok(r.distanceM > 1000 && r.distanceM < 1200);
  assert.ok(r.gainM > 0);
});
test('fromGPX errores en español', () => {
  assert.throws(() => RT.fromGPX('<gpx></gpx>', {}), /El archivo GPX no tiene puntos de recorrido/);
  assert.throws(() => RT.fromGPX('', {}), /no tiene puntos/);
  assert.throws(() => RT.fromGPX('<gpx><trkpt lat="1" lon="1"/></gpx>', {}), /recorrido suficiente/);
});
test('GPX real Alpe d\'Huez', () => {
  const txt = fs.readFileSync(path.join(__dirname, '..', 'tools', 'alpe_d_huez_source.gpx'), 'utf8');
  const r = RT.fromGPX(txt, { name: "Alpe d'Huez" });
  assert.ok(r.distanceM > 10000, r.distanceM);
  assert.ok(r.gainM > 0 && r.maxEleM > r.minEleM);
  assert.ok(r.points.length > 500);
  const p = RT.profile(r, 50);
  assert.strictEqual(p.length, 50);
  assert.strictEqual(p[0].distM, 0);
  assert.ok(Math.abs(p[49].distM - r.distanceM) < 1e-6);
});
test('sampleAt: interpolación, gradiente, clamp, heading', () => {
  const r = RT.fromGPX(GPX_ELE, {});
  const s = RT.sampleAt(r, 1000);
  assert.ok(s.gradePct > 8 && s.gradePct < 12, s.gradePct);
  assert.ok(s.ele > 540 && s.ele < 660);
  assert.ok(Math.abs(s.headingRad) < 0.01); // norte
  assert.strictEqual(RT.sampleAt(r, -50).index, 0);
  const end = RT.sampleAt(r, 1e9);
  assert.ok(Math.abs(end.ele - r.points[r.points.length - 1][2]) < 1e-9);
  const mid = RT.sampleAt(r, 30);
  assert.strictEqual(mid.index, 1);
  assert.ok(Math.abs(mid.t - 0.5) < 1e-9);
});
test('toLocalXY: x este, z = -norte, origen en el centro del bbox', () => {
  const r = RT.fromGPX(GPX_ELE, {});
  const L = RT.toLocalXY(r);
  assert.ok(Math.abs(L.origin.lat - -33.391) < 1e-9);
  const a = L.project(-33.40, -70.60), b = L.project(-33.382, -70.60);
  assert.ok(a.z > 0 && b.z < 0, 'norte => z negativo');
  assert.ok(Math.abs(b.z - a.z + 2000) < 20);
  const e = L.project(-33.391, -70.59);
  assert.ok(e.x > 900 && e.x < 1000 && Math.abs(e.z) < 1e-6);
  const c = L.project(L.origin.lat, L.origin.lon);
  assert.ok(Math.abs(c.x) < 1e-9 && Math.abs(c.z) < 1e-9);
  // con terrain.bbox usa su centro
  const r2 = Object.assign({}, r, { terrain: { bbox: [-70.7, -33.5, -70.5, -33.3] } });
  assert.ok(Math.abs(RT.toLocalXY(r2).origin.lon - -70.6) < 1e-9 && Math.abs(RT.toLocalXY(r2).origin.lat - -33.4) < 1e-9);
});
test('registro: chilenas primero', () => {
  RT.register({ id: 'a', country: 'Francia', points: [], distanceM: 0 });
  RT.register({ id: 'b', country: 'Chile', points: [], distanceM: 0 });
  RT.register({ id: 'c', country: 'Chile', points: [], distanceM: 0 });
  assert.deepStrictEqual(RT.list().map((x) => x.id), ['b', 'c', 'a']);
  assert.strictEqual(RT.get('a').id, 'a');
  assert.strictEqual(RT.get('zz'), null);
  assert.strictEqual(RT.registry.b.country, 'Chile');
});
test('proceduralTerrain: forma, determinismo, sigue la elevación cerca del camino', () => {
  const r = RT.fromGPX(GPX_ELE, {});
  const t = RT.proceduralTerrain(r, { size: 64, seed: 7 });
  assert.strictEqual(t.width, 64); assert.strictEqual(t.height, 64);
  assert.strictEqual(t.texture, null); assert.strictEqual(t.procedural, true);
  assert.strictEqual(Buffer.from(t.heights, 'base64').length, 64 * 64 * 2);
  assert.ok(t.maxEle > t.minEle);
  const t2 = RT.proceduralTerrain(r, { size: 64, seed: 7 });
  assert.strictEqual(t2.heights, t.heights);
  assert.notStrictEqual(RT.proceduralTerrain(r, { size: 64, seed: 8 }).heights, t.heights);
  // bbox contiene la ruta con margen y mínimo 1.5 km
  const [x0, y0, x1, y1] = t.bbox;
  assert.ok(x0 < -70.6 && x1 > -70.6 && y0 < -33.4 && y1 > -33.382);
  assert.ok((y1 - y0) * 111195 >= 1.7 * 2000 - 50);
  // altura en el punto central de la ruta cercana a su elevación (600 m)
  const buf = Buffer.from(t.heights, 'base64');
  const col = Math.round((-70.6 - x0) / (x1 - x0) * 63), row = Math.round((y1 - -33.391) / (y1 - y0) * 63);
  const q = buf.readUInt16LE((row * 64 + col) * 2);
  const ele = t.minEle + (q / 65535) * (t.maxEle - t.minEle);
  assert.ok(Math.abs(ele - 600) < 60, ele);
});
