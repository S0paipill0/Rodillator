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

test('CSC: flags sin datos o paquete corto no emiten (sin RangeError)', () => {
  const z = new DataView(new ArrayBuffer(7));   // flags = 0
  assert.strictEqual(csc(z, null, O(0)), null);
  assert.strictEqual(csc(new DataView(new ArrayBuffer(0)), null, O(0)), null);
  const short = new DataView(new ArrayBuffer(4)); short.setUint8(0, 1);
  assert.doesNotThrow(() => csc(short, null, O(0)));
  assert.strictEqual(csc(short, null, O(0)), null);
  const shortBoth = new DataView(new ArrayBuffer(7)); shortBoth.setUint8(0, 3);
  assert.strictEqual(csc(shortBoth, null, O(0)), null);
});

test('CSC: descarta velocidades imposibles y re-siembra el contador', () => {
  let r = csc(dvWheel(100, 0), null, O(0));
  r = csc(dvWheel(101, 1024), r.state, O(1000));
  const v = r.speedKph;
  // Reinicio del sensor con salto enorme: >100 km/h => se descarta y conserva la última
  r = csc(dvWheel(5000, 2048), r.state, O(2000));
  assert.strictEqual(r.speedKph, v);
  assert.strictEqual(r.state.wheelRevs, 5000, 're-siembra');
  r = csc(dvWheel(5001, 3072), r.state, O(3000));
  assert.ok(Math.abs(r.speedKph - 7.452) < 1e-6);
  // Contador que retrocede (reinicio a 0): se descarta y re-siembra
  r = csc(dvWheel(3, 4096), r.state, O(4000));
  assert.ok(Math.abs(r.speedKph - 7.452) < 1e-6);
  assert.strictEqual(r.state.wheelRevs, 3);
  r = csc(dvWheel(5, 5120), r.state, O(5000));
  assert.ok(Math.abs(r.speedKph - 2 * 7.452) < 1e-6);
  // Revoluciones sin avance de tiempo: se descarta
  r = csc(dvWheel(9, 5120), r.state, O(5100));
  assert.ok(Math.abs(r.speedKph - 2 * 7.452) < 1e-6);
});

test('CSC: descarta cadencias > 250 rpm', () => {
  let r = csc(dvCrank(10, 0), null, O(0));
  r = csc(dvCrank(11, 683), r.state, O(700));
  const c = r.cadenceRpm;
  r = csc(dvCrank(30, 1000), r.state, O(1000));   // 19 vueltas en 0,3 s
  assert.strictEqual(r.cadenceRpm, c);
  r = csc(dvCrank(31, 1683), r.state, O(1700));
  assert.ok(Math.abs(r.cadenceRpm - 60 * 1024 / 683) < 1e-9);
});

test('CSC: dRev = 0 con tiempo distinto no reinicia la inactividad', () => {
  let r = csc(dvWheel(10, 0), null, O(0));
  r = csc(dvWheel(11, 1024), r.state, O(1000));
  r = csc(dvWheel(11, 1500), r.state, O(2500));   // tiempo cambia sin vuelta nueva
  assert.ok(r.speedKph > 7);
  r = csc(dvWheel(11, 1700), r.state, O(4100));   // 3,1 s desde la última vuelta
  assert.strictEqual(r.speedKph, 0);
});

test('texto de modo', () => {
  assert.strictEqual(D._cscModeText('speed'), 'Sensor en modo velocidad');
  assert.strictEqual(D._cscModeText('cadence'), 'Sensor en modo cadencia');
});

// ---- Emisión unificada, estado y reconexión con dispositivo falso ----
function fakeBluetooth(opts = {}) {
  const listeners = {};
  const ch = {
    fns: new Set(),
    addEventListener: (e, f) => { ch.fns.add(f); },
    removeEventListener: (e, f) => { ch.fns.delete(f); },
    fire: (value) => { [...ch.fns].forEach((f) => f({ target: { value } })); },
    startNotifications: async () => {}
  };
  const device = {
    id: opts.id || 'dev-1', name: 'Magene S3+',
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
  const bluetooth = { requestDevice: async () => device };
  if (opts.getDevices) bluetooth.getDevices = async () => [device];
  return { device, ch, listeners, nav: { bluetooth } };
}

// Reloj y temporizadores falsos: cada temporizador se guarda con su espera; clearTimeout lo anula.
function fakeTimers(dev) {
  const t = { now: 0, list: [], cleared: 0 };
  let seq = 0;
  dev._config.setTimeout = (f, ms) => { const h = ++seq; t.list.push({ h, f, ms }); return h; };
  dev._config.clearTimeout = (h) => { const i = t.list.findIndex((x) => x.h === h); if (i >= 0) { t.list.splice(i, 1); t.cleared++; } };
  dev._config.now = () => t.now;
  t.take = (ms) => { const i = t.list.findIndex((x) => x.ms === ms); assert.ok(i >= 0, 'temporizador de ' + ms + ' ms'); return t.list.splice(i, 1)[0]; };
  t.count = (ms) => t.list.filter((x) => x.ms === ms).length;
  return t;
}

// Carga una instancia nueva de devices.js (equivale a recargar la página).
function freshDevices() {
  delete require.cache[require.resolve('../src/devices.js')];
  require('../src/devices.js');
  return globalThis.R.devices;
}
function setNav(nav) { Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true }); }
const stateOf = (dev, kind) => dev.status().find((s) => s.kind === kind).state;

test('connectSpeedCadence: emite data, status y reconecta con 3 reintentos', async () => {
  const Dv = freshDevices();
  const fb = fakeBluetooth();
  setNav(fb.nav);
  const tm = fakeTimers(Dv);
  const events = [];
  Dv.on('data', (d) => events.push(d));
  const info = await Dv.connectSpeedCadence({ wheelCircMm: 2070 });
  assert.strictEqual(info.id, 'dev-1');
  assert.strictEqual(stateOf(Dv, 'csc'), 'connected');
  fb.ch.fire(dvWheel(0, 0));
  fb.ch.fire(dvWheel(1, 1024));
  const last = events[events.length - 1];
  assert.strictEqual(last.source, 'csc');
  assert.ok(Math.abs(last.speedKph - 7.452) < 1e-6);
  assert.strictEqual(Dv.status().find((s) => s.kind === 'csc').mode, 'speed');

  // Desconexión: 3 reintentos fallidos con esperas crecientes
  fb.device.gatt.connected = false; fb.device.gatt.failNext = 3;
  fb.listeners.gattserverdisconnected();
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(stateOf(Dv, 'csc'), 'reconnecting');
    const t = tm.list.filter((x) => [1000, 2000, 4000].includes(x.ms));
    assert.strictEqual(t.length, 1, 'un solo reintento pendiente (el vigilante se detuvo)');
    assert.strictEqual(t[0].ms, [1000, 2000, 4000][i]);
    tm.list.splice(tm.list.indexOf(t[0]), 1);
    await t[0].f();
  }
  assert.strictEqual(tm.list.length, 0);
  assert.strictEqual(stateOf(Dv, 'csc'), 'disconnected');
  // "Reconectar" manual con el dispositivo recordado
  const r = await Dv.reconnect('csc');
  assert.strictEqual(r.id, 'dev-1');
  assert.strictEqual(stateOf(Dv, 'csc'), 'connected');
  assert.strictEqual(fb.ch.fns.size, 1, 'un solo listener tras reconectar');
  await Dv.disconnect();
  assert.strictEqual(stateOf(Dv, 'csc'), 'disconnected');
  assert.strictEqual(fb.ch.fns.size, 0, 'disconnect quita el listener');
  assert.strictEqual(tm.list.length, 0, 'disconnect detiene el vigilante');
});

test('vigilante CSC: si el sensor deja de notificar, velocidad y cadencia pasan a 0', async () => {
  const Dv = freshDevices();
  const fb = fakeBluetooth();
  setNav(fb.nav);
  const tm = fakeTimers(Dv);
  const events = [];
  Dv.on('data', (d) => events.push(d));
  await Dv.connectSpeedCadence({ wheelCircMm: 2070 });
  fb.ch.fire(dvBoth(0, 0, 0, 0));
  tm.now = 1000; fb.ch.fire(dvBoth(4, 1024, 1, 683));
  assert.ok(events[events.length - 1].speedKph > 29);
  // El sensor calla: el vigilante (cada 1 s) no hace nada antes de 3 s
  let n = events.length;
  tm.now = 3500; tm.take(1000).f();
  assert.strictEqual(events.length, n);
  tm.now = 4100; tm.take(1000).f();
  const z = events[events.length - 1];
  assert.strictEqual(z.speedKph, 0);
  assert.strictEqual(z.cadenceRpm, 0);
  assert.strictEqual(z.source, 'csc');
  // Sigue vigilando, pero no repite la emisión si ya está en 0
  n = events.length;
  tm.now = 5100; tm.take(1000).f();
  assert.strictEqual(events.length, n);
  // gattserverdisconnected detiene el vigilante
  fb.device.gatt.connected = false; fb.device.gatt.failNext = 99;
  fb.listeners.gattserverdisconnected();
  assert.strictEqual(tm.count(1000), 1, 'solo el primer reintento (1000 ms), sin vigilante');
  await Dv.disconnect();
  assert.strictEqual(tm.list.length, 0, 'disconnect cancela el reintento pendiente');
});

test('disconnect anula un reintento ya disparado (contador de generación)', async () => {
  const Dv = freshDevices();
  const fb = fakeBluetooth();
  setNav(fb.nav);
  const tm = fakeTimers(Dv);
  await Dv.connectHeartRate();
  fb.device.gatt.connected = false;
  fb.listeners.gattserverdisconnected();
  const t = tm.take(1000);
  const before = fb.device.gatt.attempts;
  await Dv.disconnect();
  await t.f();   // aunque el temporizador se ejecute, no reconecta
  assert.strictEqual(fb.device.gatt.attempts, before);
  assert.strictEqual(stateOf(Dv, 'hr'), 'disconnected');
});

test('Reconectar tras recargar: usa el id guardado y navigator.bluetooth.getDevices()', async () => {
  const Dv = freshDevices();   // página recién cargada: nada en memoria
  fakeTimers(Dv);
  setNav(fakeBluetooth().nav);   // sin getDevices
  assert.strictEqual(Dv.canReconnect('csc', 'dev-7'), false, 'sin getDevices no se ofrece');
  await assert.rejects(Dv.reconnect('csc', 'dev-7'), /no permite reconectar/);
  const fb = fakeBluetooth({ id: 'dev-7', getDevices: true });
  setNav(fb.nav);
  assert.strictEqual(Dv.canReconnect('csc', null), false, 'sin id no se ofrece');
  assert.strictEqual(Dv.canReconnect('csc', 'dev-7'), true);
  const r = await Dv.reconnect('csc', 'dev-7');
  assert.strictEqual(r.id, 'dev-7');
  assert.strictEqual(stateOf(Dv, 'csc'), 'connected');
  assert.strictEqual(Dv.canReconnect('trainer', 'x'), false);
  await assert.rejects(Dv.reconnect('hr', 'otro-id'), /No se encontró/);
  await Dv.disconnect();
});

test('NotFoundError (selector cancelado) es un aviso suave', () => {
  const e = D._translateError({ name: 'NotFoundError', message: 'User cancelled' });
  assert.strictEqual(e.soft, true);
  assert.match(e.message, /No se seleccionó/);
  assert.ok(!D._translateError({ name: 'NetworkError' }).soft);
});

// ---- Normalización ----
test('normalize: valores por defecto', () => {
  const n = SS.normalize({});
  assert.deepStrictEqual(n.trainer, { type: 'mecanico-8', wheelCircMm: 2050, flatLevel: 3, powerScale: 1 });
  assert.deepStrictEqual(n.sensors, { lastSpeedId: null, lastHrId: null });
  assert.deepStrictEqual(SS.normalize(undefined).trainer.wheelCircMm, 2050);
  assert.strictEqual(SS.presetFor(SS.normalize({}).trainer.wheelCircMm), '26x1.95');
});

test('normalize: recorta, redondea y descarta basura; conserva otras claves', () => {
  const input = { botsCount: 14, trainer: { type: 'otro', wheelCircMm: '2300', flatLevel: 11, powerScale: 2 }, sensors: { lastSpeedId: 5, lastHrId: 'abc' } };
  const n = SS.normalize(input);
  assert.strictEqual(n.botsCount, 14);
  assert.deepStrictEqual(n.trainer, { type: 'mecanico-8', wheelCircMm: 2300, flatLevel: 8, powerScale: 1.3 });
  assert.deepStrictEqual(n.sensors, { lastSpeedId: null, lastHrId: 'abc' });
  assert.strictEqual(input.trainer.flatLevel, 11, 'no muta la entrada');
  assert.strictEqual(SS.normalizeTrainer({ powerScale: 0.1 }).powerScale, 0.7);
  assert.strictEqual(SS.normalizeTrainer({ powerScale: 'x', wheelCircMm: 'x', flatLevel: null }).wheelCircMm, 2050);
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

// ---- Tarjeta "Sensores y rodillo" con un DOM mínimo falso ----
function fakeDocument() {
  function mk(tag) {
    const n = {
      tagName: tag.toUpperCase(), attrs: {}, children: [], listeners: {}, parent: null,
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      hasAttribute(k) { return k in this.attrs; },
      addEventListener(e, f) { (this.listeners[e] = this.listeners[e] || []).push(f); },
      appendChild(c) { c.parent = this; this.children.push(c); return c; },
      dispatch(e, ev) { (this.listeners[e] || []).forEach((f) => f(Object.assign({ target: this }, ev || {}))); },
      set textContent(v) { this.children = v ? [{ text: String(v) }] : []; },
      get textContent() { return this.children.map((c) => (c.text != null ? c.text : c.textContent)).join(''); },
      all(pred, out = []) { this.children.forEach((c) => { if (c.tagName) { if (pred(c)) out.push(c); c.all(pred, out); } }); return out; },
      find(pred) { return this.all(pred)[0] || null; }
    };
    return n;
  }
  return { createElement: mk, createTextNode: (t) => ({ text: t }) };
}

function loadCard() {
  globalThis.document = fakeDocument();
  require('../src/ui/sensors-card.js');
  return globalThis.R.ui.sensorsCard;
}

function fakeStore(settings) {
  let state = { settings: settings || {} };
  return { get: () => state, set: (patch) => { state = Object.assign({}, state, { settings: Object.assign({}, state.settings, patch.settings) }); } };
}

function fakeDev(over = {}) {
  const h = {};
  return Object.assign({
    handlers: h,
    on: (ev, f) => { (h[ev] = h[ev] || []).push(f); return () => { h[ev] = h[ev].filter((x) => x !== f); }; },
    emit: (ev) => (h[ev] || []).slice().forEach((f) => f()),
    count: () => Object.values(h).reduce((a, l) => a + l.length, 0),
    isBluetoothAvailable: async () => true,
    status: () => [],
    setWheelCirc: () => {},
    canReconnect: () => false,
    reconnect: async () => ({}),
    connectSpeedCadence: async () => ({ id: 'x' }),
    connectHeartRate: async () => ({ id: 'y' }),
    _cscModeText: D._cscModeText
  }, over);
}

function withDev(dev, fn) {
  const prev = globalThis.R.devices;
  globalThis.R.devices = dev;
  try { return fn(); } finally { globalThis.R.devices = prev; }
}

const byId = (root, id) => root.find((n) => n.attrs.id === id);
const customLabel = (root) => root.find((n) => n.attrs.class === 'sn-custom');
const buttons = (root, text) => root.all((n) => n.tagName === 'BUTTON' && n.textContent === text);

test('tarjeta: "Personalizado" se puede elegir aunque los mm coincidan con un preset', () => {
  const card = loadCard();
  const store = fakeStore({});
  const root = document.createElement('div'); root.isConnected = true;
  withDev(fakeDev(), () => card(root, { store }));
  assert.strictEqual(customLabel(root).hasAttribute('hidden'), true);
  byId(root, 'sn-preset').dispatch('change', { target: { value: 'custom' } });
  const sel = byId(root, 'sn-preset');
  assert.strictEqual(sel.children.find((o) => o.selected).value, 'custom');
  assert.strictEqual(customLabel(root).hasAttribute('hidden'), false, 'aparece el campo de mm');
  // Escribe un valor que coincide con un preset: sigue en Personalizado
  customLabel(root).find((n) => n.tagName === 'INPUT').dispatch('change', { target: { value: '2070' } });
  assert.strictEqual(store.get().settings.trainer.wheelCircMm, 2070);
  assert.strictEqual(customLabel(root).hasAttribute('hidden'), false);
  // Valor propio
  customLabel(root).find((n) => n.tagName === 'INPUT').dispatch('change', { target: { value: '2111' } });
  assert.strictEqual(store.get().settings.trainer.wheelCircMm, 2111);
  // Volver a un preset oculta el campo
  byId(root, 'sn-preset').dispatch('change', { target: { value: '26x2.25' } });
  assert.strictEqual(store.get().settings.trainer.wheelCircMm, 2100);
  assert.strictEqual(customLabel(root).hasAttribute('hidden'), true);
});

test('tarjeta: "Reconectar" solo si el dispositivo lo permite, con el id guardado', async () => {
  const card = loadCard();
  const calls = [];
  let allow = false;
  const dev = fakeDev({
    status: () => [{ kind: 'csc', state: 'disconnected', id: null }],
    canReconnect: (kind, id) => { calls.push(['can', kind, id]); return allow; },
    reconnect: async (kind, id) => { calls.push(['re', kind, id]); return {}; }
  });
  const root = document.createElement('div'); root.isConnected = true;
  const store = fakeStore({ sensors: { lastSpeedId: 'dev-9' } });
  const c = withDev(dev, () => card(root, { store }));
  assert.strictEqual(buttons(root, 'Reconectar').length, 0);
  assert.ok(calls.some((x) => x[0] === 'can' && x[1] === 'csc' && x[2] === 'dev-9'));
  allow = true; c.redraw();
  const b = buttons(root, 'Reconectar');
  assert.strictEqual(b.length, 2);   // csc y hr (este último sin id)
  b[0].dispatch('click');
  assert.deepStrictEqual(calls.filter((x) => x[0] === 're')[0], ['re', 'csc', 'dev-9']);
  c.destroy();
});

test('tarjeta: cancelar el selector muestra un aviso suave, no una alerta', async () => {
  const card = loadCard();
  const err = Object.assign(new Error('No se seleccionó ningún dispositivo.'), { soft: true });
  const dev = fakeDev({ connectHeartRate: () => Promise.reject(err) });
  const root = document.createElement('div'); root.isConnected = true;
  const c = withDev(dev, () => card(root, { store: fakeStore({}) }));
  buttons(root, 'Conectar pulso')[0].dispatch('click');
  await new Promise((r) => setImmediate(r));
  assert.ok(root.find((n) => n.attrs.class === 'sn-note'));
  assert.strictEqual(root.find((n) => n.attrs.role === 'alert' && /No se seleccionó/.test(n.textContent)), null);
  c.destroy();
});

test('tarjeta: destroy() y autodesuscripción cuando el contenedor sale del documento', async () => {
  const card = loadCard();
  const dev = fakeDev();
  const root = document.createElement('div'); root.isConnected = true;
  const c = withDev(dev, () => card(root, { store: fakeStore({}) }));
  assert.strictEqual(dev.count(), 5);
  c.destroy();
  assert.strictEqual(dev.count(), 0);

  const dev2 = fakeDev();
  const root2 = document.createElement('div'); root2.isConnected = true;
  withDev(dev2, () => card(root2, { store: fakeStore({}) }));
  await new Promise((r) => setImmediate(r));
  dev2.emit('status');
  assert.strictEqual(dev2.count(), 5, 'sigue suscrita mientras está en el documento');
  root2.isConnected = false;
  dev2.emit('status');
  assert.strictEqual(dev2.count(), 0, 'se desuscribe sola');

  // Un contenedor que aún no se ha insertado no se desuscribe
  const dev3 = fakeDev();
  const root3 = document.createElement('div'); root3.isConnected = false;
  withDev(dev3, () => card(root3, { store: fakeStore({}) }));
  dev3.emit('status');
  assert.strictEqual(dev3.count(), 5);
});

test('texto del pulso: banda de pecho, reloj "según lo comprobado" y Strava como próximamente', () => {
  const card = loadCard();
  assert.match(card.MSG_WATCH, /banda de pecho/);
  assert.match(card.MSG_WATCH, /Según lo comprobado/);
  assert.match(card.MSG_WATCH, /Próximamente/);
});
