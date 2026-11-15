'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../src/physics.js');
require('../src/routes.js');
require('../src/riders.js');
const R = globalThis.R;

const GPX = `<gpx><trk><trkseg><trkpt lat="-33.40" lon="-70.60"><ele>500</ele></trkpt><trkpt lat="-33.38" lon="-70.60"><ele>650</ele></trkpt></trkseg></trk></gpx>`;
const route = R.routes.register(R.routes.fromGPX(GPX, { name: 'T', id: 't1' }));

test('ghost interpola, boost y meta', () => {
  const best = { splits: [[100, 10], [200, 25], [300, 40]] };
  const g = R.riders.createGhost(best, {});
  assert.strictEqual(g.distAt(0), 0);
  assert.ok(Math.abs(g.distAt(5) - 50) < 1e-9);
  assert.ok(Math.abs(g.distAt(17.5) - 150) < 1e-9);
  assert.strictEqual(g.distAt(1000), 300);
  const b = R.riders.createGhost(best, { boostPct: 2 });
  assert.ok(Math.abs(b.distAt(10 / 1.02) - 100) < 1e-9);
  assert.ok(b.distAt(20) > g.distAt(20));
  assert.strictEqual(b.distAt(40 / 1.02 + 1), 300);
});
function run(seed, count = 6) {
  const bots = R.riders.createBots({ count, ftp: 250, massKg: 80, route, seed });
  for (let t = 0; t < 200; t++) bots.forEach((b) => b.update(1, t));
  return bots;
}
test('bots: forma, nombres únicos, determinismo por seed', () => {
  const a = run(5), b = run(5), c = run(6);
  assert.strictEqual(a.length, 6);
  assert.strictEqual(new Set(a.map((x) => x.name)).size, 6);
  a.forEach((x) => { assert.strictEqual(x.color, '#7FA7C9'); assert.strictEqual(x.kind, 'bot'); assert.ok(x.distM > 0 && x.distM <= route.distanceM); });
  assert.deepStrictEqual(a.map((x) => [x.name, x.distM]), b.map((x) => [x.name, x.distM]));
  assert.notDeepStrictEqual(a.map((x) => x.distM), c.map((x) => x.distM));
});
test('bots: potencia entre 0.75 y 1.15 FTP, sube en pendiente, no pasan la meta', () => {
  const bots = R.riders.createBots({ count: 8, ftp: 200, massKg: 80, route, seed: 3 });
  let climbSeen = false;
  for (let t = 0; t < 5000; t++) bots.forEach((b) => {
    b.update(1, t);
    if (b.powerW) { assert.ok(b.powerW >= 150 - 1e-9 && b.powerW <= 230 + 1e-9, b.powerW); climbSeen = true; }
  });
  assert.ok(climbSeen);
  bots.forEach((b) => assert.ok(b.distM <= route.distanceM));
  assert.strictEqual(bots.length, 8);
  // misma seed, ruta llana vs. cuesta: mayor potencia en cuesta
  const flat = R.routes.fromGPX(`<gpx><trkpt lat="-33.4" lon="-70.6"/><trkpt lat="-33.38" lon="-70.6"/></gpx>`, { id: 'f' });
  const bu = R.riders.createBots({ count: 1, ftp: 200, massKg: 80, route, seed: 9 })[0];
  const bf = R.riders.createBots({ count: 1, ftp: 200, massKg: 80, route: flat, seed: 9 })[0];
  bu.update(1, 0); bf.update(1, 0);
  assert.ok(Math.abs(bu.powerW / bf.powerW - 1.05) < 1e-6, bu.powerW / bf.powerW);
});
const mk = (speed, dur, id) => { const s = []; for (let t = 0; t <= dur; t++) s.push([t, 200, null, null, speed, t * speed, 0]); return { id, routeId: 't1', samples: s, distanceM: dur * speed, durationS: dur }; };
test('splitsFromSamples cada 100 m', () => {
  const sp = R.riders.splitsFromSamples(mk(5, 100).samples);
  assert.deepStrictEqual(sp.slice(0, 3), [[100, 20], [200, 40], [300, 60]]);
  assert.deepStrictEqual(sp[sp.length - 1], [500, 100]);
});
test('updateBest: completa, mejora, ignora incompletas', () => {
  const len = route.distanceM;
  const slow = mk(5, Math.ceil(len / 5) + 1, 'a'); // completa
  let r = R.riders.updateBest({}, 't1', slow);
  assert.ok(r.improved && r.bests.t1.activityId === 'a' && r.bests.t1.splits.length > 10);
  const fast = mk(8, Math.ceil(len / 8) + 1, 'b');
  const r2 = R.riders.updateBest(r.bests, 't1', fast);
  assert.ok(r2.improved && r2.bests.t1.activityId === 'b' && r2.deltaS > 0);
  assert.strictEqual(r.bests.t1.activityId, 'a'); // no muta
  const r3 = R.riders.updateBest(r2.bests, 't1', slow);
  assert.ok(!r3.improved && r3.bests.t1.activityId === 'b' && r3.deltaS < 0);
  const partial = mk(20, 50, 'c'); // 1000 m < ruta
  assert.ok(partial.distanceM < len);
  const r4 = R.riders.updateBest({}, 't1', partial);
  assert.ok(!r4.improved && !r4.bests.t1);
});
test('ranking ordena y calcula brecha', () => {
  const rk = R.riders.ranking([{ id: 'a', distM: 100, speedMps: 10 }, { id: 'b', distM: 300 }, { id: 'c', distM: 200, speedMps: 5 }]);
  assert.deepStrictEqual(rk.map((r) => r.id), ['b', 'c', 'a']);
  assert.strictEqual(rk[0].gapS, 0);
  assert.ok(Math.abs(rk[1].gapS - 20) < 1e-9 && Math.abs(rk[2].gapS - 20) < 1e-9);
});

test('updateBest ignora el enfriamiento posterior a la meta e interpola el cruce', () => {
  const len = route.distanceM;
  const v = 7, tFin = len / v; // cruza entre muestras
  const s = [];
  for (let t = 0; t <= Math.ceil(tFin) + 300; t++) s.push([t, 200, null, null, v, Math.min(t * v, len + 3 * 20 + (t - Math.ceil(tFin)) * 1), 0]);
  const act = { id: 'cool', routeId: 't1', samples: s };
  const r = R.riders.updateBest({}, 't1', act);
  assert.ok(r.improved);
  assert.ok(Math.abs(r.bests.t1.totalTimeS - tFin) < 1.5, `${r.bests.t1.totalTimeS} vs ${tFin}`);
  const sp = r.bests.t1.splits;
  assert.ok(sp[sp.length - 1][0] <= len + 1e-6 && sp[sp.length - 1][1] < tFin + 1.5);
});
test('createBots valida ftp, masa y ruta; update no depende de this', () => {
  assert.throws(() => R.riders.createBots({ massKg: 80, route }), /FTP/);
  assert.throws(() => R.riders.createBots({ ftp: 200, route }), /masa/);
  const b = R.riders.createBots({ count: 1, ftp: 200, massKg: 80, route, seed: 1 })[0];
  const { update } = b;
  update(1, 0); update(1, 1);
  assert.ok(b.distM > 0);
});
