'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../src/physics.js');
const P = globalThis.R.physics;
const kmh = (v) => v * 3.6;

test('250 W llano 78 kg ~36-39 km/h', () => {
  const v = kmh(P.speedFromPower({ powerW: 250, gradePct: 0, massKg: 78 }));
  assert.ok(v >= 36 && v <= 39, v);
});
test('250 W al 8 % ~12-14 km/h', () => {
  const v = kmh(P.speedFromPower({ powerW: 250, gradePct: 8, massKg: 78 }));
  assert.ok(v >= 12 && v <= 14, v);
});
test('inverso consistente +-1 %', () => {
  for (const g of [-3, 0, 4, 10]) {
    const v = P.speedFromPower({ powerW: 220, gradePct: g, massKg: 85, altitudeM: 1500 });
    const w = P.powerForSpeed({ speedMps: v, gradePct: g, massKg: 85, altitudeM: 1500 });
    assert.ok(Math.abs(w - 220) / 220 < 0.01, `${g}: ${w}`);
  }
});
test('potencia 0: llano 0, bajada velocidad terminal', () => {
  assert.ok(P.speedFromPower({ powerW: 0, gradePct: 0, massKg: 80 }) < 1e-6);
  assert.ok(P.speedFromPower({ powerW: 0, gradePct: 5, massKg: 80 }) < 1e-6);
  const vt = P.speedFromPower({ powerW: 0, gradePct: -6, massKg: 80 });
  assert.ok(vt > 10 && vt < 30, vt);
  assert.ok(Math.abs(P.powerForSpeed({ speedMps: vt, gradePct: -6, massKg: 80 })) < 1);
});
test('altitud y viento', () => {
  const base = P.speedFromPower({ powerW: 250, gradePct: 0, massKg: 78 });
  assert.ok(P.speedFromPower({ powerW: 250, gradePct: 0, massKg: 78, altitudeM: 2000 }) > base);
  assert.ok(P.speedFromPower({ powerW: 250, gradePct: 0, massKg: 78, windMps: 5 }) < base);
  assert.ok(P.speedFromPower({ powerW: 250, gradePct: 0, massKg: 78, windMps: -5 }) > base);
});
test('step converge a speedFromPower con distintos dt', () => {
  for (const [dt, steps] of [[0.05, 1200], [1, 120]]) {
    for (const g of [0, 8, -2]) {
      let v = 0;
      for (let i = 0; i < steps; i++) v = P.step({ v, powerW: 250, gradePct: g, massKg: 78, altitudeM: 0, dt });
      const ss = P.speedFromPower({ powerW: 250, gradePct: g, massKg: 78 });
      assert.ok(Math.abs(v - ss) / ss < 0.02, `dt ${dt} g ${g}: ${v} vs ${ss}`);
    }
  }
});
test('step con inercia: no salta de golpe y no explota', () => {
  const v1 = P.step({ v: 0, powerW: 300, gradePct: 0, massKg: 78, altitudeM: 0, dt: 1 });
  assert.ok(v1 > 0 && v1 < 8, v1);
  const v2 = P.step({ v: 10, powerW: 0, gradePct: 0, massKg: 78, altitudeM: 0, dt: 1 });
  assert.ok(v2 < 10 && v2 > 9, v2);
  assert.ok(Number.isFinite(P.step({ v: 0, powerW: 2000, gradePct: 20, massKg: 70, altitudeM: 0, dt: 1 })));
});
test('kcalFromWork', () => {
  assert.ok(Math.abs(P.kcalFromWork(1000) - 996) < 5);
  assert.strictEqual(P.kcalFromWork(0), 0);
});
