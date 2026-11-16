(function (R) {
  'use strict';

  var MSG_NO_BT = 'Tu navegador o esta vista no permite Bluetooth. Abre la versión web de Rodillator en Chrome (Android o computador).';
  var MSG_WATCH = 'Reloj Xiaomi Watch S3: no está confirmado que transmita el pulso por Bluetooth. Busca en el reloj o en la app Mi Fitness una opción del tipo "Transmitir frecuencia cardíaca". Si no existe, usa una banda de pecho Bluetooth.';
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
  function sensorsCard(containerEl, ctx) {
    var el = (R.ui && typeof R.ui.el === 'function') ? R.ui.el : fallbackEl;
    var store = (ctx && ctx.store) || R.store;
    var SS = R.sensorsSettings;
    var dev = R.devices;
    var errorMsg = '';
    var btAvailable = null;   // null = comprobando
    var unsubs = [];

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

    function connect(kind) {
      errorMsg = '';
      var p = kind === 'csc' ? dev.connectSpeedCadence({ wheelCircMm: settings().trainer.wheelCircMm }) : dev.connectHeartRate();
      p.then(function (info) { saveSensors(kind === 'csc' ? { lastSpeedId: info.id } : { lastHrId: info.id }); draw(); },
        function (e) { errorMsg = (e && e.message) || 'No se pudo conectar.'; draw(); });
    }
    function reconnect(kind) {
      errorMsg = '';
      dev.reconnect(kind).then(draw, function (e) { errorMsg = (e && e.message) || 'No se pudo reconectar.'; draw(); });
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
        (state === 'disconnected' && (rem || (st && st.id))) ? el('button', { type: 'button', 'class': 'btn', disabled: btAvailable === false, onclick: function () { reconnect(kind); } }, 'Reconectar') : null
      ]);
    }

    function draw() {
      var s = settings();
      var t = s.trainer;
      var preset = SS.presetFor(t.wheelCircMm);
      var presetSel = el('select', { id: 'sn-preset', 'aria-label': 'Medida de la rueda', onchange: function (ev) {
        var id = ev.target.value;
        if (id !== 'custom') { var p = SS.WHEEL_PRESETS.filter(function (x) { return x.id === id; })[0]; if (p) saveTrainer({ wheelCircMm: p.mm }); }
        else customRow.hidden = false;
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
    }

    draw();
    if (dev && dev.isBluetoothAvailable) {
      Promise.resolve(dev.isBluetoothAvailable()).then(function (ok) { btAvailable = !!ok; draw(); }, function () { btAvailable = false; draw(); });
    }
    if (dev && dev.on) {
      ['status', 'cscMode', 'disconnected', 'reconnected', 'reconnectFailed'].forEach(function (ev) { unsubs.push(dev.on(ev, draw)); });
    }
    return { destroy: function () { unsubs.splice(0).forEach(function (u) { u(); }); }, redraw: draw };
  }

  R.ui = R.ui || {};
  R.ui.sensorsCard = sensorsCard;
  R.ui.sensorsCard.MSG_NO_BT = MSG_NO_BT;
  R.ui.sensorsCard.MSG_WATCH = MSG_WATCH;
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
