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

test('chooseLod (alta): usuario/fantasma con modelo a < 60 m; 5 bots mas cercanos con modelo; luego proc y lite; histeresis', () => {
  const L = (d, prev, kind = 'bot', rank = 0) => C.chooseLod(d, kind, 'alta', prev, true, rank);
  assert.equal(L(10, 'proc'), 'model');
  assert.equal(L(59.9, 'proc'), 'model');
  assert.equal(L(60, 'proc'), 'lite', 'bot a >= 45 m: lite');
  assert.equal(L(62, 'model'), 'model');
  assert.equal(L(64.5, 'model'), 'lite');
  assert.equal(L(40, 'proc', 'bot', 4), 'model');
  assert.equal(L(40, 'proc', 'bot', 5), 'proc', 'sexto bot: procedural');
  assert.equal(L(40, 'model', 'bot', 5), 'model', 'histeresis de orden');
  assert.equal(L(40, 'proc', 'bot', 8), 'proc');
  assert.equal(L(40, 'lite', 'bot', 9), 'lite');
  assert.equal(L(20, 'proc', 'bot', 19), 'lite');
  assert.equal(L(60, 'proc', 'user', -1), 'proc');
  assert.equal(L(40, 'proc', 'user', -1), 'model');
  assert.equal(L(40, 'proc', 'ghost', -1), 'model');
});

test('chooseLod: sin modelo listo o distancia invalida, procedural', () => {
  assert.equal(C.chooseLod(5, 'user', 'alta', 'proc', false, -1), 'proc');
  assert.equal(C.chooseLod(NaN, 'user', 'alta', 'proc', true, -1), 'proc');
  assert.equal(C.chooseLod(undefined, 'bot', 'alta', 'proc', true, 0), 'proc');
});

test('chooseLod (media): usuario y fantasma a < 60 m; solo los 3 bots mas cercanos y a < 30 m', () => {
  const M = (d, kind, rank, prev = 'proc') => C.chooseLod(d, kind, 'media', prev, true, rank);
  assert.equal(M(50, 'user', -1), 'model');
  assert.equal(M(50, 'ghost', -1), 'model');
  assert.equal(M(10, 'bot', 0), 'model');
  assert.equal(M(29, 'bot', 2), 'model');
  assert.equal(M(10, 'bot', 3), 'proc', 'cuarto bot mas cercano');
  assert.equal(M(10, 'bot', 7, 'lite'), 'lite', 'desde el orden 7: lite');
  assert.equal(M(10, 'bot', 7), 'proc', 'histeresis de orden desde procedural');
  assert.equal(M(30, 'bot', 0), 'proc');
  assert.equal(M(32, 'bot', 0, 'model'), 'model', 'histeresis');
  assert.equal(M(35, 'bot', 0, 'model'), 'proc');
  assert.equal(M(10, 'bot', -1), 'proc');
});

test('chooseLod (baja): solo usuario y fantasma usan el modelo', () => {
  assert.equal(C.chooseLod(12, 'user', 'baja', 'proc', true, -1), 'model');
  assert.equal(C.chooseLod(12, 'ghost', 'baja', 'proc', true, -1), 'model');
  assert.equal(C.chooseLod(12, 'bot', 'baja', 'proc', true, 0), 'proc');
  assert.equal(C.chooseLod(12, 'bot', 'baja', 'lite', true, 5), 'lite');
  assert.equal(C.chooseLod(80, 'ghost', 'baja', 'proc', true, -1), 'proc');
});

test('castsShadow: alta usuario, fantasma y bots a < 12 m; media y baja solo el usuario', () => {
  assert.equal(C.castsShadow('user', 'alta', 50), true);
  assert.equal(C.castsShadow('ghost', 'alta', 50), true);
  assert.equal(C.castsShadow('bot', 'alta', 11.9), true);
  assert.equal(C.castsShadow('bot', 'alta', 12), false);
  assert.equal(C.castsShadow('bot', 'alta', 5, 1), true);
  assert.equal(C.castsShadow('bot', 'alta', 5, 2), false, 'solo los 2 bots mas cercanos');
  assert.equal(C.castsShadow('user', 'media', 5), true);
  assert.equal(C.castsShadow('ghost', 'media', 5), false);
  assert.equal(C.castsShadow('bot', 'media', 5), false);
  assert.equal(C.castsShadow('user', 'baja', 5), true);
  assert.equal(C.castsShadow('bot', 'baja', 5), false);
  assert.equal(typeof C.castsShadow('bot', 'alta', 5), 'boolean');
});

test('shouldReleaseModel: solo bots a mas de 100 m', () => {
  assert.equal(C.shouldReleaseModel('bot', 100.5), true);
  assert.equal(C.shouldReleaseModel('bot', 99), false);
  assert.equal(C.shouldReleaseModel('user', 500), false);
  assert.equal(C.shouldReleaseModel('ghost', 500), false);
});

test('wrapAngle: mantiene el angulo acotado sin cambiar su valor modulo 2pi', () => {
  const a = -1000.3;
  const w = C.wrapAngle(a);
  assert.ok(Math.abs(w) < Math.PI * 2);
  assert.ok(Math.abs(Math.cos(w) - Math.cos(a)) < 1e-9 && Math.abs(Math.sin(w) - Math.sin(a)) < 1e-9);
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

test('chooseLod: pelotón de 20 - cuenta de niveles por calidad (presupuesto de draw calls)', () => {
  const count = (q) => {
    const c = { model: 0, proc: 0, lite: 0 };
    for (let rank = 0; rank < 18; rank++) c[C.chooseLod(10 + rank, 'bot', q, 'lite', true, rank)]++;
    return c;
  };
  assert.deepEqual(count('alta'), { model: 5, proc: 4, lite: 9 });
  assert.deepEqual(count('media'), { model: 3, proc: 4, lite: 11 });
  assert.deepEqual(count('baja'), { model: 0, proc: 5, lite: 13 });
});
