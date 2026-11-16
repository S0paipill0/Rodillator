'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../src/trainer.js');
const T = globalThis.R.trainer;

test('constantes: 8 niveles, nivel 3 = llano', () => {
  assert.strictEqual(T.LEVELS, 8);
  assert.strictEqual(T.levelForGrade(0), 3);
});

test('levelForGrade: umbrales exactos del contrato', () => {
  const cases = [[-12, 1], [-3, 1], [-2.9, 2], [-1, 2], [-0.9, 3], [0, 3], [1.5, 3], [1.6, 4], [3.5, 4], [3.6, 5], [5.5, 5],
    [5.6, 6], [7.5, 6], [7.6, 7], [10, 7], [10.1, 8], [18, 8], [NaN, 3]];
  cases.forEach(([g, l]) => assert.strictEqual(T.levelForGrade(g), l, 'pendiente ' + g));
});

test('powerFromSpeed: ancla nivel 3 a 29 km/h ≈ 180–200 W y nivel 8 a 20 km/h ≈ 300–350 W', () => {
  const p3 = T.powerFromSpeed({ speedKph: 29, level: 3 });
  assert.ok(p3 >= 180 && p3 <= 200, 'p3=' + p3);
  assert.ok(Math.abs(p3 - 192) < 1);
  const p8 = T.powerFromSpeed({ speedKph: 20, level: 8 });
  assert.ok(p8 >= 300 && p8 <= 350, 'p8=' + p8);
});

test('powerFromSpeed: monótona en nivel y velocidad; escalones de 12–25 % entre niveles', () => {
  for (const k of [15, 20, 25, 29, 35]) {
    let prev = 0;
    for (let l = 1; l <= 8; l++) {
      const p = T.powerFromSpeed({ speedKph: k, level: l });
      assert.ok(p > prev);
      if (l > 1) { const r = p / prev; assert.ok(r > 1.1 && r < 1.26, 'razón ' + r + ' nivel ' + l + ' a ' + k); }
      prev = p;
    }
  }
  assert.strictEqual(T.powerFromSpeed({ speedKph: 0, level: 5 }), 0);
});

test('powerScale escala la curva; nivel fuera de rango se acota', () => {
  const base = T.powerFromSpeed({ speedKph: 25, level: 4 });
  assert.ok(Math.abs(T.powerFromSpeed({ speedKph: 25, level: 4, powerScale: 1.1 }) - base * 1.1) < 1e-9);
  assert.strictEqual(T.powerFromSpeed({ speedKph: 25, level: 99 }), T.powerFromSpeed({ speedKph: 25, level: 8 }));
  assert.strictEqual(T.powerFromSpeed({ speedKph: 25, level: -2 }), T.powerFromSpeed({ speedKph: 25, level: 1 }));
});

test('speedFromPower es la inversa de powerFromSpeed', () => {
  for (let l = 1; l <= 8; l++) for (const k of [12, 20, 29, 38]) {
    const p = T.powerFromSpeed({ speedKph: k, level: l, powerScale: 0.95 });
    assert.ok(Math.abs(T.speedFromPower({ powerW: p, level: l, powerScale: 0.95 }) - k) < 1e-6);
  }
  assert.strictEqual(T.speedFromPower({ powerW: 0, level: 3 }), 0);
});

test('levelForTarget: cadencia 90 rpm (50×17, 2070 mm ≈ 32,9 km/h)', () => {
  // P(32,9 km/h) por nivel ≈ 179, 200, 221, 252, 291, 342, 410, 502 W (ver informe)
  assert.strictEqual(T.levelForTarget({ targetW: 150 }), 1);
  assert.strictEqual(T.levelForTarget({ targetW: 200 }), 2);
  assert.strictEqual(T.levelForTarget({ targetW: 221 }), 3);
  assert.strictEqual(T.levelForTarget({ targetW: 250 }), 4);
  assert.strictEqual(T.levelForTarget({ targetW: 300 }), 5);
  assert.strictEqual(T.levelForTarget({ targetW: 400 }), 7);
  assert.strictEqual(T.levelForTarget({ targetW: 900 }), 8);
});

test('levelForTarget: menor cadencia exige nivel más alto para la misma potencia', () => {
  const hi = T.levelForTarget({ targetW: 250, cadenceRpm: 100 });
  const lo = T.levelForTarget({ targetW: 250, cadenceRpm: 70 });
  assert.ok(lo > hi);
  assert.strictEqual(T.levelForTarget({ targetW: 250, cadenceRpm: 70 }), 6);
});

test('levelForTarget: sin objetivo usa ftp o nivel de llano', () => {
  assert.strictEqual(T.levelForTarget({ ftp: 250 }), T.levelForTarget({ targetW: 250 }));
  assert.strictEqual(T.levelForTarget({}), 3);
  assert.strictEqual(T.levelForTarget({ targetW: 0 }), 1);
  assert.strictEqual(T.levelForTarget({ targetW: 0, ftp: 250 }), 1);
});

test('virtualGradePct coherente con levelForGrade', () => {
  assert.strictEqual(T.virtualGradePct({ level: 3 }), 0);
  for (let l = 1; l <= 8; l++) assert.strictEqual(T.levelForGrade(T.virtualGradePct({ level: l })), l);
  assert.ok(T.virtualGradePct({ level: 8 }) > T.virtualGradePct({ level: 7 }));
});

test('calibrate: firma presente, aún no ajusta', () => {
  const r = T.calibrate([{ speedKph: 20, level: 3, powerW: 120 }]);
  assert.strictEqual(r.calibrated, false);
  assert.strictEqual(r.powerScale, 1);
});
