'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../src/physics.js');
require('../src/routes.js');
require('../src/training.js');
const T = globalThis.R.training;

// posición (en tiempo del entrenamiento original) y pasos vecinos de cada pausa
function analyze(orig, w) {
  const pauses = [];
  let t = 0, tOrig = 0;
  w.steps.forEach((s, i) => {
    if (s.hydrate) pauses.push({ at: tOrig, prev: w.steps[i - 1], next: w.steps[i + 1], idx: i });
    else tOrig += s.durationS;
    t += s.durationS;
  });
  return { pauses, T: tOrig };
}
const inten = (s) => s && Math.max(s.powerPct, s.powerPctEnd != null ? s.powerPctEnd : s.powerPct) >= 88;

function checkInvariants(orig, w, every = 12, dur = 45) {
  const { pauses, T: tOrig } = analyze(orig, w);
  assert.strictEqual(tOrig, orig.durationS, 'el trabajo original se conserva');
  assert.strictEqual(w.durationS, orig.durationS + pauses.length * dur);
  assert.strictEqual(w.hydration.count, pauses.length);
  pauses.forEach((p) => {
    assert.ok(p.at >= 480, 'no en los primeros 8 min: ' + p.at);
    assert.ok(p.at <= orig.durationS - 300, 'no en los últimos 5 min: ' + p.at);
    assert.ok(!(inten(p.prev) && inten(p.next)), 'no corta un bloque intenso');
    const pause = w.steps[p.idx];
    assert.deepStrictEqual([pause.durationS, pause.powerPct, pause.label, pause.hydrate], [dur, 50, 'Hidratación', true]);
  });
  // los pasos no pausa suman lo mismo por categoría de potencia (la partición de pasos suaves conserva el total)
  const sum = (steps) => steps.filter((s) => !s.hydrate).reduce((a, s) => a + s.durationS * (s.powerPct + (s.powerPctEnd != null ? s.powerPctEnd : s.powerPct)), 0);
  const so = sum(orig.steps), sn = sum(w.steps);
  assert.ok(Math.abs(so - sn) / so < 1e-3, 'energía conservada');
  // separación entre pausas ~ every min (no mucho menos)
  for (let i = 1; i < pauses.length; i++) assert.ok(pauses[i].at - pauses[i - 1].at >= (every * 60) - 1);
  return pauses;
}

test('no muta el entrenamiento original', () => {
  const o = T.getWorkout('resistencia-90');
  const copy = JSON.stringify(o);
  const w = T.withHydration(o, {});
  assert.strictEqual(JSON.stringify(o), copy);
  assert.notStrictEqual(w, o);
  assert.ok(w.durationS > o.durationS);
});

test('sweet spot 3x12: pausas tras cada bloque intenso, nunca dentro', () => {
  const o = T.getWorkout('sweetspot-3x12');
  const w = T.withHydration(o, { everyMin: 12, durationS: 45 });
  const pauses = checkInvariants(o, w);
  assert.deepStrictEqual(pauses.map((p) => p.at), [22 * 60, 39 * 60, 56 * 60]);
  pauses.forEach((p) => { assert.ok(inten(p.prev)); assert.ok(!inten(p.next)); });
  assert.strictEqual(w.durationS, o.durationS + 3 * 45);
});

test('umbral 2x20 con ventanas de 10, 12 y 15 min', () => {
  const o = T.getWorkout('umbral-2x20');
  [10, 12, 15].forEach((e) => {
    const w = T.withHydration(o, { everyMin: e, durationS: 45 });
    const pauses = checkInvariants(o, w, e);
    assert.ok(pauses.length >= 2, 'every ' + e);
    pauses.forEach((p) => assert.ok(!inten(p.next) || !inten(p.prev)));
    // ningún paso intenso fue partido: mismos pasos intensos que el original
    const oi = o.steps.filter(inten).map((s) => s.durationS), ni = w.steps.filter(inten).map((s) => s.durationS);
    assert.deepStrictEqual(ni, oi);
  });
});

test('resistencia 90: pausas cada ~12 min partiendo el paso suave', () => {
  const o = T.getWorkout('resistencia-90');
  const w = T.withHydration(o, { everyMin: 12, durationS: 45 });
  const pauses = checkInvariants(o, w);
  assert.strictEqual(pauses.length, 7);
  assert.deepStrictEqual(pauses.map((p) => p.at / 60), [12, 24, 36, 48, 60, 72, 84]);
  assert.strictEqual(w.durationS, 90 * 60 + 7 * 45);
});

test('timedWorkout de 60 min', () => {
  const o = T.timedWorkout({ durationMin: 60, focus: 'sweetspot', today: '2026-11-16', activities: [] });
  const w = T.withHydration(o, { everyMin: 12, durationS: 45 });
  const pauses = checkInvariants(o, w);
  assert.ok(pauses.length >= 3);
  const w2 = T.withHydration(o, { everyMin: 15, durationS: 30 });
  checkInvariants(o, w2, 15, 30);
});

test('toda la biblioteca cumple las reglas (con 10, 12 y 15 min)', () => {
  T.library.filter((o) => o.category !== 'test').forEach((o) => {
    [10, 12, 15].forEach((e) => {
      const w = T.withHydration(o, { everyMin: e, durationS: 45 });
      checkInvariants(o, w, e);
      // ningún paso >= 106 % ni intenso fue partido
      const key = (s) => s.durationS + '/' + s.powerPct + '/' + s.powerPctEnd;
      const oi = o.steps.filter(inten).map(key), ni = w.steps.filter((s) => !s.hydrate && inten(s)).map(key);
      assert.deepStrictEqual(ni, oi, o.id);
    });
  });
});

test('workouts cortos (< 13 min útiles) y tests no reciben pausas', () => {
  const ramp = T.getWorkout('ramp-test');
  const w = T.withHydration(ramp, {});
  assert.strictEqual(w.steps.length, ramp.steps.length);
  assert.strictEqual(w.hydration.count, 0);
  const short = T.timedWorkout({ durationMin: 15, focus: 'auto', today: '2026-11-16', activities: [] });
  assert.strictEqual(T.withHydration(short, {}).hydration.count, 0);
});

test('partir un paso suave con rampa interpola la potencia', () => {
  const w0 = { id: 'x', name: 'x', category: 'resistencia', durationS: 1800, tss: 0, steps: [{ durationS: 1800, powerPct: 50, powerPctEnd: 80, label: 'Rampa' }] };
  const w = T.withHydration(w0, { everyMin: 12, durationS: 45 });
  const i = w.steps.findIndex((s) => s.hydrate);
  assert.ok(i > 0);
  assert.strictEqual(w.steps[i - 1].powerPctEnd, w.steps[i + 1].powerPct);
  assert.ok(Math.abs(w.steps[i + 1].powerPct - 62) < 1e-9); // 50 + 30·720/1800
});

test('withHydration es idempotente (no duplica pausas)', () => {
  const w1 = T.withHydration(T.getWorkout('sweetspot-3x12'), { everyMin: 12 });
  const w2 = T.withHydration(w1, { everyMin: 12 });
  assert.strictEqual(w2.steps.filter((s) => s.hydrate).length, w1.steps.filter((s) => s.hydrate).length);
  assert.strictEqual(w2.durationS, w1.durationS);
  assert.strictEqual(w2.hydration.count, w1.hydration.count);
});

test('series on/off cortas: la pausa va tras la recuperación corta, no pegada al esfuerzo', () => {
  const steps = [{ durationS: 600, powerPct: 60 }];
  for (let i = 0; i < 20; i++) steps.push({ durationS: 40, powerPct: 120 }, { durationS: 20, powerPct: 50 });
  steps.push({ durationS: 600, powerPct: 55 });
  const orig = { id: 'onoff', name: 'On/off', category: 'vo2', steps, durationS: steps.reduce((a, s) => a + s.durationS, 0) };
  const w = T.withHydration(orig, { everyMin: 12 });
  const { pauses } = analyze(orig, w);
  assert.ok(pauses.length >= 1);
  pauses.forEach((p) => {
    if (inten(p.next)) assert.ok(!inten(p.prev) && p.prev.durationS === 20 && w.steps[p.idx - 2].powerPct === 120);
  });
  assert.ok(pauses.some((p) => inten(p.next)), 'alguna pausa cae dentro de la serie');
});
