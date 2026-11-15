/* Rodillator — Tarea 8: vista Estadísticas.
 * Parte 1: lógica pura en R.statsLogic (probada en Node).
 * Parte 2: interfaz (solo se activa si hay `document`). */
(function (R) {
  'use strict';

  // =====================================================================
  // PARTE 1 — LÓGICA PURA
  // =====================================================================
  var MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var PERIODS = [
    { key: '4w', label: '4 semanas', days: 28 },
    { key: '3m', label: '3 meses', days: 91 },
    { key: '6m', label: '6 meses', days: 182 },
    { key: '1y', label: '1 año', days: 365 },
    { key: 'all', label: 'Todo', days: null },
  ];
  // Paleta validada (scripts/validate_palette.js, modo oscuro, superficie #171a20).
  // Z1 gris neutro intencional (recuperación); Z2–Z7 pasan banda L, croma, CVD (ΔE≥8.4) y piso normal (≥15).
  var ZONE_COLORS = ['#7d8590', '#3987e5', '#c98500', '#199e70', '#d95926', '#9085e9', '#d55181'];
  var ZONE_NAMES = ['Recuperación', 'Resistencia', 'Tempo', 'Umbral', 'VO2máx', 'Anaeróbico', 'Neuromuscular'];
  var DEFAULT_DURATIONS = [1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function parseDate(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2], 12, 0, 0); }
  function addDays(s, n) { var d = parseDate(s); d.setDate(d.getDate() + n); return fmtDate(d); }
  function daysBetween(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }
  function localDate(iso) { return DATE_RE.test(iso) ? iso : fmtDate(new Date(iso)); }
  function weekStart(s) { var wd = (parseDate(s).getDay() + 6) % 7; return addDays(s, -wd); } // lunes
  function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }
  function sum(a) { var t = 0; for (var i = 0; i < a.length; i++) t += a[i]; return t; }
  function dayLabel(s) { var p = s.split('-'); return (+p[2]) + ' ' + MONTHS[+p[1] - 1]; }
  function dayLabelYear(s) { return dayLabel(s) + ' ' + s.slice(0, 4); }

  function periodRange(key, today, firstDate) {
    var p = PERIODS.filter(function (x) { return x.key === key; })[0] || PERIODS[1];
    var from, days;
    if (p.days == null) {
      from = firstDate && firstDate < today ? firstDate : addDays(today, -27);
      days = Math.max(28, daysBetween(from, today) + 1);
      from = addDays(today, -(days - 1));
    } else {
      days = p.days; from = addDays(today, -(days - 1));
    }
    return { key: p.key, label: p.label, from: from, to: today, days: days };
  }

  function filterPeriod(acts, range) {
    return (acts || []).filter(function (a) { var d = localDate(a.date); return d >= range.from && d <= range.to; });
  }

  // Segundos por zona (7). Funciona con muestras a 1 Hz o recortadas (1/5, 1/20): usa el dt real entre muestras.
  function timeInZones(samples, ftp, zoneFor) {
    var out = [0, 0, 0, 0, 0, 0, 0];
    if (!samples || !samples.length || !(ftp > 0)) return out;
    var zf = zoneFor || (R.training && R.training.zoneFor);
    var lastDt = 1;
    for (var i = 0; i < samples.length; i++) {
      var dt;
      if (i < samples.length - 1) { dt = samples[i + 1][0] - samples[i][0]; if (!(dt > 0)) dt = lastDt; dt = Math.min(dt, 30); lastDt = dt; }
      else dt = lastDt;
      var z = zf(Math.max(0, +samples[i][1] || 0), ftp);
      out[z - 1] += dt;
    }
    return out;
  }

  function activityZones(a, ftp, zoneFor) {
    if (a.samples && a.samples.length) return timeInZones(a.samples, ftp, zoneFor);
    var out = [0, 0, 0, 0, 0, 0, 0];
    if (a.durationS > 0 && a.avgPower > 0 && ftp > 0) {
      var zf = zoneFor || R.training.zoneFor;
      out[zf(a.np || a.avgPower, ftp) - 1] = a.durationS; // sin muestras: se asigna a la zona de su NP
    }
    return out;
  }

  function ftpAtDate(history, current, date) {
    var v = null;
    for (var i = 0; i < history.length; i++) if (history[i].date <= date) v = history[i].ftp;
    if (v == null && history.length) v = history[0].ftp;
    return v != null ? v : current;
  }

  function totalZones(acts, ftpOf, zoneFor) {
    var tot = [0, 0, 0, 0, 0, 0, 0];
    (acts || []).forEach(function (a) {
      var z = activityZones(a, ftpOf(localDate(a.date)), zoneFor);
      for (var i = 0; i < 7; i++) tot[i] += z[i];
    });
    return tot;
  }

  // Agregación semanal (semanas lunes–domingo), incluye semanas vacías.
  function weeklyAggregate(acts, range, ftpOf, zoneFor) {
    var weeks = [], idx = {};
    for (var w = weekStart(range.from); w <= range.to; w = addDays(w, 7)) {
      idx[w] = weeks.length;
      weeks.push({ weekStart: w, label: dayLabel(w), tss: 0, durationS: 0, hours: 0, distM: 0, sessions: 0, zoneS: [0, 0, 0, 0, 0, 0, 0] });
    }
    (acts || []).forEach(function (a) {
      var d = localDate(a.date);
      var wk = weeks[idx[weekStart(d)]];
      if (!wk) return;
      var z = activityZones(a, ftpOf(d), zoneFor);
      for (var i = 0; i < 7; i++) wk.zoneS[i] += z[i];
      wk.tss += a.tss || 0; wk.durationS += a.durationS || 0; wk.distM += a.distanceM || 0; wk.sessions++;
    });
    weeks.forEach(function (wk) { wk.hours = wk.durationS / 3600; wk.tss = Math.round(wk.tss * 10) / 10; });
    return weeks;
  }

  function kpis(acts, last) {
    var durationS = 0, distM = 0, tss = 0, kj = 0;
    (acts || []).forEach(function (a) {
      durationS += a.durationS || 0; distM += a.distanceM || 0; tss += a.tss || 0;
      kj += (a.avgPower || 0) * (a.durationS || 0) / 1000;
    });
    return { hours: durationS / 3600, km: distM / 1000, tss: Math.round(tss), kj: Math.round(kj), sessions: (acts || []).length,
      ctl: last ? last.ctl : 0, atl: last ? last.atl : 0, tsb: last ? last.tsb : 0 };
  }

  // Umbrales propios (convención Coggan/TrainingPeaks adaptada a 4 etiquetas).
  function tsbState(tsb) {
    if (tsb > 5) return { key: 'fresh', label: 'Fresco', desc: 'Descansado: buen momento para una prueba o un esfuerzo grande.' };
    if (tsb >= -10) return { key: 'optimal', label: 'Óptimo', desc: 'Equilibrio entre carga y descanso: listo para rendir.' };
    if (tsb >= -30) return { key: 'loaded', label: 'Cargado', desc: 'Carga productiva: estás acumulando forma, vigila el descanso.' };
    return { key: 'overreach', label: 'Sobrecarga', desc: 'Fatiga alta: programa recuperación para evitar sobreentrenar.' };
  }

  function bestOf(a, w) {
    if (a.bestEfforts && a.bestEfforts[String(w)] != null) return a.bestEfforts[String(w)];
    if (a.samples && a.samples.length >= w) {
      var p = a.samples.map(function (s) { return Math.max(0, +s[1] || 0); }), s0 = 0, best = 0, i;
      for (i = 0; i < w; i++) s0 += p[i];
      best = s0;
      for (i = w; i < p.length; i++) { s0 += p[i] - p[i - w]; if (s0 > best) best = s0; }
      return best / w;
    }
    return null;
  }

  // FTP a partir de tests (rampa: 75 % del mejor minuto; 20 min: 95 % de la media) + FTP del perfil hoy.
  function ftpHistory(acts, profile, today) {
    var pts = [];
    (acts || []).forEach(function (a) {
      var d = localDate(a.date), w;
      if (a.workoutId === 'ramp-test') { w = bestOf(a, 60); if (w) pts.push({ date: d, ftp: Math.round(0.75 * w), source: 'Test de rampa', activityId: a.id }); }
      else if (a.workoutId === 'ftp-20') { w = bestOf(a, 1200); if (w) pts.push({ date: d, ftp: Math.round(0.95 * w), source: 'Test FTP 20 min', activityId: a.id }); }
    });
    pts.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    var cur = profile && profile.ftp > 0 ? Math.round(profile.ftp) : 0;
    if (cur && (!pts.length || pts[pts.length - 1].ftp !== cur)) pts.push({ date: today, ftp: cur, source: 'Perfil (FTP actual)', activityId: null });
    return pts;
  }

  function ftpChange(history, from) {
    if (!history.length) return null;
    var current = history[history.length - 1].ftp;
    var base = null;
    for (var i = 0; i < history.length - 1; i++) if (history[i].date <= from) base = history[i].ftp;
    if (base == null && history.length > 1) base = history[0].ftp;
    if (base == null) return { current: current, base: null, delta: 0, pct: 0 };
    return { current: current, base: base, delta: current - base, pct: base ? Math.round((current - base) / base * 1000) / 10 : 0 };
  }

  function powerCurveCompare(periodActs, allActs, durations, weightKg) {
    var ds = durations || DEFAULT_DURATIONS;
    var pc = R.training.powerCurve(periodActs, ds), bc = R.training.powerCurve(allActs, ds);
    var pm = {}, bm = {};
    pc.forEach(function (x) { pm[x.durationS] = x; });
    bc.forEach(function (x) { bm[x.durationS] = x; });
    return ds.map(function (d) {
      var p = pm[d] || null, b = bm[d] || null;
      return { durationS: d, period: p ? p.watts : null, periodDate: p ? p.date : null, best: b ? b.watts : null, bestDate: b ? b.date : null,
        bestWkg: b && weightKg > 0 ? Math.round(b.watts / weightKg * 100) / 100 : null,
        periodWkg: p && weightKg > 0 ? Math.round(p.watts / weightKg * 100) / 100 : null };
    });
  }

  // Parciales acumulados [distM, tS] cada stepM (misma convención que R.riders.splitsFromSamples).
  function splitsFromSamples(samples, stepM) {
    var step = stepM || 100, out = [];
    if (!samples || samples.length < 2) return out;
    var next = step;
    for (var i = 1; i < samples.length; i++) {
      var a = samples[i - 1], b = samples[i], da = a[5], db = b[5];
      while (db >= next && da < next) { out.push([next, a[0] + ((next - da) / (db - da)) * (b[0] - a[0])]); next += step; }
      if (da >= next) next = (Math.floor(da / step) + 1) * step;
    }
    var end = samples[samples.length - 1];
    if (end[5] > 0 && (!out.length || end[5] > out[out.length - 1][0])) out.push([end[5], end[0]]);
    return out;
  }

  function timeAt(splits, d) {
    if (!splits.length) return null;
    var prev = [0, 0];
    for (var i = 0; i < splits.length; i++) {
      var s = splits[i];
      if (s[0] >= d) { var span = s[0] - prev[0]; return span > 0 ? prev[1] + (d - prev[0]) / span * (s[1] - prev[1]) : s[1]; }
      prev = s;
    }
    return null; // d más allá del final
  }

  // Diferencia acumulada (s) de `other` respecto de `best` cada stepM; >0 = más lento que tu mejor marca.
  function diffSplits(best, other, stepM) {
    var step = stepM || 1000, out = [{ distM: 0, diffS: 0 }];
    if (!best || !other || !best.length || !other.length) return out;
    var end = Math.min(best[best.length - 1][0], other[other.length - 1][0]);
    var marks = [];
    for (var d = step; d < end; d += step) marks.push(d);
    marks.push(end);
    marks.forEach(function (m) {
      var tb = timeAt(best, m), to = timeAt(other, m);
      if (tb != null && to != null) out.push({ distM: m, diffS: Math.round((to - tb) * 10) / 10 });
    });
    return out;
  }

  // Tiempo en que se cruza distanceM (interpolado) o null si no completó la ruta.
  function routeTime(a, distanceM) {
    var s = a.samples;
    if (!s || s.length < 2) return distanceM ? null : a.durationS || null;
    var idx = -1;
    for (var i = 0; i < s.length; i++) if (s[i][5] >= distanceM - 5) { idx = i; break; }
    if (idx < 0) return null;
    if (idx > 0 && s[idx][5] > s[idx - 1][5] && s[idx - 1][5] < distanceM && s[idx][5] >= distanceM) {
      var p = s[idx - 1], q = s[idx];
      return p[0] + ((distanceM - p[5]) / (q[5] - p[5])) * (q[0] - p[0]);
    }
    return s[idx][0];
  }

  // routes: función id -> {id,name,distanceM}|null
  function computeBests(acts, routes) {
    var bests = {};
    (acts || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; }).forEach(function (a) {
      if (!a.routeId) return;
      var r = routes(a.routeId);
      if (!r || !a.samples) return;
      var t = routeTime(a, r.distanceM);
      if (t == null) return;
      if (bests[a.routeId] && bests[a.routeId].totalTimeS <= t) return;
      var trimmed = a.samples.filter(function (s) { return s[0] <= t; });
      trimmed.push([t, 0, null, null, 0, r.distanceM, null]);
      bests[a.routeId] = { activityId: a.id, totalTimeS: t, splits: splitsFromSamples(trimmed) };
    });
    return bests;
  }

  // routes: id -> ruta|null. bests: state.bests (o demo).
  function routeRecords(acts, bests, routes) {
    var by = {};
    (acts || []).forEach(function (a) { if (a.routeId) (by[a.routeId] = by[a.routeId] || []).push(a); });
    var rows = [];
    Object.keys(by).forEach(function (id) {
      var list = by[id].slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      var route = routes(id), dist = route ? route.distanceM : 0;
      var attempts = list.map(function (a) {
        var t = dist ? routeTime(a, dist) : a.durationS;
        return { id: a.id, date: a.date, timeS: t, act: a };
      }).filter(function (x) { return x.timeS != null; });
      if (!attempts.length) return;
      var minA = attempts.reduce(function (m, x) { return x.timeS < m.timeS ? x : m; });
      var b = bests && bests[id];
      var best = b ? { activityId: b.activityId, timeS: b.totalTimeS, date: (attempts.filter(function (x) { return x.id === b.activityId; })[0] || {}).date || null }
        : { activityId: minA.id, timeS: minA.timeS, date: minA.date };
      if (b && b.totalTimeS > minA.timeS + 0.5) best = { activityId: minA.id, timeS: minA.timeS, date: minA.date }; // marca vieja/stale
      var first = attempts[0];
      rows.push({ routeId: id, name: route && route.name ? route.name : id, distanceM: dist || (list[0].distanceM || 0), attempts: attempts.length,
        best: best, first: first, last: attempts[attempts.length - 1], improvementS: Math.round((first.timeS - best.timeS) * 10) / 10, list: attempts });
    });
    rows.sort(function (a, b) { return b.attempts - a.attempts || (a.name < b.name ? -1 : 1); });
    return rows;
  }

  // Último intento distinto de la mejor marca (para "superarte a ti mismo").
  function pickComparison(attempts, bestActivityId) {
    for (var i = attempts.length - 1; i >= 0; i--) if (attempts[i].id !== bestActivityId) return attempts[i];
    return null;
  }

  // Diezmado por promedio de cubetas a ≤ max puntos. rows: filas; xi/yi: índices.
  function decimateSeries(rows, max, xi, yi) {
    var n = rows.length, out = [], i;
    if (n <= max) {
      for (i = 0; i < n; i++) out.push({ x: rows[i][xi], y: rows[i][yi] == null ? null : rows[i][yi] });
      return out;
    }
    var k = Math.ceil(n / max);
    for (i = 0; i < n; i += k) {
      var sx = 0, sy = 0, cy = 0, c = Math.min(k, n - i);
      for (var j = i; j < i + c; j++) { sx += rows[j][xi]; if (rows[j][yi] != null) { sy += rows[j][yi]; cy++; } }
      out.push({ x: sx / c, y: cy ? sy / cy : null });
    }
    return out;
  }

  function bucketPmc(rows, max) {
    if (rows.length <= max) return rows;
    var k = Math.ceil(rows.length / max), out = [];
    for (var i = 0; i < rows.length; i += k) {
      var chunk = rows.slice(i, i + k), last = chunk[chunk.length - 1];
      out.push({ date: last.date, tss: Math.round(sum(chunk.map(function (r) { return r.tss; })) * 100) / 100, ctl: last.ctl, atl: last.atl, tsb: last.tsb });
    }
    return out;
  }

  function filterHistory(acts, f) {
    var q = ((f && f.q) || '').trim().toLowerCase(), type = (f && f.type) || 'all';
    var out = (acts || []).filter(function (a) {
      if (type !== 'all' && a.type !== type) return false;
      if (q && (a.name || '').toLowerCase().indexOf(q) < 0 && (a.routeId || '').toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    out.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
    return out;
  }

  // ---- Datos de ejemplo ------------------------------------------------
  var DEMO_ROUTES = {
    'alpe-dhuez': { id: 'alpe-dhuez', name: "Alpe d'Huez", distanceM: 12100, gainM: 960, startEle: 720, pct: 0.9 },
    'farellones': { id: 'farellones', name: 'Farellones', distanceM: 16700, gainM: 1120, startEle: 1050, pct: 0.86 },
    'caracoles-portillo': { id: 'caracoles-portillo', name: 'Caracoles de Portillo', distanceM: 5400, gainM: 390, startEle: 2850, pct: 0.97 },
    'el-yeso': { id: 'el-yeso', name: 'Embalse El Yeso', distanceM: 19500, gainM: 560, startEle: 1450, pct: 0.8 },
    'talagante-valle': { id: 'talagante-valle', name: 'Valle de Talagante', distanceM: 34400, gainM: 90, startEle: 340, pct: 0.72 },
  };

  function rng(seed) {
    var a = seed >>> 0;
    return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function gauss(r) { var u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  // Velocidad (m/s) para una potencia y pendiente: P·0.976 = v·(m·g·(Crr+grade) + ½ρ·CdA·v²)
  function speedFor(powerW, grade, massKg, alt) {
    var rho = 1.225 * Math.exp(-(alt || 0) / 8500), p = powerW * 0.976, lo = 0.3, hi = 25;
    for (var i = 0; i < 40; i++) {
      var v = (lo + hi) / 2, need = v * (massKg * 9.8067 * (0.004 + grade) + 0.5 * rho * 0.32 * v * v);
      if (need > p) hi = v; else lo = v;
    }
    return Math.max(0.3, (lo + hi) / 2);
  }

  var DEMO_WEEKS = {
    tue: ['resistencia-60', 'tempo-45', 'tempo-2x20', 'tempo-3x15', 'recuperacion-45', 'tempo-2x20', 'tempo-3x15', 'resistencia-60'],
    thu: ['sweetspot-3x12', 'sweetspot-2x20', 'sweetspot-3x15', 'recuperacion-60', 'umbral-3x10', 'umbral-4x8', 'vo2-5x4', 'umbral-2x20'],
    sun: ['resistencia-90', 'resistencia-120', 'resistencia-120', 'resistencia-60', 'resistencia-120', 'resistencia-progresiva-90', 'resistencia-120', 'resistencia-90'],
    sat: ['alpe-dhuez', 'talagante-valle', 'caracoles-portillo', 'farellones', 'alpe-dhuez', 'el-yeso', 'caracoles-portillo', 'talagante-valle'],
    wed: ['ftp-20', null, null, 'ramp-test', null, 'el-yeso', 'farellones', 'ftp-20'],
  };

  function simulate(o) {
    // o: {rand, ftp, maxHr, mass, targets: array de potencias objetivo/segundo|fn, route, cadFn}
    var r = o.rand, ftp = o.ftp, samples = [], ar = 0, hr = 62, spd = 0, dist = 0;
    var ele = o.route ? o.route.startEle : 0, gSeed = r() * 6.28;
    var L = o.route ? o.route.distanceM : 0, base = o.route ? o.route.gainM / L : 0;
    var hrFtp = 0.9 * o.maxHr, cadTarget = 88 + gauss(r) * 2;
    var t = 0, endAt = o.route ? Infinity : o.targets.length, cool = 120, coolStart = -1;
    while (t < endAt + 1) {
      var grade = 0, tgt;
      if (o.route && coolStart < 0) {
        var amp = base > 0.03 ? 0.3 * base : 0.012;
        grade = clamp(base + amp * Math.sin(dist / L * 2 * Math.PI * 3.3 + gSeed), -0.07, 0.14);
        tgt = o.ftp * o.route.pct * (1 + 0.8 * (grade - base)) * (t < 60 ? 0.8 + t / 300 : 1);
      } else if (o.route) { tgt = ftp * 0.4; } else { tgt = o.targets[Math.min(t, o.targets.length - 1)]; }
      ar = 0.9 * ar + gauss(r) * 0.03;
      var p = tgt > 0 ? Math.max(0, Math.round(tgt * (1 + ar))) : 0;
      if (o.route && coolStart >= 0) grade = 0;
      var v = speedFor(p, grade, o.mass, ele);
      spd = spd ? spd + 0.15 * (v - spd) : v;
      if (p === 0) spd *= 0.9;
      var targetHr = 62 + (hrFtp - 62) * Math.pow(clamp(p / ftp, 0, 1.6), 0.85);
      hr += (targetHr - hr) / 40 + gauss(r) * 0.25 + (t / 5000) * 0.004;
      var cad = p < 5 ? 0 : Math.round(clamp(cadTarget + (o.cadBoost ? o.cadBoost(t) : 0) + (p / ftp - 0.7) * 10 + gauss(r) * 2.2, 55, 125));
      samples.push([t, p, Math.round(hr), cad, Math.round(spd * 100) / 100, Math.round(dist * 10) / 10, o.route ? Math.round(ele * 10) / 10 : null]);
      dist += spd; ele += spd * grade;
      t++;
      if (o.route && coolStart < 0 && dist >= L) { coolStart = t; endAt = t + cool; }
      if (o.route && t > 6 * 3600) break;
    }
    return samples;
  }

  function stepTargets(w, ftp, r) {
    var out = [];
    (w.steps || []).forEach(function (s) {
      var a = s.powerPct, b = s.powerPctEnd != null ? s.powerPctEnd : a;
      for (var i = 0; i < s.durationS; i++) out.push(ftp * (a + (b - a) * (s.durationS > 1 ? i / (s.durationS - 1) : 0)) / 100);
    });
    return out;
  }

  // Actividades sintéticas coherentes (8 semanas por defecto). Todas llevan demo:true.
  function generateDemo(o) {
    o = o || {};
    var T = R.training, weeks = o.weeks || 8, seed = o.seed != null ? o.seed : 20260101;
    var today = o.today || fmtDate(new Date());
    var ftpEnd = o.ftp > 0 ? o.ftp : 230, weight = o.weightKg > 0 ? o.weightKg : 72, maxHr = o.maxHr > 0 ? o.maxHr : 188;
    var routes = o.routes || function (id) { return DEMO_ROUTES[id] || null; };
    var r = rng(seed), acts = [];
    var mon0 = addDays(weekStart(today), -7 * (weeks - 1));
    function ftpAtWeek(w) { return ftpEnd * (0.93 + 0.07 * (w / Math.max(1, weeks - 1))); }
    function push(dateStr, w, kind, id) {
      if (dateStr > today) return;
      var ftp = ftpAtWeek(w), act, samples, name, wk = null, routeId = null, route = null;
      if (kind === 'route') {
        var base = DEMO_ROUTES[id] || { id: id, name: id, distanceM: 10000, gainM: 300, startEle: 500, pct: 0.8 };
        var real = routes(id);
        route = Object.assign({}, base, real ? { distanceM: real.distanceM, name: real.name || base.name } : {});
        samples = simulate({ rand: r, ftp: ftp, maxHr: maxHr, mass: weight + 8, route: route });
        name = route.name; routeId = id;
      } else {
        wk = T.getWorkout(id); name = wk.name;
        var scale = id === 'ftp-20' ? 1.05 : id === 'ramp-test' ? 0.82 : 1; // los tests se hacen a tope: el FTP resultante es coherente
        samples = simulate({ rand: r, ftp: ftp, maxHr: maxHr, mass: weight + 8, targets: stepTargets(wk, ftp * scale, r),
          cadBoost: function (t) { return Math.sin(t / 90) * 2; } });
      }
      var m = T.computeMetrics(samples, Math.round(ftp));
      var hrs = samples.filter(function (s) { return s[2]; }).map(function (s) { return s[2]; });
      var cads = samples.filter(function (s) { return s[3] > 0; }).map(function (s) { return s[3]; });
      var d = parseDate(dateStr); d.setHours(18, 15 + Math.floor(r() * 40), 0, 0);
      act = { id: 'demo-' + dateStr + '-' + (id || kind), date: d.toISOString(), type: routeId ? 'route' : 'workout', name: name,
        routeId: routeId, workoutId: wk ? wk.id : null, durationS: m.durationS, distanceM: Math.round(samples[samples.length - 1][5]),
        avgPower: m.avgPower, np: m.np, tss: m.tss, if: m.if, avgHr: hrs.length ? Math.round(sum(hrs) / hrs.length) : null,
        avgCadence: cads.length ? Math.round(sum(cads) / cads.length) : null, kcal: m.kcal, rpe: clamp(Math.round(3 + (m.if - 0.55) * 14), 2, 10),
        samples: samples, bestEfforts: m.bestEfforts, demo: true };
      acts.push(act);
    }
    for (var w = 0; w < weeks; w++) {
      var mon = addDays(mon0, 7 * w), wi = w % 8;
      var plan = [[1, 'wk', DEMO_WEEKS.tue[wi]], [3, 'wk', DEMO_WEEKS.thu[wi]], [5, 'route', DEMO_WEEKS.sat[wi]], [6, 'wk', DEMO_WEEKS.sun[wi]]];
      var wed = DEMO_WEEKS.wed[wi];
      if (wed) plan.push([2, wed === 'ramp-test' || wed === 'ftp-20' ? 'wk' : 'route', wed]);
      if (wed === 'ftp-20') plan = plan.filter(function (p) { return p[0] !== 3; }); // el test reemplaza el jueves
      plan.forEach(function (p) {
        if (p[1] === 'wk' && p[2] !== 'ftp-20' && p[2] !== 'ramp-test' && r() < 0.08) return; // alguna sesión saltada
        push(addDays(mon, p[0]), w, p[1] === 'route' ? 'route' : 'workout', p[2]);
      });
    }
    acts.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    return { activities: acts, bests: computeBests(acts, routes), ftpEnd: ftpEnd };
  }

  R.statsLogic = {
    PERIODS: PERIODS, ZONE_COLORS: ZONE_COLORS, ZONE_NAMES: ZONE_NAMES, DEMO_ROUTES: DEMO_ROUTES, DEFAULT_DURATIONS: DEFAULT_DURATIONS,
    fmtDate: fmtDate, parseDate: parseDate, addDays: addDays, daysBetween: daysBetween, localDate: localDate, weekStart: weekStart,
    dayLabel: dayLabel, dayLabelYear: dayLabelYear,
    periodRange: periodRange, filterPeriod: filterPeriod, timeInZones: timeInZones, activityZones: activityZones, totalZones: totalZones,
    weeklyAggregate: weeklyAggregate, kpis: kpis, tsbState: tsbState, ftpHistory: ftpHistory, ftpChange: ftpChange, ftpAtDate: ftpAtDate,
    powerCurveCompare: powerCurveCompare, splitsFromSamples: splitsFromSamples, timeAt: timeAt, diffSplits: diffSplits, routeTime: routeTime,
    computeBests: computeBests, routeRecords: routeRecords, pickComparison: pickComparison, decimateSeries: decimateSeries,
    bucketPmc: bucketPmc, filterHistory: filterHistory, generateDemo: generateDemo, speedFor: speedFor,
  };

  if (typeof document === 'undefined') return;
  // =====================================================================
  // PARTE 2 — INTERFAZ
  // =====================================================================
  var L = R.statsLogic;
  var C = { accent: '#FF5A1F', gold: '#FFD23F', ctl: '#3987e5', atl: '#d55181', tsb: '#c9ccd3', ink: '#eef0f3', ink2: '#aab0bb', ink3: '#7d8590',
    surface: '#171a20', grid: 'rgba(255,255,255,0.07)', line: '#2a2f3a', blue: '#3987e5', orange: '#d95926', hr: '#d55181', cad: '#3987e5' };
  var ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/></svg>';

  var S = null;            // estado de la vista montada
  var demo = { active: false, acts: [], bests: {} }; // datos de ejemplo: solo en memoria
  var prefs = { period: '3m', hist: { type: 'all', q: '', limit: 25 }, route: null };

  // ---------- utilidades DOM ----------
  function h(tag, props) {
    var e = document.createElement(tag), i, k;
    props = props || {};
    for (k in props) {
      var v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) e.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); });
      else e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }
  function svgEl(markup) { var t = document.createElement('span'); t.innerHTML = markup; return t.firstChild; } // solo marcado estático

  // ---------- formato (es-CL: coma decimal) ----------
  function fmtNum(n, d) {
    if (n == null || !isFinite(n)) return '–';
    var s = (+n).toFixed(d || 0), p = s.split('.'), neg = p[0][0] === '-';
    var ip = neg ? p[0].slice(1) : p[0];
    ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (neg ? '-' : '') + ip + (p[1] ? ',' + p[1] : '');
  }
  function fmtDur(s) {
    s = Math.round(s || 0);
    var hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return hh ? hh + ':' + (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss : mm + ':' + (ss < 10 ? '0' : '') + ss;
  }
  function fmtDurShort(s) { // 1 s, 5 s, 1 min, 20 min, 1 h
    if (s < 60) return s + ' s';
    if (s < 3600) return (s / 60) + ' min';
    return (s / 3600) + ' h';
  }
  function fmtSigned(n, d, unit) { var v = fmtNum(Math.abs(n), d); return (n > 0 ? '+' : n < 0 ? '−' : '') + v + (unit || ''); }
  function fmtSignedDur(s) { var a = Math.abs(Math.round(s)); return (s > 0 ? '+' : s < 0 ? '−' : '') + fmtDur(a); }

  // ---------- modal propio ----------
  function openModal(opts) {
    var prevFocus = document.activeElement;
    var body = h('div', { class: 'st-modal-body' });
    var titleId = 'st-modal-t-' + Math.random().toString(36).slice(2, 7);
    var dlg = h('div', { class: 'st-modal' + (opts.wide ? ' st-modal--wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('div', { class: 'st-modal-head' }, h('h3', { id: titleId, text: opts.title || '' }),
        h('button', { class: 'st-icon-btn', type: 'button', 'aria-label': 'Cerrar', text: '×', onclick: function () { api.close(); } })),
      body);
    var back = h('div', { class: 'st-modal-backdrop stats-view' }, dlg);
    var api = { el: body, root: back, closed: false, onClose: null,
      close: function () {
        if (api.closed) return; api.closed = true;
        document.removeEventListener('keydown', onKey, true);
        if (back.parentNode) back.parentNode.removeChild(back);
        if (api.onClose) api.onClose();
        if (S) S.modal = null;
        if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (e) { /* noop */ } }
      } };
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); api.close(); }
      else if (ev.key === 'Tab') {
        var f = dlg.querySelectorAll('button,input,select,textarea,[tabindex]:not([tabindex="-1"])');
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
        else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
      }
    }
    back.addEventListener('pointerdown', function (ev) { if (ev.target === back) api.close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(back);
    if (S) S.modal = api;
    var f0 = dlg.querySelector('button'); if (f0) f0.focus();
    return api;
  }

  function toast(msg, kind) {
    if (S && S.ctx && S.ctx.toast) S.ctx.toast(msg, kind);
    else if (R.ui && R.ui.toast) R.ui.toast(msg, kind);
  }

  // ---------- gráficos ----------
  var hasChart = function () { return typeof window !== 'undefined' && typeof window.Chart === 'function'; };
  function reduceMotion() { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }

  function themeChart() {
    var D = window.Chart.defaults;
    D.color = C.ink2; D.font.family = "'Inter', system-ui, sans-serif"; D.font.size = 11;
    D.borderColor = C.grid;
    if (reduceMotion()) D.animation = false;
  }
  function tipStyle(extra) {
    return Object.assign({ backgroundColor: '#0e1014', borderColor: C.line, borderWidth: 1, titleColor: C.ink2, bodyColor: C.ink, padding: 10, cornerRadius: 8,
      titleFont: { weight: '500', size: 11 }, bodyFont: { size: 12, weight: '600' }, boxWidth: 14, boxHeight: 3, usePointStyle: false, displayColors: true, caretSize: 5 }, extra || {});
  }
  var crosshair = { id: 'crosshair', afterDatasetsDraw: function (chart) {
    var a = chart.tooltip && chart.tooltip.getActiveElements && chart.tooltip.getActiveElements();
    if (!a || !a.length || !chart.options.plugins.crosshair) return;
    var x = a[0].element.x, ca = chart.chartArea, ctx = chart.ctx;
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, ca.top); ctx.lineTo(x, ca.bottom); ctx.stroke(); ctx.restore();
  } };
  function mkChart(canvas, cfg) {
    cfg.options = cfg.options || {};
    cfg.options.responsive = true; cfg.options.maintainAspectRatio = false;
    var ch = new window.Chart(canvas, cfg);
    S.charts.push(ch);
    return ch;
  }
  function axisX(extra) { return Object.assign({ grid: { display: false }, border: { color: C.line }, ticks: { color: C.ink3, maxRotation: 0, autoSkip: true } }, extra || {}); }
  function axisY(extra) { return Object.assign({ grid: { color: C.grid }, border: { display: false }, ticks: { color: C.ink3 } }, extra || {}); }

  // Tarjeta con título, leyenda y vista "Tabla" alternativa.
  function chartCard(o) {
    var canvas = h('canvas', { role: 'img', 'aria-label': o.alt || o.title });
    var wrap = h('div', { class: 'st-chart', style: 'height:' + (o.height || 260) + 'px' }, canvas);
    var tableBox = h('div', { class: 'st-table-wrap', hidden: true });
    var legendBox = h('div', { class: 'st-legend' });
    var tableMode = !hasChart();
    var btn = h('button', { class: 'st-chip', type: 'button', 'aria-pressed': 'false', text: 'Ver tabla' });
    var card = h('section', { class: 'st-card' + (o.span ? ' st-span-' + o.span : '') },
      h('header', { class: 'st-card-head' }, h('div', null, h('h3', { text: o.title }), o.sub ? h('p', { class: 'st-sub', text: o.sub }) : null), btn),
      legendBox, wrap, tableBox, o.foot ? h('p', { class: 'st-foot', text: o.foot }) : null);
    function setMode(t) {
      tableMode = t;
      wrap.hidden = t; tableBox.hidden = !t; legendBox.hidden = t;
      btn.textContent = t ? 'Ver gráfico' : 'Ver tabla'; btn.setAttribute('aria-pressed', t ? 'true' : 'false');
      if (t && !tableBox.firstChild && o.table) tableBox.appendChild(buildTable(o.table()));
    }
    if (!hasChart()) { btn.hidden = true; }
    btn.addEventListener('click', function () { setMode(!tableMode); });
    return { el: card, canvas: canvas, legend: legendBox, wrap: wrap, setMode: setMode, init: function () { if (tableMode) setMode(true); } };
  }
  function buildTable(spec) {
    var thead = h('thead', null, h('tr', null, spec.head.map(function (t) { return h('th', { scope: 'col', text: t }); })));
    var tbody = h('tbody', null, spec.rows.map(function (r) { return h('tr', null, r.map(function (c) { return h('td', { text: c == null ? '–' : String(c) }); })); }));
    return h('div', { class: 'st-table-scroll' }, h('table', { class: 'st-table' }, thead, tbody));
  }
  function legendItem(label, color, kind, dash, onToggle) {
    var key = h('span', { class: 'st-key st-key--' + (kind || 'line'), style: kind === 'bar' ? 'background:' + color : 'border-top-color:' + color + (dash ? ';border-top-style:dashed' : '') });
    var b = h('button', { class: 'st-legend-item', type: 'button', 'aria-pressed': 'true', onclick: function () {
      var on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', on ? 'true' : 'false'); if (onToggle) onToggle(on);
    } }, key, h('span', { text: label }));
    return b;
  }

  // ---------- datos de la vista ----------
  function routeLookup(id) {
    var r = R.routes && R.routes.get ? R.routes.get(id) : null;
    if (r) return r;
    return L.DEMO_ROUTES[id] || null;
  }
  function compute() {
    var st = R.store.get(), profile = st.profile || {};
    var real = st.activities || [];
    if (real.length && demo.active) { demo.active = false; demo.acts = []; demo.bests = {}; }
    var acts = (real.length ? real : (demo.active ? demo.acts : [])).slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    var today = L.fmtDate(new Date());
    var first = acts.length ? L.localDate(acts[0].date) : today;
    var range = L.periodRange(prefs.period, today, first);
    var inP = L.filterPeriod(acts, range);
    var hist = L.ftpHistory(acts, profile, today);
    var curFtp = profile.ftp > 0 ? profile.ftp : (hist.length ? hist[hist.length - 1].ftp : 0);
    var ftpOf = function (d) { return L.ftpAtDate(hist, curFtp, d) || curFtp || 200; };
    var pmcFull = acts.length ? R.training.pmc(acts, { days: range.days, today: today }) : [];
    var bests = real.length ? (st.bests || {}) : (demo.active ? demo.bests : {});
    return { st: st, profile: profile, acts: acts, today: today, range: range, inP: inP, hist: hist, curFtp: curFtp, ftpOf: ftpOf,
      pmc: pmcFull, kpi: L.kpis(inP, pmcFull.length ? pmcFull[pmcFull.length - 1] : null), bests: bests, isDemo: !real.length && demo.active };
  }

  // ---------- render ----------
  function destroyCharts() {
    if (!S) return;
    S.charts.forEach(function (c) { try { c.destroy(); } catch (e) { /* noop */ } });
    S.charts = [];
  }

  function refresh() {
    if (!S || !S.root) return;
    destroyCharts();
    var D = compute();
    S.D = D;
    var root = S.root;
    while (root.firstChild) root.removeChild(root.firstChild);
    root.appendChild(header(D));
    if (!hasChart()) root.appendChild(h('div', { class: 'st-notice', role: 'status', text: 'No se pudo cargar la librería de gráficos: se muestran tablas con los mismos datos.' }));
    if (!D.acts.length) { root.appendChild(emptyState()); return; }
    if (hasChart()) themeChart();
    root.appendChild(kpiGrid(D));
    if (!D.inP.length) root.appendChild(h('div', { class: 'st-notice', role: 'status', text: 'No hay rodadas en este período. Prueba con un rango más amplio.' }));
    var grid = h('div', { class: 'st-grid' });
    root.appendChild(grid);
    var builders = [pmcCard, weeklyCard, curveCard, ftpCard, zonesCard, recordsCard, historyCard];
    var inits = [];
    builders.forEach(function (b) {
      var c = b(D);
      if (!c) return;
      grid.appendChild(c.el);
      if (c.init) inits.push(c.init);
    });
    inits.forEach(function (f) { f(); });
  }

  function header(D) {
    var seg = h('div', { class: 'st-seg', role: 'radiogroup', 'aria-label': 'Período' }, L.PERIODS.map(function (p) {
      return h('button', { type: 'button', role: 'radio', class: 'st-seg-btn', 'aria-checked': p.key === prefs.period ? 'true' : 'false', text: p.label,
        onclick: function () { if (prefs.period === p.key) return; prefs.period = p.key; softRefresh(); } });
    }));
    var top = h('div', { class: 'st-head' }, h('div', null, h('h2', { text: 'Estadísticas' }),
      h('p', { class: 'st-sub', text: D.acts.length ? 'Tu progreso de ' + L.dayLabelYear(D.range.from) + ' a ' + L.dayLabelYear(D.range.to) : 'Aquí verás tu progreso cuando completes rodadas' })), D.acts.length ? seg : null);
    var wrap = h('div', null, top);
    if (D.isDemo) wrap.appendChild(h('div', { class: 'st-demo', role: 'status' },
      h('span', { text: 'Estás viendo datos de ejemplo (no se guardan en tu cuenta).' }),
      h('button', { class: 'st-btn st-btn--ghost', type: 'button', text: 'Quitar datos de ejemplo', onclick: function () { demo.active = false; demo.acts = []; demo.bests = {}; refresh(); toast('Datos de ejemplo eliminados', 'info'); } })));
    return wrap;
  }
  // Mantiene el marco mientras se recalcula (sin saltos de layout).
  function softRefresh() {
    if (!S) return;
    S.root.classList.add('st-loading');
    requestAnimationFrame(function () { if (!S) return; refresh(); S.root.classList.remove('st-loading'); });
  }

  function emptyState() {
    var art = svgEl('<svg class="st-empty-art" viewBox="0 0 240 150" role="img" aria-label="Ilustración de una bicicleta sobre un rodillo y una gráfica ascendente"><rect x="10" y="12" width="220" height="96" rx="12" fill="#1d2129" stroke="#2a2f3a"/><path d="M26 92 L66 74 L96 82 L132 52 L168 60 L214 30" fill="none" stroke="#FF5A1F" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M26 98 L66 90 L96 94 L132 78 L168 82 L214 62" fill="none" stroke="#3987e5" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1 7"/><g fill="none" stroke="#aab0bb" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="82" cy="126" r="16"/><circle cx="150" cy="126" r="16"/><path d="M82 126 L108 104 L132 104 L150 126 M108 104 L98 90 M132 104 L126 90 M94 90 H106 M118 90 H132"/><path d="M62 144 H170" stroke="#7d8590"/></g></svg>');
    return h('section', { class: 'st-empty' }, art,
      h('h3', { text: 'Aún no hay rodadas para analizar' }),
      h('p', { text: 'Completa tu primera rodada y aquí aparecerán tu forma física, tu curva de potencia, tus récords por ruta y mucho más.' }),
      h('div', { class: 'st-empty-actions' },
        h('button', { class: 'st-btn st-btn--primary', type: 'button', text: 'Haz tu primera rodada', onclick: function () { if (S.ctx && S.ctx.navigate) S.ctx.navigate('rodar'); else if (R.ui && R.ui.navigate) R.ui.navigate('rodar'); } }),
        h('button', { class: 'st-btn', type: 'button', text: 'Cargar datos de ejemplo', onclick: loadDemo })));
  }
  function loadDemo() {
    var p = (R.store.get().profile) || {};
    var d = L.generateDemo({ today: L.fmtDate(new Date()), ftp: p.ftp, weightKg: p.weightKg, maxHr: p.maxHr, routes: routeLookup });
    demo.active = true; demo.acts = d.activities; demo.bests = d.bests;
    refresh();
    toast('Datos de ejemplo cargados: 8 semanas de rodadas', 'info');
  }

  // ---------- KPIs ----------
  function kpiGrid(D) {
    var k = D.kpi, st = L.tsbState(k.tsb), fc = L.ftpChange(D.hist, D.range.from);
    function tile(label, value, unit, extra, cls) {
      return h('div', { class: 'st-kpi' + (cls ? ' ' + cls : '') }, h('span', { class: 'st-kpi-l', text: label }),
        h('span', { class: 'st-kpi-v' }, h('span', { text: value }), unit ? h('small', { text: ' ' + unit }) : null), extra || null);
    }
    var tsbIcon = { fresh: '◆', optimal: '●', loaded: '▲', overreach: '■' }[st.key];
    var ftpExtra = fc && fc.base != null ? h('span', { class: 'st-delta st-delta--' + (fc.delta > 0 ? 'up' : fc.delta < 0 ? 'down' : 'flat') },
      (fc.delta > 0 ? '▲ ' : fc.delta < 0 ? '▼ ' : '● ') + fmtSigned(fc.delta, 0, ' W') + ' (' + fmtSigned(fc.pct, 1, ' %') + ')') : h('span', { class: 'st-delta st-delta--flat', text: 'Sin test previo para comparar' });
    var wkg = D.profile.weightKg > 0 && D.curFtp ? fmtNum(D.curFtp / D.profile.weightKg, 2) + ' W/kg' : null;
    return h('div', { class: 'st-kpis' },
      tile('Horas', fmtNum(k.hours, 1), 'h'), tile('Distancia', fmtNum(k.km, 0), 'km'), tile('TSS total', fmtNum(k.tss, 0), ''),
      tile('Energía', fmtNum(k.kj, 0), 'kJ'), tile('Sesiones', fmtNum(k.sessions, 0), ''),
      tile('Forma (CTL)', fmtNum(k.ctl, 0), '', h('span', { class: 'st-delta st-delta--flat', text: 'Fatiga (ATL) ' + fmtNum(k.atl, 0) })),
      tile('Frescura (TSB)', fmtSigned(k.tsb, 0), '', h('span', { class: 'st-state st-state--' + st.key, title: st.desc }, h('span', { 'aria-hidden': 'true', text: tsbIcon + ' ' }), st.label), 'st-kpi--tsb'),
      tile('FTP actual', D.curFtp ? fmtNum(D.curFtp, 0) : '–', 'W', h('span', null, ftpExtra, wkg ? h('span', { class: 'st-delta st-delta--flat', text: ' · ' + wkg }) : null)));
  }

  // ---------- PMC ----------
  function pmcCard(D) {
    var rows = L.bucketPmc(D.pmc, 600);
    var bucketed = rows.length < D.pmc.length;
    var labels = rows.map(function (r) { return r.date; });
    var card = chartCard({ title: 'Forma, fatiga y frescura (PMC)', sub: 'CTL = forma (42 días), ATL = fatiga (7 días), TSB = forma − fatiga del día anterior', height: 320, span: 2,
      alt: 'Gráfica de forma CTL, fatiga ATL, frescura TSB y TSS diario en el período seleccionado',
      foot: bucketed ? 'Para mantener la gráfica ágil se agrupan días consecutivos (TSS sumado, líneas al cierre de cada grupo).' : null,
      table: function () { return { head: ['Fecha', 'TSS', 'CTL', 'ATL', 'TSB'], rows: rows.slice().reverse().map(function (r) { return [r.date, fmtNum(r.tss, 0), fmtNum(r.ctl, 1), fmtNum(r.atl, 1), fmtNum(r.tsb, 1)]; }) }; } });
    if (!hasChart()) return card;
    var bands = { id: 'tsbBands', beforeDatasetsDraw: function (chart) {
      var y = chart.scales.y, ca = chart.chartArea, ctx = chart.ctx;
      var edges = [{ v: 5, l: 'Fresco' }, { v: -10, l: 'Óptimo' }, { v: -30, l: 'Cargado' }];
      ctx.save();
      var zones = [[5, 1e9, 'Fresco'], [-10, 5, 'Óptimo'], [-30, -10, 'Cargado'], [-1e9, -30, 'Sobrecarga']];
      zones.forEach(function (z, i) {
        var top = Math.max(ca.top, y.getPixelForValue(Math.min(z[1], y.max))), bot = Math.min(ca.bottom, y.getPixelForValue(Math.max(z[0], y.min)));
        if (bot <= top) return;
        ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.05)'; ctx.fillRect(ca.left, top, ca.right - ca.left, bot - top);
        ctx.fillStyle = 'rgba(170,176,187,0.75)'; ctx.font = '10px Inter, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
        ctx.fillText(z[2].toUpperCase(), ca.right - 6, top + 4);
      });
      ctx.restore();
    } };
    var ds = [
      { type: 'bar', label: 'TSS diario', data: rows.map(function (r) { return r.tss; }), backgroundColor: 'rgba(125,133,144,0.55)', borderRadius: 2, maxBarThickness: 3, barPercentage: 1, categoryPercentage: 1, order: 4 },
      { type: 'line', label: 'Frescura (TSB)', data: rows.map(function (r) { return r.tsb; }), borderColor: C.tsb, borderWidth: 1.5, backgroundColor: 'rgba(201,204,211,0.14)', fill: 'origin', pointRadius: 0, pointHoverRadius: 5, tension: 0.25, order: 3 },
      { type: 'line', label: 'Fatiga (ATL)', data: rows.map(function (r) { return r.atl; }), borderColor: C.atl, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: C.atl, pointHoverBorderColor: C.surface, pointHoverBorderWidth: 2, tension: 0.25, order: 2 },
      { type: 'line', label: 'Forma (CTL)', data: rows.map(function (r) { return r.ctl; }), borderColor: C.ctl, borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: C.ctl, pointHoverBorderColor: C.surface, pointHoverBorderWidth: 2, tension: 0.25, order: 1 },
    ];
    var ch = mkChart(card.canvas, { data: { labels: labels, datasets: ds }, plugins: [bands, crosshair], options: {
      interaction: { mode: 'index', intersect: false },
      scales: { x: axisX({ ticks: { color: C.ink3, maxRotation: 0, maxTicksLimit: 8, callback: function (v) { return L.dayLabel(labels[v]); } } }), y: axisY({ title: { display: true, text: 'Puntos de TSS', color: C.ink3 } }) },
      plugins: { legend: { display: false }, crosshair: true, tooltip: tipStyle({ callbacks: {
        title: function (items) { return L.dayLabelYear(labels[items[0].dataIndex]); },
        label: function (c) { return ' ' + fmtNum(c.parsed.y, c.dataset.label === 'TSS diario' ? 0 : 1) + '   ' + c.dataset.label; },
        footer: function (items) { return L.tsbState(rows[items[0].dataIndex].tsb).label; } } }) } } });
    var map = [3, 2, 1, 0];
    [['Forma (CTL)', C.ctl, 'line', 3], ['Fatiga (ATL)', C.atl, 'line', 2], ['Frescura (TSB)', C.tsb, 'line', 1], ['TSS diario', '#7d8590', 'bar', 0]].forEach(function (it) {
      card.legend.appendChild(legendItem(it[0], it[1], it[2], false, function (on) { ch.setDatasetVisibility(it[3], on); ch.update(); }));
    });
    return card;
  }

  // ---------- semanas ----------
  function weeklyCard(D) {
    var weeks = L.weeklyAggregate(D.inP, D.range, D.ftpOf);
    var two = h('div', { class: 'st-split' });
    var c1 = chartCard({ title: 'Horas por semana, por zona', sub: 'Tiempo en cada zona de potencia (zonas Coggan)', height: 250,
      alt: 'Barras apiladas de horas semanales por zona de potencia',
      table: function () { return { head: ['Semana del', 'Horas'].concat(L.ZONE_NAMES.map(function (n, i) { return 'Z' + (i + 1) + ' (h)'; })), rows: weeks.map(function (w) { return [w.label, fmtNum(w.hours, 1)].concat(w.zoneS.map(function (s) { return fmtNum(s / 3600, 1); })); }) }; } });
    var c2 = chartCard({ title: 'TSS por semana', sub: 'Carga total de cada semana', height: 250, alt: 'Barras de TSS semanal',
      table: function () { return { head: ['Semana del', 'TSS', 'Sesiones'], rows: weeks.map(function (w) { return [w.label, fmtNum(w.tss, 0), w.sessions]; }) }; } });
    if (hasChart()) {
      var labels = weeks.map(function (w) { return w.label; });
      var ds = L.ZONE_NAMES.map(function (n, i) { return { label: 'Z' + (i + 1) + ' ' + n, data: weeks.map(function (w) { return w.zoneS[i] / 3600; }), backgroundColor: L.ZONE_COLORS[i], borderColor: C.surface, borderWidth: 1, borderRadius: 0, stack: 's' }; });
      var ch1 = mkChart(c1.canvas, { type: 'bar', data: { labels: labels, datasets: ds }, options: {
        interaction: { mode: 'index', intersect: false },
        scales: { x: axisX({ stacked: true, title: { display: true, text: 'Semana (inicia el lunes)', color: C.ink3 } }), y: axisY({ stacked: true, title: { display: true, text: 'Horas', color: C.ink3 } }) },
        plugins: { legend: { display: false }, tooltip: tipStyle({ itemSort: function (a, b) { return b.datasetIndex - a.datasetIndex; }, callbacks: {
          title: function (it) { return 'Semana del ' + weeks[it[0].dataIndex].label; },
          label: function (c) { return c.parsed.y > 0 ? ' ' + fmtNum(c.parsed.y, 1) + ' h   ' + c.dataset.label : null; },
          footer: function (it) { var w = weeks[it[0].dataIndex]; return fmtNum(w.hours, 1) + ' h · ' + fmtNum(w.tss, 0) + ' TSS · ' + w.sessions + ' sesiones'; } } }) } } });
      L.ZONE_NAMES.forEach(function (n, i) { c1.legend.appendChild(legendItem('Z' + (i + 1), L.ZONE_COLORS[i], 'bar', false, function (on) { ch1.setDatasetVisibility(i, on); ch1.update(); })); });
      mkChart(c2.canvas, { type: 'bar', data: { labels: labels, datasets: [{ label: 'TSS', data: weeks.map(function (w) { return w.tss; }), backgroundColor: C.accent, borderRadius: { topLeft: 4, topRight: 4 }, maxBarThickness: 36 }] }, options: {
        scales: { x: axisX({ title: { display: true, text: 'Semana (inicia el lunes)', color: C.ink3 } }), y: axisY({ beginAtZero: true, title: { display: true, text: 'TSS', color: C.ink3 } }) },
        plugins: { legend: { display: false }, tooltip: tipStyle({ callbacks: {
          title: function (it) { return 'Semana del ' + weeks[it[0].dataIndex].label; },
          label: function (c) { return ' ' + fmtNum(c.parsed.y, 0) + ' TSS'; },
          footer: function (it) { var w = weeks[it[0].dataIndex]; return fmtNum(w.hours, 1) + ' h · ' + w.sessions + ' sesiones'; } } }) } } });
    }
    two.appendChild(c1.el); two.appendChild(c2.el);
    return { el: two, init: function () { c1.init(); c2.init(); } , _wrap: true };
  }

  // ---------- curva de potencia ----------
  function curveCard(D) {
    var cmp = L.powerCurveCompare(D.inP, D.acts, L.DEFAULT_DURATIONS, D.profile.weightKg);
    var card = chartCard({ title: 'Curva de potencia', sub: 'Mejor potencia media para cada duración: ' + D.range.label.toLowerCase() + ' frente a tu mejor marca histórica', height: 290, span: 2,
      alt: 'Curva de potencia con eje de duración logarítmico, período frente a mejor histórico',
      table: function () { return { head: ['Duración', 'Período (W)', 'Mejor histórico (W)', 'W/kg histórico', 'Fecha de la marca'], rows: cmp.map(function (r) { return [fmtDurShort(r.durationS), r.period, r.best, r.bestWkg != null ? fmtNum(r.bestWkg, 2) : null, r.bestDate ? L.dayLabelYear(L.localDate(r.bestDate)) : null]; }) }; } });
    if (!hasChart()) return card;
    var pts = function (k) { return cmp.filter(function (r) { return r[k] != null; }).map(function (r) { return { x: r.durationS, y: r[k], r: r }; }); };
    var endLabels = { id: 'endLabels', afterDatasetsDraw: function (chart) {
      var ctx = chart.ctx; ctx.save(); ctx.font = '600 11px Inter, sans-serif'; ctx.textBaseline = 'middle'; ctx.fillStyle = C.ink2;
      chart.data.datasets.forEach(function (d, i) {
        if (!chart.isDatasetVisible(i) || !d.data.length) return;
        var m = chart.getDatasetMeta(i), e = m.data[0]; if (!e) return;
        ctx.textAlign = 'left'; ctx.fillText(d.data[0].y + ' W', e.x + 8, e.y - 10);
      });
      ctx.restore();
    } };
    var ch = mkChart(card.canvas, { type: 'line', data: { datasets: [
      { label: 'Mejor histórico', data: pts('best'), borderColor: C.gold, borderWidth: 2, borderDash: [6, 4], order: 1, pointRadius: 4, pointBackgroundColor: C.gold, pointBorderColor: C.surface, pointBorderWidth: 2, pointHoverRadius: 7, tension: 0.2 },
      { label: 'Período (' + D.range.label.toLowerCase() + ')', data: pts('period'), borderColor: C.accent, borderWidth: 2.5, order: 0, pointRadius: 4, pointBackgroundColor: C.accent, pointBorderColor: C.surface, pointBorderWidth: 2, pointHoverRadius: 7, tension: 0.2 },
    ] }, plugins: [crosshair], options: {
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: { x: axisX({ type: 'logarithmic', min: 1, max: 3600, afterBuildTicks: function (ax) { ax.ticks = [1, 5, 15, 30, 60, 300, 1200, 3600].map(function (v) { return { value: v }; }); },
        ticks: { color: C.ink3, callback: function (v) { return fmtDurShort(v); }, maxRotation: 0 }, title: { display: true, text: 'Duración (escala logarítmica)', color: C.ink3 } }),
        y: axisY({ beginAtZero: false, title: { display: true, text: 'Vatios (W)', color: C.ink3 } }) },
      plugins: { legend: { display: false }, crosshair: true, tooltip: tipStyle({ callbacks: {
        title: function (it) { return fmtDurShort(it[0].raw.x); },
        label: function (c) { var r = c.raw.r, isBest = c.datasetIndex === 0, date = isBest ? r.bestDate : r.periodDate, wkg = isBest ? r.bestWkg : r.periodWkg;
          return ' ' + c.raw.y + ' W' + (wkg != null ? ' · ' + fmtNum(wkg, 2) + ' W/kg' : '') + '   ' + (isBest ? 'Mejor histórico' : 'Período') + (date ? ' · ' + L.dayLabelYear(L.localDate(date)) : ''); } } }) } } });
    ch.options.plugins.legend.display = false;
    [['Mejor histórico', C.gold, 0, true], ['Período', C.accent, 1, false]].forEach(function (it) {
      card.legend.appendChild(legendItem(it[0], it[1], 'line', it[3], function (on) { ch.setDatasetVisibility(it[2], on); ch.update(); }));
    });
    return card;
  }

  // ---------- FTP ----------
  function ftpCard(D) {
    var hist = D.hist, w = D.profile.weightKg;
    var card = chartCard({ title: 'Evolución del FTP', sub: 'Estimado con tus tests (rampa 75 % del mejor minuto; 20 min 95 % de la media) y tu FTP actual', height: 250, alt: 'Línea de FTP en vatios a lo largo del tiempo',
      foot: w > 0 ? 'W/kg calculado con tu peso actual (' + fmtNum(w, 1) + ' kg).' : 'Registra tu peso en el perfil para ver W/kg.',
      table: function () { return { head: ['Fecha', 'FTP (W)', 'W/kg', 'Origen'], rows: hist.map(function (p) { return [L.dayLabelYear(p.date), p.ftp, w > 0 ? fmtNum(p.ftp / w, 2) : null, p.source]; }) }; } });
    if (hist.length < 2) {
      card.wrap.hidden = true; card.legend.hidden = true;
      card.el.insertBefore(h('p', { class: 'st-empty-note', text: hist.length ? 'Tu FTP actual es ' + hist[0].ftp + ' W. Haz un test de rampa o de 20 minutos para ver cómo evoluciona.' : 'Aún no hay datos de FTP. Haz un test de rampa o de 20 minutos para empezar a medir tu evolución.' }), card.wrap);
      var b = card.el.querySelector('.st-chip'); if (b) b.hidden = true;
      return { el: card.el };
    }
    var data = hist.map(function (p) { return { x: L.parseDate(p.date).getTime(), y: p.ftp, p: p }; });
    mkChart(card.canvas, { type: 'line', data: { datasets: [{ label: 'FTP', data: data, borderColor: C.accent, borderWidth: 2.5, stepped: false, pointRadius: 5, pointHoverRadius: 8, pointBackgroundColor: C.accent, pointBorderColor: C.surface, pointBorderWidth: 2, tension: 0.15 }] },
      plugins: [crosshair], options: {
        interaction: { mode: 'nearest', intersect: false, axis: 'x' },
        scales: { x: axisX({ type: 'linear', ticks: { color: C.ink3, maxTicksLimit: 6, callback: function (v) { return L.dayLabel(L.fmtDate(new Date(v))); } } }),
          y: axisY({ suggestedMin: Math.min.apply(null, hist.map(function (p) { return p.ftp; })) - 15, suggestedMax: Math.max.apply(null, hist.map(function (p) { return p.ftp; })) + 15, title: { display: true, text: 'FTP (W)', color: C.ink3 } }) },
        plugins: { legend: { display: false }, crosshair: true, tooltip: tipStyle({ callbacks: {
          title: function (it) { return L.dayLabelYear(it[0].raw.p.date); },
          label: function (c) { var p = c.raw.p; return ' ' + p.ftp + ' W' + (w > 0 ? ' · ' + fmtNum(p.ftp / w, 2) + ' W/kg' : '') + '   ' + p.source; } } }) } } });
    return card;
  }

  // ---------- zonas ----------
  function zonesCard(D) {
    var z = L.totalZones(D.inP, D.ftpOf), tot = z.reduce(function (a, b) { return a + b; }, 0);
    var labels = L.ZONE_NAMES.map(function (n, i) { return 'Z' + (i + 1) + ' ' + n; });
    var card = chartCard({ title: 'Tiempo en zonas', sub: 'Distribución de tu tiempo pedaleado en el período', height: 250, alt: 'Barras horizontales de horas por zona de potencia',
      table: function () { return { head: ['Zona', 'Horas', '% del tiempo'], rows: z.map(function (s, i) { return [labels[i], fmtNum(s / 3600, 1), tot ? fmtNum(s / tot * 100, 0) + ' %' : '0 %']; }) }; } });
    if (!hasChart()) return card;
    var valueLabels = { id: 'valueLabels', afterDatasetsDraw: function (chart) {
      var ctx = chart.ctx, m = chart.getDatasetMeta(0); ctx.save(); ctx.font = '600 11px Inter, sans-serif'; ctx.fillStyle = C.ink; ctx.textBaseline = 'middle';
      m.data.forEach(function (bar, i) { ctx.fillText(fmtNum(z[i] / 3600, 1) + ' h · ' + (tot ? fmtNum(z[i] / tot * 100, 0) : 0) + ' %', bar.x + 8, bar.y); });
      ctx.restore();
    } };
    mkChart(card.canvas, { type: 'bar', data: { labels: labels, datasets: [{ label: 'Horas', data: z.map(function (s) { return s / 3600; }), backgroundColor: L.ZONE_COLORS, borderRadius: 4, barThickness: 20 }] }, plugins: [valueLabels], options: {
      indexAxis: 'y', layout: { padding: { right: 78 } },
      scales: { x: axisY({ beginAtZero: true, title: { display: true, text: 'Horas', color: C.ink3 } }), y: { grid: { display: false }, border: { display: false }, ticks: { color: C.ink2 } } },
      plugins: { legend: { display: false }, tooltip: tipStyle({ displayColors: false, callbacks: {
        label: function (c) { return ' ' + fmtNum(c.parsed.x, 1) + ' h · ' + (tot ? fmtNum(z[c.dataIndex] / tot * 100, 0) : 0) + ' % del tiempo'; },
        afterLabel: function (c) { var zz = R.training.zones(D.curFtp || 200)[c.dataIndex]; return zz ? ' ' + zz.minW + (zz.maxW != null ? '–' + zz.maxW : '+') + ' W (con FTP ' + (D.curFtp || 200) + ' W)' : ''; } } }) } } });
    return card;
  }

  // ---------- récords por ruta ----------
  function recordsCard(D) {
    var recs = L.routeRecords(D.acts, D.bests, routeLookup);
    var card = h('section', { class: 'st-card st-span-2' });
    card.appendChild(h('header', { class: 'st-card-head' }, h('div', null, h('h3', { text: 'Récords por ruta' }), h('p', { class: 'st-sub', text: 'Tu mejor marca en cada ruta y cuánto has mejorado. Toca una ruta para superarte a ti mismo.' }))));
    if (!recs.length) { card.appendChild(h('p', { class: 'st-empty-note', text: 'Todavía no completas ninguna ruta. Cuando lo hagas, tu mejor marca aparecerá aquí.' })); return { el: card }; }
    var detail = h('div', { class: 'st-route-detail' });
    var rows = recs.map(function (r) {
      var imp = r.improvementS;
      var tr = h('tr', { tabindex: '0', role: 'button', 'aria-label': 'Ver detalle de ' + r.name, 'data-route': r.routeId, class: prefs.route === r.routeId ? 'is-selected' : '' },
        h('th', { scope: 'row', text: r.name }), h('td', { class: 'num', text: fmtDur(r.best.timeS) }), h('td', { text: r.best.date ? L.dayLabelYear(L.localDate(r.best.date)) : '–' }),
        h('td', { class: 'num', text: String(r.attempts) }),
        h('td', { class: 'num' }, r.attempts < 2 ? h('span', { class: 'st-delta st-delta--flat', text: 'Primer intento' }) : h('span', { class: 'st-delta st-delta--' + (imp > 0 ? 'up' : 'flat') }, (imp > 0 ? '▼ ' : '● ') + (imp > 0 ? fmtDur(imp) + ' más rápido' : 'Igual que el primero'))));
      function open() { prefs.route = r.routeId; Array.prototype.forEach.call(tr.parentNode.children, function (x) { x.classList.toggle('is-selected', x === tr); }); renderRouteDetail(detail, r, D); }
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      tr._open = open;
      return tr;
    });
    card.appendChild(h('div', { class: 'st-table-scroll' }, h('table', { class: 'st-table st-table--click' },
      h('thead', null, h('tr', null, ['Ruta', 'Mejor tiempo', 'Fecha', 'Intentos', 'vs primer intento'].map(function (t) { return h('th', { scope: 'col', text: t }); }))), h('tbody', null, rows))));
    card.appendChild(detail);
    var sel = rows.filter(function (tr) { return tr.getAttribute('data-route') === prefs.route; })[0];
    return { el: card, init: function () { if (sel) sel._open(); } };
  }

  function actById(D, id) { return D.acts.filter(function (a) { return a.id === id; })[0] || null; }

  function renderRouteDetail(box, rec, D) {
    // destruye gráficos previos de esta sección
    (box._charts || []).forEach(function (c) { var i = S.charts.indexOf(c); if (i >= 0) S.charts.splice(i, 1); try { c.destroy(); } catch (e) { /* noop */ } });
    box._charts = [];
    while (box.firstChild) box.removeChild(box.firstChild);
    var bestAct = actById(D, rec.best.activityId);
    var cmp = L.pickComparison(rec.list, rec.best.activityId);
    var route = routeLookup(rec.routeId);
    var bestSplits = D.bests[rec.routeId] && D.bests[rec.routeId].activityId === rec.best.activityId ? D.bests[rec.routeId].splits : (bestAct ? L.splitsFromSamples(bestAct.samples, 100) : []);
    box.appendChild(h('h4', { text: rec.name + ' · ' + fmtNum((route ? route.distanceM : rec.distanceM) / 1000, 1) + ' km' }));
    var stats = h('div', { class: 'st-mini-stats' },
      h('div', null, h('span', { text: 'Mejor tiempo' }), h('b', { text: fmtDur(rec.best.timeS) })),
      h('div', null, h('span', { text: 'Primer intento' }), h('b', { text: fmtDur(rec.first.timeS) })),
      h('div', null, h('span', { text: 'Último intento' }), h('b', { text: fmtDur(rec.last.timeS) })),
      h('div', null, h('span', { text: 'Intentos' }), h('b', { text: String(rec.attempts) })));
    box.appendChild(stats);
    if (!cmp) {
      box.appendChild(h('p', { class: 'st-empty-note', text: 'Es tu único intento por ahora. Repite esta ruta: la gráfica comparará cada kilómetro contra tu mejor marca para que puedas superarte.' }));
    } else {
      var cmpAct = cmp.act, diff = L.diffSplits(bestSplits, L.splitsFromSamples(cmpAct.samples, 100), 1000);
      var fin = diff[diff.length - 1].diffS;
      var isLast = cmp.id === rec.last.id;
      box.appendChild(h('p', { class: 'st-sub', text: 'Mejor intento frente a ' + (isLast ? 'tu último intento' : 'el intento anterior') + ' (' + L.dayLabelYear(L.localDate(cmp.date)) + '): ' + fmtSignedDur(fin) + ' al final. Por debajo de 0 vas más rápido que tu mejor marca; por encima, más lento.' }));
      var diffCard = chartCard({ title: 'Diferencia acumulada por kilómetro', height: 210, alt: 'Diferencia acumulada en segundos entre el intento comparado y tu mejor marca, por kilómetro',
        table: function () { return { head: ['Km', 'Diferencia (s)'], rows: diff.map(function (d) { return [fmtNum(d.distM / 1000, 1), fmtSigned(d.diffS, 1)]; }) }; } });
      var eleCard = { canvas: h('canvas', { role: 'img', 'aria-label': 'Perfil de elevación de la ruta' }) };
      var eleWrap = h('div', { class: 'st-chart', style: 'height:110px' }, eleCard.canvas);
      if (hasChart()) {
        var pro;
        if (route && R.routes && R.routes.profile && route.points) pro = R.routes.profile(route, 120).map(function (p) { return { x: p.distM / 1000, y: p.ele }; });
        else if (bestAct) pro = L.decimateSeries(bestAct.samples.filter(function (s) { return s[6] != null; }), 120, 5, 6).map(function (p) { return { x: p.x / 1000, y: p.y }; });
        else pro = [];
        var fixW = function (sc) { sc.afterFit = function (s) { s.width = 58; }; return sc; };
        var xr = { min: 0, max: diff[diff.length - 1].distM / 1000 };
        var c1 = mkChart(eleCard.canvas, { type: 'line', data: { datasets: [{ label: 'Elevación', data: pro, borderColor: C.ink3, borderWidth: 1.5, backgroundColor: 'rgba(125,133,144,0.2)', fill: 'start', pointRadius: 0, tension: 0.2 }] }, options: {
          layout: { padding: { right: 10 } },
          scales: { x: axisX({ type: 'linear', min: xr.min, max: xr.max, display: false }), y: fixW(axisY({ beginAtZero: false, grace: '10%', ticks: { color: C.ink3, maxTicksLimit: 3 }, title: { display: true, text: 'm', color: C.ink3 } })) },
          plugins: { legend: { display: false }, tooltip: { enabled: false } } } });
        var c2 = mkChart(diffCard.canvas, { type: 'line', data: { datasets: [{ label: 'Diferencia', data: diff.map(function (d) { return { x: d.distM / 1000, y: d.diffS }; }), borderColor: C.orange, borderWidth: 2.5, pointRadius: 4, pointHoverRadius: 7, pointBackgroundColor: function (c) { return c.raw && c.raw.y <= 0 ? C.blue : C.orange; }, pointBorderColor: C.surface, pointBorderWidth: 2,
          segment: { borderColor: function (c) { return (c.p0.parsed.y + c.p1.parsed.y) / 2 <= 0 ? C.blue : C.orange; } }, fill: { target: 'origin', above: 'rgba(217,89,38,0.16)', below: 'rgba(57,135,229,0.16)' }, tension: 0 }] }, plugins: [crosshair], options: {
          layout: { padding: { right: 10 } },
          interaction: { mode: 'nearest', axis: 'x', intersect: false },
          scales: { x: axisX({ type: 'linear', min: xr.min, max: xr.max, ticks: { color: C.ink3, callback: function (v) { return fmtNum(v, 0) + ' km'; } } }), y: fixW(axisY({ title: { display: true, text: 's', color: C.ink3 } })) },
          plugins: { legend: { display: false }, crosshair: true, tooltip: tipStyle({ displayColors: false, callbacks: {
            title: function (it) { return 'Km ' + fmtNum(it[0].parsed.x, 1); },
            label: function (c) { var v = c.parsed.y; return ' ' + fmtSignedDur(v) + (v <= 0 ? '  más rápido que tu mejor marca' : '  más lento que tu mejor marca'); } } }) } } });
        box._charts.push(c1, c2);
        box.appendChild(eleWrap);
      }
      box.appendChild(diffCard.el); diffCard.init();
    }
    if (bestAct) box.appendChild(h('div', { class: 'st-row-actions' }, h('button', { class: 'st-btn', type: 'button', text: 'Ver detalle del mejor intento', onclick: function () { openActivity(bestAct); } })));
  }

  // ---------- historial ----------
  function historyCard(D) {
    var card = h('section', { class: 'st-card st-span-2' });
    var listBox = h('div', { class: 'st-hist' });
    var f = prefs.hist;
    var typeSel = h('select', { 'aria-label': 'Filtrar por tipo', class: 'st-input', onchange: function () { f.type = typeSel.value; f.limit = 25; paint(); } },
      [['all', 'Todas'], ['workout', 'Entrenamientos'], ['route', 'Rutas'], ['free', 'Libres']].map(function (o) { return h('option', { value: o[0], text: o[1], selected: f.type === o[0] }); }));
    var q = h('input', { type: 'search', class: 'st-input', placeholder: 'Buscar por nombre', 'aria-label': 'Buscar actividades', value: f.q, oninput: function () { f.q = q.value; f.limit = 25; paint(); } });
    card.appendChild(h('header', { class: 'st-card-head' }, h('div', null, h('h3', { text: 'Historial de rodadas' }), h('p', { class: 'st-sub', text: 'Toca una rodada para ver su detalle' })), h('div', { class: 'st-filters' }, typeSel, q)));
    card.appendChild(listBox);
    function paint() {
      while (listBox.firstChild) listBox.removeChild(listBox.firstChild);
      var all = L.filterHistory(D.acts, f), shown = all.slice(0, f.limit);
      if (!shown.length) { listBox.appendChild(h('p', { class: 'st-empty-note', text: 'Ninguna rodada coincide con los filtros.' })); return; }
      var ul = h('ul', { class: 'st-hist-list' });
      shown.forEach(function (a) {
        ul.appendChild(h('li', null, h('button', { type: 'button', class: 'st-hist-row', onclick: function () { openActivity(a); }, 'aria-label': 'Abrir ' + a.name + ', ' + L.dayLabelYear(L.localDate(a.date)) },
          h('span', { class: 'st-hist-date', text: L.dayLabelYear(L.localDate(a.date)) }),
          h('span', { class: 'st-hist-name' }, h('b', { text: a.name }), a.demo ? h('em', { class: 'st-tag', text: 'ejemplo' }) : null, h('small', { text: ({ workout: 'Entrenamiento', route: 'Ruta', free: 'Libre' })[a.type] || '' })),
          h('span', { class: 'st-hist-m' }, h('b', { text: fmtDur(a.durationS) }), h('small', { text: 'duración' })),
          h('span', { class: 'st-hist-m st-hide-s' }, h('b', { text: fmtNum((a.distanceM || 0) / 1000, 1) }), h('small', { text: 'km' })),
          h('span', { class: 'st-hist-m' }, h('b', { text: fmtNum(a.avgPower, 0) }), h('small', { text: 'W medios' })),
          h('span', { class: 'st-hist-m' }, h('b', { text: fmtNum(a.tss, 0) }), h('small', { text: 'TSS' })))));
      });
      listBox.appendChild(ul);
      if (all.length > shown.length) listBox.appendChild(h('button', { class: 'st-btn st-btn--ghost', type: 'button', text: 'Mostrar más (' + (all.length - shown.length) + ')', onclick: function () { f.limit += 25; paint(); } }));
    }
    paint();
    return { el: card };
  }

  // ---------- detalle de actividad ----------
  function openActivity(a) {
    var D = S.D, m = openModal({ title: a.name + ' · ' + L.dayLabelYear(L.localDate(a.date)), wide: true });
    var box = m.el, charts = [];
    var metrics = [['Duración', fmtDur(a.durationS)], ['Distancia', fmtNum((a.distanceM || 0) / 1000, 1) + ' km'], ['Potencia media', fmtNum(a.avgPower, 0) + ' W'], ['Potencia normalizada', fmtNum(a.np, 0) + ' W'],
      ['IF', fmtNum(a.if, 2)], ['TSS', fmtNum(a.tss, 0)], ['FC media', a.avgHr ? fmtNum(a.avgHr, 0) + ' ppm' : '–'], ['Cadencia media', a.avgCadence ? fmtNum(a.avgCadence, 0) + ' rpm' : '–'],
      ['Energía', fmtNum((a.avgPower || 0) * (a.durationS || 0) / 1000, 0) + ' kJ'], ['RPE', a.rpe != null ? a.rpe + ' / 10' : '–']];
    box.appendChild(h('div', { class: 'st-metrics' }, metrics.map(function (x) { return h('div', null, h('span', { text: x[0] }), h('b', { text: x[1] })); })));
    var samples = a.samples || [];
    if (samples.length > 2 && hasChart()) {
      var tMax = samples[samples.length - 1][0], zoom = { min: 0, max: tMax };
      var wrapEl = h('div', { class: 'st-detail-charts' });
      var info = h('p', { class: 'st-sub', text: 'Arrastra sobre una gráfica para ampliar un tramo, usa la rueda para acercar o alejar y doble clic para restablecer.' });
      var resetBtn = h('button', { class: 'st-btn st-btn--ghost', type: 'button', text: 'Restablecer zoom', onclick: function () { setZoom(0, tMax); } });
      var zin = h('button', { class: 'st-icon-btn', type: 'button', 'aria-label': 'Acercar', text: '+', onclick: function () { zoomBy(0.5); } });
      var zout = h('button', { class: 'st-icon-btn', type: 'button', 'aria-label': 'Alejar', text: '−', onclick: function () { zoomBy(2); } });
      box.appendChild(h('div', { class: 'st-detail-bar' }, info, h('div', { class: 'st-zoom-btns' }, zout, zin, resetBtn)));
      box.appendChild(wrapEl);
      var series = [{ key: 'Potencia', idx: 1, color: C.accent, unit: 'W', h: 190 }, { key: 'Frecuencia cardíaca', idx: 2, color: C.hr, unit: 'ppm', h: 130 }, { key: 'Cadencia', idx: 3, color: C.cad, unit: 'rpm', h: 130 }]
        .filter(function (s) { return samples.some(function (r) { return r[s.idx] != null && r[s.idx] > 0; }); });
      var sel = null;
      var selPlugin = { id: 'sel', afterDraw: function (chart) { if (!sel || sel.chart !== chart) return; var ca = chart.chartArea, ctx = chart.ctx; ctx.save(); ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(Math.min(sel.x0, sel.x1), ca.top, Math.abs(sel.x1 - sel.x0), ca.bottom - ca.top); ctx.restore(); } };
      var ftpLine = D.ftpOf(L.localDate(a.date));
      var win = function (idx) { // ventana actual, diezmada a ≤ 600 puntos
        var rows = samples.filter(function (r) { return r[0] >= zoom.min && r[0] <= zoom.max; });
        return L.decimateSeries(rows, 600, 0, idx);
      };
      series.forEach(function (s, si) {
        var card = h('div', { class: 'st-mini-chart' }, h('span', { class: 'st-mini-title', text: s.key + ' (' + s.unit + ')' }), h('div', { class: 'st-chart', style: 'height:' + s.h + 'px' }));
        var canvas = h('canvas', { role: 'img', 'aria-label': s.key + ' a lo largo de la actividad' });
        card.lastChild.appendChild(canvas); wrapEl.appendChild(card);
        var ds = [{ label: s.key, data: win(s.idx), borderColor: s.color, borderWidth: 1.75, pointRadius: 0, pointHoverRadius: 4, tension: 0.15, fill: s.idx === 1 ? 'origin' : false, backgroundColor: 'rgba(255,90,31,0.1)', spanGaps: true }];
        var ch = mkChart(canvas, { type: 'line', data: { datasets: ds }, plugins: [crosshair, selPlugin], options: {
          animation: false, interaction: { mode: 'nearest', axis: 'x', intersect: false },
          scales: { x: axisX({ type: 'linear', min: 0, max: tMax, ticks: { color: C.ink3, maxTicksLimit: 8, callback: function (v) { return fmtDur(v); } }, display: si === series.length - 1 }),
            y: axisY({ beginAtZero: s.idx !== 2, suggestedMin: s.idx === 2 ? undefined : 0, title: { display: false }, afterFit: function (sc) { sc.width = 48; } }) },
          plugins: { legend: { display: false }, crosshair: true, tooltip: tipStyle({ displayColors: false, callbacks: { title: function (it) { return fmtDur(it[0].parsed.x); }, label: function (c) { return ' ' + fmtNum(c.parsed.y, 0) + ' ' + s.unit + '   ' + s.key; } } }) } } });
        charts.push(ch);
        if (s.idx === 1 && ftpLine) {
          ch.options.plugins.ftpMark = true;
          ch.config.plugins.push({ id: 'ftpLine', afterDatasetsDraw: function (c) { var y = c.scales.y, ca = c.chartArea, yy = y.getPixelForValue(ftpLine); if (yy < ca.top || yy > ca.bottom) return; var x = c.ctx; x.save(); x.strokeStyle = 'rgba(255,210,63,0.7)'; x.setLineDash([5, 4]); x.beginPath(); x.moveTo(ca.left, yy); x.lineTo(ca.right, yy); x.stroke(); x.fillStyle = C.gold; x.font = '600 10px Inter, sans-serif'; x.textAlign = 'right'; x.fillText('FTP ' + ftpLine + ' W', ca.right - 4, yy - 4); x.restore(); } });
        }
        // selección por arrastre + rueda + doble clic
        var px = function (ev) { var r = canvas.getBoundingClientRect(); return ev.clientX - r.left; };
        canvas.style.touchAction = 'pan-y';
        canvas.addEventListener('pointerdown', function (ev) { var x = px(ev), ca = ch.chartArea; if (x < ca.left || x > ca.right) return; sel = { chart: ch, x0: x, x1: x }; try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* noop */ } });
        canvas.addEventListener('pointermove', function (ev) { if (!sel || sel.chart !== ch) return; sel.x1 = clamp(px(ev), ch.chartArea.left, ch.chartArea.right); ch.draw(); });
        canvas.addEventListener('pointerup', function () { if (!sel || sel.chart !== ch) return; var s0 = sel; sel = null; if (Math.abs(s0.x1 - s0.x0) > 8) { var xs = ch.scales.x, a0 = xs.getValueForPixel(Math.min(s0.x0, s0.x1)), a1 = xs.getValueForPixel(Math.max(s0.x0, s0.x1)); setZoom(a0, a1); } else ch.draw(); });
        canvas.addEventListener('dblclick', function () { setZoom(0, tMax); });
        canvas.addEventListener('wheel', function (ev) { ev.preventDefault(); var xs = ch.scales.x, c = xs.getValueForPixel(px(ev)), f = ev.deltaY < 0 ? 0.8 : 1.25; setZoom(c - (c - zoom.min) * f, c + (zoom.max - c) * f); }, { passive: false });
      });
      function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }
      function setZoom(a0, a1) {
        var span = Math.max(20, a1 - a0); a0 = clamp(a0, 0, Math.max(0, tMax - span)); a1 = Math.min(tMax, a0 + span);
        if (a1 - a0 >= tMax - 1) { a0 = 0; a1 = tMax; }
        zoom = { min: a0, max: a1 };
        charts.forEach(function (c, i) { c.options.scales.x.min = a0; c.options.scales.x.max = a1; c.data.datasets[0].data = win(series[i].idx); c.update('none'); });
        resetBtn.disabled = a0 === 0 && a1 === tMax;
      }
      function zoomBy(f) { var c = (zoom.min + zoom.max) / 2, half = (zoom.max - zoom.min) / 2 * f; setZoom(c - half, c + half); }
      resetBtn.disabled = true;
      m.onClose = function () { charts.forEach(function (c) { var i = S && S.charts.indexOf(c); if (i >= 0) S.charts.splice(i, 1); try { c.destroy(); } catch (e) { /* noop */ } }); };
    } else if (samples.length <= 2) {
      box.appendChild(h('p', { class: 'st-empty-note', text: 'Esta rodada no conserva datos segundo a segundo.' }));
    }
    var actions = h('div', { class: 'st-modal-actions' },
      h('button', { class: 'st-btn', type: 'button', text: 'Exportar TCX', onclick: function () { exportTcx(a, m); } }),
      h('button', { class: 'st-btn st-btn--danger', type: 'button', text: 'Borrar rodada', onclick: function () { confirmDelete(a, m); } }));
    box.appendChild(actions);
  }

  function exportTcx(a, parent) {
    var tcx;
    try { tcx = R.integrations.toTCX(a, S.D.profile); } catch (e) { toast('No se pudo generar el archivo TCX', 'error'); return; }
    var fname = 'rodillator-' + L.localDate(a.date) + '.tcx';
    Promise.resolve(R.integrations.saveFile({ filename: fname, data: tcx, mime: 'application/vnd.garmin.tcx+xml' })).then(function (res) {
      if (res && res.ok) { toast('Archivo TCX guardado', 'success'); return; }
      var data = res && res.data ? res.data : tcx;
      var done = function () { toast('Tu navegador no permite descargas aquí: copiamos el TCX al portapapeles.', 'info'); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(data).then(done, function () { showCopy(data, fname); });
      else showCopy(data, fname);
    });
  }
  function showCopy(data, fname) {
    var m = openModal({ title: 'Copia el contenido TCX' });
    var ta = h('textarea', { class: 'st-input st-textarea', readonly: true, rows: '8', 'aria-label': 'Contenido del archivo ' + fname });
    ta.value = data;
    m.el.appendChild(h('p', { class: 'st-sub', text: 'No fue posible descargar ni copiar automáticamente. Selecciona el texto, cópialo y pégalo en un archivo ' + fname + '.' }));
    m.el.appendChild(ta);
    m.el.appendChild(h('div', { class: 'st-modal-actions' }, h('button', { class: 'st-btn', type: 'button', text: 'Seleccionar todo', onclick: function () { ta.focus(); ta.select(); } })));
    ta.focus(); ta.select();
  }

  function confirmDelete(a, parent) {
    var m = openModal({ title: '¿Borrar esta rodada?' });
    m.el.appendChild(h('p', { text: 'Se eliminará "' + a.name + '" del ' + L.dayLabelYear(L.localDate(a.date)) + (a.routeId ? ' y se recalcularán tus mejores marcas de la ruta' : '') + '. Esta acción no se puede deshacer.' }));
    m.el.appendChild(h('div', { class: 'st-modal-actions' },
      h('button', { class: 'st-btn', type: 'button', text: 'Cancelar', onclick: function () { m.close(); } }),
      h('button', { class: 'st-btn st-btn--danger', type: 'button', text: 'Sí, borrar', onclick: function () { deleteActivity(a); m.close(); parent.close(); } })));
  }

  function deleteActivity(a) {
    if (a.demo || String(a.id).indexOf('demo-') === 0) {
      demo.acts = demo.acts.filter(function (x) { return x.id !== a.id; });
      demo.bests = L.computeBests(demo.acts, routeLookup);
      if (!demo.acts.length) demo.active = false;
      refresh(); toast('Rodada de ejemplo borrada', 'info'); return;
    }
    var st = R.store.get(), rest = (st.activities || []).filter(function (x) { return x.id !== a.id; });
    var patch = { activities: rest };
    var b = st.bests && a.routeId ? st.bests[a.routeId] : null;
    if (b && b.activityId === a.id) { // la marca borrada: se recalcula con las rodadas restantes
      var nb = Object.assign({}, st.bests); delete nb[a.routeId];
      rest.filter(function (x) { return x.routeId === a.routeId; }).sort(function (p, q) { return p.date < q.date ? -1 : 1; }).forEach(function (x) {
        if (R.riders && R.riders.updateBest) { var r = routeLookup(a.routeId); if (r && R.routes && R.routes.get(a.routeId)) nb = R.riders.updateBest(nb, a.routeId, x, r).bests; }
      });
      patch.bests = nb;
    }
    R.store.set(patch);
    toast('Rodada borrada', 'success');
  }

  // ---------- registro de la vista ----------
  var view = {
    id: 'estadisticas', title: 'Estadísticas', icon: ICON,
    render: function (container, ctx) {
      view.destroy();
      var root = h('div', { class: 'stats-view', 'data-view': 'estadisticas' });
      container.appendChild(root);
      S = { container: container, root: root, ctx: ctx || {}, charts: [], modal: null, unsub: null, D: null };
      var t = null;
      S.unsub = R.store.subscribe(function () { clearTimeout(t); t = setTimeout(function () { if (S && S.root && S.root.isConnected) refresh(); }, 60); });
      S.timer = function () { clearTimeout(t); };
      refresh();
    },
    destroy: function () {
      if (!S) return;
      if (S.unsub) S.unsub();
      if (S.timer) S.timer();
      if (S.modal) S.modal.close();
      destroyCharts();
      if (S.root && S.root.parentNode) S.root.parentNode.removeChild(S.root);
      S = null;
    },
  };
  R.statsView = view;

  var registered = false;
  function register() { if (!registered && R.ui && R.ui.registerView) { R.ui.registerView(view); registered = true; } return registered; }
  if (!register() && typeof window !== 'undefined') {
    document.addEventListener('DOMContentLoaded', register);
    window.addEventListener('load', register);
  }
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
