'use strict';
// Tarea 20 (ola R3): nivel sugerido del rodillo mecánico, potencia virtual, sensores, hidratación,
// tope del grupo atacante y normalización de ajustes.
const test = require('node:test');
const assert = require('node:assert');
require('../src/sensors-settings.js');
require('../src/store.js');
require('../src/physics.js');
require('../src/routes.js');
require('../src/training.js');
require('../src/trainer.js');
require('../src/riders.js');
require('../src/coach.js');
require('../src/ui/ride.js');
const R = globalThis.R;
const L = R.rideLogic;

// ruta sintética con tramos de pendiente constante: [[metros, pendiente %], ...]
function rampRoute(segments) {
  const points = [];
  let d = 0, ele = 500;
  points.push([-33.4, -70.6, ele, 0]);
  segments.forEach(([len, g]) => {
    for (let k = 10; k <= len; k += 10) { d += 10; ele += (g / 100) * 10; points.push([-33.4 + d * 9e-6, -70.6, ele, d]); }
  });
  return { id: 'rampa', name: 'Rampa', distanceM: d, points };
}

// ---------- pendiente suavizada ----------
test('smoothedGrade: pendiente media en la ventana, también en los extremos y en vuelta', () => {
  const r = rampRoute([[1000, 0], [1000, 6], [1000, -4]]);
  assert.ok(Math.abs(L.smoothedGrade(r, 500, 150, false)) < 0.01);
  assert.ok(Math.abs(L.smoothedGrade(r, 1500, 150, false) - 6) < 0.05);
  assert.ok(Math.abs(L.smoothedGrade(r, 2500, 150, false) + 4) < 0.05);
  // en el inicio y el final la ventana se desplaza hacia dentro (sin NaN)
  assert.ok(Math.abs(L.smoothedGrade(r, 0, 150, false)) < 0.01);
  assert.ok(Math.abs(L.smoothedGrade(r, 3000, 150, false) + 4) < 0.05);
  // en vuelta (Libre / entrenamiento) usa la posición dentro de la vuelta
  assert.ok(Math.abs(L.smoothedGrade(r, 3000 + 1500, 150, true) - 6) < 0.05);
  // suaviza: justo en el quiebre 0 % -> 6 % da ~3 %
  assert.ok(Math.abs(L.smoothedGrade(r, 1000, 150, false) - 3) < 0.1);
});

// ---------- nivel sugerido ----------
test('advisor: primera sugerencia anuncia el nivel en llano y sigue la pendiente con histéresis', () => {
  const a = L.createLevelAdvisor({ flatLevel: 3 });
  const ev = a.update({ tS: 0, gradePct: 0 });
  assert.deepStrictEqual(ev, { level: 3, prev: null, reason: 'pendiente' });
  assert.strictEqual(a.update({ tS: 1, gradePct: 0.5 }), null, 'sin cambio no hay evento');
  // 1,6 % pasa el umbral 1,5 % por menos que el margen: sigue en 3
  assert.strictEqual(a.update({ tS: 20, gradePct: 1.6 }), null);
  assert.strictEqual(a.level, 3);
  // 2 % lo cruza con margen: nivel 4
  assert.deepStrictEqual(a.update({ tS: 21, gradePct: 2 }), { level: 4, prev: 3, reason: 'pendiente' });
  // de vuelta a 1,4 %: todavía dentro del margen del nivel 4
  assert.strictEqual(a.update({ tS: 40, gradePct: 1.4 }), null);
  assert.strictEqual(a.level, 4);
  assert.deepStrictEqual(a.update({ tS: 41, gradePct: 1.0 }), { level: 3, prev: 4, reason: 'pendiente' });
  // salto de varios niveles de una vez
  assert.deepStrictEqual(a.update({ tS: 60, gradePct: 9 }), { level: 7, prev: 3, reason: 'pendiente' });
});

test('advisor: no cambia más de una vez cada 8 s (el cambio pendiente se aplica después)', () => {
  const a = L.createLevelAdvisor({ flatLevel: 3 });
  a.update({ tS: 0, gradePct: 0 });
  assert.strictEqual(a.update({ tS: 3, gradePct: 4.5 }), null, 'a los 3 s de la primera sugerencia aún no');
  assert.deepStrictEqual(a.update({ tS: 8, gradePct: 4.5 }), { level: 5, prev: 3, reason: 'pendiente' });
  assert.strictEqual(a.update({ tS: 10, gradePct: 0 }), null);
  assert.strictEqual(a.update({ tS: 15.9, gradePct: 0 }), null);
  assert.strictEqual(a.level, 5);
  assert.deepStrictEqual(a.update({ tS: 16, gradePct: 0 }), { level: 3, prev: 5, reason: 'pendiente' });
});

test('advisor: el ajuste manual vale hasta la próxima sugerencia distinta', () => {
  const a = L.createLevelAdvisor({ flatLevel: 3 });
  a.update({ tS: 0, gradePct: 0 });
  assert.strictEqual(a.manual(1), 4);
  assert.strictEqual(a.manual(1), 5);
  assert.strictEqual(a.state.manual, true);
  // la sugerencia sigue siendo 3: el nivel real (5) se mantiene
  for (let t = 10; t < 60; t += 5) assert.strictEqual(a.update({ tS: t, gradePct: 0.3 }), null);
  assert.strictEqual(a.level, 5);
  assert.strictEqual(a.suggested, 3);
  // nueva sugerencia distinta (4): reemplaza el ajuste manual y avisa desde el nivel real
  assert.deepStrictEqual(a.update({ tS: 60, gradePct: 2.5 }), { level: 4, prev: 5, reason: 'pendiente' });
  assert.strictEqual(a.state.manual, false);
  // si el usuario ya está en el nivel de la nueva sugerencia, no hay que anunciar nada
  a.manual(1); // 5
  assert.strictEqual(a.update({ tS: 80, gradePct: 4.5 }), null);
  assert.strictEqual(a.level, 5);
  assert.strictEqual(a.suggested, 5);
  // límites 1..8
  for (let i = 0; i < 10; i++) a.manual(1);
  assert.strictEqual(a.level, 8);
  for (let i = 0; i < 10; i++) a.manual(-1);
  assert.strictEqual(a.level, 1);
});

test('advisor: ataque = nivel + 1 (tope 8) y vuelve al terminar; hidratación = llano − 1', () => {
  const a = L.createLevelAdvisor({ flatLevel: 3 });
  a.update({ tS: 0, gradePct: 0 });
  assert.deepStrictEqual(a.update({ tS: 10, gradePct: 0, attacking: true }), { level: 4, prev: 3, reason: 'ataque' });
  assert.deepStrictEqual(a.update({ tS: 70, gradePct: 0, attacking: false }), { level: 3, prev: 4, reason: 'pendiente' });
  assert.deepStrictEqual(a.update({ tS: 90, gradePct: 12 }), { level: 8, prev: 3, reason: 'pendiente' });
  assert.strictEqual(a.update({ tS: 100, gradePct: 12, attacking: true }), null, 'tope 8');
  assert.deepStrictEqual(a.update({ tS: 120, gradePct: 0, hydrating: true }), { level: 2, prev: 8, reason: 'hidratacion' });
  // la hidratación manda aunque haya ataque
  assert.strictEqual(a.update({ tS: 130, gradePct: 0, hydrating: true, attacking: true }), null);
  const b = L.createLevelAdvisor({ flatLevel: 1 });
  b.update({ tS: 0, gradePct: 0 });
  assert.strictEqual(b.update({ tS: 10, gradePct: 0, hydrating: true }), null, 'mínimo 1');
  assert.strictEqual(b.level, 1);
});

test('advisor: el nivel en llano desplaza la tabla de pendientes', () => {
  const a = L.createLevelAdvisor({ flatLevel: 4 });
  assert.strictEqual(a.update({ tS: 0, gradePct: 0 }).level, 4);
  assert.strictEqual(a.update({ tS: 10, gradePct: 4.5 }).level, 6);
  assert.strictEqual(a.update({ tS: 20, gradePct: -5 }).level, 2);
});

test('advisor: en entrenamientos usa levelForTarget con el objetivo', () => {
  const a = L.createLevelAdvisor({ flatLevel: 3 });
  const o = { cadenceRpm: 90, ftp: 250, wheelCircMm: 2050, powerScale: 1 };
  const e1 = a.update(Object.assign({ tS: 0, targetW: 150 }, o));
  assert.strictEqual(e1.reason, 'intervalo');
  assert.strictEqual(e1.level, R.trainer.levelForTarget({ targetW: 150, cadenceRpm: 90, wheelCircMm: 2050 }));
  const e2 = a.update(Object.assign({ tS: 30, targetW: 330 }, o));
  assert.strictEqual(e2.level, R.trainer.levelForTarget({ targetW: 330, cadenceRpm: 90, wheelCircMm: 2050 }));
  assert.ok(e2.level > e1.level);
  assert.strictEqual(e2.prev, e1.level);
});

// ---------- potencia virtual y fuentes de datos ----------
test('virtualPower = powerFromSpeed(velocidad de rueda, nivel) × powerScale', () => {
  const p = L.virtualPower({ speedKph: 29, level: 3, powerScale: 1 });
  assert.ok(Math.abs(p - R.trainer.powerFromSpeed({ speedKph: 29, level: 3 })) < 1e-9);
  assert.ok(Math.abs(p - 192) < 2, 'ancla del modelo: nivel 3 a 29 km/h ≈ 192 W');
  assert.ok(Math.abs(L.virtualPower({ speedKph: 29, level: 3, powerScale: 1.2 }) - 1.2 * p) < 1e-9);
  assert.ok(L.virtualPower({ speedKph: 20, level: 8, powerScale: 1 }) > 300);
  assert.strictEqual(L.virtualPower({ speedKph: null, level: 5 }), 0);
  assert.strictEqual(L.virtualPower({ speedKph: 0, level: 5 }), 0);
});

test('readings: CSC en modo velocidad -> potencia virtual con el nivel actual; sin banda no inventa FC', () => {
  const sim = { powerW: 210, hrBpm: 140, cadenceRpm: 91 };
  const status = [{ kind: 'csc', state: 'connected', mode: 'speed' }];
  const r = L.readings({ sim, dev: { speedKph: 29, cadenceRpm: null, hrBpm: null }, status, level: 3, powerScale: 1 });
  assert.strictEqual(r.powerSource, 'csc');
  assert.ok(Math.abs(r.powerW - L.virtualPower({ speedKph: 29, level: 3, powerScale: 1 })) < 1e-9);
  assert.strictEqual(r.wheelKph, 29);
  assert.strictEqual(r.cad, null, 'modo velocidad: sin cadencia');
  assert.strictEqual(r.hr, null, 'con sensor real y sin banda, la FC del simulador no se usa');
  // subir la palanca a la misma velocidad de rueda da más vatios
  const r5 = L.readings({ sim, dev: { speedKph: 29 }, status, level: 5, powerScale: 1 });
  assert.ok(r5.powerW > r.powerW + 50);
  // factor de potencia
  const rs = L.readings({ sim, dev: { speedKph: 29 }, status, level: 3, powerScale: 0.8 });
  assert.ok(Math.abs(rs.powerW - 0.8 * r.powerW) < 1e-9);
  // primera lectura del CSC (velocidad aún null): 0 W, no la del simulador
  assert.strictEqual(L.readings({ sim, dev: {}, status, level: 3, powerScale: 1 }).powerW, 0);
});

test('readings: CSC en modo cadencia, banda de pulso y sin sensores', () => {
  const sim = { powerW: 210, hrBpm: 140, cadenceRpm: 91 };
  const cad = L.readings({ sim, dev: { speedKph: null, cadenceRpm: 84 }, status: [{ kind: 'csc', state: 'connected', mode: 'cadence' }], level: 3, powerScale: 1 });
  assert.strictEqual(cad.powerSource, 'sim');
  assert.strictEqual(cad.powerW, 210);
  assert.strictEqual(cad.cad, 84);
  const both = L.readings({ sim, dev: { speedKph: 30, cadenceRpm: 88, hrBpm: 165 }, status: [{ kind: 'csc', state: 'connected', mode: 'both' }, { kind: 'hr', state: 'connected' }], level: 4, powerScale: 1 });
  assert.strictEqual(both.cad, 88);
  assert.strictEqual(both.hr, 165);
  assert.strictEqual(both.hrSource, 'hr');
  const hrOnly = L.readings({ sim, dev: { hrBpm: 171 }, status: [{ kind: 'hr', state: 'connected' }], level: 3, powerScale: 1 });
  assert.strictEqual(hrOnly.powerW, 210);
  assert.strictEqual(hrOnly.cad, 91);
  assert.strictEqual(hrOnly.hr, 171);
  // sensores desconectados o reconectando = simulador (comportamiento anterior)
  const none = L.readings({ sim, dev: { speedKph: 40, hrBpm: 100 }, status: [{ kind: 'csc', state: 'reconnecting', mode: 'speed' }, { kind: 'hr', state: 'disconnected' }], level: 3, powerScale: 1 });
  assert.deepStrictEqual([none.powerW, none.hr, none.cad, none.powerSource, none.hrSource], [210, 140, 91, 'sim', 'sim']);
});

test('hrZone: % de la FC máxima (186 por defecto) con color por zona', () => {
  assert.strictEqual(L.hrZone(null, 186), null);
  assert.strictEqual(L.hrZone(100, 186).zone, 1);   // 54 %
  assert.strictEqual(L.hrZone(120, 186).zone, 2);   // 65 %
  assert.strictEqual(L.hrZone(140, 186).zone, 3);   // 75 %
  assert.strictEqual(L.hrZone(158, 186).zone, 4);   // 85 %
  assert.strictEqual(L.hrZone(170, 186).zone, 5);   // 91 %
  assert.strictEqual(L.hrZone(170).zone, 5, 'sin FC máx usa 186');
  assert.strictEqual(L.hrZone(170, 200).zone, 4);
  assert.match(L.hrZone(170, 186).color, /^#[0-9A-F]{6}$/i);
});

// ---------- hidratación ----------
test('hidratación en rodada libre: cada everyMin, durante durationS, sin detener el reloj', () => {
  const h = L.createHydrationTimer({ everyMin: 12, durationS: 45 });
  const log = [];
  for (let t = 0; t <= 40 * 60; t += 1) {
    const s = h.update(t);
    if (s.started) log.push(['start', t]);
    if (s.ended) log.push(['end', t]);
    if (t === 12 * 60 + 15) { assert.ok(s.active); assert.strictEqual(Math.round(s.remainingS), 30); }
  }
  assert.deepStrictEqual(log, [['start', 720], ['end', 765], ['start', 1440], ['end', 1485], ['start', 2160], ['end', 2205]]);
});

test('hidratación en entrenamientos: withHydration agrega pausas (no en tests de FTP)', () => {
  const w = R.training.getWorkout('sweetspot-3x12') || R.training.library.find((x) => x.category === 'sweetspot');
  const hw = R.training.withHydration(w, { everyMin: 12, durationS: 45 });
  const pauses = hw.steps.filter((s) => s.hydrate);
  assert.ok(pauses.length >= 2);
  pauses.forEach((p) => assert.strictEqual(p.durationS, 45));
  // en el paso de hidratación el objetivo existe (pedaleo suave) y el advisor manda llano − 1
  let t = 0;
  for (const s of hw.steps) { if (s.hydrate) break; t += s.durationS; }
  const tp = R.training.targetPowerAt(hw, t + 5, 250);
  assert.ok(tp.step.hydrate);
  const a = L.createLevelAdvisor({ flatLevel: 3 });
  assert.strictEqual(a.update({ tS: t + 5, targetW: tp.watts, ftp: 250, hydrating: true }).level, 2);
  const ftpTest = R.training.library.find((x) => x.category === 'test');
  assert.strictEqual(R.training.withHydration(ftpTest, { everyMin: 10, durationS: 30 }).steps.filter((s) => s.hydrate).length, 0);
});

// ---------- tope del grupo atacante ----------
test('pelotón: en bajada larga el grupo atacante no pasa de 1,8 × v_usuario + 1 m/s', () => {
  const route = rampRoute([[3000, 0], [30000, -6]]);
  const vu = 25 / 3.6;
  let maxRatioExcess = -Infinity, sawAttack = false;
  const p = R.riders.createPeloton({ count: 14, ftp: 300, massKg: 80, route, seed: 11, attackEveryMin: [4.5, 5], attackDurS: [90, 90] });
  let ud = 0;
  for (let t = 0; t < 900; t++) {
    ud += vu;
    p.update(1, t, ud);
    if (p.state.attacking && t - p.state.startsAtS > 2) {
      sawAttack = true;
      p.bots.filter((b) => b.group === 'principal').forEach((b) => { maxRatioExcess = Math.max(maxRatioExcess, b.speedMps - (1.8 * vu + 1)); });
    }
  }
  assert.ok(sawAttack, 'hubo ataque');
  assert.ok(maxRatioExcess <= 0.05, 'exceso ' + maxRatioExcess.toFixed(2) + ' m/s');
});

// ---------- ajustes ----------
test('store: normaliza botsCount, hydration, trainer y sensors (y migra estados antiguos)', () => {
  const S = R.store;
  S.reset();
  // estado antiguo: botsCount 6, sin hydration/trainer/sensors
  S.importJSON(JSON.stringify({ schemaVersion: 1, settings: { botsCount: 6, ghostBoost: 1 } }));
  let st = S.get().settings;
  assert.strictEqual(st.botsCount, 14, '6 (antiguo valor de fábrica) migra a 14');
  S.importJSON(JSON.stringify({ schemaVersion: 1, settings: { botsCount: 7 } }));
  assert.strictEqual(S.get().settings.botsCount, 8, 'otros valores menores que 8 suben a 8');
  S.importJSON(JSON.stringify({ schemaVersion: 1, settings: { botsCount: 6, ghostBoost: 1 } }));
  assert.deepStrictEqual(st.hydration, { enabled: true, everyMin: 12, durationS: 45 });
  assert.deepStrictEqual(st.trainer, { type: 'mecanico-8', wheelCircMm: 2050, flatLevel: 3, powerScale: 1 });
  assert.deepStrictEqual(st.sensors, { lastSpeedId: null, lastHrId: null });
  assert.strictEqual(st.ghostBoost, 1);
  // sin botsCount -> 14
  S.importJSON(JSON.stringify({ schemaVersion: 1, settings: {} }));
  assert.strictEqual(S.get().settings.botsCount, 14);
  // valores fuera de rango o basura
  S.importJSON(JSON.stringify({ schemaVersion: 1, settings: {
    botsCount: 99, hydration: { enabled: 0, everyMin: 30, durationS: 5 },
    trainer: { wheelCircMm: '2070', flatLevel: 12, powerScale: 2 }, sensors: { lastSpeedId: 'abc', lastHrId: 7 },
  } }));
  st = S.get().settings;
  assert.strictEqual(st.botsCount, 20);
  assert.deepStrictEqual(st.hydration, { enabled: false, everyMin: 15, durationS: 30 });
  assert.deepStrictEqual(st.trainer, { type: 'mecanico-8', wheelCircMm: 2070, flatLevel: 8, powerScale: 1.3 });
  assert.deepStrictEqual(st.sensors, { lastSpeedId: 'abc', lastHrId: null });
  // set también normaliza
  S.set({ settings: { botsCount: '17', hydration: { enabled: true, everyMin: 10.6, durationS: 52 } } });
  st = S.get().settings;
  assert.strictEqual(st.botsCount, 17);
  assert.deepStrictEqual(st.hydration, { enabled: true, everyMin: 11, durationS: 52 });
  S.set({ settings: { botsCount: 'x', trainer: { flatLevel: 4 } } });
  assert.strictEqual(S.get().settings.botsCount, 14);
  assert.strictEqual(S.get().settings.trainer.flatLevel, 4);
  assert.strictEqual(S.get().settings.trainer.wheelCircMm, 2050, 'trainer parcial se completa');
  S.reset();
});

test('store: carga desde localStorage un estado guardado antes de la ola R3', () => {
  const saved = { schemaVersion: 1, updatedAt: 5, profile: { name: 'B' }, activities: [], bests: {},
    settings: { reminderTime: '07:00', botsCount: 6, coach: { volume: 0.9 } } };
  const m = new Map([['rodillator.v1', JSON.stringify(saved)]]);
  globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  try {
    const st = R.store.load().settings;
    assert.strictEqual(st.reminderTime, '07:00');
    assert.strictEqual(st.botsCount, 14);
    assert.strictEqual(st.coach.volume, 1.6);
    assert.strictEqual(st.hydration.enabled, true);
    assert.strictEqual(st.trainer.flatLevel, 3);
    assert.strictEqual(st.sensors.lastSpeedId, null);
  } finally { delete globalThis.localStorage; R.store.reset(); }
});

test('readings: rodillo FTMS o medidor de potencia conectado -> su potencia real manda', () => {
  const L = R.rideLogic;
  const st = (kind, extra) => [Object.assign({ kind, state: 'connected' }, extra)];
  let r = L.readings({ sim: { powerW: 120 }, dev: { powerW: 205, cadenceRpm: 88, speedKph: 30 }, status: st('trainer'), level: 3, powerScale: 1 });
  assert.strictEqual(r.powerW, 205); assert.strictEqual(r.powerSource, 'device'); assert.strictEqual(r.cad, 88);
  r = L.readings({ sim: { powerW: 120 }, dev: { powerW: 230 }, status: st('powermeter').concat(st('csc', { mode: 'speed' })), level: 3, powerScale: 1 });
  assert.strictEqual(r.powerW, 230, 'gana al CSC virtual'); assert.strictEqual(r.powerSource, 'device');
  // conectado pero aún sin dato de potencia: cae al comportamiento anterior
  r = L.readings({ sim: { powerW: 120 }, dev: {}, status: st('trainer'), level: 3, powerScale: 1 });
  assert.strictEqual(r.powerSource, 'sim');
});

test('coach: el paso de hidratación no dice "¡Recupera!" (queda solo el aviso de hidratación)', () => {
  const spoken = [];
  const c = R.coach.createCoach({ say: (t) => spoken.push(t), beep: () => {}, now: () => 0, verbosity: 'completo' });
  const wk = { id: 'x', durationS: 400, steps: [
    { durationS: 200, powerPct: 90, label: 'a' },
    { durationS: 60, powerPct: 50, label: 'Hidratación', hydrate: true },
    { durationS: 140, powerPct: 90, label: 'b' }] };
  const base = { mode: 'workout', workout: wk, ftp: 200, paused: false, distM: 0, routeLenM: 0, speedMps: 0, intensity: 1, workoutRemainingS: 300, powerW: 0, gradePct: 0 };
  c.update(Object.assign({ tS: 1, stepIndex: 0, stepElapsedS: 1, stepRemainingS: 199, targetW: 180 }, base));
  c.update(Object.assign({ tS: 201, stepIndex: 1, stepElapsedS: 1, stepRemainingS: 59, targetW: 100 }, base));
  c.event('hydrate', { durationS: 60 });
  const all = spoken.join(' | ');
  assert.ok(!/Recupera/.test(all), all);
  assert.ok(/Hidrataci/.test(all), all);
});
