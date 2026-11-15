'use strict';
const test = require('node:test');
const assert = require('node:assert');
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
  const workout = { steps };
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
  assert.deepStrictEqual(C.normalizeSettings(undefined), { voice: true, beeps: true, volume: 0.9, verbosity: 'completo' });
  assert.deepStrictEqual(C.normalizeSettings({ volume: 5, verbosity: 'x', voice: false }), { voice: false, beeps: true, volume: 1, verbosity: 'completo' });
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
  let cancelled = 0, speaking = false, t = 0, intervalFn = null;
  class Utter { constructor(text) { this.text = text; } }
  class Ctx {
    constructor() { order.push('ctx'); this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() {}
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    createOscillator() { const o = { frequency: {}, connect() {}, start() {}, stop() {} }; osc.push(o); return o; }
  }
  const navigator = {};
  Object.defineProperty(navigator, 'audioSession', { value: { set type(v) { order.push('session:' + v); } }, enumerable: true });
  const env = {
    navigator, AudioContext: Ctx, SpeechSynthesisUtterance: Utter,
    speechSynthesis: { getVoices: () => [{ lang: 'es-CL', name: 'Chile' }], speak: (u) => { spoken.push(u); speaking = true; }, cancel: () => { cancelled++; speaking = false; }, get speaking() { return speaking; } },
    setInterval: (fn) => { intervalFn = fn; return 1; }, clearInterval() {},
  };
  return { env, spoken, osc, order, now: () => t, advance: (ms) => { t += ms; }, cancelled: () => cancelled, tick: () => intervalFn && intervalFn() };
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
