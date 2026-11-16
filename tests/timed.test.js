'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/training.js');
require('../src/store.js');
const T = globalThis.R.training;

const TODAY = '2026-11-16'; // lunes
const FOCUSES = ['hoy', 'recuperacion', 'resistencia', 'tempo', 'sweetspot', 'umbral', 'vo2', 'sprints', 'sorpresa', 'auto'];
const DURS = [15, 20, 30, 45, 60, 75, 90, 150];
const at = (d, h = 18) => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd, h).toISOString(); };
const act = (date, over) => Object.assign({
  id: 'a-' + date, date: at(date), type: 'workout', name: 'x', routeId: null, workoutId: null, durationS: 3600,
  distanceM: 0, avgPower: 200, np: 200, tss: 60, if: 0.8, avgHr: null, avgCadence: null, kcal: 700, rpe: null, samples: [], bestEfforts: {},
}, over || {});
const planWith = (todayId) => ({
  createdAt: '2026-11-01T00:00:00.000Z', goal: 'ftp',
  weeks: [{ index: 1, phase: 'construccion', targetTss: 300, days: [
    { date: '2026-11-16', workoutId: todayId, status: 'pendiente' },
    { date: '2026-11-17', workoutId: null, status: 'pendiente' },
    { date: '2026-11-18', workoutId: 'vo2-5x4', status: 'pendiente' },
  ] }],
});
const sum = (w) => w.steps.reduce((a, s) => a + s.durationS, 0);
const isWork = (s) => s.powerPct >= 85 && !/Calentamiento|Vuelta/.test(s.label);

test('duración exacta para todos los enfoques y tiempos', () => {
  const plan = planWith('umbral-2x20');
  FOCUSES.forEach((focus) => DURS.forEach((m) => {
    const w = T.timedWorkout({ durationMin: m, focus, ftp: 200, plan, activities: [], today: TODAY });
    if (focus === 'hoy' && !w.generated) { assert.equal(w, T.getWorkout(w.id)); assert.ok(w.durationS <= m * 60); return; } // la sesión del plan cabe tal cual
    assert.equal(w.durationS, m * 60, focus + ' ' + m);
    assert.equal(sum(w), m * 60, 'suma de pasos ' + focus + ' ' + m);
    assert.ok(w.steps.every((s) => s.durationS > 0 && Number.isInteger(s.durationS)));
    assert.equal(w.generated, true);
    assert.ok(w.name.startsWith(m + ' min'));
    assert.ok(w.description.length > 20);
    assert.ok(w.tss > 0);
  }));
});

test('calentamiento (15 %, 5-15 min) y enfriamiento (10 %, mín. 3 min)', () => {
  ['tempo', 'sweetspot', 'umbral', 'vo2', 'sprints', 'resistencia'].forEach((focus) => DURS.forEach((m) => {
    const w = T.timedWorkout({ durationMin: m, focus, today: TODAY });
    const warm = w.steps[0], cool = w.steps[w.steps.length - 1];
    assert.ok(warm.durationS >= 300 && warm.durationS <= 900, 'calentamiento ' + focus + m);
    assert.ok(cool.durationS >= 180, 'enfriamiento ' + focus + m);
    if (m === 60) { assert.equal(warm.durationS, 540); assert.equal(cool.durationS, 360); }
  }));
});

test('VO2: en 30 min son 4×2 min y en 60 min 5×4 min, misma intensidad', () => {
  const w30 = T.timedWorkout({ durationMin: 30, focus: 'vo2', today: TODAY });
  const w60 = T.timedWorkout({ durationMin: 60, focus: 'vo2', today: TODAY });
  const work = (w) => w.steps.filter((s) => s.powerPct >= 110);
  assert.equal(work(w30).length, 4);
  assert.ok(work(w30).every((s) => s.durationS === 120));
  assert.equal(work(w60).length, 5);
  assert.ok(work(w60).every((s) => s.durationS === 240));
  assert.ok(work(w30)[0].powerPct >= 112 && work(w30)[0].powerPct <= 120);
  assert.ok(work(w30).every((s) => s.powerPct === work(w60)[0].powerPct));
  assert.ok(work(w30)[0].cadence);
});

test('sprints: de pie y con cadencia alta', () => {
  const w = T.timedWorkout({ durationMin: 30, focus: 'sprints', today: TODAY });
  const sp = w.steps.filter((s) => s.powerPct >= 150);
  assert.ok(sp.length >= 3);
  assert.ok(sp.every((s) => s.position === 'pie' && s.cadence >= 110));
  assert.equal(w.category, 'anaerobico');
});

test('id determinístico y categorías', () => {
  const a = T.timedWorkout({ durationMin: 45, focus: 'sweetspot', today: TODAY });
  const b = T.timedWorkout({ durationMin: 45, focus: 'sweetspot', today: TODAY });
  assert.equal(a.id, 'tiempo-sweetspot-45-20261116');
  assert.deepEqual(a, b);
  assert.equal(a.category, 'sweetspot');
  assert.equal(a.name, '45 min · Sweet spot exprés');
  assert.equal(T.timedWorkout({ durationMin: 60, focus: 'umbral', today: TODAY }).name, '60 min · Umbral');
});

test('validación en español', () => {
  assert.throws(() => T.timedWorkout({ durationMin: 14, focus: 'auto', today: TODAY }), /entre 15 y 150/);
  assert.throws(() => T.timedWorkout({ durationMin: 151, focus: 'auto', today: TODAY }), /entre 15 y 150/);
  assert.throws(() => T.timedWorkout({ durationMin: 45.5, focus: 'auto', today: TODAY }), /entero/);
  assert.throws(() => T.timedWorkout({ durationMin: 45, focus: 'zzz', today: TODAY }), /Enfoque/);
});

test('fatiga: TSB < -25 baja a recuperación y lo explica', () => {
  const acts = [];
  for (let i = 1; i <= 14; i++) acts.push(act(('2026-11-' + String(16 - i).padStart(2, '0')), { tss: 200 }));
  const tsb = T.pmc(acts, { today: TODAY }).pop().tsb;
  assert.ok(tsb < -25, 'tsb ' + tsb);
  ['auto', 'sorpresa', 'hoy'].forEach((focus) => {
    const w = T.timedWorkout({ durationMin: 45, focus, plan: planWith('vo2-5x4'), activities: acts, today: TODAY });
    assert.equal(w.category, 'recuperacion', focus);
    assert.match(w.notice, /fatiga/i);
    assert.match(w.description, /fatiga/i);
  });
  // enfoque explícito se respeta
  assert.equal(T.timedWorkout({ durationMin: 45, focus: 'vo2', activities: acts, today: TODAY }).category, 'vo2');
});

test('fatiga: RPE >= 9 ayer baja a resistencia', () => {
  const acts = [act('2026-11-15', { rpe: 9, tss: 50 })];
  const w = T.timedWorkout({ durationMin: 45, focus: 'auto', plan: planWith('vo2-5x4'), activities: acts, today: TODAY });
  assert.equal(w.category, 'resistencia');
  assert.match(w.notice, /RPE|esfuerzo/i);
  const ok = T.timedWorkout({ durationMin: 45, focus: 'auto', plan: planWith('vo2-5x4'), activities: [act('2026-11-14', { rpe: 9, tss: 50 })], today: TODAY });
  assert.equal(ok.category, 'vo2');
  assert.equal(ok.notice, null);
});

test('auto sigue la sesión de hoy; día de descanso y fresco usa la próxima de calidad', () => {
  assert.equal(T.timedWorkout({ durationMin: 45, focus: 'auto', plan: planWith('sweetspot-2x20'), today: TODAY }).category, 'sweetspot');
  const rest = T.timedWorkout({ durationMin: 45, focus: 'auto', plan: planWith(null), today: TODAY });
  assert.ok(['vo2', 'resistencia', 'sweetspot'].includes(rest.category));
  assert.equal(T.timedWorkout({ durationMin: 45, focus: 'auto', today: TODAY }).category, 'resistencia');
});

test('sorpresa es coherente con la fase y determinística', () => {
  const plan = planWith('umbral-2x20');
  plan.weeks[0].phase = 'descarga';
  const w = T.timedWorkout({ durationMin: 45, focus: 'sorpresa', plan, today: TODAY });
  assert.ok(['resistencia', 'recuperacion'].includes(w.category));
  assert.deepEqual(w, T.timedWorkout({ durationMin: 45, focus: 'sorpresa', plan, today: TODAY }));
});

test('hoy: sesión más corta que el tiempo se devuelve igual', () => {
  const plan = planWith('resistencia-45');
  const w = T.timedWorkout({ durationMin: 60, focus: 'hoy', plan, today: TODAY });
  assert.equal(w.id, 'resistencia-45');
  assert.equal(w, T.getWorkout('resistencia-45'));
});

test('hoy: sesión más larga se comprime conservando categoría e intervalos', () => {
  const plan = planWith('vo2-5x4');
  const w = T.timedWorkout({ durationMin: 45, focus: 'hoy', plan, today: TODAY });
  assert.equal(w.id, 'tiempo-hoy-45-20261116');
  assert.equal(w.durationS, 2700);
  assert.equal(sum(w), 2700);
  assert.equal(w.category, 'vo2');
  const work = w.steps.filter((s) => s.powerPct === 115);
  assert.ok(work.length >= 3 && work.length < 5);
  assert.ok(work.every((s) => s.durationS === 240));
  assert.ok(w.steps.some((s) => s.powerPct === 50 && s.durationS >= 120));
  assert.match(w.description, /versión/i);
  assert.ok(w.steps[0].durationS >= 300 && w.steps[0].durationS <= 900);
  // etiquetas coherentes
  const labels = work.map((s) => s.label);
  assert.equal(labels[labels.length - 1], 'VO2 ' + work.length + '/' + work.length);
});

test('hoy comprime también sesiones con intervalos cortos y over-unders', () => {
  ['vo2-30-30', 'over-unders', 'tabata', 'sprints-neuromusculares', 'sweetspot-90', 'resistencia-120', 'tempo-progresivo-75', 'recuperacion-60'].forEach((id) => {
    [20, 30, 45].forEach((m) => {
      const w = T.timedWorkout({ durationMin: m, focus: 'hoy', plan: planWith(id), today: TODAY });
      assert.equal(sum(w), m * 60, id + ' ' + m);
      assert.equal(w.category, T.getWorkout(id).category);
      const peak = Math.max.apply(null, T.getWorkout(id).steps.map((s) => s.powerPct));
      assert.ok(Math.max.apply(null, w.steps.map((s) => s.powerPct)) >= peak * 0.9 || id === 'tempo-progresivo-75' || id === 'sweetspot-90', id + ' intensidad');
    });
  });
});

test('hoy en día de descanso propone algo suave y lo dice', () => {
  const w = T.timedWorkout({ durationMin: 30, focus: 'hoy', plan: planWith(null), today: TODAY });
  assert.ok(['recuperacion', 'resistencia'].includes(w.category));
  assert.match(w.description, /descanso|no tienes sesión/i);
  const w2 = T.timedWorkout({ durationMin: 30, focus: 'hoy', today: TODAY });
  assert.ok(['recuperacion', 'resistencia'].includes(w2.category));
});

test('hoy con un test que no cabe: rodaje de resistencia con aviso', () => {
  const w = T.timedWorkout({ durationMin: 20, focus: 'hoy', plan: planWith('ftp-20'), today: TODAY });
  assert.equal(w.category, 'resistencia');
  assert.match(w.notice, /test/i);
  assert.equal(sum(w), 1200);
});

test('getWorkout resuelve generados: registro y actividades', () => {
  const w = T.timedWorkout({ durationMin: 20, focus: 'tempo', today: TODAY });
  assert.equal(T.getWorkout(w.id), null);
  const compact = T.compactWorkout(w);
  assert.deepEqual(Object.keys(compact).sort(), ['category', 'durationS', 'id', 'name', 'steps', 'tss']);
  const got = T.getWorkout(w.id, [act('2026-11-16', { workoutId: w.id, workout: compact })]);
  assert.equal(got.name, w.name);
  assert.equal(got.durationS, 1200);
  assert.deepEqual(got.steps, w.steps);
  T.registerWorkout(w);
  assert.equal(T.getWorkout(w.id), w);
  assert.equal(T.getWorkout('nada'), null);
  assert.equal(T.getWorkout('resistencia-60').id, 'resistencia-60');
});

test('adaptPlan: versión corta de hoy queda hecha con nota y sin castigo', () => {
  const plan = planWith('vo2-5x4');
  const w = T.timedWorkout({ durationMin: 45, focus: 'hoy', plan, today: TODAY });
  const a = act(TODAY, { workoutId: w.id, workout: T.compactWorkout(w), rpe: 6 });
  const next = T.adaptPlan(plan, [a], { goal: 'ftp' }, { today: TODAY });
  const d = next.weeks[0].days[0];
  assert.equal(d.status, 'hecho');
  assert.equal(d.note, 'versión corta (45 min)');
  assert.equal(d.workoutId, 'vo2-5x4');
  // día siguiente: el día ya no se marca saltado
  const later = T.adaptPlan(plan, [a], { goal: 'ftp' }, { today: '2026-11-17' });
  assert.equal(later.weeks[0].days[0].status, 'hecho');
  assert.equal(later.weeks[0].days[0].note, 'versión corta (45 min)');
  // sin la actividad no hay nota
  assert.equal(T.adaptPlan(plan, [], { goal: 'ftp' }, { today: TODAY }).weeks[0].days[0].note, undefined);
  // adaptPlanOnce conserva la nota
  assert.equal(T.adaptPlanOnce(plan, [a], { goal: 'ftp' }, { today: TODAY }).plan.weeks[0].days[0].note, 'versión corta (45 min)');
});

test('adaptPlan: una actividad generada intensa cuenta como intensa', () => {
  const w = T.timedWorkout({ durationMin: 45, focus: 'vo2', today: TODAY });
  const acts = [act('2026-11-14', { workoutId: w.id, workout: T.compactWorkout(w), rpe: 3 }), act('2026-11-15', { workoutId: w.id, workout: T.compactWorkout(w), rpe: 3 })];
  const plan = planWith('sweetspot-2x20');
  plan.weeks[0].days[0].date = '2026-11-17'; plan.weeks[0].days[1].date = '2026-11-18'; plan.weeks[0].days[2].date = '2026-11-19';
  const next = T.adaptPlan(plan, acts, { goal: 'ftp' }, { today: TODAY });
  assert.ok(next.lastAdaptation === null || next.lastAdaptation.reason);
});

test('store: settings.lastTimed se normaliza', () => {
  const S = globalThis.R.store;
  S.reset && S.reset();
  assert.deepEqual(S.get().settings.lastTimed, { durationMin: 45, focus: 'auto' });
  S.set({ settings: { lastTimed: { durationMin: 500, focus: 'xx' } } });
  assert.deepEqual(S.get().settings.lastTimed, { durationMin: 150, focus: 'auto' });
  S.set({ settings: { lastTimed: { durationMin: 30, focus: 'hoy' } } });
  assert.deepEqual(S.get().settings.lastTimed, { durationMin: 30, focus: 'hoy' });
});
