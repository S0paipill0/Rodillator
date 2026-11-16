'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
require('../src/coach.js');
const C = globalThis.R.coach;

const FTP = 250;
const st = (durationS, powerPct, extra) => Object.assign({ durationS, powerPct, label: 'x' }, extra || {});

function rig(verbosity) {
  const log = [];
  const clock = { t: 0 };
  const coach = C.createCoach({
    say: (text, o) => log.push(['say', text, o.priority]),
    beep: (k) => log.push(['beep', k]),
    now: () => clock.t,
    verbosity,
  });
  const texts = () => log.filter((e) => e[0] === 'say').map((e) => e[1]);
  const beeps = () => log.filter((e) => e[0] === 'beep').map((e) => e[1]);
  return { coach, log, clock, texts, beeps };
}

// Simula un workout a pasos de 0,1 s (10 updates por segundo)
function playWorkout(r, steps, opts) {
  const o = opts || {};
  const workout = { id: o.id, steps };
  const total = steps.reduce((a, s) => a + s.durationS, 0);
  const to = Math.min(o.to == null ? total : o.to, total);
  for (let t10 = Math.round((o.from || 0) * 10); t10 <= to * 10; t10++) {
    const tS = t10 / 10;
    let acc = 0, idx = 0;
    for (; idx < steps.length - 1 && tS >= acc + steps[idx].durationS; idx++) acc += steps[idx].durationS;
    r.clock.t = tS * 1000;
    r.coach.update({
      mode: 'workout', tS, paused: false, workout, ftp: FTP, stepIndex: idx, stepElapsedS: tS - acc,
      stepRemainingS: steps[idx].durationS - (tS - acc), targetW: 0, powerW: 0, gradePct: 0, distM: 0, routeLenM: 1, workoutRemainingS: total - tS,
    });
  }
}

test('duración hablada en español natural', () => {
  assert.strictEqual(C.spokenDuration(30), '30 segundos');
  assert.strictEqual(C.spokenDuration(1), '1 segundo');
  assert.strictEqual(C.spokenDuration(60), '1 minuto');
  assert.strictEqual(C.spokenDuration(90), '1 minuto y medio');
  assert.strictEqual(C.spokenDuration(240), '4 minutos');
  assert.strictEqual(C.spokenDuration(210), '3 minutos y medio');
  assert.strictEqual(C.spokenDuration(75), '1 minuto y 15 segundos');
});

test('cuenta regresiva: Tres/Dos/Uno/¡Vamos! exactamente una vez con 10 updates por segundo', () => {
  const r = rig();
  playWorkout(r, [st(30, 50), st(30, 100), st(30, 50)], { to: 31 });
  const t = r.texts();
  assert.deepStrictEqual(t.filter((x) => ['Tres', 'Dos', 'Uno', '¡Vamos!'].includes(x)), ['Tres', 'Dos', 'Uno', '¡Vamos!']);
  assert.strictEqual(r.beeps().filter((b) => b === 'tick').length, 3);
  assert.strictEqual(r.beeps().filter((b) => b === 'go').length, 1);
  // los tres números salen en prioridad máxima
  r.log.filter((e) => e[1] === 'Tres').forEach((e) => assert.strictEqual(e[2], C.PRIORITY.COUNT));
});

test('cambio < 10 % FTP: solo pitido go; en el test de rampa, "Siguiente escalón"', () => {
  const steps = [st(60, 45), st(60, 51), st(60, 57)];
  const r = rig();
  playWorkout(r, steps, { id: 'otro', to: 121 });
  assert.ok(!r.texts().some((x) => x === '¡Vamos!' || x === '¡Recupera!' || x.indexOf('Siguiente') === 0));
  assert.strictEqual(r.beeps().filter((b) => b === 'go').length, 2);
  const q = rig();
  playWorkout(q, steps, { id: 'ramp-test', to: 121 });
  assert.deepStrictEqual(q.texts().filter((x) => x.indexOf('Siguiente') === 0), ['Siguiente escalón: 130 vatios', 'Siguiente escalón: 145 vatios']);
  q.log.filter((e) => e[1] && e[1].indexOf('Siguiente') === 0).forEach((e) => assert.strictEqual(e[2], C.PRIORITY.REST));
  const e = rig('esencial');
  playWorkout(e, steps, { id: 'ramp-test', to: 121 });
  assert.ok(!e.texts().some((x) => x.indexOf('Siguiente') === 0));
});

test('paso más suave: ¡Recupera!', () => {
  const r = rig();
  playWorkout(r, [st(30, 120), st(30, 50)], { to: 31 });
  assert.ok(r.texts().includes('¡Recupera!'));
  assert.ok(!r.texts().includes('¡Vamos!'));
});

test('anuncio a −10 s con vatios redondeados a 5 y una sola vez', () => {
  const r = rig();
  playWorkout(r, [st(60, 50), st(240, 101)], { to: 52 });
  const a = r.texts().filter((x) => x.indexOf('Prepárate') === 0);
  assert.deepStrictEqual(a, ['Prepárate: 4 minutos a 255 vatios']); // 101 % de 250 = 252,5 -> 255
});

test('anuncio de un paso suave: "a ritmo suave"', () => {
  const r = rig();
  playWorkout(r, [st(60, 100), st(90, 50)], { to: 52 });
  assert.ok(r.texts().includes('Prepárate: 1 minuto y medio a ritmo suave'));
});

test('de pie inferido (130 % durante 30 s) y "Nos sentamos" al terminar', () => {
  assert.strictEqual(C.isStanding(st(30, 130)), true);
  assert.strictEqual(C.isStanding(st(30, 130, { position: 'sentado' })), false);
  assert.strictEqual(C.isStanding(st(120, 130)), false);
  const r = rig();
  playWorkout(r, [st(40, 50), st(30, 130), st(40, 50)], { to: 71 });
  const t = r.texts();
  assert.strictEqual(t.filter((x) => x === '¡Arriba! De pie').length, 1);
  assert.strictEqual(t.filter((x) => x === 'Nos sentamos').length, 1);
  assert.ok(t.indexOf('¡Arriba! De pie') < t.indexOf('Nos sentamos'));
});

test('de pie explícito con position:"pie" aunque la potencia sea baja', () => {
  const r = rig();
  playWorkout(r, [st(40, 50), st(30, 90, { position: 'pie' }), st(40, 50)], { to: 71 });
  assert.strictEqual(r.texts().filter((x) => x === '¡Arriba! De pie').length, 1);
});

test('cadencia al empezar el paso', () => {
  const r = rig();
  playWorkout(r, [st(40, 50), st(40, 100, { cadence: 100 })], { to: 41 });
  assert.ok(r.texts().includes('Cadencia 100'));
});

test('fin de workout: frase final única y pitido end', () => {
  const r = rig();
  playWorkout(r, [st(30, 50), st(30, 50)], { to: 60 });
  r.coach.event('end');
  r.coach.event('end');
  assert.strictEqual(r.texts().filter((x) => x === 'Tres, dos, uno… ¡terminamos! Buen trabajo').length, 1);
  assert.strictEqual(r.beeps().filter((b) => b === 'end').length, 1);
  assert.ok(!r.texts().includes('¡Terminamos! Buen trabajo'));
});

test('pausa suprime avisos y se anuncia con event', () => {
  const r = rig();
  const workout = { steps: [st(30, 50), st(30, 100)] };
  r.coach.event('pause');
  const n0 = r.texts().length;
  r.clock.t = 5000;
  r.coach.update({ mode: 'workout', tS: 28, paused: true, workout, ftp: FTP, stepIndex: 0, stepElapsedS: 28, stepRemainingS: 2 });
  assert.strictEqual(r.texts().length, n0);
  assert.deepStrictEqual(r.texts(), ['Pausa']);
  r.coach.event('resume');
  assert.ok(r.texts().includes('Seguimos'));
});

test('verbosidad esencial filtra mitad, último minuto, cadencia y anuncio; deja cuenta y postura', () => {
  const steps = [st(60, 50), st(240, 135, { cadence: 100, position: 'pie' }), st(60, 50)];
  const full = rig('completo'), ess = rig('esencial');
  playWorkout(full, steps); playWorkout(ess, steps);
  assert.ok(full.texts().includes('Mitad del intervalo') && full.texts().includes('Último minuto'));
  assert.ok(full.texts().some((x) => x.indexOf('Prepárate') === 0));
  assert.ok(!ess.texts().some((x) => x === 'Mitad del intervalo' || x === 'Último minuto' || x === 'Cadencia 100' || x.indexOf('Prepárate') === 0));
  assert.ok(ess.texts().includes('Tres') && ess.texts().includes('¡Arriba! De pie') && ess.texts().includes('Nos sentamos'));
  assert.ok(ess.beeps().includes('tick'));
});

test('verbosidad off: nada de voz ni pitidos', () => {
  const r = rig('off');
  playWorkout(r, [st(30, 50), st(30, 100)]);
  r.coach.event('start'); r.coach.event('end');
  assert.strictEqual(r.log.length, 0);
});

test('cola: nunca superpone frases ni se pierde la prioridad alta', () => {
  const r = rig();
  const workout = { steps: [st(30, 50), st(60, 100, { cadence: 90 })] };
  const base = { mode: 'workout', paused: false, workout, ftp: FTP, targetW: 0, powerW: 0, gradePct: 0, distM: 0, routeLenM: 1 };
  r.clock.t = 0;
  r.coach.update(Object.assign({ tS: 29.5, stepIndex: 0, stepElapsedS: 29.5, stepRemainingS: 0.5 }, base));
  r.coach.update(Object.assign({ tS: 30.1, stepIndex: 1, stepElapsedS: 0.1, stepRemainingS: 59.9 }, base));
  // ¡Vamos! sale ya; postura/cadencia esperan
  assert.deepStrictEqual(r.texts(), ['Uno', '¡Vamos!']);
  r.clock.t = 100;
  r.coach.update(Object.assign({ tS: 30.2, stepIndex: 1, stepElapsedS: 0.2, stepRemainingS: 59.8 }, base));
  assert.strictEqual(r.texts().length, 2); // todavía ocupado
  r.clock.t = 4000; // 3,9 s después: "Cadencia" (baja prioridad) caduca
  r.coach.update(Object.assign({ tS: 34, stepIndex: 1, stepElapsedS: 4, stepRemainingS: 56 }, base));
  assert.ok(!r.texts().includes('Cadencia 90'));
});

test('inicio: cuenta 3,2,1 sincronizada con pitidos', () => {
  const r = rig();
  [3, 2, 1, 0].forEach((n) => { r.coach.event('start', { n }); r.coach.event('start', { n }); });
  assert.deepStrictEqual(r.texts(), ['Tres, dos, uno, ¡vamos!']);
  assert.deepStrictEqual(r.beeps(), ['tick', 'tick', 'tick', 'go']);
});

test('eventos de fantasma', () => {
  const r = rig();
  r.coach.event('ghostPassed');
  assert.deepStrictEqual(r.texts(), ['¡Pasaste a tu mejor marca!']);
  r.clock.t = 5000;
  r.coach.event('ghostOvertook');
  assert.deepStrictEqual(r.texts().pop(), 'Tu mejor marca se adelanta, ¡vamos!');
});

test('resistencia larga: cada 10 min de pie 20 s', () => {
  const r = rig();
  playWorkout(r, [st(1800, 60)], { to: 1300 });
  const t = r.texts();
  assert.strictEqual(t.filter((x) => x.indexOf('¡Arriba! 20 segundos de pie') === 0).length, 2);
  assert.strictEqual(t.filter((x) => x === 'Nos sentamos').length, 2);
});

function playRoute(r, grades, o) {
  const len = (o && o.len) || 8000, v = (o && o.v) || 10;
  for (let t10 = 0; t10 <= (o.to || 100) * 10; t10++) {
    const tS = t10 / 10;
    r.clock.t = tS * 1000;
    r.coach.update({ mode: 'route', tS, paused: false, ftp: FTP, distM: v * tS, routeLenM: len, gradePct: grades(tS), powerW: 200 });
  }
}

test('ruta: aviso por kilómetro con coma decimal hablada', () => {
  const r = rig();
  playRoute(r, () => 2, { len: 4200, v: 10, to: 315 });
  const km = r.texts().filter((x) => x.indexOf('Kilómetro') === 0);
  assert.deepStrictEqual(km, ['Kilómetro 1, quedan 3 coma 2', 'Kilómetro 2, quedan 2 coma 2', 'Kilómetro 3, quedan 1 coma 2']);
});

test('ruta: pendiente > 8 % sostenida 8 s -> ¡Arriba! y luego < 5 % -> Nos sentamos', () => {
  const r = rig();
  playRoute(r, (t) => (t >= 10 && t < 40 ? 9.4 : t < 10 ? 3 : 2), { to: 70 });
  const t = r.texts();
  assert.deepStrictEqual(t.filter((x) => x.indexOf('Muro') >= 0 || x === 'Nos sentamos'), ['¡Arriba! Muro de 9 por ciento', 'Nos sentamos']);
});

test('ruta: pendiente breve (< 8 s) no dispara el muro', () => {
  const r = rig();
  playRoute(r, (t) => (t >= 10 && t < 15 ? 12 : 2), { to: 40 });
  assert.ok(!r.texts().some((x) => x.indexOf('Muro') >= 0));
});

test('ruta: muro máx. 1 vez cada 2 minutos', () => {
  const r = rig();
  playRoute(r, (t) => ((t % 60) < 30 ? 10 : 2), { to: 200, len: 100000 });
  const muros = r.texts().filter((x) => x.indexOf('Muro') >= 0).length;
  assert.strictEqual(muros, 2); // t≈8 y t≈128 (no en t≈68)
});

test('ruta: cuenta a la meta con velocidad estimada y ¡Meta!', () => {
  const r = rig();
  playRoute(r, () => 0, { len: 2000, v: 10, to: 220 });
  r.coach.event('end');
  const t = r.texts();
  assert.deepStrictEqual(t.filter((x) => ['Tres', 'Dos', 'Uno'].includes(x)), ['Tres', 'Dos', 'Uno']);
  assert.ok(t.includes('Últimos quinientos metros'));
  assert.strictEqual(t[t.length - 1], '¡Meta! ¡Bien hecho!');
});

test('ajustes: normalización compatible con estados guardados', () => {
  assert.deepStrictEqual(C.normalizeSettings(undefined), { voice: true, beeps: true, volume: 1.6, verbosity: 'completo', natural: true });
  assert.deepStrictEqual(C.normalizeSettings({ volume: 5, verbosity: 'x', voice: false, natural: false }), { voice: false, beeps: true, volume: 2, verbosity: 'completo', natural: false });
  assert.strictEqual(C.normalizeSettings({ volume: 0 }).volume, 0);
  assert.strictEqual(C.normalizeSettings({ volume: 1.3 }).volume, 1.3);
});

// ---------- motor de audio con entorno simulado ----------
test('voz: preferencia es-CL > es-419/US/MX > es-ES > es-*', () => {
  const v = (lang) => ({ lang, name: lang });
  assert.strictEqual(C.pickVoice([v('en-US'), v('es-ES'), v('es-MX'), v('es-CL')]).lang, 'es-CL');
  assert.strictEqual(C.pickVoice([v('es-ES'), v('es-AR'), v('es_US')]).lang, 'es_US');
  assert.strictEqual(C.pickVoice([v('es-AR'), v('es-ES')]).lang, 'es-ES');
  assert.strictEqual(C.pickVoice([v('en-US'), v('es-AR')]).lang, 'es-AR');
  assert.strictEqual(C.pickVoice([v('en-US'), v('fr-FR')]), null);
});

function fakeEnv() {
  const spoken = [], osc = [], order = [];
  let cancelled = 0, speaking = false, pending = false, t = 0, intervalFn = null; const timers = [];
  class Utter { constructor(text) { this.text = text; } }
  const ctxHolder = [];
  class Ctx {
    constructor() { ctxHolder.push(this); order.push('ctx'); this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() {}
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    createOscillator() { const o = { frequency: {}, connect() {}, start() {}, stop() {} }; osc.push(o); return o; }
  }
  const navigator = {};
  Object.defineProperty(navigator, 'audioSession', { value: { set type(v) { order.push('session:' + v); } }, enumerable: true });
  const env = {
    navigator, AudioContext: Ctx, SpeechSynthesisUtterance: Utter,
    speechSynthesis: { getVoices: () => [{ lang: 'es-CL', name: 'Chile' }], speak: (u) => { spoken.push(u); speaking = true; }, cancel: () => { cancelled++; speaking = false; }, get speaking() { return speaking; }, get pending() { return pending; }, _set(v) { speaking = v; } },
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {},
    setInterval: (fn) => { intervalFn = fn; return 1; }, clearInterval() {},
  };
  return { env, spoken, osc, order, timers, ctxs: () => ctxHolder, now: () => t, advance: (ms) => { t += ms; }, cancelled: () => cancelled, tick: () => intervalFn && intervalFn() };
}

test('audio: audioSession ambient antes de crear el AudioContext; un solo contexto', () => {
  const f = fakeEnv();
  const a = C.createAudio({ env: f.env, now: f.now });
  a.unlock(); a.unlock();
  assert.deepStrictEqual(f.order, ['session:ambient', 'ctx']);
});

test('audio: voz con es-CL, rate 1,08 y volumen; cancela solo con prioridad máxima', () => {
  const f = fakeEnv();
  const a = C.createAudio({ env: f.env, volume: 0.5, now: f.now });
  a.unlock();
  a.say('Hola', { priority: 1 });
  assert.strictEqual(f.cancelled(), 0);
  const u = f.spoken[f.spoken.length - 1];
  assert.strictEqual(u.rate, 1.08); assert.strictEqual(u.volume, 0.5); assert.strictEqual(u.lang, 'es-CL');
  a.say('Tres', { priority: C.PRIORITY.COUNT });
  assert.strictEqual(f.cancelled(), 1);
  a.setEnabled({ voice: false });
  const n = f.spoken.length;
  a.say('mudo', { priority: 1 });
  assert.strictEqual(f.spoken.length, n);
});

test('audio: pitidos con osciladores (tick 1, go 1, end 3) y sin Audio/mediaSession', () => {
  const f = fakeEnv();
  f.env.Audio = function () { throw new Error('no debe usarse'); };
  const a = C.createAudio({ env: f.env });
  assert.strictEqual(a.beep('tick'), false); // sin unlock no hay contexto
  a.unlock();
  a.beep('tick'); assert.strictEqual(f.osc.length, 1); assert.strictEqual(f.osc[0].frequency.value, 880);
  a.beep('go'); assert.strictEqual(f.osc[1].frequency.value, 1320);
  a.beep('end'); assert.strictEqual(f.osc.length, 5);
  a.setEnabled({ beeps: false });
  assert.strictEqual(a.beep('tick'), false);
  assert.strictEqual(f.env.navigator.mediaSession, undefined);
});

test('audio: watchdog cancela speechSynthesis pegado > 8 s', () => {
  const f = fakeEnv();
  const a = C.createAudio({ env: f.env, now: f.now });
  a.unlock();
  a.say('larga', { priority: 1 });
  const c0 = f.cancelled();
  f.tick(); f.advance(5000); f.tick();
  assert.strictEqual(f.cancelled(), c0);
  f.advance(4000); f.tick();
  assert.strictEqual(f.cancelled(), c0 + 1);
});

test('audio: sin speechSynthesis ni AudioContext no lanza (Node)', () => {
  const a = C.createAudio();
  assert.doesNotThrow(() => { a.unlock(); a.say('x'); a.beep('tick'); a.setVolume(0.3); a.setEnabled({ voice: true, beeps: true }); a.test(); a.dispose(); });
});

test('intensidad: los vatios hablados aplican ride.intensity (anuncio y escalón)', () => {
  const r = rig();
  const workout = { steps: [st(60, 50), st(240, 100)] };
  r.clock.t = 1000;
  r.coach.update({ mode: 'workout', tS: 52, paused: false, workout, ftp: FTP, intensity: 1.1, stepIndex: 0, stepElapsedS: 52, stepRemainingS: 8 });
  assert.ok(r.texts().includes('Prepárate: 4 minutos a 275 vatios'));
  const q = rig();
  const ramp = { id: 'ramp-test', steps: [st(60, 45), st(60, 51)] };
  q.coach.update({ mode: 'workout', tS: 10, paused: false, workout: ramp, ftp: FTP, intensity: 0.9, stepIndex: 0, stepElapsedS: 10, stepRemainingS: 50 });
  q.clock.t = 100;
  q.coach.update({ mode: 'workout', tS: 61, paused: false, workout: ramp, ftp: FTP, intensity: 0.9, stepIndex: 1, stepElapsedS: 1, stepRemainingS: 59 });
  assert.ok(q.texts().includes('Siguiente escalón: 115 vatios'));
});

test('test de rampa: sin "Prepárate", solo "Siguiente escalón"', () => {
  const r = rig();
  playWorkout(r, [st(60, 45), st(60, 51), st(60, 57)], { id: 'ramp-test', to: 125 });
  assert.ok(!r.texts().some((x) => x.indexOf('Prepárate') === 0));
  assert.ok(r.texts().some((x) => x.indexOf('Siguiente escalón') === 0));
});

test('resistencia larga: "Nos sentamos" sale aunque el "¡Arriba!" fuese tarde en el paso', () => {
  const r = rig();
  // el paso dura 1230 s: a los 600 s quedan 630 s (hay ¡Arriba!); a los 1200 s quedan 30 s (< 40): sin ¡Arriba! ni Nos sentamos
  playWorkout(r, [st(1230, 60)], { to: 1225 });
  const t = r.texts();
  assert.strictEqual(t.filter((x) => x.indexOf('¡Arriba!') === 0).length, 1);
  assert.strictEqual(t.filter((x) => x === 'Nos sentamos').length, 1);
  // ¡Arriba! emitido justo antes del umbral: el "Nos sentamos" debe salir aunque rem ya sea < 40
  const q = rig();
  const w = { steps: [st(1000, 60)] };
  const base = { mode: 'workout', paused: false, workout: w, ftp: FTP, stepIndex: 0 };
  q.clock.t = 0; q.coach.update(Object.assign({ tS: 600, stepElapsedS: 600, stepRemainingS: 400 }, base));
  q.clock.t = 10000; q.coach.update(Object.assign({ tS: 970, stepElapsedS: 970, stepRemainingS: 30 }, base));
  assert.ok(q.texts().includes('Nos sentamos'));
});

test('varias frases de cuenta en un mismo flush: solo la más reciente', () => {
  const w2 = { steps: [st(30, 50), st(30, 100), st(30, 50)] };
  const z = rig();
  z.coach.update({ mode: 'workout', tS: 0, paused: false, workout: w2, ftp: FTP, stepIndex: 0, stepElapsedS: 0, stepRemainingS: 30 });
  z.coach.update({ mode: 'workout', tS: 30.2, paused: false, workout: w2, ftp: FTP, stepIndex: 1, stepElapsedS: 27.1, stepRemainingS: 2.9 });
  // ¡Vamos! (cambio de paso) y Tres (cuenta del paso nuevo) coinciden: solo suena la más reciente
  assert.deepStrictEqual(z.texts().filter((x) => ['Tres', 'Dos', 'Uno', '¡Vamos!'].includes(x)), ['Tres']);
});

test('audio: no cancela si no hay nada sonando; si cancela, difiere el speak ~40 ms', () => {
  const f = fakeEnv();
  const a = C.createAudio({ env: f.env, now: f.now });
  a.unlock();
  f.env.speechSynthesis._set(false);
  const n0 = f.spoken.length;
  a.say('Tres', { priority: C.PRIORITY.COUNT });
  assert.strictEqual(f.cancelled(), 0);
  assert.strictEqual(f.spoken.length, n0 + 1);
  f.env.speechSynthesis._set(true);
  a.say('Dos', { priority: C.PRIORITY.COUNT });
  assert.strictEqual(f.cancelled(), 1);
  assert.strictEqual(f.spoken.length, n0 + 1); // aún no
  f.timers.forEach((fn) => fn());
  assert.strictEqual(f.spoken.length, n0 + 2);
  assert.strictEqual(f.spoken[f.spoken.length - 1].text, 'Dos');
});

test('audio: el watchdog mide cada frase, no el tiempo seguido hablando', () => {
  const f = fakeEnv();
  const a = C.createAudio({ env: f.env, now: f.now });
  a.unlock();
  f.env.speechSynthesis._set(false);
  a.say('A', { priority: 1 });
  const uA = f.spoken[f.spoken.length - 1];
  f.advance(7000); f.tick();
  uA.onend(); // A termina a los 7 s y empieza B enseguida
  a.say('B', { priority: 1 });
  const c0 = f.cancelled();
  f.advance(2000); f.tick(); // 9 s desde A, 2 s desde B
  assert.strictEqual(f.cancelled(), c0);
  f.advance(7000); f.tick(); // B lleva 9 s
  assert.strictEqual(f.cancelled(), c0 + 1);
});

test('audio: reanuda el contexto si no está running (iOS interrupted) y atrapa rechazos', () => {
  const f = fakeEnv();
  const a = C.createAudio({ env: f.env });
  a.unlock();
  const ctx = f.ctxs()[0];
  let resumes = 0;
  ctx.resume = () => { resumes++; return Promise.reject(new Error('x')); };
  ctx.close = () => Promise.reject(new Error('x'));
  ctx.state = 'interrupted';
  a.beep('tick');
  assert.strictEqual(resumes, 1);
  ctx.state = 'running';
  a.beep('tick');
  assert.strictEqual(resumes, 1);
  assert.doesNotThrow(() => a.dispose());
});

// ---------- tarea 15: avisos nuevos ----------
test('prioridades: cuenta > resistencia > postura > ataque > hidratación > siguiente > resto', () => {
  const P = C.PRIORITY;
  assert.ok(P.COUNT > P.RESIST && P.RESIST > P.POSTURE && P.POSTURE > P.ATTACK && P.ATTACK > P.HYDRATE && P.HYDRATE > P.NEXT && P.NEXT > P.REST);
});

test('evento resistance: nivel, sube y baja, con prioridad RESIST', () => {
  const r = rig();
  r.coach.event('resistance', { level: 5 });
  r.clock.t = 10000; r.coach.event('resistance', { level: 6, prev: 5, reason: 'pendiente' });
  r.clock.t = 20000; r.coach.event('resistance', { level: 3, prev: 6, reason: 'intervalo' });
  r.clock.t = 30000; r.coach.event('resistance', { level: 4, prev: 4 });
  assert.deepStrictEqual(r.texts(), ['Resistencia 5', 'Sube a resistencia 6', 'Baja a resistencia 3', 'Resistencia 4']);
  r.log.filter((e) => e[0] === 'say').forEach((e) => assert.strictEqual(e[2], C.PRIORITY.RESIST));
});

test('evento hydrate: avisa con la duración y dice "Seguimos" al cumplirse', () => {
  const r = rig();
  r.clock.t = 0;
  r.coach.update({ mode: 'workout', tS: 100, paused: false, workout: { steps: [st(600, 50)] }, ftp: FTP, stepIndex: 0, stepElapsedS: 0, stepRemainingS: 600, distM: 0, routeLenM: 1 });
  r.clock.t = 100000;
  r.coach.event('hydrate', { durationS: 45 });
  assert.strictEqual(r.texts().pop(), 'Hidratación: toma agua, 45 segundos');
  const upd = (tS) => { r.clock.t = tS * 1000; r.coach.update({ mode: 'workout', tS, paused: false, workout: { steps: [st(600, 50)] }, ftp: FTP, stepIndex: 0, stepElapsedS: tS - 100, stepRemainingS: 700 - tS, distM: 0, routeLenM: 1 }); };
  upd(120); assert.ok(!r.texts().includes('Seguimos'));
  upd(144); assert.ok(!r.texts().includes('Seguimos'));
  upd(146); assert.strictEqual(r.texts().filter((x) => x === 'Seguimos').length, 1);
  upd(160); assert.strictEqual(r.texts().filter((x) => x === 'Seguimos').length, 1);
  const last = r.log.filter((e) => e[1] === 'Seguimos').pop(); assert.strictEqual(last[2], C.PRIORITY.HYDRATE);
  r.coach.event('hydrate', { durationS: 90 });
  assert.strictEqual(r.texts().pop(), 'Hidratación: toma agua, 1 minuto y medio');
});

test('evento attack: inicio, alcanzado y se escapó', () => {
  const r = rig();
  r.coach.event('attack', { phase: 'start', gapS: 0 });
  r.clock.t = 5000; r.coach.event('attack', { phase: 'caught', gapS: 2 });
  r.clock.t = 10000; r.coach.event('attack', { phase: 'dropped', gapS: 30 });
  r.clock.t = 15000; r.coach.event('attack', { phase: 'end' }); // sin texto
  assert.deepStrictEqual(r.texts(), ['¡El pelotón ataca! Síguelos', 'Bien, sigues con el grupo', 'Se te escapó el grupo, ¡vamos!']);
  r.log.filter((e) => e[0] === 'say').forEach((e) => assert.strictEqual(e[2], C.PRIORITY.ATTACK));
});

test('la cola atiende por prioridad: resistencia antes que hidratación', () => {
  const r = rig();
  r.coach.event('pause'); // deja ocupado el canal
  const n = r.texts().length;
  r.coach.event('hydrate', { durationS: 30 });
  r.coach.event('attack', { phase: 'start' });
  r.coach.event('resistance', { level: 7, prev: 6 });
  r.clock.t = 5000; r.coach.event('resume');
  for (const t of [9, 14, 19]) { r.clock.t = t * 1000; r.coach.update({ mode: 'free', tS: t, paused: false }); }
  const out = r.texts().slice(n);
  assert.deepStrictEqual(out.slice(0, 3), ['Sube a resistencia 7', '¡El pelotón ataca! Síguelos', 'Hidratación: toma agua, 30 segundos']);
});

test('verbosidad esencial deja pasar resistencia, ataque e hidratación', () => {
  const r = rig('esencial');
  r.coach.event('resistance', { level: 4, prev: 3 });
  r.clock.t = 10000; r.coach.event('attack', { phase: 'start' });
  r.clock.t = 20000; r.coach.event('hydrate', { durationS: 30 });
  assert.strictEqual(r.texts().length, 3);
  const q = rig('off'); q.coach.event('resistance', { level: 4, prev: 3 });
  assert.strictEqual(q.texts().length, 0);
});

// ---------- tarea 15: voz pregrabada ----------
require('../src/voicepack.js');
function packEnv(extra) {
  const f = fakeEnv();
  const started = [], chain = [];
  const clips = {};
  globalThis.R.voicepack.VOCAB.forEach((e) => { clips[e.key] = Buffer.from('x').toString('base64'); });
  f.env.atob = (b) => Buffer.from(b, 'base64').toString('binary');
  const C0 = f.env.AudioContext;
  f.env.AudioContext = class extends C0 {
    decodeAudioData(ab) { return Promise.resolve({ duration: 0.5 }); }
    createDynamicsCompressor() { const c = { threshold: {}, ratio: {}, knee: {}, attack: {}, release: {}, connect(d) { chain.push(['comp', d]); } }; chain.push(['createComp', c]); return c; }
    createGain() { const g = { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect(d) { chain.push(['gain->', d]); } }; return g; }
    createBufferSource() { const s = { buffer: null, connect(d) { this.dest = d; }, start(t) { started.push([this, t]); }, stop() { this.stopped = true; } }; return s; }
  };
  f.env.R_VOICE = { voice: 'test', license: 'MIT', clips };
  return Object.assign(f, { started, chain });
}
const settle = () => new Promise((r) => setImmediate(r));

test('voz natural: decodifica el pack una vez, concatena clips y no usa speechSynthesis ni Audio', async () => {
  const f = packEnv();
  f.env.Audio = function () { throw new Error('no debe usarse'); };
  const a = C.createAudio({ env: f.env, volume: 1.6, now: f.now });
  a.unlock(); await settle();
  assert.strictEqual(a.say('Resistencia 5', { priority: C.PRIORITY.RESIST }), true);
  assert.strictEqual(f.started.length, 2);
  assert.strictEqual(f.spoken.filter((u) => u.text.trim()).length, 0);
  // clips consecutivos sin solaparse
  assert.ok(f.started[1][1] > f.started[0][1] + 0.5 - 1e-9);
  // cadena: Gain(volumen) -> compresor -> destino
  const comp = f.chain.find((c) => c[0] === 'createComp')[1];
  assert.strictEqual(comp.threshold.value, -18); assert.strictEqual(comp.ratio.value, 4); assert.strictEqual(comp.knee.value, 6);
  assert.ok(f.chain.some((c) => c[0] === 'comp' && c[1] === f.ctxs()[0].destination));
  assert.strictEqual(f.started[0][0].dest.gain.value, 1.6);
  a.setVolume(2); assert.strictEqual(f.started[0][0].dest.gain.value, 2);
});

test('voz natural: frase no componible o natural=false cae a speechSynthesis', async () => {
  const f = packEnv();
  const a = C.createAudio({ env: f.env, now: f.now });
  a.unlock(); await settle();
  a.say('No pudimos guardar la rodada', { priority: 1 });
  assert.strictEqual(f.started.length, 0);
  assert.strictEqual(f.spoken[f.spoken.length - 1].text, 'No pudimos guardar la rodada');
  a.setEnabled({ natural: false });
  a.say('Pausa', { priority: 1 });
  assert.strictEqual(f.started.length, 0);
  assert.strictEqual(f.spoken[f.spoken.length - 1].text, 'Pausa');
  // el volumen de speechSynthesis se limita a 1
  a.setVolume(2); a.say('Seguimos', { priority: 1 });
  assert.strictEqual(f.spoken[f.spoken.length - 1].volume, 1);
});

test('voz natural: sin pack o antes de decodificar usa speechSynthesis; la cuenta corta lo que suena', async () => {
  const f0 = packEnv(); delete f0.env.R_VOICE;
  const a0 = C.createAudio({ env: f0.env }); a0.unlock(); a0.say('Pausa', { priority: 1 });
  assert.strictEqual(f0.started.length, 0);
  const f = packEnv();
  const a = C.createAudio({ env: f.env, now: f.now });
  a.unlock();
  a.say('Pausa', { priority: 1 }); // aún decodificando
  assert.strictEqual(f.started.length, 0);
  await settle();
  a.say('Hidratación: toma agua, 45 segundos', { priority: C.PRIORITY.HYDRATE });
  const first = f.started.slice();
  a.say('Tres', { priority: C.PRIORITY.COUNT });
  assert.ok(first.every((s) => s[0].stopped), 'la cuenta regresiva corta el aviso en curso');
});

test('voz natural: test() espera la decodificación y reproduce clips del pack', async () => {
  const f = packEnv();
  const a = C.createAudio({ env: f.env, now: f.now });
  a.test();
  await settle(); await settle();
  assert.ok(f.started.length >= 5);
});

test('voz natural: setEnabled({voice:false}) y stop() detienen los clips programados y liberan la cola', async () => {
  const f = packEnv();
  const a = C.createAudio({ env: f.env, now: f.now });
  a.unlock(); await settle();
  a.say('Hidratación: toma agua, 45 segundos', { priority: C.PRIORITY.HYDRATE });
  const first = f.started.slice();
  assert.ok(first.length >= 2);
  a.setEnabled({ voice: false });
  assert.ok(first.every((s) => s[0].stopped), 'voice:false detiene los nodos');
  a.setEnabled({ voice: true });
  const n0 = f.started.length;
  a.say('Pausa', { priority: 1 });
  const s2 = f.started.slice(n0);
  assert.ok(s2.length >= 1 && s2[0][1] <= f.ctxs()[0].currentTime + 0.05, 'la cola quedó libre (nextFree = ahora)');
  a.stop();
  assert.ok(s2.every((s) => s[0].stopped), 'stop() detiene lo programado (pausa)');
});

test('voz natural: caché de AudioBuffer a nivel de módulo; precarga vamos y 1..3 primero', async () => {
  const f = packEnv();
  const order = [];
  const Base = f.env.AudioContext;
  f.env.AudioContext = class extends Base {
    decodeAudioData(ab) { order.push(1); return super.decodeAudioData(ab); }
  };
  // clips distinguibles para conocer el orden de decodificación
  const keys = Object.keys(f.env.R_VOICE.clips);
  const seq = [];
  keys.forEach((k) => { f.env.R_VOICE.clips[k] = Buffer.from(k).toString('base64'); });
  f.env.AudioContext = class extends Base {
    decodeAudioData(ab) { seq.push(Buffer.from(ab).toString()); return Promise.resolve({ duration: 0.5 }); }
  };
  const a1 = C.createAudio({ env: f.env, now: f.now });
  a1.unlock();
  assert.deepStrictEqual(seq.slice(0, 4), ['vamos', 'n1', 'n2', 'n3']);
  await settle(); await settle();
  const total = seq.length;
  assert.strictEqual(total, keys.length);
  a1.dispose();
  const a2 = C.createAudio({ env: f.env, now: f.now });
  a2.unlock(); await settle();
  assert.strictEqual(seq.length, total, 'otra instancia reutiliza los buffers sin decodificar');
  assert.strictEqual(a2.say('Tres, dos, uno', { priority: C.PRIORITY.COUNT }), true);
  assert.strictEqual(f.spoken.filter((u) => u.text.trim()).length, 0, 'sin respaldo a speechSynthesis');
});

test('ride.js pasa natural a createAudio y a setEnabled; la pausa llama audio.stop()', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'ride.js'), 'utf8');
  assert.match(src, /createAudio\(\{[^}]*natural: cs\.natural/);
  assert.match(src, /audio\.setEnabled\(\{[^}]*natural: cs\.natural/);
  assert.match(src, /audio\.stop\(\)/);
});
