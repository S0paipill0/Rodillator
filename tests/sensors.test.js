const test = require('node:test');
const assert = require('node:assert');
require('../src/devices.js');
require('../src/sensors-settings.js');
const D = globalThis.R.devices;
const SS = globalThis.R.sensorsSettings;
const csc = D._parse.csc;

function dvWheel(revs, time) { const b = new DataView(new ArrayBuffer(7)); b.setUint8(0, 1); b.setUint32(1, revs, true); b.setUint16(5, time, true); return b; }
function dvCrank(revs, time) { const b = new DataView(new ArrayBuffer(5)); b.setUint8(0, 2); b.setUint16(1, revs, true); b.setUint16(3, time, true); return b; }
function dvBoth(wr, wt, cr, ct) { const b = new DataView(new ArrayBuffer(11)); b.setUint8(0, 3); b.setUint32(1, wr, true); b.setUint16(5, wt, true); b.setUint16(7, cr, true); b.setUint16(9, ct, true); return b; }
const O = (ms) => ({ wheelCircMm: 2070, nowMs: ms });

test('CSC rueda: primera lectura sin velocidad, luego km/h con 2070 mm', () => {
  const a = csc(dvWheel(100, 1000), null, O(0));
  assert.strictEqual(a.speedKph, null);
  assert.strictEqual(a.mode, 'speed');
  assert.strictEqual(a.wheelRevs, 100);
  assert.strictEqual(a.cadenceRpm, null);
  // 1 vuelta cada 1024 ticks (1 s): 2,07 m/s = 7,452 km/h
  const b = csc(dvWheel(101, 2024), a.state, O(1000));
  assert.ok(Math.abs(b.speedKph - 7.452) < 1e-6);
  // 4 vueltas en 1 s => 29,808 km/h
  const c = csc(dvWheel(105, 3048), b.state, O(2000));
  assert.ok(Math.abs(c.speedKph - 29.808) < 1e-6);
});

test('CSC biela: cadencia y modo cadencia', () => {
  const a = csc(dvCrank(10, 500), null, O(0));
  const b = csc(dvCrank(11, 500 + 683), a.state, O(700)); // 1 vuelta en 683/1024 s ~ 90 rpm
  assert.strictEqual(b.mode, 'cadence');
  assert.strictEqual(b.speedKph, null);
  assert.ok(Math.abs(b.cadenceRpm - 60 * 1024 / 683) < 1e-9);
  assert.strictEqual(b.crankRevs, 11);
});

test('CSC ambos flags', () => {
  const a = csc(dvBoth(1000, 0, 50, 0), null, O(0));
  const b = csc(dvBoth(1002, 1024, 51, 512), a.state, O(1000));
  assert.strictEqual(b.mode, 'both');
  assert.ok(Math.abs(b.speedKph - 2 * 2.07 * 3.6) < 1e-9);
  assert.ok(Math.abs(b.cadenceRpm - 120) < 1e-9);
});

test('CSC desborde uint16 de tiempo y de revs de biela', () => {
  const a = csc(dvCrank(65535, 65000), null, O(0));
  const b = csc(dvCrank(1, 488), a.state, O(500)); // dRev=2, dTime=1024
  assert.ok(Math.abs(b.cadenceRpm - 120) < 1e-9);
  const w = csc(dvWheel(5, 65000), null, O(0));
  const w2 = csc(dvWheel(6, 488), w.state, O(500)); // dTime=1024
  assert.ok(Math.abs(w2.speedKph - 7.452) < 1e-6);
});

test('CSC desborde uint32 de revs de rueda', () => {
  const a = csc(dvWheel(0xFFFFFFFF, 0), null, O(0));
  const b = csc(dvWheel(1, 1024), a.state, O(1000)); // dRev=2
  assert.ok(Math.abs(b.speedKph - 2 * 7.452) < 1e-6);
  assert.strictEqual(b.wheelRevs, 1);
});

test('CSC sin cambio: conserva y pasa a 0 tras 3 s', () => {
  let r = csc(dvWheel(10, 0), null, O(0));
  r = csc(dvWheel(11, 1024), r.state, O(1000));
  const v = r.speedKph;
  r = csc(dvWheel(11, 1024), r.state, O(2500));
  assert.strictEqual(r.speedKph, v);
  r = csc(dvWheel(11, 1024), r.state, O(4500)); // 3,5 s desde el último evento
  assert.strictEqual(r.speedKph, 0);
  // y se recupera
  r = csc(dvWheel(12, 2048), r.state, O(5000));
  assert.ok(r.speedKph > 7);
});

test('CSC sin cambio en biela: cadencia 0 tras 3 s', () => {
  let r = csc(dvCrank(1, 0), null, O(0));
  r = csc(dvCrank(2, 700), r.state, O(700));
  assert.ok(r.cadenceRpm > 80);
  r = csc(dvCrank(2, 700), r.state, O(4000));
  assert.strictEqual(r.cadenceRpm, 0);
});

test('CSC usa la circunferencia indicada', () => {
  const a = csc(dvWheel(0, 0), null, { wheelCircMm: 2300, nowMs: 0 });
  const b = csc(dvWheel(1, 1024), a.state, { wheelCircMm: 2300, nowMs: 1000 });
  assert.ok(Math.abs(b.speedKph - 8.28) < 1e-6);
});

test('texto de modo', () => {
  assert.strictEqual(D._cscModeText('speed'), 'Sensor en modo velocidad');
  assert.strictEqual(D._cscModeText('cadence'), 'Sensor en modo cadencia');
});

// ---- Emisión unificada, estado y reconexión con dispositivo falso ----
function fakeBluetooth() {
  const listeners = {};
  const ch = { addEventListener: (e, f) => { ch.fn = f; }, startNotifications: async () => {} };
  const device = {
    id: 'dev-1', name: 'Magene S3+',
    addEventListener: (e, f) => { listeners[e] = f; },
    gatt: {
      connected: false, attempts: 0, failNext: 0,
      async connect() { if (this.failNext > 0) { this.failNext--; throw new Error('fallo'); } this.attempts++; this.connected = true; return server; },
      disconnect() { this.connected = false; }
    }
  };
  const server = {
    connected: true,
    async getPrimaryService(uuid) {
      if (uuid === 0x180F) throw new Error('sin batería');
      return { getCharacteristic: async () => ch };
    }
  };
  return { device, ch, listeners, nav: { bluetooth: { requestDevice: async () => device } } };
}

test('connectSpeedCadence: emite data, status y reconecta con 3 reintentos', async () => {
  const fb = fakeBluetooth();
  Object.defineProperty(globalThis, 'navigator', { value: fb.nav, configurable: true });
  const timers = [];
  D._config.setTimeout = (f, ms) => { timers.push({ f, ms }); return 0; };
  const events = [];
  D.on('data', (d) => events.push(d));
  const info = await D.connectSpeedCadence({ wheelCircMm: 2070 });
  assert.strictEqual(info.id, 'dev-1');
  assert.strictEqual(D.status().find((s) => s.kind === 'csc').state, 'connected');
  fb.ch.fn({ target: { value: dvWheel(0, 0) } });
  fb.ch.fn({ target: { value: dvWheel(1, 1024) } });
  const last = events[events.length - 1];
  assert.strictEqual(last.source, 'csc');
  assert.ok(Math.abs(last.speedKph - 7.452) < 1e-6);
  assert.strictEqual(D.status().find((s) => s.kind === 'csc').mode, 'speed');

  // Desconexión: 3 reintentos fallidos con esperas crecientes
  fb.device.gatt.connected = false; fb.device.gatt.failNext = 3;
  fb.listeners.gattserverdisconnected();
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(D.status().find((s) => s.kind === 'csc').state, 'reconnecting');
    const t = timers.shift(); assert.strictEqual(t.ms, [1000, 2000, 4000][i]);
    await t.f();
  }
  assert.strictEqual(timers.length, 0);
  assert.strictEqual(D.status().find((s) => s.kind === 'csc').state, 'disconnected');
  // "Reconectar" manual con el dispositivo recordado
  const r = await D.reconnect('csc');
  assert.strictEqual(r.id, 'dev-1');
  assert.strictEqual(D.status().find((s) => s.kind === 'csc').state, 'connected');
  await D.disconnect();
  assert.strictEqual(D.status().find((s) => s.kind === 'csc').state, 'disconnected');
});

// ---- Normalización ----
test('normalize: valores por defecto', () => {
  const n = SS.normalize({});
  assert.deepStrictEqual(n.trainer, { type: 'mecanico-8', wheelCircMm: 2070, flatLevel: 3, powerScale: 1 });
  assert.deepStrictEqual(n.sensors, { lastSpeedId: null, lastHrId: null });
  assert.deepStrictEqual(SS.normalize(undefined).trainer.wheelCircMm, 2070);
});

test('normalize: recorta, redondea y descarta basura; conserva otras claves', () => {
  const input = { botsCount: 14, trainer: { type: 'otro', wheelCircMm: '2300', flatLevel: 11, powerScale: 2 }, sensors: { lastSpeedId: 5, lastHrId: 'abc' } };
  const n = SS.normalize(input);
  assert.strictEqual(n.botsCount, 14);
  assert.deepStrictEqual(n.trainer, { type: 'mecanico-8', wheelCircMm: 2300, flatLevel: 8, powerScale: 1.3 });
  assert.deepStrictEqual(n.sensors, { lastSpeedId: null, lastHrId: 'abc' });
  assert.strictEqual(input.trainer.flatLevel, 11, 'no muta la entrada');
  assert.strictEqual(SS.normalizeTrainer({ powerScale: 0.1 }).powerScale, 0.7);
  assert.strictEqual(SS.normalizeTrainer({ powerScale: 'x', wheelCircMm: 'x', flatLevel: null }).wheelCircMm, 2070);
  assert.strictEqual(SS.normalizeTrainer({ wheelCircMm: 50 }).wheelCircMm, 1000);
  assert.strictEqual(SS.normalizeTrainer({ flatLevel: 0 }).flatLevel, 1);
  assert.strictEqual(SS.normalizeTrainer({ trainer: 1 }).powerScale, 1);
  assert.strictEqual(SS.normalize({ trainer: 'x', sensors: [] }).trainer.flatLevel, 3);
});

test('presets de rueda', () => {
  assert.deepStrictEqual(SS.WHEEL_PRESETS.map((p) => p.mm), [2050, 2070, 2100, 2105, 2300]);
  assert.strictEqual(SS.presetFor(2070), '26x2.10');
  assert.strictEqual(SS.presetFor(2111), 'custom');
});
