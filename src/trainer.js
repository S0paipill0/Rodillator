(function (R) {
  'use strict';

  // ======================================================================
  // Rodillo mecánico de 8 niveles (nivel 3 = llano, nivel 8 = máxima pendiente)
  // ======================================================================
  // MODELO (ESTIMACIÓN, no medición): rodillo magnético genérico con la rueda trasera apoyada.
  //   P(v, L) = scale · (c_L · v + K · v³)        v en m/s, P en W
  //   c_L  : término lineal (resistencia magnética + rodadura del neumático), crece con el nivel.
  //   K    : término cúbico pequeño (aire sobre el rotor, ventilación), igual para todos los niveles.
  // Calibración de partida (punto ancla del usuario): nivel 3 a 29 km/h (8,06 m/s) ≈ 192 W,
  // coherente con rodar en llano a 29 km/h (≈ 190 W según physics.js con CdA 0,32).
  // Nivel 8 a 20 km/h ≈ 311 W. Los factores entre niveles consecutivos (c_{L+1}/c_L):
  //   1→2: 1,12 · 2→3: 1,12 · 3→4: 1,15 · 4→5: 1,17 · 5→6: 1,20 · 6→7: 1,22 · 7→8: 1,25
  // (suben con el nivel: los últimos niveles son más duros que los primeros).
  // `powerScale` (settings.trainer.powerScale) multiplica toda la curva para ajustarla a tu rodillo
  // real; `calibrate()` la estimará con datos reales cuando haya sensor de potencia (fase posterior).
  const LEVELS = 8;
  const FLAT_LEVEL = 3;
  const K_CUBIC = 0.02; // W / (m/s)³
  const C3 = 22.5;      // W / (m/s) en el nivel 3
  const RATIOS_UP = [1.15, 1.17, 1.20, 1.22, 1.25]; // 3→4 ... 7→8
  const RATIOS_DOWN = [1.12, 1.12];                  // 3→2, 2→1
  const COEFF = (function () {
    const c = new Array(LEVELS + 1); // índice 1..8
    c[3] = C3;
    for (let l = 4; l <= LEVELS; l++) c[l] = c[l - 1] * RATIOS_UP[l - 4];
    for (let l = 2; l >= 1; l--) c[l] = c[l + 1] / RATIOS_DOWN[2 - l];
    return c;
  })();

  // Pendiente "sentida" aproximada por nivel (centro del tramo de levelForGrade), para el HUD.
  const VIRTUAL_GRADE = [null, -4, -2, 0, 2.5, 4.5, 6.5, 8.5, 11];

  const KPH = 3.6;

  function clampLevel(level) {
    const n = Math.round(Number(level));
    if (!isFinite(n)) return FLAT_LEVEL;
    return Math.min(LEVELS, Math.max(1, n));
  }

  function levelForGrade(gradePct) {
    const g = Number(gradePct);
    if (!isFinite(g)) return FLAT_LEVEL;
    if (g <= -3) return 1;
    if (g <= -1) return 2;
    if (g <= 1.5) return 3;
    if (g <= 3.5) return 4;
    if (g <= 5.5) return 5;
    if (g <= 7.5) return 6;
    if (g <= 10) return 7;
    return 8;
  }

  function scaleOf(o) {
    const s = o && o.powerScale;
    return isFinite(s) && s > 0 ? s : 1;
  }

  // potencia virtual (W) a una velocidad (km/h) y nivel
  function powerFromSpeed(o) {
    o = o || {};
    const v = Math.max(0, Number(o.speedKph) || 0) / KPH;
    const L = clampLevel(o.level);
    return scaleOf(o) * (COEFF[L] * v + K_CUBIC * v * v * v);
  }

  // velocidad (km/h) para una potencia (W) y nivel; inversa exacta por bisección (P es monótona en v)
  function speedFromPower(o) {
    o = o || {};
    const p = Math.max(0, Number(o.powerW) || 0);
    if (p === 0) return 0;
    const L = clampLevel(o.level), s = scaleOf(o);
    let lo = 0, hi = 1;
    while (s * (COEFF[L] * hi + K_CUBIC * hi * hi * hi) < p && hi < 200) hi *= 2;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (s * (COEFF[L] * mid + K_CUBIC * mid * mid * mid) < p) lo = mid; else hi = mid;
    }
    return ((lo + hi) / 2) * KPH;
  }

  // Nivel que deja la potencia objetivo más cerca de lo que se produce a la cadencia indicada.
  // Suposición: relación 50×17 (la de llano de un plato mediano en rodillo) y rueda de wheelCircMm
  // (por defecto 2070 mm, aro 26): v = rpm · (50/17) · circunferencia. A 90 rpm ≈ 32,9 km/h.
  function levelForTarget(o) {
    o = o || {};
    let target = Number(o.targetW);
    if (!(target > 0)) target = Number(o.ftp) > 0 ? Number(o.ftp) : NaN;
    if (!(target > 0)) return FLAT_LEVEL;
    const rpm = o.cadenceRpm > 0 ? o.cadenceRpm : 90;
    const circM = (o.wheelCircMm > 0 ? o.wheelCircMm : 2070) / 1000;
    const ratio = (o.chainring > 0 ? o.chainring : 50) / (o.cog > 0 ? o.cog : 17);
    const speedKph = rpm * ratio * circM * 60 / 1000;
    let best = 1, bestErr = Infinity;
    for (let l = 1; l <= LEVELS; l++) {
      const err = Math.abs(powerFromSpeed({ speedKph: speedKph, level: l, powerScale: o.powerScale }) - target);
      if (err < bestErr - 1e-9) { best = l; bestErr = err; }
    }
    return best;
  }

  function virtualGradePct(o) {
    return VIRTUAL_GRADE[clampLevel(o && o.level)];
  }

  // TODO (fase posterior): ajustar powerScale (y quizá K) por mínimos cuadrados con muestras
  // { speedKph, level, powerW } medidas con un medidor de potencia. Por ahora no ajusta nada.
  function calibrate(samples) {
    return { powerScale: 1, samples: Array.isArray(samples) ? samples.length : 0, calibrated: false };
  }

  R.trainer = {
    LEVELS: LEVELS,
    FLAT_LEVEL: FLAT_LEVEL,
    levelForGrade: levelForGrade,
    levelForTarget: levelForTarget,
    powerFromSpeed: powerFromSpeed,
    speedFromPower: speedFromPower,
    virtualGradePct: virtualGradePct,
    calibrate: calibrate,
    COEFF: COEFF.slice(),
    K_CUBIC: K_CUBIC,
  };
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
