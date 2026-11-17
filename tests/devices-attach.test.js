'use strict';
// Tarea 20: attach comprueba la generación tras cada espera y limpia si hubo disconnect() en curso;
// los catch de openDevice/reconnect quitan el listener y cierran el GATT.
const test = require('node:test');
const assert = require('node:assert');

function freshDevices() {
  delete require.cache[require.resolve('../src/devices.js')];
  require('../src/devices.js');
  const D = globalThis.R.devices;
  const timers = [];
  D._config.setTimeout = (f, ms) => { timers.push({ f, ms }); return timers.length; };
  D._config.clearTimeout = () => {};
  D._config.now = () => 0;
  D._timers = timers;
  return D;
}
function setNav(nav) { Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true }); }
function deferred() { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; }

// Dispositivo falso con puntos de espera controlables: gate.connect / gate.service / gate.char / gate.notify
function fakeBle(gate = {}) {
  const ch = {
    fns: new Set(),
    addEventListener: (e, f) => ch.fns.add(f),
    removeEventListener: (e, f) => ch.fns.delete(f),
    startNotifications: async () => { if (gate.notify) await gate.notify.p; if (gate.notifyFail) throw new Error('notify falló'); }
  };
  const server = {
    connected: true,
    async getPrimaryService(uuid) {
      if (uuid === 0x180F) throw new Error('sin batería');
      if (gate.service) await gate.service.p;
      return { getCharacteristic: async () => { if (gate.char) await gate.char.p; return ch; } };
    }
  };
  const device = {
    id: 'dev-1', name: 'Magene S3+', listeners: {},
    addEventListener(e, f) { this.listeners[e] = f; },
    gatt: {
      connected: false, disconnects: 0,
      async connect() { if (gate.connect) await gate.connect.p; this.connected = true; return server; },
      disconnect() { this.connected = false; this.disconnects++; }
    }
  };
  return { ch, device, nav: { bluetooth: { requestDevice: async () => device } } };
}
const stateOf = (D, kind) => (D.status().find((s) => s.kind === kind) || {}).state;

for (const stage of ['connect', 'service', 'char', 'notify']) {
  test('disconnect() mientras attach espera (' + stage + '): limpia listener, vigilante y GATT', async () => {
    const D = freshDevices();
    const gate = {}; gate[stage] = deferred();
    const fb = fakeBle(gate);
    setNav(fb.nav);
    const pending = D.connectSpeedCadence({ wheelCircMm: 2050 });
    await new Promise((r) => setImmediate(r));
    await D.disconnect();
    gate[stage].resolve();
    await assert.rejects(pending, (e) => e.superseded === true && e.soft === true);
    assert.strictEqual(fb.ch.fns.size, 0, 'sin listener de notificaciones');
    assert.strictEqual(fb.device.gatt.connected, false, 'GATT cerrado');
    assert.notStrictEqual(stateOf(D, 'csc'), 'connected');
    assert.strictEqual(D._timers.filter((t) => t.ms === 1000).length, 0, 'sin vigilante CSC');
    // no quedó una conexión fantasma: reconectar vuelve a abrir desde cero
    const fb2 = fakeBle();
    setNav(fb2.nav);
    await D.connectSpeedCadence({ wheelCircMm: 2050 });
    assert.strictEqual(stateOf(D, 'csc'), 'connected');
    assert.strictEqual(fb2.ch.fns.size, 1);
    await D.disconnect();
  });
}

test('una conexión nueva del mismo tipo anula la anterior sin pisarla', async () => {
  const D = freshDevices();
  const gate = { connect: deferred() };
  const old = fakeBle(gate);
  setNav(old.nav);
  const p1 = D.connectHeartRate();
  await new Promise((r) => setImmediate(r));
  const fresh = fakeBle();
  fresh.device.id = 'dev-2';
  setNav(fresh.nav);
  const info = await D.connectHeartRate();
  assert.strictEqual(info.id, 'dev-2');
  gate.connect.resolve();
  await assert.rejects(p1, (e) => e.superseded === true);
  assert.strictEqual(old.device.gatt.connected, false, 'el GATT viejo se cierra');
  assert.strictEqual(old.ch.fns.size, 0);
  assert.strictEqual(fresh.ch.fns.size, 1, 'el listener nuevo sigue');
  assert.strictEqual(fresh.device.gatt.connected, true);
  assert.strictEqual(stateOf(D, 'hr'), 'connected');
  await D.disconnect();
});

test('openDevice: si startNotifications falla, quita el listener y cierra el GATT', async () => {
  const D = freshDevices();
  const fb = fakeBle({ notifyFail: true });
  setNav(fb.nav);
  await assert.rejects(D.connectSpeedCadence({}), /Error de Bluetooth/);
  assert.strictEqual(fb.ch.fns.size, 0);
  assert.strictEqual(fb.device.gatt.connected, false);
  assert.ok(fb.device.gatt.disconnects >= 1);
});

test('reconnect: si falla, quita el listener y cierra el GATT', async () => {
  const D = freshDevices();
  const fb = fakeBle();
  setNav(fb.nav);
  await D.connectHeartRate();
  fb.device.gatt.connected = false;
  fb.device.listeners.gattserverdisconnected();   // pierde la conexión: queda un reintento pendiente
  // "Reconectar" manual con un fallo en startNotifications
  fb.ch.startNotifications = async () => { throw new Error('notify falló'); };
  await assert.rejects(D.reconnect('hr'), /Error de Bluetooth/);
  assert.strictEqual(fb.ch.fns.size, 0);
  assert.strictEqual(fb.device.gatt.connected, false);
  assert.strictEqual(stateOf(D, 'hr'), 'disconnected');
});
