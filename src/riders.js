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


  // ---------- pelotón con ataques ----------
  const RANK = { tranquilo: 0, constante: 1, atacante: 2, fuerte: 3 };
  const PEL_ELASTIC_GAIN = 0.04;  // s⁻¹: m/s de ajuste de velocidad por metro de error de posición
  const PEL_ELASTIC_LIM_FRAC = 0.3, PEL_ELASTIC_LIM_ABS = 1.5; // tope del ajuste: ±(0,3·v_usuario + 1,5) m/s
  const PEL_MIN_SPACING_M = 2;    // separación mínima en la colocación inicial
  const PEL_MAX_ACCEL = 1.5;      // m/s² máximo de cambio de velocidad de un bot (sin saltos visibles)
  const PEL_MIN_ATTACK_START_S = 240;  // sin ataques en los primeros 4 min
  const PEL_NO_ATTACK_LAST_M = 2000;   // ni en los últimos 2 km de la ruta
  const PEL_CAUGHT_S = 5, PEL_DROPPED_S = 10;
  // tope de la velocidad comandada del grupo atacante: 1,8 × v_usuario + 1 m/s (en bajadas largas la física
  // con potencia ×boost los dispararía lejos del usuario; así el ataque sigue siendo alcanzable)
  const PEL_ATTACK_MAX_FRAC = 1.8, PEL_ATTACK_MAX_ABS = 1;

  // Pelotón: bots de createBots repartidos en 3 grupos (principal 60 %, escapada 20 %, rezagados 20 %).
  // Fuera de ataques, un elástico suave mantiene a cada bot cerca de su puesto respecto al usuario
  // (principal ±35 m, escapada 80–220 m delante, rezagados 60–180 m detrás). Cada ~6–12 min el grupo
  // principal ataca: su potencia sube 25–35 % durante 30–90 s sin elástico (se escapa del usuario) y luego
  // vuelve. gapS > 0 = el grupo principal va por delante del usuario.
  // state.groupIds = { principal: [ids], escapada: [ids], rezagados: [ids] }; state.phase: 'idle' | 'start' | 'end'.
  // Callbacks: opts.onAttack o peloton.onAttack = fn(phase, info), phase 'start'|'end'|'caught'|'dropped'.
  function createPeloton(opts) {
    opts = opts || {};
    const count = Math.min(20, Math.max(8, Math.round(Number(opts.count) || 14)));
    const { ftp, massKg, route } = opts;
    const seed = opts.seed == null ? 1 : opts.seed;
    const every = opts.attackEveryMin || [6, 12];
    const durR = opts.attackDurS || [30, 90];
    const bots = createBots({ count: count, ftp: ftp, massKg: massKg, route: route, seed: seed });
    const rand = rng((seed >>> 0) ^ 0x9e3779b9);
    const uni = (lo, hi) => lo + rand() * (hi - lo);

    // reparto de grupos: los más fuertes a la escapada, los más tranquilos atrás
    const order = bots.map((b, i) => ({ b, i })).sort((x, y) => (RANK[y.b.personality] - RANK[x.b.personality]) || (x.i - y.i));
    const nEsc = Math.max(1, Math.round(count * 0.2));
    const nRez = Math.max(1, Math.round(count * 0.2));
    const groupIds = { principal: [], escapada: [], rezagados: [] };
    const cfg = new Map();
    order.forEach((o, k) => {
      const group = k < nEsc ? 'escapada' : (k >= count - nRez ? 'rezagados' : 'principal');
      o.b.group = group;
      groupIds[group].push(o.b.id);
      const off = group === 'principal' ? uni(-35, 35) : group === 'escapada' ? uni(80, 220) : -uni(60, 180);
      cfg.set(o.b.id, {
        off, boost: group === 'escapada' ? uni(0.02, 0.05) : 0,
        wobA: uni(4, 10), wobP: uni(25, 60), wobPh: uni(0, 6.283), jitter: uni(-0.03, 0.03),
      });
    });
    const mainBots = bots.filter((b) => b.group === 'principal');

    const state = { attacking: false, phase: 'idle', endsAtS: null, startsAtS: null, nextAttackAtS: 0, attackCount: 0, groupIds, gapS: 0 };
    const nextInterval = () => uni(every[0], every[1]) * 60;
    let nextStart = Math.max(PEL_MIN_ATTACK_START_S, nextInterval());
    state.nextAttackAtS = nextStart;
    let boost = 1, userSpeed = 8.33, lastUserD = null, initialized = false;
    const peloton = { bots, state, onAttack: opts.onAttack || null };

    const emit = (phase, info) => { if (typeof peloton.onAttack === 'function') peloton.onAttack(phase, info); };
    const mainMean = () => mainBots.reduce((a, b) => a + b.distM, 0) / mainBots.length;
    const gapNow = () => (mainMean() - lastUserD) / Math.max(2, userSpeed);

    peloton.update = function (dt, tS, userDistM) {
      if (!(dt > 0)) return;
      const ud = Number(userDistM) || 0;
      if (lastUserD != null) userSpeed += (Math.max(0, (ud - lastUserD) / dt) - userSpeed) * Math.min(1, dt / 3);
      if (state.phase === 'end') state.phase = 'idle';
      const first = !initialized;
      lastUserD = ud;
      const end = route.distanceM;

      // ataques
      if (!state.attacking && tS >= nextStart && ud <= end - PEL_NO_ATTACK_LAST_M) {
        const dur = uni(durR[0], durR[1]);
        boost = 1 + uni(0.25, 0.35);
        state.attacking = true; state.phase = 'start'; state.startsAtS = tS; state.endsAtS = tS + dur;
        state.attackCount++;
        nextStart = tS + nextInterval();
        state.nextAttackAtS = nextStart;
        emit('start', { phase: 'start', tS, durS: dur, endsAtS: state.endsAtS, powerBoostPct: Math.round((boost - 1) * 100), gapS: state.gapS });
      }
      const attackingNow = state.attacking;

      if (first) { // colocación inicial (antes de que se vea el pelotón)
        // los puestos que caerían detrás de la largada (distM < 0) se reparten hacia delante,
        // con al menos PEL_MIN_SPACING_M entre bots, para no apilarlos en distM = 0
        const placed = bots.map((bot) => {
          const c = cfg.get(bot.id);
          const target = ud + c.off + c.wobA * Math.sin((2 * Math.PI * tS) / c.wobP + c.wobPh);
          return { bot, d: Math.min(end, Math.max(0, target)) };
        }).sort((a, b) => a.d - b.d);
        for (let k = 1; k < placed.length; k++) {
          if (placed[k].d < placed[k - 1].d + PEL_MIN_SPACING_M) placed[k].d = Math.min(end, placed[k - 1].d + PEL_MIN_SPACING_M);
        }
        placed.forEach((o) => { o.bot.distM = o.d; o.bot.speedMps = Math.max(0, userSpeed); });
      }

      bots.forEach((bot) => {
        const c = cfg.get(bot.id);
        const target = ud + c.off + c.wobA * Math.sin((2 * Math.PI * tS) / c.wobP + c.wobPh);
        const prevD = bot.distM, prevV = bot.speedMps;
        bot.update(dt, tS); // calcula la potencia "libre" del bot en bot.powerW (la posición se recalcula abajo)
        if (prevD >= end) { bot.distM = end; bot.speedMps = 0; bot.powerW = 0; return; }
        const attacker = attackingNow && bot.group === 'principal';
        const mult = attacker ? boost + c.jitter : 1;
        bot.powerW *= mult; // potencia efectiva (coherente para HUD/coach durante el ataque)
        let vCmd;
        if (attacker) {
          // el grupo atacante rueda libre con su potencia ×boost (física)
          const s = R.routes.sampleAt(route, prevD);
          vCmd = R.physics.step({ v: prevV, powerW: bot.powerW, gradePct: s.gradePct, massKg: massKg, altitudeM: s.ele, dt });
          vCmd = Math.min(vCmd, PEL_ATTACK_MAX_FRAC * userSpeed + PEL_ATTACK_MAX_ABS);
        } else {
          // objetivo de velocidad (no aceleración): ritmo del usuario + corrección proporcional al error
          // de posición, acotada. Es un sistema de primer orden (constante de tiempo 1/G), estable e
          // independiente de dt.
          const lim = PEL_ELASTIC_LIM_FRAC * userSpeed + PEL_ELASTIC_LIM_ABS;
          vCmd = Math.max(0, userSpeed * (1 + c.boost) + Math.min(lim, Math.max(-lim, PEL_ELASTIC_GAIN * (target - prevD))));
        }
        const v = Math.max(0, prevV + Math.min(PEL_MAX_ACCEL * dt, Math.max(-PEL_MAX_ACCEL * dt, vCmd - prevV)));
        bot.distM = Math.min(end, Math.max(0, prevD + ((prevV + v) / 2) * dt));
        bot.speedMps = v;
      });
      initialized = true;
      state.gapS = gapNow();

      if (state.attacking && tS >= state.endsAtS) {
        const gap = state.gapS;
        state.attacking = false; state.phase = 'end';
        const info = { tS, gapS: gap, durS: tS - state.startsAtS };
        emit('end', Object.assign({ phase: 'end' }, info));
        if (gap < PEL_CAUGHT_S) emit('caught', Object.assign({ phase: 'caught' }, info));
        else if (gap > PEL_DROPPED_S) emit('dropped', Object.assign({ phase: 'dropped' }, info));
        state.endsAtS = null; // phase queda en 'end' hasta el siguiente update
      }
    };
    return peloton;
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

  R.riders = { createGhost, createBots, createPeloton, splitsFromSamples, updateBest, ranking };
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
