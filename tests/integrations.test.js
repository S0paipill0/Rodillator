const test = require('node:test');
const assert = require('node:assert');
require('../src/devices.js');
require('../src/integrations.js');
const R = globalThis.R;
const I = R.integrations, P = R.devices._parse;

function dv(bytes) { return new DataView(new Uint8Array(bytes).buffer); }

// ---------- TCX ----------
function activity() {
  const samples = [];
  for (let i = 0; i < 5; i++) samples.push([i, 200 + i, i === 0 ? null : 140 + i, 90, 8.5, i * 8.5, 600]);
  return { id: 'a1', date: '2026-03-01T10:00:00.000Z', type: 'workout', name: 'Sweet Spot 3×12 & <más>', routeId: null,
    durationS: 5, distanceM: 34, avgPower: 202, kcal: 12, avgHr: 142, avgCadence: 90, samples };
}

test('TCX: estructura, Biking, Watts, FC, cadencia y escape XML', () => {
  const x = I.toTCX(activity(), {});
  assert.match(x, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(x, /<Activity Sport="Biking">/);
  assert.match(x, /xmlns="http:\/\/www.garmin.com\/xmlschemas\/TrainingCenterDatabase\/v2"/);
  assert.equal((x.match(/<Trackpoint>/g) || []).length, 5);
  assert.equal((x.match(/<\/Trackpoint>/g) || []).length, 5);
  assert.match(x, /<ns3:Watts>204<\/ns3:Watts>/);
  assert.match(x, /<ns3:Speed>8.500<\/ns3:Speed>/);
  assert.match(x, /<HeartRateBpm><Value>141<\/Value><\/HeartRateBpm>/);
  assert.match(x, /<Cadence>90<\/Cadence>/);
  assert.match(x, /<Time>2026-03-01T10:00:03.000Z<\/Time>/);
  assert.doesNotMatch(x, /<Position>/);
  assert.match(x, /Sweet Spot 3×12 &amp; &lt;más&gt;/);
  // el primer trackpoint no tiene FC
  const first = x.split('<Trackpoint>')[1].split('</Trackpoint>')[0];
  assert.doesNotMatch(first, /HeartRateBpm/);
  // etiquetas balanceadas (bien formado básico)
  const stack = [];
  for (const m of x.matchAll(/<(\/?)([A-Za-z0-9:]+)[^>]*?(\/?)>/g)) {
    if (m[2] === 'xml') continue;
    if (m[3]) continue;
    if (m[1]) assert.equal(stack.pop(), m[2]); else stack.push(m[2]);
  }
  assert.equal(stack.length, 0);
});

test('TCX: Position solo si R.routes.sampleAt existe', () => {
  const a = activity(); a.routeId = 'r1'; a.type = 'route';
  assert.doesNotMatch(I.toTCX(a, {}), /<Position>/);
  R.routes = { get: (id) => ({ id }), sampleAt: (route, d) => ({ lat: -33.4 + d / 1e5, lon: -70.6, eleM: 600 }) };
  const x = I.toTCX(a, {});
  assert.equal((x.match(/<Position>/g) || []).length, 5);
  assert.match(x, /<LatitudeDegrees>-33.400000<\/LatitudeDegrees>/);
  delete R.routes;
});

test('Strava: URL y nombre', () => {
  assert.equal(I.stravaUploadUrl, 'https://www.strava.com/upload/select');
  assert.equal(I.stravaActivityName({ name: 'Sweet Spot 3×12' }), '🚴 Rodillator · Sweet Spot 3×12');
});

// ---------- ICS ----------
function plan() {
  return { weeks: [{ index: 0, days: [
    { date: '2020-01-01', workoutId: 'w1', status: 'pendiente' }, // pasado
    { date: '2099-06-10', workoutId: 'w1', status: 'pendiente' },
    { date: '2099-06-11', workoutId: null, status: 'pendiente' },
    { date: '2099-06-12', workoutId: 'w1', status: 'hecho' },
    { date: '2099-06-13', workoutId: 'w1', status: 'pendiente' }
  ] }] };
}
const workouts = { w1: { id: 'w1', name: 'Sweet Spot 3×12, con una descripción larga; para plegar', durationS: 5400, tss: 88.4,
  description: 'Tres bloques de doce minutos en zona sweet spot con recuperación de cinco minutos entre bloques.' } };

test('ICS: CRLF, VEVENT solo futuros pendientes, TZID, VALARM y plegado', () => {
  const ics = I.toICS({ plan: plan(), settings: { reminderTime: '07:30' }, profile: {}, workouts, now: new Date('2026-01-01T12:00:00Z') });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
  assert.doesNotMatch(ics.replace(/\r\n/g, ''), /[\r\n]/);
  assert.ok(!/(^|[^\r])\n/.test(ics), 'no debe haber LF sueltos');
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.match(ics, /DTSTART;TZID=America\/Santiago:20990610T073000/);
  assert.match(ics, /DTEND;TZID=America\/Santiago:20990610T090000/);
  assert.match(ics, /BEGIN:VTIMEZONE\r\nTZID:America\/Santiago/);
  assert.equal((ics.match(/BEGIN:VALARM/g) || []).length, 2);
  assert.match(ics, /TRIGGER:-PT15M/);
  assert.doesNotMatch(ics, /20200101/);
  const unfolded = ics.replace(/\r\n /g, '');
  assert.match(unfolded, /SUMMARY:Sweet Spot 3×12\\, con una descripción larga\; para plegar/);
  assert.match(unfolded, /DESCRIPTION:Duración: 90 min · TSS: 88\\n/);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75, 'línea > 75 octetos: ' + line);
});

test('ICS: plegado no parte caracteres multibyte', () => {
  const folded = I._foldLine('SUMMARY:' + '🚴ñ'.repeat(40));
  for (const l of folded.split('\r\n')) assert.ok(Buffer.byteLength(l, 'utf8') <= 75);
  const back = folded.replace(/\r\n /g, '');
  assert.equal(back, 'SUMMARY:' + '🚴ñ'.repeat(40));
  assert.ok(!back.includes('�'));
});

// ---------- Recordatorios ----------
test('recordatorio: dispara una vez al día en día y hora correctos', () => {
  let nowD = new Date(2026, 5, 10, 18, 59); // miércoles (3)
  assert.equal(nowD.getDay(), 3);
  const fired = [];
  const s = I.createReminderScheduler({
    getState: () => ({ settings: { reminderDays: [1, 3, 5], reminderTime: '19:00' } }),
    onFire: (p) => fired.push(p), now: () => nowD, setInterval: () => 1, clearInterval: () => {}
  });
  assert.equal(s._check(), false);
  nowD = new Date(2026, 5, 10, 19, 1);
  assert.equal(s._check(), true);
  assert.equal(s._check(), false);
  assert.equal(fired.length, 1);
  assert.ok(fired[0].title && fired[0].body);
  nowD = new Date(2026, 5, 11, 19, 1); // jueves: no
  assert.equal(s._check(), false);
});

// ---------- saveFile ----------
test('saveFile: usa downloads, maneja rechazo y ausencia', async () => {
  let saved = null;
  globalThis.claude = { use: async (n) => (n === 'downloads' ? { save: async (o) => { saved = o; } } : null) };
  assert.deepEqual(await I.saveFile({ filename: 'a.tcx', data: 'X', mime: 'application/xml' }), { ok: true });
  assert.deepEqual(saved, { filename: 'a.tcx', data: 'X' });
  globalThis.claude = { use: async () => ({ save: async () => { throw new Error('rechazado'); } }) };
  const r = await I.saveFile({ filename: 'a', data: 'D' });
  assert.equal(r.ok, false); assert.equal(r.fallback, 'copy'); assert.equal(r.data, 'D');
  globalThis.claude = { use: async () => null };
  assert.equal((await I.saveFile({ filename: 'a', data: 'D' })).fallback, 'copy');
  delete globalThis.claude;
  assert.deepEqual(await I.saveFile({ filename: 'a', data: 'D' }), { ok: false, fallback: 'copy', data: 'D' });
  assert.equal(await I.requestNotificationPermission(), 'unsupported');
});

// ---------- Parsers ----------
test('indoorBikeData: velocidad, cadencia y potencia (FTMS típico)', () => {
  // flags = bit2 cadencia + bit6 potencia = 0x0044 ; velocidad 30.00 km/h = 3000 ; cadencia 180*0.5=90 ; potencia 250
  const r = P.indoorBikeData(dv([0x44, 0x00, 0xB8, 0x0B, 0xB4, 0x00, 0xFA, 0x00]));
  assert.equal(r.speedKph, 30);
  assert.equal(r.cadenceRpm, 90);
  assert.equal(r.powerW, 250);
  assert.equal(r.hrBpm, null);
});

test('indoorBikeData: bit0 "More Data" omite velocidad; todos los campos intermedios', () => {
  const r0 = P.indoorBikeData(dv([0x41, 0x00, 0x64, 0x00])); // bit0 + bit6: sólo potencia 100
  assert.equal(r0.speedKph, null); assert.equal(r0.powerW, 100);
  // flags: velocidad(implícita) + avg speed(1) + cadencia(2) + avg cad(3) + dist(4) + resist(5) + potencia(6) + avg pow(7) + energía(8) + FC(9)
  const flags = 0x3FE;
  const bytes = [flags & 0xff, flags >> 8,
    0x10, 0x0E,       // vel 36.00
    0x00, 0x00,       // vel media
    0x50, 0x00,       // cadencia 40 rpm
    0x00, 0x00,       // cadencia media
    0x01, 0x00, 0x00, // distancia
    0x05, 0x00,       // resistencia
    0x2C, 0x01,       // potencia 300
    0x00, 0x00,       // potencia media
    0x00, 0x00, 0x00, 0x00, 0x00, // energía
    0x96];            // FC 150
  const r = P.indoorBikeData(dv(bytes));
  assert.equal(r.speedKph, 36); assert.equal(r.cadenceRpm, 40); assert.equal(r.powerW, 300); assert.equal(r.hrBpm, 150);
  // potencia negativa (sint16)
  assert.equal(P.indoorBikeData(dv([0x41, 0, 0xFF, 0xFF])).powerW, -1);
});

test('cyclingPower: potencia en offset 2 y cadencia desde revoluciones de biela', () => {
  const mk = (power, revs, time) => dv([0x20, 0x00, power & 0xff, (power >> 8) & 0xff, revs & 0xff, revs >> 8, time & 0xff, time >> 8]);
  const a = P.cyclingPower(mk(180, 100, 1000), null);
  assert.equal(a.powerW, 180);
  assert.equal(a.cadenceRpm, null);
  // 2 revoluciones en 1.4 s (1434 ticks de 1/1024 s ≈ 1.4004 s) → ≈ 85.7 rpm
  const b = P.cyclingPower(mk(190, 102, 1000 + 1434), a.state);
  assert.equal(b.powerW, 190);
  assert.ok(Math.abs(b.cadenceRpm - 2 / (1434 / 1024) * 60) < 1e-9);
  // sin evento nuevo conserva cadencia
  const c = P.cyclingPower(mk(190, 102, 1000 + 1434), b.state);
  assert.equal(c.cadenceRpm, b.cadenceRpm);
  // desbordamiento del contador de tiempo (uint16)
  const d = P.cyclingPower(mk(200, 105, (1000 + 1434 + 2048) & 0xffff), c.state);
  assert.ok(d.cadenceRpm > 0);
  const wrapPrev = { crankRevs: 65535, crankTime: 65000, cadenceRpm: null, idle: 0 };
  const w = P.cyclingPower(mk(100, 1, 65000 + 1024 - 65536), wrapPrev);
  assert.ok(Math.abs(w.cadenceRpm - 120) < 1e-9); // 2 revs en 1 s
});

test('cyclingPower: salta campos opcionales previos a la biela', () => {
  // flags: bit0 balance (1 B) + bit2 torque (2 B) + bit4 rueda (6 B) + bit5 biela
  const f = 0x01 | 0x04 | 0x10 | 0x20;
  const bytes = [f, 0, 0x64, 0x00, 50, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0x0A, 0x00, 0x00, 0x04];
  const r = P.cyclingPower(dv(bytes), null);
  assert.equal(r.powerW, 100);
  assert.deepEqual([r.state.crankRevs, r.state.crankTime], [10, 1024]);
});

test('heartRate: uint8 y uint16 según flag bit 0', () => {
  assert.equal(P.heartRate(dv([0x00, 142])).hrBpm, 142);
  assert.equal(P.heartRate(dv([0x01, 0x2C, 0x01])).hrBpm, 300);
});

// ---------- Bluetooth ----------
test('isBluetoothAvailable: false sin navigator.bluetooth o si lanza', async () => {
  assert.equal(await R.devices.isBluetoothAvailable(), false);
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { bluetooth: { getAvailability: async () => { throw new Error('policy'); } } }, configurable: true });
  assert.equal(await R.devices.isBluetoothAvailable(), false);
  Object.defineProperty(globalThis, 'navigator', { value: { bluetooth: { getAvailability: async () => true } }, configurable: true });
  assert.equal(await R.devices.isBluetoothAvailable(), true);
  if (desc) Object.defineProperty(globalThis, 'navigator', desc); else delete globalThis.navigator;
});

test('connectTrainer traduce el bloqueo por política de permisos', async () => {
  const e = new Error("Access to the feature 'bluetooth' is disallowed by permissions policy."); e.name = 'SecurityError';
  Object.defineProperty(globalThis, 'navigator', { value: { bluetooth: { requestDevice: async () => { throw e; } } }, configurable: true });
  await assert.rejects(R.devices.connectTrainer(), /El navegador bloqueó Bluetooth en esta vista\. Abre Rodillator en una pestaña de Chrome o Edge\./);
  delete globalThis.navigator;
});

// ---------- Simulador ----------
function fakeClock() {
  let t = 1000, fn = null;
  return {
    now: () => t, setInterval: (f) => { fn = f; return 1; }, clearInterval: () => { fn = null; },
    advance(sec) { for (let i = 0; i < sec * 4; i++) { t += 250; fn && fn(); } }
  };
}

test('simulador: converge al objetivo ±3 %, cadencia 85–95, FC por cinética de 30 s', () => {
  const clk = fakeClock();
  const sim = R.devices.createSimulator({ now: clk.now, setInterval: clk.setInterval, clearInterval: clk.clearInterval, ftp: 200, maxHr: 190, restHr: 60 });
  const out = [];
  sim.on('data', (d) => out.push(d));
  sim.start();
  sim.setTargetPower(200);
  clk.advance(1);
  assert.ok(out[out.length - 1].powerW < 150, 'lag: aún lejos del objetivo');
  clk.advance(20);
  const tail = out.slice(-20);
  for (const d of tail) {
    assert.ok(Math.abs(d.powerW - 200) <= 200 * 0.031, 'potencia ' + d.powerW);
    assert.ok(d.cadenceRpm >= 85 && d.cadenceRpm <= 95, 'cadencia ' + d.cadenceRpm);
    assert.equal(d.source, 'simulator');
    assert.ok(d.speedKph > 20 && d.speedKph < 40);
  }
  const hr20 = out[out.length - 1].hrBpm;
  assert.ok(hr20 > 60 && hr20 < 150, 'FC aún subiendo: ' + hr20);
  clk.advance(180);
  const hrEnd = out[out.length - 1].hrBpm;
  const expected = 60 + (190 - 60) * 0.85;
  assert.ok(Math.abs(hrEnd - expected) < 3, 'FC final ' + hrEnd + ' vs ' + expected);
  sim.stop();
});

test('simulador: nudge ±10 W y bajo de cero', () => {
  const sim = R.devices.createSimulator({ setInterval: () => 1, clearInterval: () => {} });
  sim.setTargetPower(100);
  assert.equal(sim.nudge(10), 110);
  assert.equal(sim.nudge(-10), 100);
  assert.equal(sim.nudge(-500), 0);
});
