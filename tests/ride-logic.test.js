'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../src/physics.js');
require('../src/routes.js');
require('../src/training.js');
require('../src/riders.js');
require('../src/ui/ride.js');
const L = globalThis.R.rideLogic;
const R = globalThis.R;

// Fantasma: 100 m cada 10 s (10 m/s) durante 1000 m
const ghost = R.riders.createGhost({ splits: Array.from({ length: 10 }, (_, i) => [(i + 1) * 100, (i + 1) * 10]) }, {});

test('formato de tiempo y brecha', () => {
  assert.strictEqual(L.fmtTime(83), '1:23');
  assert.strictEqual(L.fmtTime(3725), '1:02:05');
  assert.strictEqual(L.fmtGap(12), '+12 s');
  assert.strictEqual(L.fmtGap(-8), '−8 s');
  assert.strictEqual(L.fmtGap(0.2), '0 s');
  assert.strictEqual(L.fmtGap(125), '+2:05');
});

test('brecha con el fantasma: + detrás, − por delante', () => {
  // el fantasma llega a 500 m en t=50
  assert.ok(Math.abs(L.ghostTimeAt(ghost, 500) - 50) < 0.01);
  assert.ok(Math.abs(L.ghostGapS(ghost, 500, 62) - 12) < 0.01);   // llegó en 62 s: 12 s detrás
  assert.ok(Math.abs(L.ghostGapS(ghost, 500, 42) + 8) < 0.01);    // llegó en 42 s: 8 s adelante
  assert.strictEqual(L.ghostGapS(null, 1, 1), null);
  // más allá de la meta del fantasma: tiempo total del fantasma
  assert.ok(Math.abs(L.ghostGapS(ghost, 1000, 95) + 5) < 0.01);
});

test('fantasma con boost: la brecha usa el tiempo reforzado', () => {
  const g = R.riders.createGhost({ splits: [[500, 50], [1000, 100]] }, { boostPct: 10 });
  assert.ok(Math.abs(L.ghostTimeAt(g, 500) - 50 / 1.1) < 0.01);
});

test('muestreo a 1 Hz sin huecos ni duplicados', () => {
  const s = L.createSampler();
  s.advance(0, { powerW: 100, distM: 0, speedMps: 0 });
  assert.strictEqual(s.samples.length, 1);
  s.advance(0.5, { powerW: 100, distM: 2, speedMps: 4 });
  assert.strictEqual(s.samples.length, 1);
  s.advance(1.01, { powerW: 200, hr: 120.4, cadence: 90, distM: 8, speedMps: 8, eleM: 700 });
  assert.strictEqual(s.samples.length, 2);
  assert.deepStrictEqual(s.samples[1], [1, 200, 120, 90, 8, 8, 700]);
  // salto (pestaña oculta): 3 s de golpe, distancia interpolada
  s.advance(4.2, { powerW: 150, distM: 38, speedMps: 10 });
  assert.strictEqual(s.samples.length, 5);
  assert.deepStrictEqual(s.samples.map((x) => x[0]), [0, 1, 2, 3, 4]);
  assert.strictEqual(s.samples[2][5], 18);
  assert.strictEqual(s.samples[4][5], 38);
  assert.strictEqual(s.samples[4][2], null);
});

test('mensajes por evento: intervalo, fantasma, km y último km', () => {
  const d = L.createEventDetector({ mode: 'route', totalDistM: 3500 });
  let m = d.update({ tS: 0, distM: 0, step: null, ghostGapS: 0 });
  assert.strictEqual(m[0].key, 'start');
  assert.deepStrictEqual(d.update({ tS: 5, distM: 30, step: null, ghostGapS: 4 }), []);
  m = d.update({ tS: 60, distM: 900, step: null, ghostGapS: -3 });
  assert.deepStrictEqual(m.map((x) => x.key), ['ghost-pass']);
  assert.deepStrictEqual(d.update({ tS: 61, distM: 920, step: null, ghostGapS: -0.5 }), []); // banda muerta
  m = d.update({ tS: 70, distM: 1001, step: null, ghostGapS: -5 });
  assert.deepStrictEqual(m.map((x) => x.key), ['km']);
  assert.match(m[0].text, /Kilómetro 1 en 1:10/);
  m = d.update({ tS: 200, distM: 2600, step: null, ghostGapS: 3 });
  assert.ok(m.some((x) => x.key === 'last-km'));
  assert.ok(m.some((x) => x.key === 'ghost-lost'));
  assert.ok(!m.some((x) => x.key === 'km'), 'km y último km coinciden: gana el último km');
  assert.ok(!d.update({ tS: 210, distM: 2700, step: null, ghostGapS: 3 }).some((x) => x.key === 'last-km'), 'el último km se anuncia una vez');
});

test('mensajes de intervalo en entrenamientos', () => {
  const d = L.createEventDetector({ mode: 'workout', totalDistM: 0 });
  const st = (i, last) => ({ index: i, label: 'Intervalo ' + i, watts: 250, durationS: 300, isLast: !!last });
  let m = d.update({ tS: 0, distM: 0, step: st(0), ghostGapS: null });
  assert.strictEqual(m[0].key, 'step-first');
  assert.match(m[0].text, /250 W durante 5 min/);
  assert.deepStrictEqual(d.update({ tS: 10, distM: 50, step: st(0), ghostGapS: null }), []);
  assert.strictEqual(d.update({ tS: 300, distM: 900, step: st(1), ghostGapS: null })[0].key, 'step');
  assert.strictEqual(d.update({ tS: 600, distM: 1500, step: st(2, true), ghostGapS: null }).filter((x) => x.key === 'step-last').length, 1);
});

test('tabla de posiciones: ventana de 5 alrededor del usuario', () => {
  const riders = Array.from({ length: 9 }, (_, i) => ({ id: i === 6 ? 'user' : 'r' + i, distM: 1000 - i * 10, speedMps: 8 }));
  const ranked = R.riders.ranking(riders);
  const w = L.windowAround(ranked, 'user', 5);
  assert.strictEqual(w.length, 5);
  assert.deepStrictEqual(w.map((r) => r.pos), [5, 6, 7, 8, 9]);
  assert.ok(w.some((r) => r.id === 'user'));
  const top = L.windowAround(ranked.slice(0, 3), 'user', 5);
  assert.strictEqual(top.length, 3);
  const first = L.windowAround(R.riders.ranking(riders.map((r) => (r.id === 'user' ? { ...r, distM: 5000 } : r))), 'user', 5);
  assert.deepStrictEqual(first.map((r) => r.pos), [1, 2, 3, 4, 5]);
});

test('actividad: contrato SPEC y métricas', () => {
  const s = L.createSampler();
  for (let t = 0; t <= 600; t++) s.advance(t, { powerW: 200, hr: 140, cadence: 90, speedMps: 8, distM: t * 8, eleM: 500 });
  const a = L.buildActivity({ type: 'route', name: 'Ruta X', routeId: 'x', samples: s.samples, ftp: 200 });
  assert.strictEqual(a.durationS, 601);
  assert.strictEqual(a.distanceM, 4800);
  assert.strictEqual(a.avgPower, 200);
  assert.strictEqual(a.avgHr, 140);
  assert.strictEqual(a.avgCadence, 90);
  assert.strictEqual(a.rpe, null);
  assert.strictEqual(a.workoutId, null);
  assert.ok(a.id && a.date && a.bestEfforts['60'] === 200);
  ['np', 'tss', 'if', 'kcal', 'samples', 'type', 'name'].forEach((k) => assert.ok(k in a, k));
  const z = L.zoneSeconds(a.samples, 200); // 200 W = 100 % FTP = Z4
  assert.strictEqual(z[3], 601);
  assert.strictEqual(z.reduce((x, y) => x + y, 0), 601);
});

test('flecha de pendiente', () => {
  assert.strictEqual(L.gradeArrow(5), '\u2197');
  assert.strictEqual(L.gradeArrow(-5), '\u2198');
  assert.strictEqual(L.gradeArrow(0.2), '\u2192');
});

test('entrenamiento de hoy desde el plan', () => {
  const plan = { weeks: [{ days: [{ date: '2026-11-13', workoutId: null }, { date: '2026-11-14', workoutId: 'tempo-45', status: 'pendiente' }] }] };
  assert.deepStrictEqual(L.pickTodayWorkout(plan, '2026-11-14'), { workoutId: 'tempo-45', status: 'pendiente' });
  assert.strictEqual(L.pickTodayWorkout(plan, '2026-11-13'), null);
  assert.strictEqual(L.pickTodayWorkout(null, '2026-11-14'), null);
  assert.strictEqual(L.ymd(new Date(2026, 10, 5)), '2026-11-05');
});

test('escala RPE 1-10 descriptiva', () => {
  assert.strictEqual(L.RPE_SCALE.length, 10);
  L.RPE_SCALE.forEach((x, i) => { assert.strictEqual(x.n, i + 1); assert.ok(x.label && x.desc); });
});

test('flush: cruzar la meta a mitad de segundo registra la mejor marca', () => {
  const route = { id: 'meta-test', distanceM: 1010, points: [[0, 0, 0, 0], [0, 0, 0, 1010]] };
  const make = (withFlush) => {
    const s = L.createSampler();
    let t = 0, dist = 0;
    const dt = 1 / 60;
    while (dist < route.distanceM) { // 20 m/s: cruza la meta en t = 50,5 s
      t += dt; dist = Math.min(route.distanceM, t * 20);
      s.advance(t, { powerW: 300, speedMps: 20, distM: dist });
    }
    if (withFlush) s.flush(t, { powerW: 300, speedMps: 20, distM: dist });
    return { s, t };
  };
  const mk = (s) => L.buildActivity({ id: 'a1', type: 'route', name: 'M', routeId: route.id, samples: s.samples, ftp: 250 });
  const sin = make(false);
  assert.strictEqual(R.riders.updateBest({}, route.id, mk(sin.s), route).improved, false, 'sin flush no llega a distanceM-5');
  const con = make(true);
  const res = R.riders.updateBest({}, route.id, mk(con.s), route);
  assert.strictEqual(res.improved, true);
  assert.ok(Math.abs(res.bests[route.id].totalTimeS - 50.5) < 0.1, String(res.bests[route.id].totalTimeS));
  const last = con.s.samples[con.s.samples.length - 1];
  assert.strictEqual(last[5], 1010);
  assert.ok(last[0] > con.s.samples[con.s.samples.length - 2][0]);
});

test('flush en un segundo entero solo corrige la distancia', () => {
  const s = L.createSampler();
  s.advance(0, { powerW: 1, distM: 0 });
  s.advance(1, { powerW: 1, distM: 5 });
  s.flush(1, { powerW: 1, distM: 5.4 });
  assert.strictEqual(s.samples.length, 2);
  assert.strictEqual(s.samples[1][5], 5.4);
});

test('actividad: date es el inicio de la rodada cuando se entrega', () => {
  const s = L.createSampler();
  for (let t = 0; t <= 20; t++) s.advance(t, { powerW: 150, hr: null, cadence: null, speedMps: 8, distM: t * 8, eleM: 0 });
  const start = '2026-03-04T10:00:00.000Z';
  const a = L.buildActivity({ type: 'route', name: 'X', routeId: 'x', samples: s.samples, ftp: 200, date: start });
  assert.strictEqual(a.date, start);
  assert.strictEqual(L.fmtKm(12345), '12,3');
  assert.strictEqual(L.fmtKm(1234), '1,23');
});
