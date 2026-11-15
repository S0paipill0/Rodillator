'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../src/training.js');
require('../src/ui/stats.js');
const L = globalThis.R.statsLogic;

const flat = (watts, n, dist0 = 0, speed = 8) => Array.from({ length: n }, (_, i) => [i, watts, 140, 90, speed, dist0 + i * speed, null]);

test('periodRange: presets y "todo"', () => {
  assert.deepStrictEqual(L.periodRange('4w', '2026-11-14'), { key: '4w', label: '4 semanas', from: '2026-10-18', to: '2026-11-14', days: 28 });
  assert.strictEqual(L.periodRange('1y', '2026-11-14').days, 365);
  const all = L.periodRange('all', '2026-11-14', '2026-01-01');
  assert.strictEqual(all.from, '2026-01-01');
  assert.strictEqual(L.periodRange('all', '2026-11-14', '2026-11-10').days, 28); // mínimo 28 días
});

test('weekStart es lunes y addDays cruza meses', () => {
  assert.strictEqual(L.weekStart('2026-11-15'), '2026-11-09'); // domingo
  assert.strictEqual(L.weekStart('2026-11-09'), '2026-11-09');
  assert.strictEqual(L.addDays('2026-12-30', 3), '2027-01-02');
});

test('timeInZones: 1 Hz y muestras recortadas dan el mismo tiempo', () => {
  const s = flat(140, 100).concat(flat(230, 100).map((r) => [r[0] + 100, r[1], 0, 0, 0, 0, null])); // FTP 200: 100 W = Z2, 230 W = Z5
  const z = L.timeInZones(s, 200);
  assert.strictEqual(z[1], 100); assert.strictEqual(z[4], 100);
  assert.strictEqual(z.reduce((a, b) => a + b, 0), 200);
  const thin = s.filter((_, i) => i % 5 === 0);
  const zt = L.timeInZones(thin, 200);
  assert.strictEqual(zt.reduce((a, b) => a + b, 0), 200);
  assert.strictEqual(zt[1], 100);
  assert.deepStrictEqual(L.timeInZones([], 200), [0, 0, 0, 0, 0, 0, 0]);
});

test('timeInZones: un hueco largo no cuenta más de 30 s', () => {
  const z = L.timeInZones([[0, 100, 0, 0, 0, 0, null], [600, 100, 0, 0, 0, 0, null]], 200);
  assert.ok(z.reduce((a, b) => a + b, 0) <= 60);
});

test('weeklyAggregate: semanas lunes-domingo con semanas vacías y tiempo por zona', () => {
  const range = { from: '2026-11-02', to: '2026-11-15' };
  const acts = [
    { id: 'a', date: '2026-11-03', durationS: 100, distanceM: 1000, tss: 10, avgPower: 100, samples: flat(140, 100) },
    { id: 'b', date: '2026-11-15', durationS: 50, distanceM: 500, tss: 5, avgPower: 230, samples: flat(230, 50) }, // domingo -> semana del 9
  ];
  const w = L.weeklyAggregate(acts, range, () => 200);
  assert.strictEqual(w.length, 2);
  assert.strictEqual(w[0].weekStart, '2026-11-02'); assert.strictEqual(w[0].tss, 10); assert.strictEqual(w[0].zoneS[1], 100);
  assert.strictEqual(w[1].weekStart, '2026-11-09'); assert.strictEqual(w[1].zoneS[4], 50); assert.strictEqual(w[1].sessions, 1);
  assert.ok(Math.abs(w[0].hours - 100 / 3600) < 1e-9);
});

test('kpis y tsbState', () => {
  const k = L.kpis([{ durationS: 3600, distanceM: 30000, tss: 50, avgPower: 200 }, { durationS: 1800, distanceM: 10000, tss: 20, avgPower: 100 }], { ctl: 40, atl: 50, tsb: -10 });
  assert.strictEqual(k.hours, 1.5); assert.strictEqual(k.km, 40); assert.strictEqual(k.tss, 70); assert.strictEqual(k.kj, 900); assert.strictEqual(k.sessions, 2); assert.strictEqual(k.ctl, 40);
  assert.strictEqual(L.tsbState(12).label, 'Fresco');
  assert.strictEqual(L.tsbState(0).label, 'Óptimo');
  assert.strictEqual(L.tsbState(-10).label, 'Óptimo');
  assert.strictEqual(L.tsbState(-20).label, 'Cargado');
  assert.strictEqual(L.tsbState(-45).label, 'Sobrecarga');
});

test('ftpHistory: tests + FTP del perfil; ftpChange', () => {
  const mk = (id, date, wid, be) => ({ id, date, workoutId: wid, bestEfforts: be });
  const acts = [mk('r', '2026-09-01', 'ramp-test', { 60: 300 }), mk('t', '2026-10-01', 'ftp-20', { 1200: 240 }), mk('x', '2026-10-05', 'resistencia-60', { 1200: 400 })];
  const h = L.ftpHistory(acts, { ftp: 235 }, '2026-11-14');
  assert.deepStrictEqual(h.map((p) => p.ftp), [225, 228, 235]);
  assert.strictEqual(h[2].date, '2026-11-14');
  const c = L.ftpChange(h, '2026-09-15');
  assert.deepStrictEqual([c.base, c.delta, c.current], [225, 10, 235]);
  assert.strictEqual(L.ftpChange([], '2026-01-01'), null);
  assert.strictEqual(L.ftpHistory([], { ftp: 200 }, '2026-11-14').length, 1);
  assert.strictEqual(L.ftpAtDate(h, 235, '2026-09-20'), 225);
});

test('splitsFromSamples, timeAt y diffSplits (positivo = más lento)', () => {
  const fast = flat(200, 400, 0, 10); // 10 m/s -> 4 km
  const slow = flat(200, 440, 0, 10 * 400 / 440).map((r, i) => r); // 4 km en 440 s
  const sf = L.splitsFromSamples(fast, 100), ss = L.splitsFromSamples(slow, 100);
  assert.strictEqual(sf[0][0], 100); assert.ok(Math.abs(sf[0][1] - 10) < 1e-6);
  assert.ok(Math.abs(L.timeAt(sf, 1500) - 150) < 1e-6);
  assert.strictEqual(L.timeAt(sf, 99999), null);
  const d = L.diffSplits(sf, ss, 1000);
  assert.strictEqual(d[0].diffS, 0);
  assert.ok(d[d.length - 1].diffS > 30 && d[d.length - 1].diffS < 45);
  assert.ok(d.every((x, i) => i === 0 || x.diffS >= d[i - 1].diffS)); // ritmo constante: crece monótono
  assert.deepStrictEqual(L.diffSplits(sf, sf, 1000).every((x) => x.diffS === 0), true);
  assert.deepStrictEqual(L.diffSplits([], sf), [{ distM: 0, diffS: 0 }]);
});

test('routeRecords: mejor tiempo, intentos, mejora vs primero y comparación', () => {
  const route = { id: 'r1', name: 'Ruta 1', distanceM: 1000 };
  const mkAct = (id, date, secs) => ({ id, date, type: 'route', routeId: 'r1', durationS: secs + 20, distanceM: 1000, samples: flat(200, secs + 20, 0, 1000 / secs) });
  const acts = [mkAct('a1', '2026-10-01T10:00:00.000Z', 200), mkAct('a2', '2026-10-08T10:00:00.000Z', 170), mkAct('a3', '2026-10-15T10:00:00.000Z', 185)];
  const bests = L.computeBests(acts, () => route);
  assert.strictEqual(bests.r1.activityId, 'a2');
  assert.ok(Math.abs(bests.r1.totalTimeS - 170) < 1);
  const recs = L.routeRecords(acts, bests, () => route);
  assert.strictEqual(recs.length, 1);
  const r = recs[0];
  assert.strictEqual(r.attempts, 3); assert.strictEqual(r.best.activityId, 'a2');
  assert.ok(Math.abs(r.improvementS - 30) < 2);
  assert.strictEqual(L.pickComparison(r.list, 'a2').id, 'a3');
  assert.strictEqual(L.pickComparison(r.list.slice(0, 2), 'a2').id, 'a1');
  assert.strictEqual(L.pickComparison(r.list.slice(1, 2), 'a2'), null);
  assert.strictEqual(L.routeTime({ samples: flat(100, 50, 0, 10) }, 1000), null); // no completó
});

test('decimateSeries y bucketPmc: máximo de puntos y valores conservados', () => {
  const rows = Array.from({ length: 5000 }, (_, i) => [i, 100]);
  const d = L.decimateSeries(rows, 600, 0, 1);
  assert.ok(d.length <= 600 && d.length > 500);
  assert.ok(d.every((p) => p.y === 100));
  assert.strictEqual(L.decimateSeries(rows.slice(0, 10), 600, 0, 1).length, 10);
  const pm = Array.from({ length: 1000 }, (_, i) => ({ date: 'd' + i, tss: 1, ctl: i, atl: i, tsb: 0 }));
  const b = L.bucketPmc(pm, 600);
  assert.ok(b.length <= 600);
  assert.strictEqual(b.reduce((a, r) => a + r.tss, 0), 1000); // el TSS se conserva
  assert.strictEqual(b[b.length - 1].ctl, 999);
});

test('filterHistory: tipo, texto y orden descendente', () => {
  const acts = [{ id: '1', date: '2026-01-01', type: 'route', name: 'Alpe' }, { id: '2', date: '2026-02-01', type: 'workout', name: 'Umbral' }, { id: '3', date: '2026-03-01', type: 'route', name: 'Farellones' }];
  assert.deepStrictEqual(L.filterHistory(acts, { type: 'route' }).map((a) => a.id), ['3', '1']);
  assert.deepStrictEqual(L.filterHistory(acts, { q: 'umb' }).map((a) => a.id), ['2']);
  assert.strictEqual(L.filterHistory(acts, {}).length, 3);
});

test('generateDemo: 8 semanas coherentes, demo:true, ids reales de ruta y bests consistentes', () => {
  const d = L.generateDemo({ today: '2026-11-14', ftp: 230, weightKg: 72, seed: 7 });
  const acts = d.activities;
  assert.ok(acts.length >= 28 && acts.length <= 40);
  assert.ok(acts.every((a) => a.demo === true && a.id.startsWith('demo-') && a.samples.length === a.durationS + (a.routeId ? 0 : 0) || a.routeId));
  assert.ok(acts.every((a) => a.date.slice(0, 10) <= '2026-11-15' && a.tss > 0 && a.avgPower > 0));
  const ids = new Set(acts.filter((a) => a.routeId).map((a) => a.routeId));
  assert.deepStrictEqual([...ids].sort(), ['alpe-dhuez', 'caracoles-portillo', 'el-yeso', 'farellones', 'talagante-valle']);
  const km = { 'alpe-dhuez': 12.1, farellones: 16.7, 'caracoles-portillo': 5.4, 'el-yeso': 19.5, 'talagante-valle': 34.4 };
  acts.filter((a) => a.routeId).forEach((a) => assert.ok(a.distanceM / 1000 >= km[a.routeId] - 0.1 && a.distanceM / 1000 <= km[a.routeId] + 1.5, a.routeId));
  Object.keys(km).forEach((id) => {
    const b = d.bests[id];
    assert.ok(b, id);
    const times = acts.filter((a) => a.routeId === id).map((a) => L.routeTime(a, km[id] * 1000));
    assert.ok(Math.abs(b.totalTimeS - Math.min.apply(null, times)) < 1);
    assert.ok(Math.abs(b.splits[b.splits.length - 1][0] - km[id] * 1000) < 5);
  });
  assert.ok(acts.some((a) => a.workoutId === 'ftp-20') && acts.some((a) => a.workoutId === 'ramp-test'));
  const hist = L.ftpHistory(acts, { ftp: 230 }, '2026-11-14');
  assert.ok(hist.length >= 3 && hist[0].ftp < hist[hist.length - 1].ftp);
  // determinista
  const d2 = L.generateDemo({ today: '2026-11-14', ftp: 230, weightKg: 72, seed: 7 });
  assert.deepStrictEqual(d2.activities.map((a) => a.avgPower), acts.map((a) => a.avgPower));
});

test('powerCurveCompare: período vs histórico con fecha de la marca y W/kg', () => {
  const old = { id: 'o', date: '2026-01-10', samples: flat(300, 400) };
  const rec = { id: 'n', date: '2026-11-10', samples: flat(250, 400) };
  const c = L.powerCurveCompare([rec], [old, rec], [5, 60, 300], 75);
  assert.strictEqual(c[1].period, 250); assert.strictEqual(c[1].best, 300);
  assert.strictEqual(c[1].bestDate, '2026-01-10'); assert.strictEqual(c[1].bestWkg, 4);
});
