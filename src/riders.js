(function (R) {
  'use strict';

  const BOT_COLOR = '#7FA7C9';
  const NAMES = ['Cata', 'Nacho', 'Feña', 'Pancho', 'Coté', 'Benja', 'Jose', 'Rocío', 'Tomi', 'Vale'];
  // rango de potencia base relativa al FTP y amplitud de variación por personalidad
  const PERSONALITIES = {
    tranquilo: { lo: 0.75, hi: 0.88, vary: 0.03 },
    constante: { lo: 0.88, hi: 0.98, vary: 0.02 },
    fuerte: { lo: 0.98, hi: 1.1, vary: 0.04 },
    atacante: { lo: 0.85, hi: 1.05, vary: 0.07 },
  };
  const PERSONALITY_KEYS = Object.keys(PERSONALITIES);
  const POWER_MIN = 0.75, POWER_MAX = 1.15;
  const CLIMB_BONUS = 0.05;
  const DEFAULT_SPEED_MPS = 8.33; // para estimar brechas de riders sin speedMps

  function rng(seed) { // mulberry32
    let a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- fantasma ----------
  function createGhost(best, opts) {
    const boost = 1 + ((opts && opts.boostPct) || 0) / 100;
    let splits = (best && best.splits ? best.splits : []).slice();
    if (!splits.length) throw new Error('La mejor marca no tiene parciales');
    if (splits[0][0] > 0) splits.unshift([0, 0]);
    const last = splits[splits.length - 1];
    return {
      totalTimeS: last[1] / boost,
      distanceM: last[0],
      distAt(tS) {
        const t = Math.max(0, tS) * boost; // tiempo en la escala de la marca original
        if (t >= last[1]) return last[0];
        let lo = 0, hi = splits.length - 1;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (splits[mid][1] <= t) lo = mid; else hi = mid;
        }
        const a = splits[lo], b = splits[hi];
        return b[1] > a[1] ? a[0] + ((t - a[1]) / (b[1] - a[1])) * (b[0] - a[0]) : a[0];
      },
    };
  }

  // ---------- bots ----------
  function createBots(opts) {
    const { count = 6, ftp, massKg, route, seed = 1 } = opts;
    if (!(ftp > 0)) throw new Error('Se necesita un FTP válido para crear los bots');
    if (!(massKg > 0)) throw new Error('Se necesita la masa (massKg) para crear los bots');
    if (!route || !route.points) throw new Error('Se necesita una ruta para crear los bots');
    const physics = R.physics, routes = R.routes;
    const rand = rng(seed);
    const names = NAMES.slice();
    for (let i = names.length - 1; i > 0; i--) { // Fisher-Yates determinístico
      const j = Math.floor(rand() * (i + 1));
      const tmp = names[i]; names[i] = names[j]; names[j] = tmp;
    }
    const bots = [];
    for (let i = 0; i < count; i++) {
      const personality = PERSONALITY_KEYS[Math.floor(rand() * PERSONALITY_KEYS.length)];
      const cfg = PERSONALITIES[personality];
      const base = cfg.lo + rand() * (cfg.hi - cfg.lo);
      const ph1 = rand() * Math.PI * 2, ph2 = rand() * Math.PI * 2;
      const per1 = 40 + rand() * 40, per2 = 110 + rand() * 90; // períodos en s
      const name = i < names.length ? names[i] : names[i % names.length] + ' ' + (Math.floor(i / names.length) + 1);
      const bot = {
        id: 'bot-' + (i + 1), name, label: name, kind: 'bot', color: BOT_COLOR, personality,
        distM: 0, speedMps: 0, powerW: 0,
        update(dt, tS) {
          if (bot.distM >= route.distanceM) { bot.speedMps = 0; bot.powerW = 0; return; }
          const s = routes.sampleAt(route, bot.distM);
          const wave = Math.sin((2 * Math.PI * tS) / per1 + ph1) * 0.65 + Math.sin((2 * Math.PI * tS) / per2 + ph2) * 0.35;
          const climb = CLIMB_BONUS * Math.min(1, Math.max(0, s.gradePct / 3));
          const rel = Math.min(POWER_MAX, Math.max(POWER_MIN, base * (1 + cfg.vary * wave) * (1 + climb)));
          bot.powerW = rel * ftp;
          const v = physics.step({ v: bot.speedMps, powerW: bot.powerW, gradePct: s.gradePct, massKg, altitudeM: s.ele, dt });
          bot.distM = Math.min(route.distanceM, bot.distM + ((bot.speedMps + v) / 2) * dt);
          bot.speedMps = v;
        },
      };
      bots.push(bot);
    }
    return bots;
  }

  // ---------- mejores marcas ----------
  function splitsFromSamples(samples) {
    const out = [];
    if (!samples || samples.length < 2) return out;
    let next = 100;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i];
      const da = a[5], db = b[5];
      while (db >= next && da < next) {
        out.push([next, a[0] + ((next - da) / (db - da)) * (b[0] - a[0])]);
        next += 100;
      }
      if (da >= next) next = (Math.floor(da / 100) + 1) * 100; // por si hubo retroceso de datos
    }
    const end = samples[samples.length - 1];
    if (end[5] > 0 && (!out.length || end[5] > out[out.length - 1][0])) out.push([end[5], end[0]]);
    return out;
  }

  function updateBest(bests, routeId, activity, route) {
    const current = bests || {};
    const unchanged = { bests: current, improved: false, deltaS: 0 };
    route = route || (R.routes && R.routes.get(routeId));
    if (!activity || !activity.samples || activity.samples.length < 2 || !route) return unchanged;
    if (activity.routeId && activity.routeId !== routeId) return unchanged;
    const smp = activity.samples;
    const idx = smp.findIndex((x) => x[5] >= route.distanceM - 5);
    if (idx < 0) return unchanged; // no completó la ruta
    // tiempo en que se cruza distanceM (interpolado); lo que sigue (enfriamiento) se ignora
    let totalTimeS = smp[idx][0];
    if (idx > 0 && smp[idx][5] > smp[idx - 1][5] && smp[idx - 1][5] < route.distanceM && smp[idx][5] >= route.distanceM) {
      const a = smp[idx - 1], b = smp[idx];
      totalTimeS = a[0] + ((route.distanceM - a[5]) / (b[5] - a[5])) * (b[0] - a[0]);
    }
    const trimmed = smp.slice(0, idx + 1);
    const last = trimmed[idx];
    trimmed[idx] = [totalTimeS, last[1], last[2], last[3], last[4], Math.min(last[5], route.distanceM), last[6]];
    const prev = current[routeId];
    if (prev && prev.totalTimeS <= totalTimeS) return { bests: current, improved: false, deltaS: prev.totalTimeS - totalTimeS };
    const next = Object.assign({}, current);
    next[routeId] = { activityId: activity.id, totalTimeS, splits: splitsFromSamples(trimmed) };
    return { bests: next, improved: true, deltaS: prev ? prev.totalTimeS - totalTimeS : 0 };
  }

  function ranking(riders) {
    const sorted = riders.slice().sort((a, b) => b.distM - a.distM);
    if (!sorted.length) return [];
    const lead = sorted[0].distM;
    return sorted.map((r) => {
      const v = r.speedMps > 1 ? r.speedMps : DEFAULT_SPEED_MPS;
      return Object.assign({}, r, { gapS: (lead - r.distM) / v });
    });
  }

  R.riders = { createGhost, createBots, splitsFromSamples, updateBest, ranking };
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
