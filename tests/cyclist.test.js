'use strict';
const test = require('node:test');
const assert = require('node:assert');

require('../src/cyclist.js');
const C = globalThis.R.cyclist;

test('classifyWheelNode: piezas de rueda por nombre (Trasera/Delantera)', () => {
  assert.equal(C.classifyWheelNode('Neumatico Trasera'), 'rear');
  assert.equal(C.classifyWheelNode('Llanta Delantera'), 'front');
  assert.equal(C.classifyWheelNode('Buje Trasera'), 'rear');
  assert.equal(C.classifyWheelNode('Radio Delantera.017'), 'front');
  assert.equal(C.classifyWheelNode('Disco freno Trasera'), 'rear');
  assert.equal(C.classifyWheelNode('Rueda Delantera · Caucho'), 'front');
});

test('classifyWheelNode: acepta nombres saneados por three.js y acentos', () => {
  assert.equal(C.classifyWheelNode('Neumatico_Trasera'), 'rear');
  assert.equal(C.classifyWheelNode('Radio_Delantera001'), 'front');
  assert.equal(C.classifyWheelNode('Neumático Trasera'), 'rear');
  assert.equal(C.classifyWheelNode('Rueda_Trasera_·_Aluminio'), 'rear');
});

test('classifyWheelNode: sin lado en el nombre decide por posicion (z>0 trasera)', () => {
  assert.equal(C.classifyWheelNode('Soporte disco.003', { x: -0.055, y: 0.35, z: 0.605 }), 'rear');
  assert.equal(C.classifyWheelNode('Soporte disco.009', { x: -0.055, y: 0.35, z: -0.515 }), 'front');
  assert.equal(C.classifyWheelNode('Pinon.004', { x: 0.08, y: 0.35, z: 0.57 }), 'rear');
  assert.equal(C.classifyWheelNode('Soporte disco'), null);
});

test('classifyWheelNode: lo que no es rueda devuelve null', () => {
  for (const n of ['Muslo -1', 'Biela 1', 'Pedal -1', 'Tubo cuadro', 'Plato', 'Cadena', 'Horquilla', 'Vaina', 'Rostro proyectado', 'Cuerpo · Aluminio']) {
    assert.equal(C.classifyWheelNode(n, { x: 0, y: 0.3, z: 0.5 }), null, n);
  }
});

test('cadenceTimeScale: rpm/60, pausa con 0 rpm o detenido', () => {
  assert.equal(C.cadenceTimeScale(60, 5), 1);
  assert.equal(C.cadenceTimeScale(90, 8), 1.5);
  assert.equal(C.cadenceTimeScale(0, 8), 0);
  assert.equal(C.cadenceTimeScale(90, 0), 0);
  assert.equal(C.cadenceTimeScale(90, 0.1), 0);
  assert.equal(C.cadenceTimeScale(NaN, 5), 0);
  assert.equal(C.cadenceTimeScale(null, 5), 0);
  assert.equal(C.cadenceTimeScale(75), 1.25);       // sin velocidad conocida: solo cadencia
});

test('riderCadence: usa cadenceRpm si viene; bots/fantasma 85–95 rpm estables por id', () => {
  assert.equal(C.riderCadence('user', 82, 7, 'user'), 82);
  assert.equal(C.riderCadence('user', 0, 7, 'user'), 0);
  assert.equal(C.riderCadence('user', null, 7, 'user'), 90);
  assert.equal(C.riderCadence('bot', null, 0, 'b1'), 0);
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const c = C.riderCadence('bot', undefined, 8, 'bot-' + i);
    assert.ok(c >= 85 && c <= 95, String(c));
    assert.equal(C.riderCadence('bot', undefined, 9, 'bot-' + i), c);
    seen.add(c);
  }
  assert.ok(seen.size > 3, 'con variacion entre bots');
  const g = C.riderCadence('ghost', undefined, 8, 'ghost');
  assert.ok(g >= 85 && g <= 95);
});

test('wheelOmega: v / r con r por defecto 0,34 m', () => {
  assert.ok(Math.abs(C.wheelOmega(10, 0.35) - 10 / 0.35) < 1e-9);
  assert.ok(Math.abs(C.wheelOmega(6.8) - 20) < 1e-9);
  assert.equal(C.wheelOmega(0, 0.35), 0);
  assert.equal(C.wheelOmega(-1, 0.35), 0);
});

test('chooseLod: modelo a < 60 m, procedural lejos, con histeresis', () => {
  const base = { kind: 'bot', quality: 'alta', modelReady: true };
  assert.equal(C.chooseLod({ ...base, distM: 10, prev: 'proc' }), 'model');
  assert.equal(C.chooseLod({ ...base, distM: 59.9, prev: 'proc' }), 'model');
  assert.equal(C.chooseLod({ ...base, distM: 60, prev: 'proc' }), 'proc');
  assert.equal(C.chooseLod({ ...base, distM: 62, prev: 'model' }), 'model');
  assert.equal(C.chooseLod({ ...base, distM: 64.5, prev: 'model' }), 'proc');
  assert.equal(C.chooseLod({ ...base, distM: 500, prev: 'model' }), 'proc');
});

test('chooseLod: sin modelo listo siempre procedural', () => {
  assert.equal(C.chooseLod({ kind: 'user', quality: 'alta', distM: 5, modelReady: false }), 'proc');
  assert.equal(C.chooseLod(null), 'proc');
});

test('chooseLod: en calidad baja solo usuario y fantasma usan el modelo', () => {
  assert.equal(C.chooseLod({ kind: 'user', quality: 'baja', distM: 12, modelReady: true }), 'model');
  assert.equal(C.chooseLod({ kind: 'ghost', quality: 'baja', distM: 12, modelReady: true }), 'model');
  assert.equal(C.chooseLod({ kind: 'bot', quality: 'baja', distM: 12, modelReady: true }), 'proc');
  assert.equal(C.chooseLod({ kind: 'bot', quality: 'media', distM: 12, modelReady: true }), 'model');
  assert.equal(C.chooseLod({ kind: 'ghost', quality: 'baja', distM: 80, modelReady: true }), 'proc');
});

test('botTeam: paleta de 6–8 equipos distintos, sin colores de usuario ni fantasma', () => {
  assert.ok(C.BOT_TEAMS.length >= 6 && C.BOT_TEAMS.length <= 8);
  const jerseys = new Set(C.BOT_TEAMS.map((t) => t.jersey));
  assert.equal(jerseys.size, C.BOT_TEAMS.length);
  for (const t of C.BOT_TEAMS) {
    assert.notEqual(t.jersey, 0xFF5A1F);
    assert.notEqual(t.jersey, 0xFFD23F);
  }
  const first = [0, 1, 2, 3, 4, 5].map((i) => C.botTeam(i).name);
  assert.equal(new Set(first).size, 6, 'los primeros 6 bots tienen equipos distintos');
  assert.equal(C.botTeam(-1, 'abc'), C.botTeam(-1, 'abc'));
});

test('materialRole: reconoce los materiales del modelo', () => {
  assert.equal(C.materialRole('Rostro fotografia de referencia', true), 'face');
  assert.equal(C.materialRole('Cualquiera', true), 'face');
  assert.equal(C.materialRole('Montura lentes', false), 'lenses');
  assert.equal(C.materialRole('Maillot azul petroleo', false), 'jersey');
  assert.equal(C.materialRole('Cuadro azul grafito', false), 'frame');
  assert.equal(C.materialRole('Cabello entrecano', false), 'hair');
  assert.equal(C.materialRole('Piel', false), 'skin');
  assert.equal(C.materialRole('Aluminio', false), 'other');
});
