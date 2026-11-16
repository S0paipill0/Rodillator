(function (R) {
  'use strict';

  var MSG_NO_BT = 'Para sensores usa la versión web en Chrome.';
  var MSG_WATCH = 'Para el pulso en vivo usa una banda de pecho Bluetooth (estándar Heart Rate, servicio 0x180D), por ejemplo la de Decathlon. Según lo comprobado, el Xiaomi Watch S3 no transmite el pulso en vivo por Bluetooth. Próximamente: importar el pulso del reloj desde Strava.';
  var STATE_TEXT = { connected: 'Conectado', reconnecting: 'Reconectando…', disconnected: 'Sin conectar' };

  function fallbackEl(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') node.setAttribute('class', v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') node[k] = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    });
    (function add(c) {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) { c.forEach(add); return; }
      node.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    })(children);
    return node;
  }

  // Dibuja la tarjeta "Sensores y rodillo" dentro de containerEl.
  // ctx: { store } con get() y set(patch); si falta usa R.store.
  // Ciclo de vida: llamar destroy() al quitar la tarjeta. Además, si containerEl estuvo en el
  // documento y deja de estarlo (isConnected false), la tarjeta se desuscribe sola en el próximo evento.
  function sensorsCard(containerEl, ctx) {
    var el = (R.ui && typeof R.ui.el === 'function') ? R.ui.el : fallbackEl;
    var store = (ctx && ctx.store) || R.store;
    var SS = R.sensorsSettings;
    var dev = R.devices;
    var errorMsg = '';
    var noteMsg = '';         // aviso suave (p. ej. selector cancelado)
    var btAvailable = null;   // null = comprobando
    var unsubs = [];
    var destroyed = false;
    var wasConnected = false;
    // "Personalizado" elegido explícitamente: se mantiene aunque los mm coincidan con un preset.
    var customMode = SS.presetFor(SS.normalize((store.get() || {}).settings).trainer.wheelCircMm) === 'custom';

    function settings() { return SS.normalize((store.get() || {}).settings); }
    function saveTrainer(patch) {
      var s = settings();
      var trainer = SS.normalizeTrainer(Object.assign({}, s.trainer, patch));
      store.set({ settings: { trainer: trainer } });
      if (dev && dev.setWheelCirc) dev.setWheelCirc(trainer.wheelCircMm);
      return trainer;
    }
    function saveSensors(patch) {
      var s = settings();
      store.set({ settings: { sensors: SS.normalizeSensors(Object.assign({}, s.sensors, patch)) } });
    }

    function statusFor(kind) {
      var list = dev && dev.status ? dev.status() : [];
      for (var i = 0; i < list.length; i++) if (list[i].kind === kind) return list[i];
      return null;
    }

    function fail(e, fallback) {
      if (e && e.soft) noteMsg = e.message; else errorMsg = (e && e.message) || fallback;
      draw();
    }
    function connect(kind) {
      errorMsg = ''; noteMsg = '';
      var p = kind === 'csc' ? dev.connectSpeedCadence({ wheelCircMm: settings().trainer.wheelCircMm }) : dev.connectHeartRate();
      p.then(function (info) { saveSensors(kind === 'csc' ? { lastSpeedId: info.id } : { lastHrId: info.id }); draw(); },
        function (e) { fail(e, 'No se pudo conectar.'); });
    }
    function reconnect(kind, id) {
      errorMsg = ''; noteMsg = '';
      dev.reconnect(kind, id).then(function () { draw(); }, function (e) { fail(e, 'No se pudo reconectar.'); });
    }

    function sensorRow(kind, title, connectLabel) {
      var st = statusFor(kind);
      var state = st ? st.state : 'disconnected';
      var rem = settings().sensors[kind === 'csc' ? 'lastSpeedId' : 'lastHrId'];
      var bits = [STATE_TEXT[state] || state];
      if (st && st.name) bits.push(st.name);
      if (st && st.batteryPct != null) bits.push('batería ' + st.batteryPct + ' %');
      if (kind === 'csc' && st && st.mode && state === 'connected') bits.push(dev._cscModeText(st.mode));
      return el('div', { 'class': 'sn-row' }, [
        el('strong', null, title),
        el('span', { 'class': 'sn-state', role: 'status' }, bits.join(' · ')),
        el('button', { type: 'button', 'class': 'btn', disabled: btAvailable === false || state === 'connected' || state === 'reconnecting', onclick: function () { connect(kind); } }, connectLabel),
        (state === 'disconnected' && dev && dev.canReconnect && dev.canReconnect(kind, rem || (st && st.id) || null))
          ? el('button', { type: 'button', 'class': 'btn', disabled: btAvailable === false, onclick: function () { reconnect(kind, rem || (st && st.id) || null); } }, 'Reconectar')
          : null
      ]);
    }

    function draw() {
      if (destroyed) return;
      var s = settings();
      var t = s.trainer;
      if (SS.presetFor(t.wheelCircMm) === 'custom') customMode = true;
      var preset = customMode ? 'custom' : SS.presetFor(t.wheelCircMm);
      var presetSel = el('select', { id: 'sn-preset', 'aria-label': 'Medida de la rueda', onchange: function (ev) {
        var id = ev.target.value;
        if (id === 'custom') customMode = true;
        else {
          customMode = false;
          var p = SS.WHEEL_PRESETS.filter(function (x) { return x.id === id; })[0];
          if (p) saveTrainer({ wheelCircMm: p.mm });
        }
        draw();
      } }, SS.WHEEL_PRESETS.map(function (p) {
        return el('option', { value: p.id, selected: preset === p.id }, p.label + ' (' + p.mm + ' mm)');
      }).concat([el('option', { value: 'custom', selected: preset === 'custom' }, 'Personalizado')]));
      var customRow = el('label', { 'class': 'sn-custom', hidden: preset !== 'custom' }, [
        'Circunferencia (mm) ',
        el('input', { type: 'number', min: SS.LIMITS.wheelMm[0], max: SS.LIMITS.wheelMm[1], step: 1, value: t.wheelCircMm, onchange: function (ev) { saveTrainer({ wheelCircMm: ev.target.value }); draw(); } })
      ]);
      var levelSel = el('select', { id: 'sn-level', 'aria-label': 'Nivel en llano', onchange: function (ev) { saveTrainer({ flatLevel: Number(ev.target.value) }); } },
        [1, 2, 3, 4, 5, 6, 7, 8].map(function (n) { return el('option', { value: n, selected: t.flatLevel === n }, String(n)); }));
      var scaleLabel = el('span', { 'class': 'sn-scale-val' }, String(t.powerScale).replace('.', ','));
      var scale = el('input', { id: 'sn-scale', type: 'range', min: SS.LIMITS.powerScale[0], max: SS.LIMITS.powerScale[1], step: 0.01, value: t.powerScale, 'aria-label': 'Factor de ajuste de potencia', oninput: function (ev) {
        var tr = saveTrainer({ powerScale: ev.target.value }); scaleLabel.textContent = String(tr.powerScale).replace('.', ',');
      } });

      var card = el('section', { 'class': 'card', 'aria-labelledby': 'sn-title' }, [
        el('h2', { id: 'sn-title' }, 'Sensores y rodillo'),
        el('p', { 'class': 'card-sub' }, 'Conecta tu sensor de velocidad/cadencia y tu pulso por Bluetooth.'),
        btAvailable === false ? el('p', { 'class': 'sn-warn', role: 'alert' }, MSG_NO_BT) : null,
        errorMsg ? el('p', { 'class': 'sn-warn', role: 'alert' }, errorMsg) : null,
        noteMsg ? el('p', { 'class': 'sn-note' }, noteMsg) : null,
        sensorRow('csc', 'Velocidad / cadencia', 'Conectar velocidad/cadencia'),
        sensorRow('hr', 'Pulso', 'Conectar pulso'),
        el('p', { 'class': 'card-sub' }, MSG_WATCH),
        el('h3', null, 'Rueda y rodillo'),
        el('label', null, ['Medida de la rueda ', presetSel]),
        customRow,
        el('label', null, ['Tipo de rodillo ', el('select', { id: 'sn-type', 'aria-label': 'Tipo de rodillo' }, [el('option', { value: 'mecanico-8', selected: true }, 'Mecánico 8 niveles')])]),
        el('label', null, ['Nivel en llano ', levelSel]),
        el('label', null, ['Factor de ajuste de potencia ', scale, ' ', scaleLabel])
      ]);
      containerEl.textContent = '';
      containerEl.appendChild(card);
      if (containerEl.isConnected) wasConnected = true;
    }

    function destroy() {
      destroyed = true;
      unsubs.splice(0).forEach(function (u) { try { u(); } catch (e) { /* nada */ } });
    }

    // Redibujo por evento de R.devices: si el contenedor ya salió del documento, se desuscribe.
    function onDeviceEvent() {
      if (destroyed) return;
      if (wasConnected && containerEl.isConnected === false) { destroy(); return; }
      draw();
    }

    draw();
    if (dev && dev.isBluetoothAvailable) {
      Promise.resolve(dev.isBluetoothAvailable()).then(function (ok) { btAvailable = !!ok; onDeviceEvent(); }, function () { btAvailable = false; onDeviceEvent(); });
    }
    if (dev && dev.on) {
      ['status', 'cscMode', 'disconnected', 'reconnected', 'reconnectFailed'].forEach(function (ev) { unsubs.push(dev.on(ev, onDeviceEvent)); });
    }
    return { destroy: destroy, redraw: draw };
  }

  R.ui = R.ui || {};
  R.ui.sensorsCard = sensorsCard;
  R.ui.sensorsCard.MSG_NO_BT = MSG_NO_BT;
  R.ui.sensorsCard.MSG_WATCH = MSG_WATCH;
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
