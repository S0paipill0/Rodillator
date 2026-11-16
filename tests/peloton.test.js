'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../src/physics.js');
require('../src/routes.js');
require('../src/riders.js');
const R = globalThis.R;

// ruta sintética de 40 km con ondulaciones suaves
function makeRoute(lenM = 40000) {
  const points = [];
  for (let d = 0; d <= lenM; d += 20) points.push([-33.4 + d * 9e-6, -70.6, 500 + 30 * Math.sin(d / 1500), d]);
  return { id: 'sint', name: 'Sintética', distanceM: lenM, points };
}
const route = makeRoute();

// simula un usuario que rueda a velocidad fija; devuelve eventos y trazas
function sim({ seed = 7, count = 14, userKph = 30, seconds = 3600, rt = route, userFn, ftp = 250 } = {}) {
  const events = [];
  const p = R.riders.createPeloton({ count, ftp, massKg: 80, route: rt, seed, onAttack: (phase, info) => events.push(Object.assign({ phase }, info)) });
  let ud = 0;
  const trace = [];
  const prev = new Map();
  let maxJump = 0;
  for (let t = 0; t < seconds; t++) {
    ud = userFn ? userFn(t, ud) : Math.min(rt.distanceM, ud + userKph / 3.6);
    p.update(1, t, ud);
    p.bots.forEach((b) => {
      if (prev.has(b.id)) maxJump = Math.max(maxJump, Math.abs(b.distM - prev.get(b.id)));
      prev.set(b.id, b.distM);
    });
    trace.push({ t, ud, gap: p.state.gapS, attacking: p.state.attacking });
  }
  return { p, events, trace, maxJump, ud };
}

test('composición de grupos y escala con count 8–20', () => {
  [[8, [4, 2, 2]], [14, [8, 3, 3]], [20, [12, 4, 4]]].forEach(([c, [m, e, r]]) => {
    const p = R.riders.createPeloton({ count: c, ftp: 250, massKg: 80, route, seed: 3 });
    assert.strictEqual(p.bots.length, c);
    const g = p.state.groupIds;
    assert.deepStrictEqual([g.principal.length, g.escapada.length, g.rezagados.length], [m, e, r]);
    assert.strictEqual(new Set(g.principal.concat(g.escapada, g.rezagados)).size, c);
    p.bots.forEach((b) => assert.ok(['principal', 'escapada', 'rezagados'].includes(b.group)));
  });
  assert.strictEqual(R.riders.createPeloton({ count: 3, ftp: 250, massKg: 80, route }).bots.length, 8);
  assert.strictEqual(R.riders.createPeloton({ count: 99, ftp: 250, massKg: 80, route }).bots.length, 20);
});

test('determinismo por seed', () => {
  const a = sim({ seed: 11, seconds: 1500 }), b = sim({ seed: 11, seconds: 1500 }), c = sim({ seed: 12, seconds: 1500 });
  assert.deepStrictEqual(a.events, b.events);
  assert.deepStrictEqual(a.p.bots.map((x) => x.distM), b.p.bots.map((x) => x.distM));
  assert.notDeepStrictEqual(a.events.map((e) => e.tS), c.events.map((e) => e.tS));
});

test('ataques: cada 6–12 min, 30–90 s, no en los primeros 4 min, start→end', () => {
  const { events } = sim({ seed: 5, seconds: 3600 });
  const starts = events.filter((e) => e.phase === 'start'), ends = events.filter((e) => e.phase === 'end');
  assert.ok(starts.length >= 4 && starts.length <= 10, 'ataques: ' + starts.length);
  assert.ok(starts[0].tS >= 240);
  for (let i = 1; i < starts.length; i++) {
    const d = (starts[i].tS - starts[i - 1].tS) / 60;
    assert.ok(d >= 6 - 0.02 && d <= 12 + 0.02, 'intervalo ' + d);
  }
  starts.forEach((s) => { assert.ok(s.durS >= 30 && s.durS <= 90); assert.ok(s.powerBoostPct >= 25 && s.powerBoostPct <= 35); });
  assert.ok(Math.abs(starts.length - ends.length) <= 1);
  ends.forEach((e, i) => { assert.ok(Math.abs(e.durS - starts[i].durS) <= 1.01); });
  // orden: start, end, (caught|dropped)?, start, ...
  let open = false;
  events.forEach((e) => {
    if (e.phase === 'start') { assert.ok(!open); open = true; }
    else if (e.phase === 'end') { assert.ok(open); open = false; }
    else assert.ok(!open);
  });
});

test('state refleja el ataque en curso', () => {
  const p = R.riders.createPeloton({ count: 14, ftp: 250, massKg: 80, route, seed: 5 });
  let ud = 0, sawAttack = false, sawEnd = false;
  for (let t = 0; t < 3000; t++) {
    ud += 30 / 3.6; p.update(1, t, ud);
    if (p.state.attacking) { sawAttack = true; assert.strictEqual(p.state.phase, 'start'); assert.ok(p.state.endsAtS > t - 1); }
    if (p.state.phase === 'end') { sawEnd = true; assert.strictEqual(p.state.attacking, false); }
  }
  assert.ok(sawAttack && sawEnd);
  assert.ok(Array.isArray(p.state.groupIds.principal));
});

test('durante el ataque el grupo principal se escapa; gapS crece y el usuario pasivo queda atrás', () => {
  const { trace, events } = sim({ seed: 5, seconds: 1500, userKph: 30 });
  const s = events.find((e) => e.phase === 'start');
  const t0 = Math.floor(s.tS), t1 = Math.min(1499, Math.floor(s.tS + s.durS));
  assert.ok(trace[t1].gap > trace[t0].gap + 2, 'gap ' + trace[t0].gap + ' → ' + trace[t1].gap);
});

test('caught si el usuario sigue al grupo, dropped si se queda (tras el ataque)', () => {
  // el usuario sigue la rueda del grupo principal (misma velocidad) → caught
  const follow = [];
  const pF = R.riders.createPeloton({ count: 14, ftp: 250, massKg: 80, route, seed: 5, onAttack: (ph, i) => follow.push({ ph, gap: i.gapS }) });
  let ud = 0;
  for (let t = 0; t < 2000; t++) {
    const main = pF.bots.filter((b) => b.group === 'principal');
    const mean = main.reduce((a, b) => a + b.distM, 0) / main.length;
    ud = pF.state.attacking ? Math.max(ud, mean - 10) : ud + 30 / 3.6; // sigue al grupo mientras ataca
    pF.update(1, t, ud);
  }
  assert.ok(follow.some((e) => e.ph === 'caught'));
  assert.ok(!follow.some((e) => e.ph === 'dropped'));
  // usuario casi detenido → dropped
  const { events } = sim({ seed: 5, seconds: 2000, userFn: (t, d) => d + 1.5 });
  assert.ok(events.some((e) => e.phase === 'dropped'));
  assert.ok(!events.some((e) => e.phase === 'caught'));
  events.filter((e) => e.phase === 'caught').forEach((e) => assert.ok(e.gapS < 5));
  events.filter((e) => e.phase === 'dropped').forEach((e) => assert.ok(e.gapS > 10));
});

test('sin ataques en los últimos 2 km de la ruta', () => {
  const short = makeRoute(12000);
  const { events } = sim({ seed: 9, seconds: 2400, rt: short, userKph: 30 });
  assert.ok(events.length > 0);
  // el usuario llega a la meta; ningún ataque nace con menos de 2 km por delante
  events.filter((e) => e.phase === 'start').forEach((e) => assert.ok(e.tS * (30 / 3.6) <= 12000 - 2000 + 30));
  const tiny = makeRoute(1900);
  assert.strictEqual(sim({ seed: 9, seconds: 1200, rt: tiny }).events.length, 0);
});

test('elástico: siempre hay compañía y no hay teletransportes', () => {
  const { p, maxJump, ud } = sim({ seed: 21, seconds: 3000, userKph: 28, rt: makeRoute(60000) });
  // velocidad máx. razonable: 25 m/s → salto por tick < 25 m
  assert.ok(maxJump < 25, 'salto máx ' + maxJump);
  const near = p.bots.filter((b) => Math.abs(b.distM - ud) < 300).length;
  assert.ok(near >= p.bots.length * 0.6, 'cerca: ' + near + '/' + p.bots.length);
  p.bots.forEach((b) => { assert.ok(b.distM >= 0); assert.ok(isFinite(b.speedMps)); });
});

test('la escapada va por delante y los rezagados por detrás fuera de ataques', () => {
  const p = R.riders.createPeloton({ count: 14, ftp: 250, massKg: 80, route, seed: 4 });
  let ud = 0;
  for (let t = 0; t < 200; t++) { ud += 30 / 3.6; p.update(1, t, ud); }
  const byId = new Map(p.bots.map((b) => [b.id, b]));
  p.state.groupIds.escapada.forEach((id) => assert.ok(byId.get(id).distM > ud + 30));
  p.state.groupIds.rezagados.forEach((id) => assert.ok(byId.get(id).distM < ud - 20));
});

test('bots son compatibles con el contrato de rider para la escena', () => {
  const p = R.riders.createPeloton({ count: 10, ftp: 250, massKg: 80, route, seed: 1 });
  p.bots.forEach((b) => { assert.strictEqual(b.kind, 'bot'); assert.ok(b.id && b.name && b.color); assert.strictEqual(typeof b.distM, 'number'); });
});

// ---- ronda 1: el elástico es un objetivo de velocidad; comportamiento independiente de dt ----
const talagante = require('../data/routes/talagante-valle.json');

function simDt({ rt, dt, seed = 5, seconds = 1800, userMode = 'const' }) {
  const p = R.riders.createPeloton({ count: 14, ftp: 250, massKg: 80, route: rt, seed });
  let ud = 0, uv = 0, lastEnd = -1e9, worst = null, maxMeanErr = 0, attacks = 0, vmin = Infinity, vmax = 0;
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    if (userMode === 'const') uv = 30 / 3.6;
    else { const s = R.routes.sampleAt(rt, ud); uv = R.physics.step({ v: uv, powerW: 200, gradePct: s.gradePct, massKg: 80, altitudeM: s.ele, dt }); }
    ud = Math.min(rt.distanceM, ud + uv * dt);
    const was = p.state.attacking;
    p.update(dt, t, ud);
    if (!was && p.state.attacking) attacks++;
    if (p.state.phase === 'end') lastEnd = t;
    if (t > 30) {
      p.bots.forEach((b) => {
        vmin = Math.min(vmin, b.speedMps); vmax = Math.max(vmax, b.speedMps);
        if (b.speedMps < 0.4 * uv - 1 || b.speedMps > 1.8 * uv + 1) worst = worst || { t, id: b.id, v: b.speedMps, uv };
      });
    }
    // entre ataques (tras 150 s de reagrupamiento) la media del grupo principal va a ±60 m del usuario
    if (t > 60 && !p.state.attacking && t - lastEnd > 150) {
      const m = p.bots.filter((b) => b.group === 'principal');
      maxMeanErr = Math.max(maxMeanErr, Math.abs(m.reduce((a, b) => a + b.distM, 0) / m.length - ud));
    }
  }
  return { worst, maxMeanErr, attacks, vmin, vmax };
}

[['sintética 60 km', makeRoute(60000), 'const'], ['talagante-valle', talagante, 'power']].forEach(([name, rt, mode]) => {
  test('dt=1/60 durante 30 min (' + name + '): bots entre 0,4× y 1,8× la velocidad del usuario, grupo cerca', () => {
    const r = simDt({ rt, dt: 1 / 60, userMode: mode });
    assert.strictEqual(r.worst, null, JSON.stringify(r.worst));
    assert.ok(r.maxMeanErr <= 60, 'error medio ' + r.maxMeanErr);
    assert.ok(r.attacks >= 2, 'ataques ' + r.attacks);
  });
});

test('mismo comportamiento con dt=1 y dt=1/60', () => {
  const a = simDt({ rt: makeRoute(60000), dt: 1 }), b = simDt({ rt: makeRoute(60000), dt: 1 / 60 });
  assert.strictEqual(a.worst, null);
  assert.strictEqual(a.attacks, b.attacks);
  assert.ok(Math.abs(a.vmax - b.vmax) < 1, a.vmax + ' vs ' + b.vmax);
  assert.ok(Math.abs(a.vmin - b.vmin) < 1, a.vmin + ' vs ' + b.vmin);
});

test('bot.powerW refleja la potencia ×boost durante el ataque', () => {
  const p = R.riders.createPeloton({ count: 14, ftp: 250, massKg: 80, route, seed: 5 });
  let ud = 0, checked = 0;
  for (let t = 0; t < 1500; t++) {
    ud += 30 / 3.6; p.update(1, t, ud);
    if (p.state.attacking) {
      p.bots.filter((b) => b.group === 'principal').forEach((b) => {
        // potencia libre máx. 1,15·FTP; con boost ≥ 1,22 la efectiva supera el tope libre en algún bot
        assert.ok(b.powerW >= 0.75 * 250 * 1.22 - 1e-6, 'powerW ' + b.powerW);
      });
      checked++;
    }
  }
  assert.ok(checked > 0);
});

test('colocación inicial con el usuario en 0: sin bots apilados en distM = 0', () => {
  const p = R.riders.createPeloton({ count: 20, ftp: 250, massKg: 80, route, seed: 3 });
  p.update(1 / 60, 0, 0);
  const ds = p.bots.map((b) => b.distM).sort((a, b) => a - b);
  for (let i = 1; i < ds.length; i++) assert.ok(ds[i] - ds[i - 1] >= 2 - 0.2, 'separación ' + (ds[i] - ds[i - 1]));
  assert.ok(ds.every((d) => d >= 0));
});
