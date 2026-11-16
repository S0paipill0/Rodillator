(function (R) {
  'use strict';

  var STORAGE_KEY = 'rodillator.v1';
  var SCHEMA_VERSION = 1;
  var SAVE_DEBOUNCE_MS = 300;
  var DB_DEBOUNCE_MS = 3000;
  var DAY_MS = 86400000;

  function defaults() {
    return {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: 0,
      profile: null,
      plan: null,
      activities: [],
      settings: { reminderTime: '19:00', reminderDays: [1, 3, 5], ghostBoost: 0, botsCount: 6, units: 'metric', graphicsQuality: 'auto', lastTimed: { durationMin: 45, focus: 'auto' }, coach: { voice: true, beeps: true, volume: 0.9, verbosity: 'completo' } },
      bests: {}
    };
  }

  var GRAPHICS_QUALITIES = ['auto', 'alta', 'media', 'baja'];
  // Calidad grafica de la escena 3D: valores fuera de la lista vuelven a 'auto'.
  function normalizeGraphicsQuality(q) { return GRAPHICS_QUALITIES.indexOf(q) >= 0 ? q : 'auto'; }

  var TIMED_FOCUS = ['hoy', 'recuperacion', 'resistencia', 'tempo', 'sweetspot', 'umbral', 'vo2', 'sprints', 'sorpresa', 'auto'];
  // Ultima duracion/enfoque de "entrenar por tiempo": duracion entera 15-150 min, enfoque conocido (si no, 'auto').
  function normalizeLastTimed(v) {
    var o = isObj(v) ? v : {};
    var m = Math.round(Number(o.durationMin));
    return { durationMin: isFinite(m) && m > 0 ? Math.min(150, Math.max(15, m)) : 45, focus: TIMED_FOCUS.indexOf(o.focus) >= 0 ? o.focus : 'auto' };
  }

  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  function getStorage() {
    try {
      var ls = (typeof localStorage !== 'undefined') ? localStorage : null;
      return ls || null;
    } catch (e) { return null; }
  }

  // Normaliza un objeto arbitrario sobre los valores por defecto (sin validar a fondo).
  function normalize(raw) {
    var d = defaults();
    var s = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
      profile: isObj(raw.profile) ? raw.profile : null,
      plan: isObj(raw.plan) ? raw.plan : null,
      activities: Array.isArray(raw.activities) ? raw.activities : [],
      settings: Object.assign(d.settings, isObj(raw.settings) ? raw.settings : {}),
      bests: isObj(raw.bests) ? raw.bests : {}
    };
    s.settings.coach = Object.assign({}, defaults().settings.coach, isObj(s.settings.coach) ? s.settings.coach : {});
    s.settings.graphicsQuality = normalizeGraphicsQuality(s.settings.graphicsQuality);
    s.settings.lastTimed = normalizeLastTimed(s.settings.lastTimed);
    return s;
  }

  // Valida una estructura importada; lanza Error en español si es inválida.
  function validate(raw) {
    if (!isObj(raw)) throw new Error('El archivo no tiene el formato de Rodillator.');
    if (raw.schemaVersion !== undefined && (typeof raw.schemaVersion !== 'number' || raw.schemaVersion > SCHEMA_VERSION)) {
      throw new Error('Versión de datos no compatible.');
    }
    if (raw.profile != null && !isObj(raw.profile)) throw new Error('Perfil inválido.');
    if (raw.plan != null && !isObj(raw.plan)) throw new Error('Plan inválido.');
    if (raw.activities !== undefined && !Array.isArray(raw.activities)) throw new Error('Actividades inválidas.');
    if (raw.settings !== undefined && !isObj(raw.settings)) throw new Error('Ajustes inválidos.');
    if (raw.bests !== undefined && !isObj(raw.bests)) throw new Error('Mejores marcas inválidas.');
    (raw.activities || []).forEach(function (a) {
      if (!isObj(a) || typeof a.id !== 'string' && typeof a.id !== 'number') throw new Error('Actividad inválida.');
    });
    return normalize(raw);
  }

  // Recorta samples a 1 de cada `keep` (siempre conserva la primera y la última).
  function thin(samples, keep) {
    if (!Array.isArray(samples) || samples.length <= keep) return samples;
    var out = [];
    for (var i = 0; i < samples.length; i++) {
      if (i % keep === 0 || i === samples.length - 1) out.push(samples[i]);
    }
    return out;
  }

  // Devuelve una copia serializable con samples recortadas según antigüedad.
  // level 0: >60 días a 1/5. level 1 (tras QuotaExceeded): >60 días a 1/20 y >14 días a 1/5.
  function compact(state, level, nowMs) {
    var out = Object.assign({}, state);
    out.activities = state.activities.map(function (a) {
      if (!a || !Array.isArray(a.samples)) return a;
      var t = Date.parse(a.date);
      var age = isNaN(t) ? 0 : (nowMs - t) / DAY_MS;
      var keep = 1;
      if (level === 0) { if (age > 60) keep = 5; }
      else { if (age > 60) keep = 20; else if (age > 14) keep = 5; }
      if (keep === 1) return a;
      return Object.assign({}, a, { samples: thin(a.samples, keep) });
    });
    return out;
  }

  var state = defaults();
  var listeners = [];
  var saveTimer = null;
  var dbTimer = null;
  var db = null;
  var dbUserId = null;
  var dbBusy = false;
  var dbDirty = false;

  function load() {
    var ls = getStorage();
    if (!ls) return;
    try {
      var txt = ls.getItem(STORAGE_KEY);
      if (!txt) return;
      var raw = JSON.parse(txt);
      if (isObj(raw)) state = normalize(raw);
    } catch (e) { /* datos corruptos: se ignoran y se parte de cero */ }
  }

  var lastWriteOk = null; // null = aún sin intentar escribir

  function writeLocal() {
    saveTimer = null;
    var ls = getStorage();
    if (!ls) { lastWriteOk = false; return false; }
    var now = Date.now();
    try {
      ls.setItem(STORAGE_KEY, JSON.stringify(compact(state, 0, now)));
      lastWriteOk = true;
      return true;
    } catch (e) {
      try {
        ls.setItem(STORAGE_KEY, JSON.stringify(compact(state, 1, now)));
        lastWriteOk = true;
        return true;
      } catch (e2) { lastWriteOk = false; return false; } // solo memoria
    }
  }

  // true si hay localStorage y la última escritura funcionó (o aún no se intentó una).
  function isPersistent() { return !!getStorage() && lastWriteOk !== false; }

  function scheduleSave() {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(writeLocal, SAVE_DEBOUNCE_MS);
    scheduleDb();
  }

  function notify() {
    listeners.slice().forEach(function (fn) {
      try { fn(state); } catch (e) { /* un suscriptor defectuoso no afecta a los demás */ }
    });
  }

  function getDocRef(dbh, uid) {
    dbh = dbh || db; uid = uid || dbUserId;
    if (typeof dbh.doc === 'function') return dbh.doc('data/users/' + uid + '/state/main');
    return dbh.collection('data/users/' + uid + '/state').doc('main');
  }

  // Versión para el documento remoto: sin samples de actividades de más de 14 días.
  function compactRemote(st, nowMs) {
    var out = compact(st, 0, nowMs);
    out.activities = out.activities.map(function (a) {
      if (!a || !Array.isArray(a.samples)) return a;
      var t = Date.parse(a.date);
      if (!isNaN(t) && (nowMs - t) / DAY_MS > 14) {
        var c = Object.assign({}, a); delete c.samples; return c;
      }
      return a;
    });
    return out;
  }

  function unwrapDoc(snap) {
    if (!snap) return null;
    if (typeof snap.exists === 'boolean' && !snap.exists) return null;
    if (typeof snap.data === 'function') return snap.data() || null;
    if (snap.data && isObj(snap.data)) return snap.data;
    return isObj(snap) ? snap : null;
  }

  function scheduleDb() {
    if (!db) return;
    if (dbTimer !== null) clearTimeout(dbTimer);
    dbTimer = setTimeout(pushDb, DB_DEBOUNCE_MS);
  }

  async function pushDb() {
    dbTimer = null;
    if (!db) return;
    if (dbBusy) { dbDirty = true; return; }
    dbBusy = true;
    try {
      var payload = { updatedAt: state.updatedAt, state: compactRemote(state, Date.now()) };
      await getDocRef().set(payload);
    } catch (e) { /* sincronización opcional: no bloquea */ }
    dbBusy = false;
    if (dbDirty) { dbDirty = false; scheduleDb(); }
  }

  async function attachDb(dbHandle, userId) {
    if (!dbHandle || !userId) return false;
    var adoptedRemote = false;
    try {
      var remote = unwrapDoc(await getDocRef(dbHandle, userId).get());
      var remoteState = remote && isObj(remote.state) ? remote.state : null;
      var remoteAt = remote && typeof remote.updatedAt === 'number' ? remote.updatedAt : 0;
      if (remote && !remoteState) throw new Error('remoto inválido');
      var adopted = remoteState ? validate(remoteState) : null; // si no valida, no se activa la sincronización
      if (adopted && remoteAt > state.updatedAt) {
        adopted.updatedAt = remoteAt;
        state = adopted;
        adoptedRemote = true;
      }
    } catch (e) { return false; } // sin lectura válida no se activa la sincronización (no se sobrescribe el remoto)
    db = dbHandle;      // dbReady: solo tras una lectura inicial correcta
    dbUserId = userId;
    if (adoptedRemote) { writeLocal(); notify(); return true; }
    await pushDb();
    return false;
  }

  function set(patch) {
    if (!isObj(patch)) return state;
    var next = Object.assign({}, state);
    Object.keys(patch).forEach(function (k) {
      if (k === 'schemaVersion' || k === 'updatedAt') return;
      if (k === 'settings' && isObj(patch.settings)) {
        next.settings = Object.assign({}, state.settings, patch.settings);
        next.settings.graphicsQuality = normalizeGraphicsQuality(next.settings.graphicsQuality);
        next.settings.lastTimed = normalizeLastTimed(next.settings.lastTimed);
      }
      else next[k] = patch[k];
    });
    next.updatedAt = Date.now();
    state = next;
    scheduleSave();
    notify();
    return state;
  }

  function reset() {
    state = defaults();
    state.updatedAt = Date.now();
    scheduleSave();
    notify();
    return state;
  }

  function subscribe(fn) {
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function exportJSON() { return JSON.stringify(state); }

  function importJSON(str) {
    var raw;
    try { raw = JSON.parse(str); } catch (e) { throw new Error('El archivo no es un JSON válido.'); }
    var next = validate(raw);
    next.updatedAt = Date.now();
    state = next;
    scheduleSave();
    notify();
    return state;
  }

  // Escribe de inmediato lo pendiente (útil al cerrar la vista y en pruebas).
  function flush() {
    if (saveTimer !== null) { clearTimeout(saveTimer); writeLocal(); }
  }

  load();

  R.store = {
    STORAGE_KEY: STORAGE_KEY,
    get: function () { return state; },
    set: set,
    subscribe: subscribe,
    reset: reset,
    attachDb: attachDb,
    exportJSON: exportJSON,
    importJSON: importJSON,
    flush: flush,
    isPersistent: isPersistent,
    load: function () { load(); notify(); return state; },
    normalizeGraphicsQuality: normalizeGraphicsQuality,
    _compact: compact,
    _defaults: defaults
  };
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
