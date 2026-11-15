(function (R) {
  'use strict';

  var FTMS = 0x1826, INDOOR_BIKE_DATA = 0x2AD2, FTMS_CONTROL_POINT = 0x2AD9;
  var CYCLING_POWER = 0x1818, CYCLING_POWER_MEASUREMENT = 0x2A63;
  var HEART_RATE = 0x180D, HEART_RATE_MEASUREMENT = 0x2A37;

  var MSG_BLOCKED = 'El navegador bloqueó Bluetooth en esta vista. Abre Rodillator en una pestaña de Chrome o Edge.';

  // ---------- Parsers puros ----------

  function indoorBikeData(dv) {
    var flags = dv.getUint16(0, true);
    var o = 2;
    var out = { powerW: null, cadenceRpm: null, speedKph: null, hrBpm: null };
    if ((flags & 0x01) === 0) { out.speedKph = dv.getUint16(o, true) * 0.01; o += 2; } // bit0=1: "More Data", sin velocidad
    if (flags & 0x02) o += 2;                                                         // velocidad media
    if (flags & 0x04) { out.cadenceRpm = dv.getUint16(o, true) * 0.5; o += 2; }       // cadencia instantánea
    if (flags & 0x08) o += 2;                                                         // cadencia media
    if (flags & 0x10) o += 3;                                                         // distancia total (uint24)
    if (flags & 0x20) o += 2;                                                         // nivel de resistencia
    if (flags & 0x40) { out.powerW = dv.getInt16(o, true); o += 2; }                  // potencia instantánea
    if (flags & 0x80) o += 2;                                                         // potencia media
    if (flags & 0x100) o += 5;                                                        // energía (total, /h, /min)
    if (flags & 0x200) { out.hrBpm = dv.getUint8(o); o += 1; }                        // frecuencia cardíaca
    return out;
  }

  // prevState: { crankRevs, crankTime, cadenceRpm, idle } de la lectura anterior (o null).
  function cyclingPower(dv, prevState) {
    var flags = dv.getUint16(0, true);
    var powerW = dv.getInt16(2, true);
    var o = 4;
    if (flags & 0x01) o += 1;   // balance de pedal
    if (flags & 0x04) o += 2;   // torque acumulado
    if (flags & 0x10) o += 6;   // revoluciones de rueda
    var cadenceRpm = prevState && prevState.cadenceRpm != null ? prevState.cadenceRpm : null;
    var state = prevState ? { crankRevs: prevState.crankRevs, crankTime: prevState.crankTime, cadenceRpm: cadenceRpm, idle: prevState.idle || 0 } : null;
    if (flags & 0x20) {
      var revs = dv.getUint16(o, true), time = dv.getUint16(o + 2, true);
      if (prevState && prevState.crankRevs != null) {
        var dRev = (revs - prevState.crankRevs + 65536) % 65536;
        var dTime = (time - prevState.crankTime + 65536) % 65536;
        if (dTime > 0) {
          cadenceRpm = dRev / (dTime / 1024) * 60;
          state = { crankRevs: revs, crankTime: time, cadenceRpm: cadenceRpm, idle: 0 };
        } else {
          // Sin evento de biela nuevo: conserva la cadencia unas lecturas y luego la pone en 0.
          var idle = (prevState.idle || 0) + 1;
          cadenceRpm = idle > 3 ? 0 : cadenceRpm;
          state = { crankRevs: revs, crankTime: time, cadenceRpm: cadenceRpm, idle: idle };
        }
      } else {
        state = { crankRevs: revs, crankTime: time, cadenceRpm: null, idle: 0 };
      }
    }
    return { powerW: powerW, cadenceRpm: cadenceRpm, state: state };
  }

  function heartRate(dv) {
    var flags = dv.getUint8(0);
    return { hrBpm: (flags & 0x01) ? dv.getUint16(1, true) : dv.getUint8(1) };
  }

  // ---------- Emisor ----------

  function createEmitter() {
    var handlers = {};
    return {
      on: function (ev, fn) {
        (handlers[ev] = handlers[ev] || []).push(fn);
        return function () { handlers[ev] = (handlers[ev] || []).filter(function (f) { return f !== fn; }); };
      },
      emit: function (ev, payload) {
        (handlers[ev] || []).slice().forEach(function (f) { try { f(payload); } catch (e) { /* aislar suscriptores */ } });
      }
    };
  }

  // ---------- Errores ----------

  function translateError(e) {
    var name = e && e.name, msg = (e && e.message) || '';
    if (name === 'SecurityError' || name === 'NotAllowedError' || /permissions? policy|disallowed|not allowed/i.test(msg)) {
      return new Error(MSG_BLOCKED);
    }
    if (name === 'NotFoundError') return new Error('No se seleccionó ningún dispositivo.');
    if (name === 'NetworkError') return new Error('No se pudo conectar con el dispositivo. Acércalo e inténtalo de nuevo.');
    if (/bluetooth/i.test(msg) && /not (supported|available)|undefined/i.test(msg)) {
      return new Error('Este navegador no es compatible con Bluetooth. Usa Chrome o Edge.');
    }
    return new Error('Error de Bluetooth: ' + (msg || 'desconocido'));
  }

  function nav() { return (typeof navigator !== 'undefined') ? navigator : null; }

  async function isBluetoothAvailable() {
    try {
      var n = nav();
      if (!n || !n.bluetooth) return false;
      if (typeof n.bluetooth.getAvailability === 'function') return !!(await n.bluetooth.getAvailability());
      return true;
    } catch (e) { return false; }
  }

  // ---------- Dispositivos reales ----------

  var emitter = createEmitter();
  var latest = { trainer: {}, powermeter: {}, hr: {} };
  var conns = { trainer: null, powermeter: null, hr: null };   // { device, server, chars... }
  var cpState = null;
  var writeChain = Promise.resolve();

  function pick() {
    for (var i = 0; i < arguments.length; i++) if (arguments[i] != null) return arguments[i];
    return null;
  }

  function publish(source) {
    var t = latest.trainer, p = latest.powermeter, h = latest.hr;
    emitter.emit('data', {
      powerW: pick(p.powerW, t.powerW),
      cadenceRpm: pick(p.cadenceRpm, t.cadenceRpm),
      speedKph: pick(t.speedKph),
      hrBpm: pick(h.hrBpm, t.hrBpm),
      source: source
    });
  }

  async function openDevice(options, kind, serviceUuid, charUuid, onValue) {
    var n = nav();
    if (!n || !n.bluetooth) throw new Error(MSG_BLOCKED);
    var device = null;
    try {
      device = await n.bluetooth.requestDevice(options);
      var server = await device.gatt.connect();
      var service = await server.getPrimaryService(serviceUuid);
      var ch = await service.getCharacteristic(charUuid);
      ch.addEventListener('characteristicvaluechanged', function (ev) { onValue(ev.target.value); });
      await ch.startNotifications();
      device.addEventListener('gattserverdisconnected', function () {
        conns[kind] = null;
        latest[kind] = {};
        if (kind === 'powermeter') cpState = null;
        emitter.emit('disconnected', { kind: kind });
      });
      conns[kind] = { device: device, server: server, service: service, ch: ch };
      return { name: device.name || '', kind: kind, service: service, server: server };
    } catch (e) {
      try { if (device && device.gatt && device.gatt.connected) device.gatt.disconnect(); } catch (e2) { /* ya desconectado */ }
      if (kind === 'powermeter') cpState = null;
      throw translateError(e);
    }
  }

  // ---- Control Point FTMS: comandos serializados con espera de la indicación de respuesta ----
  var CONTROL_TIMEOUT_MS = 3000;
  var MSG_CONTROL_REFUSED = 'El rodillo no aceptó el control (ERG/pendiente). Puedes seguir en modo libre.';
  var MSG_CONTROL_ABSENT = 'Este rodillo no ofrece control remoto (ERG/pendiente). Puedes seguir en modo libre.';
  var pendingResp = null;   // { opcode, resolve }

  function onControlResponse(dv) {
    // Respuesta: [0x80, opcode solicitado, resultado]; resultado 0x01 = éxito.
    if (!dv || dv.byteLength < 3 || dv.getUint8(0) !== 0x80 || !pendingResp) return;
    if (dv.getUint8(1) !== pendingResp.opcode) return;
    var p = pendingResp; pendingResp = null;
    p.resolve(dv.getUint8(2));
  }

  function controlError(msg, kind) {
    emitter.emit('controlError', { message: msg, kind: kind || 'refused' });
    return new Error(msg);
  }

  function writeControl(bytes) {
    var c = conns.trainer && conns.trainer.control;
    if (!c) {
      return Promise.reject(new Error(conns.trainer ? MSG_CONTROL_ABSENT : 'No hay un rodillo conectado.'));
    }
    var buf = new Uint8Array(bytes);
    var opcode = bytes[0];
    var job = writeChain.then(async function () {
      var wait = new Promise(function (resolve) {
        var timer = setTimeout(function () { if (pendingResp && pendingResp.opcode === opcode) pendingResp = null; resolve(null); }, CONTROL_TIMEOUT_MS);
        pendingResp = { opcode: opcode, resolve: function (r) { clearTimeout(timer); resolve(r); } };
      });
      try {
        if (typeof c.writeValueWithResponse === 'function') await c.writeValueWithResponse(buf); else await c.writeValue(buf);
      } catch (e) {
        pendingResp = null;
        throw controlError(MSG_CONTROL_REFUSED);
      }
      var result = await wait;
      if (result !== 0x01) throw controlError(MSG_CONTROL_REFUSED);
      return true;
    });
    writeChain = job.catch(function () {});
    return job;
  }

  async function connectTrainer() {
    var info = await openDevice(
      { filters: [{ services: [FTMS] }], optionalServices: [FTMS, CYCLING_POWER, HEART_RATE] },
      'trainer', FTMS, INDOOR_BIKE_DATA,
      function (dv) { latest.trainer = indoorBikeData(dv); publish('trainer'); }
    );
    var control = null;
    try {
      control = await info.service.getCharacteristic(FTMS_CONTROL_POINT);
    } catch (e) {
      // Característica ausente: rodillo de solo lectura (distinto de un rechazo de control).
      controlError(MSG_CONTROL_ABSENT, 'absent');
    }
    if (control) {
      try {
        control.addEventListener('characteristicvaluechanged', function (ev) { onControlResponse(ev.target.value); });
        await control.startNotifications();   // indicaciones ANTES de escribir
        conns.trainer.control = control;
        await writeControl([0x00]);           // Request Control
        await writeControl([0x07]);           // Start
      } catch (e) {
        if (conns.trainer && conns.trainer.control) { /* el error ya se emitió en writeControl */ }
        else controlError(MSG_CONTROL_REFUSED);
        if (conns.trainer) conns.trainer.control = null;
      }
    }
    return { name: info.name, kind: 'trainer', controllable: !!(conns.trainer && conns.trainer.control) };
  }

  async function connectPowerMeter() {
    var info = await openDevice(
      { filters: [{ services: [CYCLING_POWER] }] },
      'powermeter', CYCLING_POWER, CYCLING_POWER_MEASUREMENT,
      function (dv) {
        var r = cyclingPower(dv, cpState);
        cpState = r.state;
        latest.powermeter = { powerW: r.powerW, cadenceRpm: r.cadenceRpm };
        publish('powermeter');
      }
    );
    return { name: info.name, kind: 'powermeter' };
  }

  async function connectHeartRate() {
    var info = await openDevice(
      { filters: [{ services: [HEART_RATE] }] },
      'hr', HEART_RATE, HEART_RATE_MEASUREMENT,
      function (dv) { latest.hr = heartRate(dv); publish('hr'); }
    );
    return { name: info.name, kind: 'hr' };
  }

  function clampInt(v, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(v))); }

  function i16(v) { var x = clampInt(v, -32768, 32767); return [x & 0xff, (x >> 8) & 0xff]; }

  function setErgPower(w) {
    var b = i16(w);
    return writeControl([0x05, b[0], b[1]]);
  }

  // gradePct en %, windMps en m/s, crr adimensional (ej. 0.004), cw en kg/m (ej. 0.51)
  function setSimulation(o) {
    o = o || {};
    var wind = i16((o.windMps || 0) / 0.001);
    var grade = i16((o.gradePct || 0) / 0.01);
    var crr = clampInt((o.crr != null ? o.crr : 0.004) / 0.0001, 0, 255);
    var cw = clampInt((o.cw != null ? o.cw : 0.51) / 0.01, 0, 255);
    return writeControl([0x11, wind[0], wind[1], grade[0], grade[1], crr, cw]);
  }

  async function disconnect() {
    ['trainer', 'powermeter', 'hr'].forEach(function (k) {
      var c = conns[k];
      try { if (c && c.server && c.server.connected) c.device.gatt.disconnect(); } catch (e) { /* ya desconectado */ }
      conns[k] = null;
      latest[k] = {};
    });
    cpState = null;
  }

  // ---------- Simulador ----------

  // Velocidad en llano (km/h) para una potencia en rueda, con constantes del SPEC (masa 80 kg total aprox.).
  function flatSpeedKph(powerW, massKg) {
    var rho = 1.225, cda = 0.32, crr = 0.004, g = 9.8067, eff = 0.976;
    var lo = 0, hi = 30; // m/s
    var p = powerW * eff;
    for (var i = 0; i < 30; i++) {
      var v = (lo + hi) / 2;
      var need = 0.5 * rho * cda * v * v * v + crr * massKg * g * v;
      if (need > p) hi = v; else lo = v;
    }
    return ((lo + hi) / 2) * 3.6;
  }

  function createSimulator(opts) {
    opts = opts || {};
    var now = opts.now || function () { return Date.now(); };
    var setIv = opts.setInterval || function (f, ms) { return setInterval(f, ms); };
    var clearIv = opts.clearInterval || function (h) { clearInterval(h); };
    var rand = opts.random || Math.random;
    var ftp = opts.ftp || 200;
    var maxHr = opts.maxHr || 185;
    var restHr = opts.restHr || 60;
    var massKg = opts.massKg || 80;
    var TICK_MS = 250, POWER_TAU = 2, HR_TAU = 30;
    var em = createEmitter();

    var target = opts.targetPower != null ? opts.targetPower : 0;
    var power = 0, hr = restHr, handle = null, last = 0, elapsed = 0;

    function tick() {
      var t = now();
      var dt = last ? Math.max(0.001, (t - last) / 1000) : TICK_MS / 1000;
      last = t;
      elapsed += dt;
      power += (target - power) * (1 - Math.exp(-dt / POWER_TAU));
      var noisy = Math.max(0, power * (1 + (rand() * 2 - 1) * 0.03));
      var pct = ftp > 0 ? noisy / ftp : 0;
      var hrTarget = restHr + (maxHr - restHr) * Math.min(1, pct * 0.85); // 100 % FTP ≈ 85 % de la reserva
      hr += (hrTarget - hr) * (1 - Math.exp(-dt / HR_TAU));
      var cadence = noisy < 5 ? 0 : 90 + 4 * Math.sin(elapsed / 6) + (rand() * 2 - 1);
      em.emit('data', {
        powerW: Math.round(noisy),
        cadenceRpm: Math.round(Math.max(0, cadence)),
        speedKph: Math.round(flatSpeedKph(noisy, massKg) * 10) / 10,
        hrBpm: Math.round(hr),
        source: 'simulator'
      });
    }

    var sim = {
      on: em.on,
      start: function () { if (handle === null) { last = 0; handle = setIv(tick, TICK_MS); } return sim; },
      stop: function () { if (handle !== null) { clearIv(handle); handle = null; } return sim; },
      setTargetPower: function (w) { target = Math.max(0, w); return target; },
      nudge: function (delta) { target = Math.max(0, target + delta); return target; },
      getTargetPower: function () { return target; },
      setFtp: function (w) { ftp = w; },
      // Paridad con la interfaz del rodillo real.
      setErgPower: function (w) { sim.setTargetPower(w); return Promise.resolve(); },
      setSimulation: function () { return Promise.resolve(); },
      disconnect: function () { sim.stop(); return Promise.resolve(); },
      _tick: tick
    };
    return sim;
  }

  R.devices = {
    isBluetoothAvailable: isBluetoothAvailable,
    connectTrainer: connectTrainer,
    connectPowerMeter: connectPowerMeter,
    connectHeartRate: connectHeartRate,
    setErgPower: setErgPower,
    setSimulation: setSimulation,
    disconnect: disconnect,
    on: emitter.on,
    createSimulator: createSimulator,
    _parse: { indoorBikeData: indoorBikeData, cyclingPower: cyclingPower, heartRate: heartRate },
    _translateError: translateError
  };
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
