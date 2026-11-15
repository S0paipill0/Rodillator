'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/training.js');
const T = globalThis.R.training;

// ---------- helpers ----------
const at = (d, h = 18) => {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(y, m - 1, dd, h).toISOString();
};
const constSamples = (n, w) => Array.from({ length: n }, (_, i) => [i, w, null, null, 8, i * 8, null]);
function act(date, over) {
  return Object.assign({
    id: 'a-' + date, date: at(date), type: 'workout', name: 'x', routeId: null, workoutId: null,
    durationS: 3600, distanceM: 0, avgPower: 200, np: 200, tss: 60, if: 0.8, avgHr: null,
    avgCadence: null, kcal: 700, rpe: null, samples: [], bestEfforts: {},
  }, over || {});
}
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
}
const INTENSE = ['umbral', 'vo2', 'anaerobico'];
const wd = (s) => new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), 12).getDay();
const PREF = [2, 4, 6, 0, 1, 3, 5];
const baseProfile = {
  name: 'Ana', age: 35, weightKg: 70, level: 'intermedio', ftp: 200, ftpEstimated: false,
  goal: 'ftp', hoursPerWeek: 5, daysPerWeek: 4, weeks: 8,
};

// ---------- FTP, zonas, FC ----------
test('estimateFtp: ejemplo del brief y ajuste por edad multiplicativo', () => {
  const r = T.estimateFtp({ weightKg: 70, age: 40, level: 'intermedio' });
  assert.equal(r.ftp, 191);
  assert.ok(Math.abs(r.wkg - 191 / 70) < 0.01);
  assert.equal(T.estimateFtp({ weightKg: 70, age: 30, level: 'intermedio' }).ftp, 196);
  assert.equal(T.estimateFtp({ weightKg: 80, age: 35, level: 'competitivo' }).ftp, Math.round(4.2 * 80));
  assert.equal(T.estimateFtp({ weightKg: 60, age: 35, level: 'principiante' }).ftp, 120);
  assert.equal(T.estimateFtp({ weightKg: 75, age: 35, level: 'avanzado' }).ftp, Math.round(3.5 * 75));
  // piso 0.6
  assert.equal(T.estimateFtp({ weightKg: 100, age: 120, level: 'avanzado' }).ftp, Math.round(3.5 * 100 * 0.6));
});

test('zones: 7 zonas con nombres, colores y límites Coggan', () => {
  const z = T.zones(200);
  assert.equal(z.length, 7);
  assert.deepEqual(z.map((x) => x.zone), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(z.map((x) => x.name), ['Recuperación', 'Resistencia', 'Tempo', 'Umbral', 'VO2máx', 'Anaeróbico', 'Neuromuscular']);
  assert.deepEqual(z.map((x) => x.color), ['#8A8F98', '#3FA7D6', '#59CD90', '#FAC05E', '#F79D84', '#EE6352', '#B83280']);
  assert.deepEqual(z.map((x) => [x.minW, x.maxW]), [[0, 110], [111, 150], [151, 180], [181, 210], [211, 240], [241, 300], [301, null]]);
});

test('zoneFor: clasifica potencia en la zona correcta', () => {
  assert.equal(T.zoneFor(0, 200), 1);
  assert.equal(T.zoneFor(110, 200), 1);
  assert.equal(T.zoneFor(111, 200), 2);
  assert.equal(T.zoneFor(150, 200), 2);
  assert.equal(T.zoneFor(200, 200), 4);
  assert.equal(T.zoneFor(210, 200), 4);
  assert.equal(T.zoneFor(230, 200), 5);
  assert.equal(T.zoneFor(300, 200), 6);
  assert.equal(T.zoneFor(301, 200), 7);
  assert.equal(T.zoneFor(1200, 200), 7);
});

test('estimateMaxHr: Tanaka redondeado', () => {
  assert.equal(T.estimateMaxHr(40), 180);
  assert.equal(T.estimateMaxHr(33), 185);
  assert.equal(T.estimateMaxHr(20), 194);
});

// ---------- biblioteca ----------
test('library: >=30 entrenamientos válidos, todas las categorías, 20-120 min', () => {
  const lib = T.library;
  assert.ok(lib.length >= 30);
  assert.equal(new Set(lib.map((w) => w.id)).size, lib.length, 'ids únicos');
  const cats = ['recuperacion', 'resistencia', 'tempo', 'sweetspot', 'umbral', 'vo2', 'anaerobico', 'test'];
  for (const c of cats) assert.ok(lib.some((w) => w.category === c), 'falta categoría ' + c);
  for (const w of lib) {
    assert.ok(cats.includes(w.category), w.id);
    assert.ok(w.name && w.description, w.id);
    assert.ok(w.durationS >= 20 * 60 && w.durationS <= 120 * 60, `${w.id} duración ${w.durationS}`);
    assert.equal(w.durationS, w.steps.reduce((s, x) => s + x.durationS, 0), w.id);
    let tss = 0;
    for (const s of w.steps) {
      const avg = (s.powerPct + (s.powerPctEnd != null ? s.powerPctEnd : s.powerPct)) / 2 / 100;
      tss += (s.durationS / 3600) * avg * avg * 100;
    }
    assert.ok(Math.abs(w.tss - tss) < 0.1, `${w.id} tss ${w.tss} vs ${tss}`);
    assert.ok(w.tss > 0);
  }
});

test('library: entrenamientos exigidos existen y getWorkout los entrega', () => {
  const ids = ['ramp-test', 'ftp-20', 'recuperacion-30', 'resistencia-60', 'resistencia-90', 'resistencia-120',
    'sweetspot-3x12', 'vo2-5x4', 'umbral-2x20', 'over-unders', 'tabata', 'sprints-neuromusculares'];
  for (const id of ids) assert.equal(T.getWorkout(id).id, id);
  assert.equal(T.getWorkout('nope'), null);
  const names = T.library.map((w) => w.name);
  for (const n of ['Sweet Spot 3×12', 'VO2 5×4', 'Umbral 2×20', 'Resistencia 60', 'Resistencia 90', 'Resistencia 120',
    'Recuperación 30', 'Over-unders', 'Tabata', 'Sprints neuromusculares']) assert.ok(names.includes(n), n);
  assert.equal(T.getWorkout('resistencia-120').durationS, 7200);
  assert.equal(T.getWorkout('recuperacion-30').durationS, 1800);
});

test('ramp-test: pasos de 1 min desde 45 % subiendo 6 % hasta 150 %', () => {
  const w = T.getWorkout('ramp-test');
  assert.equal(w.category, 'test');
  const ramp = w.steps.filter((s) => s.durationS === 60 && s.powerPctEnd == null);
  assert.equal(ramp[0].powerPct, 45);
  for (let i = 1; i < ramp.length - 1; i++) assert.equal(ramp[i].powerPct - ramp[i - 1].powerPct, 6);
  assert.equal(ramp[ramp.length - 1].powerPct, 150);
  assert.ok(ramp.length >= 18);
});

test('ftp-20 incluye un esfuerzo continuo de 20 min', () => {
  const w = T.getWorkout('ftp-20');
  assert.equal(w.category, 'test');
  assert.ok(w.steps.some((s) => s.durationS === 1200));
});

// ---------- métricas ----------
test('computeMetrics: 1 h a FTP constante => NP=FTP, IF=1, TSS=100', () => {
  const m = T.computeMetrics(constSamples(3600, 250), 250);
  assert.equal(m.durationS, 3600);
  assert.equal(m.avgPower, 250);
  assert.equal(m.np, 250);
  assert.equal(m.if, 1);
  assert.ok(Math.abs(m.tss - 100) <= 0.5);
  assert.equal(m.kcal, 900); // 250 W * 3600 s = 900 kJ
});

test('computeMetrics: NP > potencia media con potencia variable', () => {
  const s = Array.from({ length: 1800 }, (_, i) => [i, Math.floor(i / 60) % 2 ? 100 : 400, null, null, 8, 0, null]);
  const m = T.computeMetrics(s, 250);
  assert.equal(m.avgPower, 250);
  assert.ok(m.np > 280, 'np=' + m.np);
  assert.ok(Math.abs(m.if - m.np / 250) < 0.01);
});

test('computeMetrics: bestEfforts por ventana y omite ventanas largas', () => {
  const samples = [];
  for (let i = 0; i < 400; i++) samples.push([i, i >= 100 && i < 160 ? 500 : 200, null, null, 8, 0, null]);
  const m = T.computeMetrics(samples, 250);
  assert.deepEqual(Object.keys(m.bestEfforts).sort(), ['300', '5', '60']);
  assert.equal(m.bestEfforts['5'], 500);
  assert.equal(m.bestEfforts['60'], 500);
  assert.equal(m.bestEfforts['300'], Math.round((60 * 500 + 240 * 200) / 300));
  const long = T.computeMetrics(constSamples(3700, 200), 250);
  assert.deepEqual(Object.keys(long.bestEfforts).sort(), ['1200', '300', '3600', '5', '60']);
});

test('computeMetrics: sin muestras devuelve ceros', () => {
  const m = T.computeMetrics([], 200);
  assert.equal(m.durationS, 0);
  assert.equal(m.tss, 0);
  assert.deepEqual(m.bestEfforts, {});
});

test('pmc: una actividad produce CTL/ATL/TSB con EWMA 42/7', () => {
  const r = T.pmc([act('2026-03-08', { tss: 100 })], { days: 120, today: '2026-03-10' });
  assert.equal(r.length, 120);
  assert.equal(r[r.length - 1].date, '2026-03-10');
  const d0 = r.find((x) => x.date === '2026-03-08');
  assert.equal(d0.tss, 100);
  assert.ok(Math.abs(d0.ctl - 100 / 42) < 0.01);
  assert.ok(Math.abs(d0.atl - 100 / 7) < 0.01);
  assert.equal(d0.tsb, 0);
  const d1 = r.find((x) => x.date === '2026-03-09');
  assert.equal(d1.tss, 0);
  assert.ok(Math.abs(d1.tsb - (100 / 42 - 100 / 7)) < 0.02);
  assert.ok(Math.abs(d1.ctl - (100 / 42) * (41 / 42)) < 0.01);
  assert.ok(Math.abs(d1.atl - (100 / 7) * (6 / 7)) < 0.01);
});

test('pmc: la carga previa a la ventana se arrastra', () => {
  const r = T.pmc([act('2025-12-01', { tss: 300 })], { days: 10, today: '2026-03-10' });
  assert.equal(r.length, 10);
  assert.ok(r[0].ctl > 0);
});

test('powerCurve: máximos de todas las actividades (muestras o bestEfforts)', () => {
  const a1 = act('2026-03-01', { id: 'a1', samples: constSamples(600, 300) });
  const a2 = act('2026-03-05', { id: 'a2', bestEfforts: { '5': 900, '300': 350 } });
  const r = T.powerCurve([a1, a2], [5, 300, 600, 1200]);
  const by = Object.fromEntries(r.map((x) => [x.durationS, x]));
  assert.equal(by[5].watts, 900);
  assert.equal(by[5].activityId, 'a2');
  assert.equal(by[300].watts, 350);
  assert.equal(by[600].watts, 300);
  assert.equal(by[600].activityId, 'a1');
  assert.equal(by[1200], undefined);
  assert.ok(T.powerCurve([a1]).length > 0);
});

test('suggestFtpUpdate: 95 % del mejor de 20 min y umbral del 2 %', () => {
  const profile = { ftp: 200 };
  const a = act('2026-03-01', { bestEfforts: { '1200': 240 } });
  const r = T.suggestFtpUpdate([a], profile, { today: '2026-03-10' });
  assert.equal(r.suggestedFtp, 228);
  assert.ok(/\S/.test(r.reason));
  // diferencia <= 2 %
  assert.equal(T.suggestFtpUpdate([act('2026-03-01', { bestEfforts: { '1200': 210 } })], profile, { today: '2026-03-10' }), null);
  // fuera de 42 días
  assert.equal(T.suggestFtpUpdate([act('2026-01-01', { bestEfforts: { '1200': 300 } })], profile, { today: '2026-03-10' }), null);
  assert.equal(T.suggestFtpUpdate([], profile, { today: '2026-03-10' }), null);
});

test('suggestFtpUpdate: 75 % del mejor minuto de un ramp-test', () => {
  const a = act('2026-03-05', { workoutId: 'ramp-test', bestEfforts: { '60': 360 } });
  const r = T.suggestFtpUpdate([a], { ftp: 200 }, { today: '2026-03-10' });
  assert.equal(r.suggestedFtp, 270);
  // un minuto fuerte fuera de un ramp-test no cuenta
  const b = act('2026-03-05', { workoutId: null, bestEfforts: { '60': 360 } });
  assert.equal(T.suggestFtpUpdate([b], { ftp: 200 }, { today: '2026-03-10' }), null);
});

test('suggestFtpUpdate: un rodaje no máximo nunca baja el FTP', () => {
  const easy = act('2026-03-05', { workoutId: 'resistencia-60', bestEfforts: { '1200': 120, '60': 150 } });
  assert.equal(T.suggestFtpUpdate([easy], { ftp: 200 }, { today: '2026-03-10' }), null);
  // un test sí puede bajarlo
  const test20 = act('2026-03-05', { workoutId: 'ftp-20', bestEfforts: { '1200': 180 } });
  assert.equal(T.suggestFtpUpdate([test20], { ftp: 200 }, { today: '2026-03-10' }).suggestedFtp, 171);
  const ramp = act('2026-03-05', { workoutId: 'ramp-test', bestEfforts: { '60': 240 } });
  assert.equal(T.suggestFtpUpdate([ramp], { ftp: 200 }, { today: '2026-03-10' }).suggestedFtp, 180);
  // un rodaje fuerte que sube el FTP sí cuenta
  const hard = act('2026-03-05', { workoutId: 'umbral-2x20', bestEfforts: { '1200': 240 } });
  assert.equal(T.suggestFtpUpdate([hard], { ftp: 200 }, { today: '2026-03-10' }).suggestedFtp, 228);
});

test('suggestFtpUpdate: elige el mejor candidato, no el más reciente', () => {
  const best = act('2026-03-01', { id: 'b', workoutId: 'ftp-20', bestEfforts: { '1200': 260 } });
  const recent = act('2026-03-08', { id: 'r', workoutId: 'ftp-20', bestEfforts: { '1200': 230 } });
  assert.equal(T.suggestFtpUpdate([best, recent], { ftp: 200 }, { today: '2026-03-10' }).suggestedFtp, 247);
});

// ---------- plan ----------
test('buildPlan: estructura, semanas por defecto y progresión de TSS por bloque', () => {
  const p = T.buildPlan({ profile: { ...baseProfile, weeks: undefined }, startDate: '2026-03-02' });
  assert.equal(p.goal, 'ftp');
  assert.equal(p.weeks.length, 8);
  assert.deepEqual(p.weeks.map((w) => w.index), [1, 2, 3, 4, 5, 6, 7, 8]);
  const t = p.weeks.map((w) => w.targetTss);
  const close = (a, b) => assert.ok(Math.abs(a - b) < 0.1, `${a} vs ${b}`);
  const t0 = 5 * 55;
  close(t[0], t0);
  close(t[1], t0 * 1.08);
  close(t[2], t0 * 1.08 * 1.08);
  assert.equal(p.weeks[3].phase, 'descarga');
  close(t[3], t[2] * 0.6);
  // el bloque 2 se reinicia: inicio x 1.05, luego +8 % por semana
  close(t[4], t0 * 1.05);
  close(t[5], t0 * 1.05 * 1.08);
  close(t[6], t0 * 1.05 * 1.08 * 1.08);
  assert.equal(p.weeks[7].phase, 'descarga');
  close(t[7], t[6] * 0.6);
  for (const w of p.weeks) {
    assert.equal(w.days.length, 7);
    assert.ok(w.days.every((d) => d.status === 'pendiente' && /^\d{4}-\d{2}-\d{2}$/.test(d.date)));
  }
  assert.equal(p.weeks[0].days[0].date, '2026-03-02');
  assert.equal(p.weeks[1].days[0].date, '2026-03-09');
  assert.equal(p.weeks[0].phase, 'base');
  assert.equal(p.weeks[4].phase, 'construccion');
});

test('buildPlan: targetTss con topes (x1.6 del inicial y realizable por horas)', () => {
  const p = T.buildPlan({ profile: { ...baseProfile, weeks: 24 }, startDate: '2026-03-02' });
  const t0 = 5 * 55;
  for (const w of p.weeks) {
    assert.ok(w.targetTss <= 4 * 85 + 0.1, `w${w.index} ${w.targetTss}`);
    assert.ok(w.targetTss <= t0 * 1.6 + 0.1, `w${w.index} ${w.targetTss}`);
    assert.ok(w.targetTss <= 5 * 1.1 * 72 + 0.1, `w${w.index} ${w.targetTss}`);
  }
  assert.ok(p.weeks[22].targetTss < 5 * 1.1 * 72 + 0.1);
  const q = T.buildPlan({ profile: { ...baseProfile, hoursPerWeek: 4, level: 'competitivo', goal: 'gran-fondo', weeks: 24 }, startDate: '2026-03-02' });
  q.weeks.forEach((w) => assert.ok(w.targetTss <= 4 * 1.1 * 72 + 0.1));
});

test('buildPlan: el TSS real persigue targetTss (+-25 %) y crece entre bloques', () => {
  const tssOf = (w) => w.days.filter((d) => d.workoutId).reduce((s, d) => s + T.getWorkout(d.workoutId).tss, 0);
  for (const goal of ['forma', 'ftp', 'evento']) {
    for (const hoursPerWeek of [5, 6, 8]) {
      const profile = { ...baseProfile, goal, hoursPerWeek, daysPerWeek: 4, weeks: 12, ftpEstimated: true, eventDate: goal === 'evento' ? '2026-05-24' : null };
      const p = T.buildPlan({ profile, startDate: '2026-03-02' });
      p.weeks.forEach((w) => {
        const real = tssOf(w);
        assert.ok(Math.abs(real - w.targetTss) / w.targetTss <= 0.25, `${goal}/${hoursPerWeek}h w${w.index} real=${real} target=${w.targetTss}`);
      });
      const mean = (a, b) => p.weeks.slice(a, b).reduce((s, w) => s + tssOf(w), 0) / (b - a);
      if (hoursPerWeek <= 5) assert.ok(mean(4, 7) > mean(0, 3), `${goal}/${hoursPerWeek}h: ${mean(4, 7)} vs ${mean(0, 3)}`);
    }
  }
});

test('buildPlan: las semanas de descarga no repiten siempre los mismos workouts', () => {
  const p = T.buildPlan({ profile: { ...baseProfile, weeks: 12 }, startDate: '2026-03-02' });
  const sets = p.weeks.filter((w) => w.phase === 'descarga').map((w) => w.days.filter((d) => d.workoutId).map((d) => d.workoutId).sort().join(','));
  assert.equal(sets.length, 3);
  assert.ok(new Set(sets).size >= 2, sets.join(' | '));
  assert.notEqual(sets[0], sets[1]);
});

test('buildPlan: gran-fondo con eventDate se comporta como evento (semanas + taper)', () => {
  const p = T.buildPlan({ profile: { ...baseProfile, goal: 'gran-fondo', eventDate: '2026-05-24', weeks: 8 }, startDate: '2026-03-02' });
  assert.equal(p.weeks.length, 12);
  assert.equal(p.weeks[11].phase, 'taper');
  assert.equal(p.weeks[8].phase, 'especifico');
});

test('buildPlan/estimateFtp: validan entradas con errores en español', () => {
  assert.throws(() => T.buildPlan({ profile: baseProfile }), /startDate/);
  assert.throws(() => T.buildPlan({ profile: baseProfile, startDate: '02/03/2026' }), /startDate/);
  assert.throws(() => T.estimateFtp({ age: 40, level: 'intermedio' }), /weightKg/);
  assert.throws(() => T.estimateFtp({ weightKg: 0, age: 40 }), /weightKg/);
});

test('buildPlan: multiplicadores por objetivo y nivel principiante', () => {
  const mk = (goal, level) => T.buildPlan({ profile: { ...baseProfile, goal, level, hoursPerWeek: 6, daysPerWeek: 7 }, startDate: '2026-03-02' }).weeks[0].targetTss;
  assert.ok(Math.abs(mk('forma', 'intermedio') - 300) < 0.1);
  assert.ok(Math.abs(mk('peso', 'intermedio') - 300) < 0.1);
  assert.ok(Math.abs(mk('ftp', 'intermedio') - 330) < 0.1);
  assert.ok(Math.abs(mk('evento', 'intermedio') - 360) < 0.1);
  assert.ok(Math.abs(mk('gran-fondo', 'intermedio') - 360) < 0.1);
  assert.ok(Math.abs(mk('ftp', 'principiante') - 330 * 0.85) < 0.1);
});

test('buildPlan: respeta días, horas y máximo 2 sesiones intensas', () => {
  for (const goal of ['forma', 'peso', 'ftp', 'evento', 'gran-fondo']) {
    for (const daysPerWeek of [2, 3, 4, 5, 6, 7]) {
      for (const hoursPerWeek of [4, 6, 9]) {
        if (daysPerWeek * 0.5 > hoursPerWeek) continue;
        const profile = { ...baseProfile, goal, daysPerWeek, hoursPerWeek, weeks: 12, ftpEstimated: true,
          eventDate: goal === 'evento' ? '2026-05-24' : null };
        const p = T.buildPlan({ profile, startDate: '2026-03-02' });
        const allowed = PREF.slice(0, daysPerWeek);
        p.weeks.forEach((w) => {
          const train = w.days.filter((d) => d.workoutId);
          const tag = `${goal}/${daysPerWeek}d/${hoursPerWeek}h/w${w.index}`;
          assert.equal(train.length, daysPerWeek, 'días ' + tag);
          assert.ok(train.every((d) => allowed.includes(wd(d.date))), 'días preferidos ' + tag);
          const total = train.reduce((s, d) => s + T.getWorkout(d.workoutId).durationS, 0);
          assert.ok(total <= hoursPerWeek * 3600 * 1.1 + 1, `horas ${tag}: ${total / 3600}`);
          if (w.phase !== 'descarga' && w.phase !== 'taper' && hoursPerWeek <= daysPerWeek * 1.5) {
            assert.ok(total >= hoursPerWeek * 3600 * 0.6, `muy poco volumen ${tag}: ${total / 3600}`);
          }
          const intense = train.filter((d) => INTENSE.includes(T.getWorkout(d.workoutId).category));
          assert.ok(intense.length <= 2, 'intensas ' + tag);
          assert.ok(train.every((d) => T.getWorkout(d.workoutId)), 'ids válidos ' + tag);
        });
      }
    }
  }
});

test('buildPlan: ramp-test en la semana 1 si ftpEstimated y al final de cada descarga', () => {
  const est = T.buildPlan({ profile: { ...baseProfile, ftpEstimated: true }, startDate: '2026-03-02' });
  assert.ok(est.weeks[0].days.some((d) => d.workoutId === 'ramp-test'));
  const noEst = T.buildPlan({ profile: { ...baseProfile, ftpEstimated: false }, startDate: '2026-03-02' });
  assert.ok(!noEst.weeks[0].days.some((d) => d.workoutId === 'ramp-test'));
  for (const p of [est, noEst]) {
    p.weeks.filter((w) => w.phase === 'descarga').forEach((w) => {
      const train = w.days.filter((d) => d.workoutId);
      assert.equal(train[train.length - 1].workoutId, 'ramp-test');
      assert.equal(train.filter((d) => d.workoutId === 'ramp-test').length, 1);
    });
  }
});

test('buildPlan: objetivo peso sin intensas; ftp incluye sweetspot/umbral/vo2', () => {
  const peso = T.buildPlan({ profile: { ...baseProfile, goal: 'peso', weeks: 12 }, startDate: '2026-03-02' });
  const used = peso.weeks.flatMap((w) => w.days.filter((d) => d.workoutId).map((d) => T.getWorkout(d.workoutId).category));
  assert.ok(!used.some((c) => INTENSE.includes(c)));
  assert.ok(used.filter((c) => c === 'resistencia' || c === 'tempo').length > used.length / 2);
  const ftp = T.buildPlan({ profile: { ...baseProfile, goal: 'ftp', weeks: 12 }, startDate: '2026-03-02' });
  const cats = new Set(ftp.weeks.flatMap((w) => w.days.filter((d) => d.workoutId).map((d) => T.getWorkout(d.workoutId).category)));
  for (const c of ['sweetspot', 'umbral', 'vo2']) assert.ok(cats.has(c), c);
});

test('buildPlan: evento ajusta semanas a la fecha, con taper al final y fase específica', () => {
  const p = T.buildPlan({ profile: { ...baseProfile, goal: 'evento', eventDate: '2026-05-24', weeks: 8 }, startDate: '2026-03-02' });
  assert.equal(p.weeks.length, 12);
  assert.equal(p.weeks[11].phase, 'taper');
  assert.equal(p.weeks[0].phase, 'base');
  assert.equal(p.weeks[4].phase, 'construccion');
  assert.equal(p.weeks[8].phase, 'especifico');
  assert.equal(p.weeks[10].phase, 'especifico');
  assert.ok(p.weeks[11].targetTss < p.weeks[10].targetTss);
  const near = T.buildPlan({ profile: { ...baseProfile, goal: 'evento', eventDate: '2026-03-10' }, startDate: '2026-03-02' });
  assert.equal(near.weeks.length, 4);
  const far = T.buildPlan({ profile: { ...baseProfile, goal: 'evento', eventDate: '2027-12-10' }, startDate: '2026-03-02' });
  assert.equal(far.weeks.length, 24);
});

test('buildPlan: weeks se limita al rango 4-24', () => {
  assert.equal(T.buildPlan({ profile: { ...baseProfile, weeks: 2 }, startDate: '2026-03-02' }).weeks.length, 4);
  assert.equal(T.buildPlan({ profile: { ...baseProfile, weeks: 40 }, startDate: '2026-03-02' }).weeks.length, 24);
});

// ---------- adaptación ----------
function handPlan() {
  return {
    createdAt: '2026-03-01T00:00:00.000Z', goal: 'ftp',
    weeks: [{
      index: 1, phase: 'base', targetTss: 300,
      days: [
        { date: '2026-03-02', workoutId: 'resistencia-60', status: 'pendiente' },
        { date: '2026-03-03', workoutId: 'sweetspot-3x12', status: 'pendiente' },
        { date: '2026-03-04', workoutId: null, status: 'pendiente' },
        { date: '2026-03-05', workoutId: 'umbral-2x20', status: 'pendiente' },
        { date: '2026-03-06', workoutId: null, status: 'pendiente' },
        { date: '2026-03-07', workoutId: 'resistencia-90', status: 'pendiente' },
        { date: '2026-03-08', workoutId: null, status: 'pendiente' },
      ],
    }],
  };
}
const dayOf = (plan, date) => plan.weeks.flatMap((w) => w.days).find((d) => d.date === date);

test('adaptPlan: marca hecho/saltado, no muta y no adapta sin señales', () => {
  const plan = deepFreeze(handPlan());
  const acts = deepFreeze([act('2026-03-03', { workoutId: 'sweetspot-3x12', rpe: 6 })]);
  const out = T.adaptPlan(plan, acts, baseProfile, { today: '2026-03-04' });
  assert.notEqual(out, plan);
  assert.equal(dayOf(out, '2026-03-02').status, 'saltado');
  assert.equal(dayOf(out, '2026-03-03').status, 'hecho');
  assert.equal(dayOf(out, '2026-03-04').status, 'pendiente');
  assert.equal(dayOf(out, '2026-03-05').workoutId, 'umbral-2x20');
  assert.equal(dayOf(out, '2026-03-05').status, 'pendiente');
  assert.equal(out.lastAdaptation, null);
  assert.equal(dayOf(plan, '2026-03-02').status, 'pendiente');
});

test('adaptPlan: RPE >= 9 en dos sesiones de la última semana baja la próxima intensa', () => {
  const plan = handPlan();
  const acts = [
    act('2026-03-02', { workoutId: 'resistencia-60', rpe: 9, tss: 50 }),
    act('2026-03-03', { workoutId: 'sweetspot-3x12', rpe: 10, tss: 80 }),
  ];
  const out = T.adaptPlan(plan, acts, baseProfile, { today: '2026-03-04' });
  const d = dayOf(out, '2026-03-05');
  const w = T.getWorkout(d.workoutId);
  assert.ok(['resistencia', 'recuperacion'].includes(w.category), w.id);
  assert.notEqual(d.workoutId, 'umbral-2x20');
  assert.equal(dayOf(out, '2026-03-02').status, 'hecho');
  assert.equal(out.lastAdaptation.date, '2026-03-04');
  assert.ok(/\S{3,}/.test(out.lastAdaptation.reason));
  assert.equal(dayOf(plan, '2026-03-05').workoutId, 'umbral-2x20', 'entrada intacta');
});

test('adaptPlan: lastAdaptation vuelve a null si esta pasada no adapta', () => {
  const plan = handPlan();
  plan.lastAdaptation = { date: '2026-02-01', reason: 'antigua' };
  const out = T.adaptPlan(plan, [], baseProfile, { today: '2026-03-04' });
  assert.equal(out.lastAdaptation, null);
});

test('adaptPlan: un solo RPE alto no dispara la reducción', () => {
  const acts = [act('2026-03-03', { workoutId: 'sweetspot-3x12', rpe: 10, tss: 60 })];
  const out = T.adaptPlan(handPlan(), acts, baseProfile, { today: '2026-03-04' });
  assert.equal(dayOf(out, '2026-03-05').workoutId, 'umbral-2x20');
});

test('adaptPlan: TSB < -30 baja la próxima intensa', () => {
  const acts = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(2026, 1, 18 + i, 12);
    const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    acts.push(act(s, { tss: 220, rpe: 6 }));
  }
  const tsb = T.pmc(acts, { days: 30, today: '2026-03-04' }).pop().tsb;
  assert.ok(tsb < -30, 'precondición tsb=' + tsb);
  const out = T.adaptPlan(handPlan(), acts, baseProfile, { today: '2026-03-04' });
  const w = T.getWorkout(dayOf(out, '2026-03-05').workoutId);
  assert.ok(['resistencia', 'recuperacion'].includes(w.category), w.id);
  assert.ok(/TSB|fatiga/i.test(out.lastAdaptation.reason));
});

test('adaptPlan: RPE <= 4 en las dos últimas intensas y TSB > -10 sube de nivel', () => {
  const plan = handPlan();
  plan.weeks[0].days[3].workoutId = 'umbral-3x10'; // próxima sesión
  const acts = [
    act('2026-02-20', { workoutId: 'umbral-3x10', rpe: 4, tss: 40 }),
    act('2026-02-24', { workoutId: 'vo2-5x4', rpe: 3, tss: 40 }),
  ];
  const tsb = T.pmc(acts, { days: 60, today: '2026-03-04' }).pop().tsb;
  assert.ok(tsb > -10, 'precondición tsb=' + tsb);
  const out = T.adaptPlan(plan, acts, baseProfile, { today: '2026-03-04' });
  const cur = T.getWorkout('umbral-3x10');
  const expected = T.library.filter((w) => w.category === 'umbral' && w.tss > cur.tss).sort((a, b) => a.tss - b.tss)[0];
  assert.ok(expected);
  assert.equal(dayOf(out, '2026-03-05').workoutId, expected.id);
  assert.ok(out.lastAdaptation && /\S/.test(out.lastAdaptation.reason));
});

test('adaptPlan: el reemplazo al subir de nivel dura como máximo 1.1x el original', () => {
  const acts = [
    act('2026-02-20', { workoutId: 'umbral-3x10', rpe: 4, tss: 40 }),
    act('2026-02-24', { workoutId: 'vo2-5x4', rpe: 3, tss: 40 }),
  ];
  let changed = 0;
  for (const w of T.library.filter((x) => x.category !== 'test')) {
    const plan = handPlan();
    plan.weeks[0].days[3].workoutId = w.id;
    const out = T.adaptPlan(plan, acts, baseProfile, { today: '2026-03-04' });
    const rep = T.getWorkout(dayOf(out, '2026-03-05').workoutId);
    assert.ok(rep.durationS <= w.durationS * 1.1 + 1e-9, `${w.id} -> ${rep.id}`);
    if (rep.id !== w.id) { changed++; assert.equal(rep.category, w.category); assert.ok(rep.tss > w.tss); }
  }
  assert.ok(changed > 5);
});

test('adaptPlan: una de las dos intensas con RPE alto impide subir de nivel', () => {
  const acts = [
    act('2026-02-20', { workoutId: 'umbral-3x10', rpe: 4, tss: 40 }),
    act('2026-02-24', { workoutId: 'vo2-5x4', rpe: 7, tss: 40 }),
  ];
  const out = T.adaptPlan(handPlan(), acts, baseProfile, { today: '2026-03-04' });
  assert.equal(dayOf(out, '2026-03-05').workoutId, 'umbral-2x20');
  assert.equal(out.lastAdaptation, null);
});

// ---------- targetPowerAt ----------
test('targetPowerAt: pasos constantes, rampas interpoladas y límites', () => {
  const w = {
    id: 'x', name: 'x', category: 'tempo', description: '', durationS: 900, tss: 0,
    steps: [
      { durationS: 300, powerPct: 50, powerPctEnd: 70, label: 'Rampa' },
      { durationS: 600, powerPct: 90, label: 'Tempo' },
    ],
  };
  let r = T.targetPowerAt(w, 0, 200);
  assert.equal(r.watts, 100);
  assert.equal(r.stepIndex, 0);
  assert.equal(r.stepElapsedS, 0);
  assert.equal(r.stepRemainingS, 300);
  assert.equal(r.step.label, 'Rampa');
  r = T.targetPowerAt(w, 150, 200);
  assert.equal(r.watts, 120);
  assert.equal(r.stepElapsedS, 150);
  assert.equal(r.stepRemainingS, 150);
  r = T.targetPowerAt(w, 300, 200);
  assert.equal(r.stepIndex, 1);
  assert.equal(r.watts, 180);
  assert.equal(r.stepElapsedS, 0);
  r = T.targetPowerAt(w, 899, 200);
  assert.equal(r.stepIndex, 1);
  assert.equal(r.stepRemainingS, 1);
  r = T.targetPowerAt(w, 5000, 200);
  assert.equal(r.stepIndex, 1);
  assert.equal(r.stepRemainingS, 0);
  r = T.targetPowerAt(w, -5, 200);
  assert.equal(r.stepIndex, 0);
});

test('targetPowerAt: ramp-test de la biblioteca sube 6 % por minuto', () => {
  const w = T.getWorkout('ramp-test');
  const first = w.steps.findIndex((s) => s.powerPct === 45 && s.durationS === 60);
  const t0 = w.steps.slice(0, first).reduce((s, x) => s + x.durationS, 0);
  assert.equal(T.targetPowerAt(w, t0 + 30, 200).watts, 90);
  assert.equal(T.targetPowerAt(w, t0 + 90, 200).watts, 102);
});

// ---------- motivación ----------
test('motivation: >=25 frases base, determinista por fecha y personalizada', () => {
  assert.ok(T.motivationPhrases.length >= 25);
  assert.equal(new Set(T.motivationPhrases).size, T.motivationPhrases.length);
  const acts = [act('2026-03-08', { tss: 60 }), act('2026-03-09', { tss: 60 }), act('2026-03-10', { tss: 60 })];
  const plan = handPlan();
  const args = { profile: { name: 'Ana' }, activities: acts, plan, today: '2026-03-10' };
  const a = T.motivation(args);
  assert.equal(typeof a, 'string');
  assert.equal(a, T.motivation(args));
  assert.ok(a.includes('3'), 'menciona racha de 3 días: ' + a);
  const seen = new Set();
  for (let i = 1; i <= 28; i++) {
    seen.add(T.motivation({ profile: {}, activities: [], plan: null, today: `2026-03-${String(i).padStart(2, '0')}` }));
  }
  assert.ok(seen.size >= 20, 'variación diaria: ' + seen.size);
  assert.ok(T.motivation({ profile: {}, activities: [], plan: null, today: '2026-03-10' }).length > 10);
});

test('motivation: menciona próxima sesión y récord reciente', () => {
  const pbAct = act('2026-03-09', { bestEfforts: { '300': 400 }, samples: [] });
  const old = act('2026-02-01', { bestEfforts: { '300': 300 } });
  const texts = new Set();
  for (let i = 1; i <= 12; i++) {
    texts.add(T.motivation({ profile: { name: 'Ana' }, activities: [old, pbAct], plan: handPlan(), today: `2026-03-${String(i).padStart(2, '0')}` }));
  }
  const all = [...texts].join(' | ');
  assert.ok(/récord|record/i.test(all), all);
  assert.ok(/próxima sesión/i.test(all), all);
});

test('motivation: antepone el nombre y siempre empieza en mayúscula', () => {
  const upper = (t) => t[0] !== t[0].toLowerCase();
  const scenarios = [
    { activities: [], plan: null },
    { activities: [act('2026-03-09'), act('2026-03-10')], plan: handPlan() },
    { activities: [act('2026-03-10', { bestEfforts: { '300': 400 } }), act('2026-02-01', { bestEfforts: { '300': 300 } })], plan: handPlan() },
  ];
  for (const sc of scenarios) {
    for (let i = 1; i <= 28; i++) {
      const today = `2026-03-${String(i).padStart(2, '0')}`;
      const named = T.motivation({ profile: { name: 'Ana' }, ...sc, today });
      assert.ok(named.includes('Ana'), named);
      assert.ok(named.startsWith('Ana'), named);
      const anon = T.motivation({ profile: {}, ...sc, today });
      assert.ok(upper(anon), anon);
      assert.ok(!anon.includes('undefined'));
    }
  }
  assert.ok(upper(T.motivation({ profile: { name: 'ana' }, activities: [], plan: null, today: '2026-03-10' })));
});

test('adaptPlanOnce: dos pasadas el mismo día dan un solo cambio', () => {
  const acts = [
    act('2026-03-02', { workoutId: 'resistencia-60', rpe: 9, tss: 50 }),
    act('2026-03-03', { workoutId: 'sweetspot-3x12', rpe: 10, tss: 80 }),
  ];
  const o = { today: '2026-03-04' };
  const r1 = T.adaptPlanOnce(handPlan(), acts, baseProfile, o);
  assert.ok(r1.reason);
  const changed = dayOf(r1.plan, '2026-03-05').workoutId;
  assert.notEqual(changed, 'umbral-2x20');
  const acts2 = acts.concat([act('2026-03-04', { workoutId: 'resistencia-60', rpe: 10, tss: 60 })]);
  const r2 = T.adaptPlanOnce(r1.plan, acts2, baseProfile, o);
  assert.equal(dayOf(r2.plan, '2026-03-05').workoutId, changed, 'sin segundo cambio');
  assert.equal(r2.plan.lastAdaptation.date, '2026-03-04');
  assert.equal(r2.reason, null, 'sin motivo repetido');
});
