(function (R) {
  'use strict';

  const G = 9.8067;
  const RHO0 = 1.225;
  const DRIVETRAIN_EFF = 0.976;
  const WHEEL_INERTIA_KG = 1.4; // masa equivalente de la inercia de las ruedas
  const MAX_SUBSTEPS = 200;

  function airDensity(altitudeM) {
    return RHO0 * Math.exp(-(altitudeM || 0) / 8500);
  }

  // Fuerza resistiva total (N) a velocidad de suelo v. windMps > 0 = viento de frente.
  function resistiveForce(v, gradePct, massKg, rho, cda, crr, windMps) {
    const theta = Math.atan(gradePct / 100);
    const va = v + windMps;
    return massKg * G * (Math.sin(theta) + crr * Math.cos(theta)) + 0.5 * rho * cda * va * Math.abs(va);
  }

  function speedFromPower(opts) {
    const { powerW, gradePct, massKg, altitudeM = 0, windMps = 0, cda = 0.32, crr = 0.004 } = opts;
    const pe = Math.max(0, powerW || 0) * DRIVETRAIN_EFF;
    const rho = airDensity(altitudeM);
    const g = (v) => v * resistiveForce(v, gradePct || 0, massKg, rho, cda, crr, windMps) - pe;
    // g puede ser no monótona en bajada: buscamos la raíz más grande (último cruce de <=0 a >0).
    const stepV = 0.1;
    const vMax = 90;
    let lo = 0;
    let found = false;
    for (let v = 0; v < vMax; v += stepV) {
      if (g(v) <= 0) { lo = v; found = true; }
    }
    if (!found) return 0;
    let hi = lo + stepV;
    lo = Math.max(0, lo);
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (g(mid) <= 0) lo = mid; else hi = mid;
    }
    return Math.max(0, (lo + hi) / 2);
  }

  // Integra la energía cinética E = m v²/2 con dE/dt = P_rueda − v·F_res(v).
  // Es estable a baja velocidad (sin piso de velocidad) y tiene el mismo equilibrio que speedFromPower.
  function step(opts) {
    const { v, powerW, gradePct, massKg, altitudeM = 0, dt, windMps = 0, cda = 0.32, crr = 0.004 } = opts;
    let vel = Math.max(0, Number.isFinite(v) ? v : 0);
    if (!Number.isFinite(dt) || dt <= 0) return vel;
    const m = massKg + WHEEL_INERTIA_KG;
    const rho = airDensity(altitudeM);
    const pe = Math.max(0, powerW || 0) * DRIVETRAIN_EFF;
    const n = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dt / 0.05)));
    const h = dt / n;
    let e = 0.5 * m * vel * vel;
    for (let i = 0; i < n; i++) {
      vel = Math.sqrt((2 * e) / m);
      e = Math.max(0, e + (pe - vel * resistiveForce(vel, gradePct || 0, massKg, rho, cda, crr, windMps)) * h);
    }
    return Math.sqrt((2 * e) / m);
  }

  function powerForSpeed(opts) {
    const { speedMps, gradePct, massKg, altitudeM = 0, windMps = 0, cda = 0.32, crr = 0.004 } = opts;
    const f = resistiveForce(speedMps, gradePct || 0, massKg, airDensity(altitudeM), cda, crr, windMps);
    return Math.max(0, (speedMps * f) / DRIVETRAIN_EFF);
  }

  // Convención de ciclismo: 1 kJ de trabajo mecánico ≈ 1 kcal metabólica (eficiencia ~24 %).
  function kcalFromWork(kJ) {
    return kJ / (4.184 * 0.24);
  }

  R.physics = { speedFromPower, step, powerForSpeed, kcalFromWork, airDensity, G, DRIVETRAIN_EFF };
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
