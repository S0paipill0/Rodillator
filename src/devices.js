(function (R) {
  'use strict';

  var FTMS = 0x1826, INDOOR_BIKE_DATA = 0x2AD2, FTMS_CONTROL_POINT = 0x2AD9;
  var CYCLING_POWER = 0x1818, CYCLING_POWER_MEASUREMENT = 0x2A63;
  var HEART_RATE = 0x180D, HEART_RATE_MEASUREMENT = 0x2A37;
  var CSC = 0x1816, CSC_MEASUREMENT = 0x2A5B;
  var BATTERY = 0x180F, BATTERY_LEVEL = 0x2A19;
  var DEFAULT_WHEEL_MM = 2050;
  var CSC_IDLE_MS = 3000;   // sin eventos de rueda/biela durante 3 s => velocidad/cadencia 0

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

  // CSC (0x2A5B). prevState: el `state` devuelto por la lectura anterior (o null).
  // opts: { wheelCircMm = 2070, nowMs = Date.now() }.
  // Devuelve { speedKph|null, cadenceRpm|null, wheelRevs, crankRevs, mode, state }.
  //   wheelRevs/crankRevs: contadores crudos del sensor (null si el flag no viene).
  //   mode: 'speed' (solo rueda) | 'cadence' (solo biela) | 'both'.
  // Los tiempos de evento van en 1/1024 s y se desbordan en uint16; las revoluciones de rueda en uint32.
  function csc(dv, prevState, opts) {
    opts = opts || {};
    var circMm = opts.wheelCircMm > 0 ? opts.wheelCircMm : DEFAULT_WHEEL_MM;
    var nowMs = opts.nowMs != null ? opts.nowMs : Date.now();
    var flags = dv.getUint8(0);
    var hasWheel = !!(flags & 0x01), hasCrank = !!(flags & 0x02);
    var o = 1;
    var prev = prevState || {};
    var st = {
      wheelRevs: prev.wheelRevs != null ? prev.wheelRevs : null, wheelTime: prev.wheelTime != null ? prev.wheelTime : null,
      crankRevs: prev.crankRevs != null ? prev.crankRevs : null, crankTime: prev.crankTime != null ? prev.crankTime : null,
      speedKph: prev.speedKph != null ? prev.speedKph : null, cadenceRpm: prev.cadenceRpm != null ? prev.cadenceRpm : null,
      lastWheelMs: prev.lastWheelMs != null ? prev.lastWheelMs : null, lastCrankMs: prev.lastCrankMs != null ? prev.lastCrankMs : null
    };
    var wheelRevs = null, crankRevs = null;
    if (hasWheel) {
      wheelRevs = dv.getUint32(o, true); var wt = dv.getUint16(o + 4, true); o += 6;
      if (prev.wheelRevs == null) {
        st.lastWheelMs = nowMs;
      } else {
        var dTime = (wt - prev.wheelTime + 65536) % 65536;
        var dRev = (wheelRevs - prev.wheelRevs) >>> 0;
        if (dTime > 0 && dRev > 0) {
          st.speedKph = dRev * (circMm / 1000) / (dTime / 1024) * 3.6;
          st.lastWheelMs = nowMs;
        } else if (dRev === 0 && dTime === 0) {
          if (st.lastWheelMs == null) st.lastWheelMs = nowMs;
          if (nowMs - st.lastWheelMs > CSC_IDLE_MS) st.speedKph = 0;   // sin evento nuevo: conserva y luego 0
        } else {
          st.lastWheelMs = nowMs;
        }
      }
      st.wheelRevs = wheelRevs; st.wheelTime = wt;
    }
    if (hasCrank) {
      crankRevs = dv.getUint16(o, true); var ct = dv.getUint16(o + 2, true); o += 4;
      if (prev.crankRevs == null) {
        st.lastCrankMs = nowMs;
      } else {
        var cdT = (ct - prev.crankTime + 65536) % 65536;
        var cdR = (crankRevs - prev.crankRevs + 65536) % 65536;
        if (cdT > 0 && cdR > 0) {
          st.cadenceRpm = cdR / (cdT / 1024) * 60;
          st.lastCrankMs = nowMs;
        } else if (cdR === 0 && cdT === 0) {
          if (st.lastCrankMs == null) st.lastCrankMs = nowMs;
          if (nowMs - st.lastCrankMs > CSC_IDLE_MS) st.cadenceRpm = 0;
        } else {
          st.lastCrankMs = nowMs;
        }
      }
      st.crankRevs = crankRevs; st.crankTime = ct;
    }
    return {
      speedKph: hasWheel ? st.speedKph : null,
      cadenceRpm: hasCrank ? st.cadenceRpm : null,
      wheelRevs: wheelRevs, crankRevs: crankRevs,
      mode: hasWheel && hasCrank ? 'both' : (hasCrank ? 'cadence' : 'speed'),
      state: st
    };
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
  var latest = { trainer: {}, powermeter: {}, hr: {}, csc: {} };
  var conns = { trainer: null, powermeter: null, hr: null, csc: null };   // { device, server, chars... }
  var cpState = null;
  var cscState = null;
  var wheelCircMm = null;      // fijado por setWheelCirc / opciones de connectSpeedCadence
  var cscMode = null;          // 'speed' | 'cadence' | 'both' | null
  var RETRY_DELAYS_MS = [1000, 2000, 4000];   // 3 reintentos con espera creciente
  var cfg = { retryDelaysMs: RETRY_DELAYS_MS, setTimeout: function (f, ms) { return setTimeout(f, ms); } };
  var remembered = {};         // kind -> { id, name, device } (sesión)
  var meta = {};               // kind -> { name, id, state, batteryPct, retries }
  var closing = {};            // kind -> true si la desconexión fue pedida por el usuario
  var writeChain = Promise.resolve();

  function pick() {
    for (var i = 0; i < arguments.length; i++) if (arguments[i] != null) return arguments[i];
    return null;
  }

  function publish(source) {
    var t = latest.trainer, p = latest.powermeter, h = latest.hr;
    var c = latest.csc;
    emitter.emit('data', {
      powerW: pick(p.powerW, t.powerW),
      cadenceRpm: pick(p.cadenceRpm, c.cadenceRpm, t.cadenceRpm),
      speedKph: pick(c.speedKph, t.speedKph),
      hrBpm: pick(h.hrBpm, t.hrBpm),
      source: source
    });
  }

  function setMeta(kind, patch) {
    meta[kind] = Object.assign(meta[kind] || { name: '', id: null, state: 'disconnected', batteryPct: null, retries: 0 }, patch);
    emitter.emit('status', status());
  }

  function status() {
    return Object.keys(meta).map(function (k) {
      var m = meta[k];
      return { kind: k, name: m.name, id: m.id, state: m.state, batteryPct: m.batteryPct, retries: m.retries, mode: k === 'csc' ? cscMode : null };
    });
  }

  function rememberDevice(kind, device) {
    remembered[kind] = { id: device.id || null, name: device.name || '', device: device };
    try { if (typeof sessionStorage !== 'undefined') sessionStorage.setItem('rodillator.sensor.' + kind, device.id || ''); } catch (e) { /* sin sessionStorage */ }
  }

  function clearLatest(kind) {
    latest[kind] = {};
    if (kind === 'powermeter') cpState = null;
    if (kind === 'csc') { cscState = null; cscMode = null; }
  }

  async function readBattery(kind, server) {
    try {
      var bs = await server.getPrimaryService(BATTERY);
      var bc = await bs.getCharacteristic(BATTERY_LEVEL);
      var v = await bc.readValue();
      setMeta(kind, { batteryPct: v.getUint8(0) });
    } catch (e) { /* Battery Service opcional */ }
  }

  // Conecta GATT, suscribe notificaciones y registra el manejo de desconexión (con reintentos).
  async function attach(device, kind, serviceUuid, charUuid, onValue) {
    var server = await device.gatt.connect();
    var service = await server.getPrimaryService(serviceUuid);
    var ch = await service.getCharacteristic(charUuid);
    ch.addEventListener('characteristicvaluechanged', function (ev) { onValue(ev.target.value); });
    await ch.startNotifications();
    conns[kind] = { device: device, server: server, service: service, ch: ch, spec: [serviceUuid, charUuid, onValue] };
    setMeta(kind, { name: device.name || '', id: device.id || null, state: 'connected', retries: 0 });
    readBattery(kind, server);
    return conns[kind];
  }

  var wired = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
  function wireDisconnect(device, kind) {
    if (wired) { if (wired.has(device)) return; wired.add(device); }
    device.addEventListener('gattserverdisconnected', function () {
      var spec = conns[kind] && conns[kind].spec;
      conns[kind] = null;
      clearLatest(kind);
      emitter.emit('disconnected', { kind: kind });
      if (closing[kind] || !spec || (kind !== 'csc' && kind !== 'hr')) { setMeta(kind, { state: 'disconnected' }); return; }
      retryConnect(device, kind, spec, 0);
    });
  }

  function retryConnect(device, kind, spec, attempt) {
    var delays = cfg.retryDelaysMs;
    if (attempt >= delays.length) { setMeta(kind, { state: 'disconnected', retries: attempt }); emitter.emit('reconnectFailed', { kind: kind }); return; }
    setMeta(kind, { state: 'reconnecting', retries: attempt + 1 });
    cfg.setTimeout(async function () {
      if (closing[kind] || conns[kind]) return;
      try {
        await attach(device, kind, spec[0], spec[1], spec[2]);
        emitter.emit('reconnected', { kind: kind });
      } catch (e) { retryConnect(device, kind, spec, attempt + 1); }
    }, delays[attempt]);
  }

  async function openDevice(options, kind, serviceUuid, charUuid, onValue) {
    var n = nav();
    if (!n || !n.bluetooth) throw new Error(MSG_BLOCKED);
    var device = null;
    closing[kind] = false;
    try {
      device = await n.bluetooth.requestDevice(options);
      await attach(device, kind, serviceUuid, charUuid, onValue);
      wireDisconnect(device, kind);
      rememberDevice(kind, device);
      return { name: device.name || '', id: device.id || null, kind: kind, service: conns[kind].service, server: conns[kind].server };
    } catch (e) {
      try { if (device && device.gatt && device.gatt.connected) device.gatt.disconnect(); } catch (e2) { /* ya desconectado */ }
      conns[kind] = null;
      clearLatest(kind);
      throw translateError(e);
    }
  }

  // "Reconectar": reutiliza el dispositivo recordado en la sesión (por objeto o, si el navegador lo permite, por device.id).
  async function reconnect(kind) {
    var rem = remembered[kind];
    if (!rem) throw new Error('No hay un sensor recordado en esta sesión. Conéctalo de nuevo.');
    if (conns[kind]) return { name: rem.name, id: rem.id, kind: kind };
    var spec = kind === 'csc' ? [CSC, CSC_MEASUREMENT, onCscValue] : kind === 'hr' ? [HEART_RATE, HEART_RATE_MEASUREMENT, onHrValue] : null;
    if (!spec) throw new Error('Este tipo de sensor no admite reconexión rápida.');
    var device = rem.device;
    var n = nav();
    if (!device && n && n.bluetooth && typeof n.bluetooth.getDevices === 'function') {
      var list = await n.bluetooth.getDevices();
      device = list.filter(function (d) { return d.id === rem.id; })[0];
    }
    if (!device) throw new Error('No se encontró el sensor. Conéctalo de nuevo.');
    closing[kind] = false;
    try {
      await attach(device, kind, spec[0], spec[1], spec[2]);
      wireDisconnect(device, kind);
    } catch (e) {
      conns[kind] = null;
      setMeta(kind, { state: 'disconnected' });
      throw translateError(e);
    }
    return { name: rem.name, id: rem.id, kind: kind };
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

  function onHrValue(dv) { latest.hr = heartRate(dv); publish('hr'); }

  function currentWheelMm() {
    if (wheelCircMm > 0) return wheelCircMm;
    try {
      var st = R.store && R.store.get && R.store.get();
      var w = st && st.settings && st.settings.trainer && st.settings.trainer.wheelCircMm;
      if (w > 0) return w;
    } catch (e) { /* sin store */ }
    return DEFAULT_WHEEL_MM;
  }

  function setWheelCirc(mm) { if (mm > 0) wheelCircMm = Number(mm); }

  function onCscValue(dv) {
    var r = csc(dv, cscState, { wheelCircMm: currentWheelMm() });
    cscState = r.state;
    var first = cscMode !== r.mode;
    cscMode = r.mode;
    latest.csc = { speedKph: r.speedKph, cadenceRpm: r.cadenceRpm };
    if (first) emitter.emit('cscMode', { mode: r.mode, text: cscModeText(r.mode) });
    publish('csc');
  }

  function cscModeText(mode) {
    return mode === 'cadence' ? 'Sensor en modo cadencia' : mode === 'both' ? 'Sensor en modo velocidad y cadencia' : 'Sensor en modo velocidad';
  }

  // Velocidad/cadencia (Magene S3+ u otro CSC 0x1816). Opciones: { wheelCircMm }.
  async function connectSpeedCadence(opts) {
    if (opts && opts.wheelCircMm > 0) setWheelCirc(opts.wheelCircMm);
    cscState = null; cscMode = null;
    var info = await openDevice(
      { filters: [{ services: [CSC] }], optionalServices: [CSC, BATTERY] },
      'csc', CSC, CSC_MEASUREMENT, onCscValue
    );
    return { name: info.name, id: info.id, kind: 'csc' };
  }

  async function connectHeartRate() {
    var info = await openDevice(
      { filters: [{ services: [HEART_RATE] }], optionalServices: [HEART_RATE, BATTERY] },
      'hr', HEART_RATE, HEART_RATE_MEASUREMENT, onHrValue
    );
    return { name: info.name, id: info.id, kind: 'hr' };
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
    ['trainer', 'powermeter', 'hr', 'csc'].forEach(function (k) {
      var c = conns[k];
      closing[k] = true;
      if (meta[k]) meta[k].state = 'disconnected';
      try { if (c && c.server && c.server.connected) c.device.gatt.disconnect(); } catch (e) { /* ya desconectado */ }
      conns[k] = null;
      latest[k] = {};
    });
    cpState = null; cscState = null; cscMode = null;
    emitter.emit('status', status());
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
    connectSpeedCadence: connectSpeedCadence,
    reconnect: reconnect,
    setWheelCirc: setWheelCirc,
    status: status,
    setErgPower: setErgPower,
    setSimulation: setSimulation,
    disconnect: disconnect,
    on: emitter.on,
    createSimulator: createSimulator,
    _parse: { indoorBikeData: indoorBikeData, cyclingPower: cyclingPower, heartRate: heartRate, csc: csc },
    _config: cfg,
    _cscModeText: cscModeText,
    _translateError: translateError
  };
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
