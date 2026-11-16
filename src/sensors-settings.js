(function (R) {
  'use strict';

  // Normaliza settings.trainer y settings.sensors (contrato de la ola R2).
  //   trainer = { type: 'mecanico-8', wheelCircMm: 2050, flatLevel: 3, powerScale: 1.0 }
  //   sensors = { lastSpeedId: string|null, lastHrId: string|null }
  var DEFAULT_TRAINER = { type: 'mecanico-8', wheelCircMm: 2050, flatLevel: 3, powerScale: 1 };
  var WHEEL_MIN = 1000, WHEEL_MAX = 3000;
  var SCALE_MIN = 0.7, SCALE_MAX = 1.3;
  var LEVELS = 8;

  var WHEEL_PRESETS = [
    { id: '26x1.95', label: '26 × 1,95', mm: 2050 },
    { id: '26x2.10', label: '26 × 2,10', mm: 2070 },
    { id: '26x2.25', label: '26 × 2,25', mm: 2100 },
    { id: '700x25c', label: '700 × 25c', mm: 2105 },
    { id: '29x2.2', label: '29 × 2,2', mm: 2300 }
  ];

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function num(v) {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return NaN;
    return Number(v);
  }

  function normalizeTrainer(raw) {
    var t = isObj(raw) ? raw : {};
    var wheel = num(t.wheelCircMm);
    wheel = isFinite(wheel) ? Math.round(clamp(wheel, WHEEL_MIN, WHEEL_MAX)) : DEFAULT_TRAINER.wheelCircMm;
    var level = num(t.flatLevel);
    level = isFinite(level) ? Math.round(clamp(level, 1, LEVELS)) : DEFAULT_TRAINER.flatLevel;
    var scale = num(t.powerScale);
    scale = isFinite(scale) ? Math.round(clamp(scale, SCALE_MIN, SCALE_MAX) * 100) / 100 : DEFAULT_TRAINER.powerScale;
    return { type: 'mecanico-8', wheelCircMm: wheel, flatLevel: level, powerScale: scale };
  }

  function normalizeSensors(raw) {
    var s = isObj(raw) ? raw : {};
    function id(v) { return typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null; }
    return { lastSpeedId: id(s.lastSpeedId), lastHrId: id(s.lastHrId) };
  }

  // Devuelve una copia de `settings` con trainer y sensors normalizados (no muta la entrada).
  function normalize(settings) {
    var out = Object.assign({}, isObj(settings) ? settings : {});
    out.trainer = normalizeTrainer(out.trainer);
    out.sensors = normalizeSensors(out.sensors);
    return out;
  }

  // Id del preset que coincide con los mm dados, o 'custom'.
  function presetFor(mm) {
    for (var i = 0; i < WHEEL_PRESETS.length; i++) if (WHEEL_PRESETS[i].mm === mm) return WHEEL_PRESETS[i].id;
    return 'custom';
  }

  R.sensorsSettings = {
    normalize: normalize,
    normalizeTrainer: normalizeTrainer,
    normalizeSensors: normalizeSensors,
    presetFor: presetFor,
    WHEEL_PRESETS: WHEEL_PRESETS,
    DEFAULTS: DEFAULT_TRAINER,
    LIMITS: { wheelMm: [WHEEL_MIN, WHEEL_MAX], powerScale: [SCALE_MIN, SCALE_MAX], levels: LEVELS }
  };
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
