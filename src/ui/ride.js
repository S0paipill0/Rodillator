/* Rodillator — Pantalla de rodada (vista "rodar").
 * Parte 1: R.rideLogic (lógica pura, probada en Node). Parte 2: la vista (solo con DOM). */
(function (R) {
  'use strict';

  // ======================================================================
  // Parte 1 — Lógica pura
  // ======================================================================
  const MINUS = '−';
  const ACCENT = '#FF5A1F', GHOST = '#FFD23F', BOT = '#7FA7C9';
  const CAMERAS = [
    { id: 'cerca', label: 'Cerca', short: 'Cerca' },
    { id: 'aerea', label: 'Aérea', short: 'Aérea' },
    { id: 'lateral', label: 'Lateral', short: 'Lateral' },
    { id: 'lejos', label: 'Lejos', short: 'Lejos' },
  ];
  const RPE_SCALE = [
    { n: 1, label: 'Muy fácil', desc: 'Podrías conversar sin problema durante horas.' },
    { n: 2, label: 'Fácil', desc: 'Respiración tranquila, casi no lo notas.' },
    { n: 3, label: 'Suave', desc: 'Cómodo, puedes hablar con frases largas.' },
    { n: 4, label: 'Moderado', desc: 'Empiezas a sentir el esfuerzo pero lo sostienes bien.' },
    { n: 5, label: 'Algo duro', desc: 'Respiras fuerte, hablas con frases cortas.' },
    { n: 6, label: 'Duro', desc: 'Exigente, solo puedes decir pocas palabras seguidas.' },
    { n: 7, label: 'Muy duro', desc: 'Cuesta mantener el ritmo, piernas pesadas.' },
    { n: 8, label: 'Intenso', desc: 'Casi no puedes hablar, necesitas concentrarte.' },
    { n: 9, label: 'Extremo', desc: 'Al límite, apenas terminas el esfuerzo.' },
    { n: 10, label: 'Máximo', desc: 'Todo lo que tenías; no podrías dar más.' },
  ];

  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // 83 -> "1:23"; 3725 -> "1:02:05"
  function fmtTime(s) {
    s = Math.max(0, Math.round(s || 0));
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return hh > 0 ? hh + ':' + pad2(mm) + ':' + pad2(ss) : mm + ':' + pad2(ss);
  }

  // Brecha con signo: positivo = vas detrás (pierdes tiempo), negativo = vas por delante.
  function fmtGap(gapS) {
    const a = Math.abs(gapS || 0);
    if (a < 0.5) return '0 s';
    const sign = gapS > 0 ? '+' : MINUS;
    return a >= 120 ? sign + fmtTime(a) : sign + Math.round(a) + ' s';
  }

  function fmtKm(m) { return ((m || 0) / 1000).toFixed(m >= 10000 ? 1 : 2).replace('.', ','); }

  function ymd(date) {
    const d = date || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  // Tiempo (s) en que el fantasma pasó por distM. ghost = { distAt(tS), totalTimeS, distanceM }.
  function ghostTimeAt(ghost, distM) {
    if (distM <= 0) return 0;
    const total = ghost.totalTimeS;
    if (distM >= ghost.distanceM) return total;
    let lo = 0, hi = total;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (ghost.distAt(mid) < distM) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // Brecha en segundos con el fantasma: tiempo del usuario − tiempo que tardó el fantasma en llegar a esa distancia.
  function ghostGapS(ghost, userDistM, userTimeS) {
    if (!ghost) return null;
    return userTimeS - ghostTimeAt(ghost, userDistM);
  }

  function ghostSpeed(ghost, tS) {
    return Math.max(0, ghost.distAt(tS + 0.5) - ghost.distAt(Math.max(0, tS - 0.5)));
  }

  // Muestreo a 1 Hz. advance(tS, snap) completa los segundos enteros transcurridos (desde 0).
  // snap = { powerW, hr, cadence, speedMps, distM, eleM }
  function createSampler() {
    const samples = [];
    let next = 0, lastDist = 0, lastT = -1;
    return {
      samples,
      // Fuerza una muestra final con el tiempo real y la distancia exacta (p. ej. la meta).
      flush(tS, snap) {
        const row = [
          Math.round(tS * 100) / 100,
          Math.max(0, Math.round(snap.powerW || 0)),
          snap.hr != null ? Math.round(snap.hr) : null,
          snap.cadence != null ? Math.round(snap.cadence) : null,
          Math.round((snap.speedMps || 0) * 100) / 100,
          Math.round(snap.distM * 10) / 10,
          snap.eleM != null ? Math.round(snap.eleM * 10) / 10 : null,
        ];
        if (samples.length && row[0] <= lastT) {
          const last = samples[samples.length - 1];
          last[5] = Math.max(last[5], row[5]); // mismo instante: solo corrige la distancia
        } else { samples.push(row); lastT = row[0]; }
        lastDist = snap.distM;
      },
      advance(tS, snap) {
        const pending = Math.floor(tS) - next + 1;
        if (pending <= 0) return 0;
        const d0 = lastDist, d1 = snap.distM;
        for (let k = 1; k <= pending; k++) {
          const dist = pending === 1 ? d1 : d0 + ((d1 - d0) * k) / pending;
          lastT = next;
          samples.push([
            next,
            Math.max(0, Math.round(snap.powerW || 0)),
            snap.hr != null ? Math.round(snap.hr) : null,
            snap.cadence != null ? Math.round(snap.cadence) : null,
            Math.round((snap.speedMps || 0) * 100) / 100,
            Math.round(dist * 10) / 10,
            snap.eleM != null ? Math.round(snap.eleM * 10) / 10 : null,
          ]);
          next++;
        }
        lastDist = d1;
        return pending;
      },
    };
  }

  // Mensajes motivacionales por evento. update(s) devuelve una lista de { key, text }.
  // s = { tS, distM, step: {index,label,watts,durationS,isLast}|null, ghostGapS|null }
  function createEventDetector(opts) {
    const o = opts || {};
    const total = o.totalDistM || 0;
    let started = false, lastStep = null, lastKm = 0, kmStartT = 0, lastKmEmitted = false;
    let ghostState = null;
    return {
      update(s) {
        const out = [];
        if (s.step) {
          if (s.step.index !== lastStep) {
            const first = lastStep === null;
            const w = s.step.watts ? ' · ' + Math.round(s.step.watts) + ' W' : '';
            const dur = s.step.durationS ? ' durante ' + durText(s.step.durationS) : '';
            if (s.step.isLast && !first) out.push({ key: 'step-last', text: 'Último tramo: ' + s.step.label + w + '. ¡Ya casi!' });
            else if (first) out.push({ key: 'step-first', text: '¡Arrancamos! ' + s.step.label + w + dur + '.' });
            else out.push({ key: 'step', text: s.step.label + w + dur + '.' });
            lastStep = s.step.index;
          }
        } else if (!started) {
          out.push({ key: 'start', text: '¡A rodar! Busca un ritmo cómodo los primeros minutos.' });
        }
        started = true;

        if (s.ghostGapS != null) {
          if (s.ghostGapS > 1) {
            if (ghostState === 'ahead') out.push({ key: 'ghost-lost', text: 'Tu mejor marca te alcanzó. ¡Engánchate a su rueda!' });
            ghostState = 'behind';
          } else if (s.ghostGapS < -1) {
            if (ghostState === 'behind') out.push({ key: 'ghost-pass', text: '¡Pasaste a tu mejor marca! Ahora vas por delante.' });
            ghostState = 'ahead';
          }
        }

        let lastKmNow = false;
        if (total >= 2000 && !lastKmEmitted && total - s.distM <= 1000) {
          lastKmEmitted = true; lastKmNow = true;
          out.push({ key: 'last-km', text: '¡Último kilómetro! Vacía el tanque.' });
        }
        const km = Math.floor(s.distM / 1000);
        if (km > lastKm) {
          if (!lastKmNow) out.push({ key: 'km', text: 'Kilómetro ' + km + ' en ' + fmtTime(s.tS - kmStartT) + '.' });
          lastKm = km; kmStartT = s.tS;
        }
        return out;
      },
    };
  }

  function durText(s) {
    s = Math.round(s);
    if (s >= 120 && s % 60 === 0) return s / 60 + ' min';
    if (s >= 60) return Math.floor(s / 60) + ' min ' + (s % 60 ? (s % 60) + ' s' : '').trim();
    return s + ' s';
  }

  // Filas de la tabla: n filas contiguas alrededor del usuario, conservando la posición real.
  function windowAround(ranked, userId, size) {
    size = size || 5;
    const rows = ranked.map((r, i) => Object.assign({ pos: i + 1 }, r));
    if (rows.length <= size) return rows;
    const iu = Math.max(0, rows.findIndex((r) => r.id === userId));
    const start = clamp(iu - 2, 0, rows.length - size);
    return rows.slice(start, start + size);
  }

  function zoneSeconds(samples, ftp) {
    const out = [0, 0, 0, 0, 0, 0, 0];
    (samples || []).forEach((s) => { out[R.training.zoneFor(s[1], ftp) - 1]++; });
    return out;
  }

  function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

  function buildActivity(o) {
    const samples = o.samples;
    const m = R.training.computeMetrics(samples, o.ftp);
    const hrs = samples.filter((s) => s[2] != null && s[2] > 0).map((s) => s[2]);
    const cads = samples.filter((s) => s[3] != null && s[3] > 0).map((s) => s[3]);
    const last = samples[samples.length - 1];
    const act = {
      id: o.id || ('act-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      date: o.date || new Date().toISOString(),
      type: o.type, name: o.name,
      routeId: o.routeId || null, workoutId: o.workoutId || null,
      durationS: m.durationS,
      distanceM: last ? Math.round(last[5]) : 0,
      avgPower: m.avgPower, np: m.np, tss: m.tss, if: m.if,
      avgHr: hrs.length ? Math.round(mean(hrs)) : null,
      avgCadence: cads.length ? Math.round(mean(cads)) : null,
      kcal: m.kcal, rpe: o.rpe != null ? o.rpe : null,
      samples: samples,
      bestEfforts: m.bestEfforts,
    };
    if (o.workout) act.workout = o.workout; // copia compacta de una sesión generada (por tiempo)
    return act;
  }

  // Elección de "entrenar por tiempo": duración entera 15-150 y enfoque conocido.
  const TIMED_FOCUS_IDS = ['hoy', 'recuperacion', 'resistencia', 'tempo', 'sweetspot', 'umbral', 'vo2', 'sprints', 'sorpresa', 'auto'];
  function timedChoice(v) {
    const o = v || {};
    const m = Math.round(Number(o.durationMin));
    return { durationMin: isFinite(m) && m > 0 ? clamp(m, 15, 150) : 45, focus: TIMED_FOCUS_IDS.indexOf(o.focus) >= 0 ? o.focus : 'auto' };
  }

  function gradeArrow(g) { return g > 1 ? '↗' : g < -1 ? '↘' : '→'; }

  function pickTodayWorkout(plan, dateStr) {
    if (!plan || !plan.weeks) return null;
    for (const w of plan.weeks) {
      for (const d of w.days || []) {
        if (d.date === dateStr && d.workoutId) return { workoutId: d.workoutId, status: d.status };
      }
    }
    return null;
  }

  // Texto de la píldora de posiciones: "7.º · Fantasma +12 s" (con fantasma) o "3.º de 7".
  function positionPill(ranked, userId, ghostGapS) {
    const list = ranked || [];
    const iu = list.findIndex((r) => r.id === userId);
    if (iu < 0) return '';
    const pos = (iu + 1) + '.º';
    if (ghostGapS != null) return pos + ' · Fantasma ' + fmtGap(ghostGapS);
    return list.length > 1 ? pos + ' de ' + list.length : pos;
  }

  // Márgenes del HUD sobre la escena (px CSS, relativos a la escena) a partir de rectángulos medidos.
  // rects: { scene:{top,bottom,left,right}, top:{bottom}|null, strip:{top}|null, controls:{left}|null, level:{right}|null }
  // level: columna del nivel del rodillo a la izquierda (celular) -> margen izquierdo.
  function computeViewInsets(rects) {
    const sc = rects && rects.scene;
    if (!sc) return { top: 0, bottom: 0, left: 0, right: 0 };
    const pos = (v) => Math.max(0, Math.round(v));
    return {
      top: rects.top ? pos(rects.top.bottom - sc.top) : 0,
      bottom: rects.strip ? pos(sc.bottom - rects.strip.top) : 0,
      left: rects.level ? pos(rects.level.right - sc.left) : 0,
      right: rects.controls ? pos(sc.right - rects.controls.left) : 0,
    };
  }

  // Doble toque: dos toques a menos de maxMs y maxDist px. tap(t, x, y) devuelve true en el segundo.
  function createDoubleTap(maxMs, maxDist) {
    const ms = maxMs || 320, dist = maxDist || 36;
    let last = null;
    return {
      tap(t, x, y) {
        if (last && t - last.t <= ms && Math.hypot(x - last.x, y - last.y) <= dist) { last = null; return true; }
        last = { t, x, y };
        return false;
      },
      reset() { last = null; },
    };
  }

  // ---------- Rodillo mecánico: nivel sugerido, potencia virtual y fuentes de datos ----------
  const LEVELS = 8;
  const HR_MAX_DEFAULT = 186;
  const LEVEL_WINDOW_M = 150;  // ventana de la pendiente suavizada (m)
  const LEVEL_MIN_GAP_S = 8;   // no cambiar la sugerencia más de una vez cada 8 s
  const LEVEL_MARGIN_PCT = 0.25; // la pendiente debe pasar el umbral por este margen (evita parpadeo)

  function clampLevel(n) { n = Math.round(Number(n)); return isFinite(n) ? clamp(n, 1, LEVELS) : 3; }

  // Pendiente media (%) en una ventana de windowM centrada en distM. loop = la ruta se repite (Libre /
  // entrenamiento): se usa la posición dentro de la vuelta. En los extremos la ventana se desplaza hacia dentro.
  function smoothedGrade(route, distM, windowM, loop) {
    const len = route && route.distanceM;
    if (!(len > 0)) return 0;
    const W = Math.min(windowM > 0 ? windowM : LEVEL_WINDOW_M, len);
    let d = Number(distM) || 0;
    d = loop ? ((d % len) + len) % len : clamp(d, 0, len);
    let a = d - W / 2, b = d + W / 2;
    if (a < 0) { b -= a; a = 0; }
    if (b > len) { a = Math.max(0, a - (b - len)); b = len; }
    if (b - a < 1) return 0;
    return ((R.routes.sampleAt(route, b).ele - R.routes.sampleAt(route, a).ele) / (b - a)) * 100;
  }

  // Potencia virtual (W) del rodillo mecánico a partir de la velocidad de rueda del sensor CSC.
  function virtualPower(o) {
    const kph = o && o.speedKph;
    if (kph == null || !isFinite(kph) || kph <= 0) return 0;
    const scale = o.powerScale > 0 ? o.powerScale : 1;
    return R.trainer.powerFromSpeed({ speedKph: kph, level: clampLevel(o.level) }) * scale;
  }

  // Combina el simulador con los sensores reales.
  //   CSC conectado en modo velocidad (o ambos): potencia virtual desde la velocidad de rueda y el nivel actual;
  //     cadencia del CSC si trae biela (si no, null).
  //   CSC en modo cadencia: potencia del simulador, cadencia del CSC.
  //   Banda de pulso conectada: FC de la banda. Con algún sensor real pero sin banda: FC null (no se inventa).
  //   Sin sensores: todo del simulador (comportamiento anterior).
  // o = { sim, dev, status: R.devices.status(), level, powerScale }
  function readings(o) {
    const sim = (o && o.sim) || {}, dev = (o && o.dev) || {};
    const on = (kind) => ((o && o.status) || []).filter((x) => x && x.kind === kind && x.state === 'connected')[0] || null;
    const csc = on('csc'), hrDev = on('hr');
    const pwrDev = on('trainer') || on('powermeter');
    const cscSpeed = !!csc && csc.mode !== 'cadence';
    const num = (v) => (v != null && isFinite(v) ? Number(v) : null);
    const out = { powerW: 0, hr: null, cad: null, wheelKph: null, powerSource: 'sim', hrSource: null };
    if (pwrDev && num(dev.powerW) != null) {
      // rodillo FTMS o medidor de potencia: su potencia real manda sobre la virtual/simulada
      out.powerW = Math.max(0, num(dev.powerW));
      out.powerSource = 'device';
      out.wheelKph = cscSpeed ? num(dev.speedKph) : null;
      out.cad = num(dev.cadenceRpm);
    } else if (cscSpeed) {
      out.wheelKph = num(dev.speedKph);
      out.powerW = virtualPower({ speedKph: out.wheelKph, level: o.level, powerScale: o.powerScale });
      out.powerSource = 'csc';
      out.cad = csc.mode === 'both' ? num(dev.cadenceRpm) : null;
    } else {
      out.powerW = Math.max(0, num(sim.powerW) || 0);
      out.cad = csc ? num(dev.cadenceRpm) : num(sim.cadenceRpm);
    }
    if (hrDev) { out.hr = num(dev.hrBpm); out.hrSource = 'hr'; }
    else if (!csc && !pwrDev) { out.hr = num(sim.hrBpm); out.hrSource = out.hr != null ? 'sim' : null; }
    return out;
  }

  // Zona de FC (1..5) por % de la FC máxima: < 60, 60–70, 70–80, 80–90, ≥ 90 %.
  const HR_ZONES = [
    { zone: 1, name: 'Muy suave', color: '#8A8F98' },
    { zone: 2, name: 'Suave', color: '#3FA7D6' },
    { zone: 3, name: 'Moderada', color: '#59CD90' },
    { zone: 4, name: 'Intensa', color: '#FAC05E' },
    { zone: 5, name: 'Máxima', color: '#EE6352' },
  ];
  function hrZone(hr, maxHr) {
    if (hr == null || !(hr > 0)) return null;
    const max = maxHr > 0 ? maxHr : HR_MAX_DEFAULT;
    const pct = (hr / max) * 100;
    const z = pct < 60 ? 1 : pct < 70 ? 2 : pct < 80 ? 3 : pct < 90 ? 4 : 5;
    return Object.assign({ pct: Math.round(pct) }, HR_ZONES[z - 1]);
  }

  // Nivel sugerido del rodillo mecánico (1..8). La app solo sugiere; el usuario mueve la palanca.
  //   base: en rutas, levelForGrade(pendiente suavizada) desplazado por flatLevel (nivel en llano);
  //         en entrenamientos, levelForTarget(objetivo). La pendiente debe cruzar el umbral por marginPct.
  //   ataque del pelotón: base + 1 (tope 8); hidratación: flatLevel − 1 (mín. 1).
  //   La sugerencia no cambia más de una vez cada minGapS segundos.
  //   manual(±1): el usuario indica el nivel real; vale hasta la próxima sugerencia distinta.
  // update(s) devuelve { level, prev, reason } cuando hay que mover la palanca (evento 'resistance'), o null.
  function createLevelAdvisor(opts) {
    const o = opts || {};
    const flat = clampLevel(o.flatLevel != null ? o.flatLevel : 3);
    const offset = flat - 3;
    const minGapS = o.minGapS != null ? o.minGapS : LEVEL_MIN_GAP_S;
    const margin = o.marginPct != null ? o.marginPct : LEVEL_MARGIN_PCT;
    const st = { level: flat, suggested: null, base: null, manual: false, lastChangeS: -Infinity, reason: null };
    const gradeLevel = (g) => clampLevel(R.trainer.levelForGrade(g) + offset);

    function baseFor(s) {
      if (s.targetW != null && isFinite(s.targetW)) {
        st.base = R.trainer.levelForTarget({ targetW: s.targetW, cadenceRpm: s.cadenceRpm, ftp: s.ftp, wheelCircMm: s.wheelCircMm, powerScale: s.powerScale });
        return 'intervalo';
      }
      const g = Number(s.gradePct);
      if (isFinite(g)) {
        const cand = gradeLevel(g);
        if (st.base == null) st.base = cand;
        else if (cand !== st.base) {
          // solo si la pendiente pasa el umbral con margen: se evalúa con la pendiente acercada al nivel actual
          const back = gradeLevel(g - Math.sign(cand - st.base) * margin);
          if (back !== st.base) st.base = back;
        }
      } else if (st.base == null) st.base = flat;
      return 'pendiente';
    }

    return {
      state: st,
      update(s) {
        s = s || {};
        let reason = baseFor(s);
        let want = st.base;
        if (s.hydrating) { want = Math.max(1, flat - 1); reason = 'hidratacion'; }
        else if (s.attacking) { want = Math.min(LEVELS, st.base + 1); reason = 'ataque'; }
        if (want === st.suggested) return null;
        const t = Number(s.tS) || 0;
        if (st.suggested != null && t - st.lastChangeS < minGapS) return null;
        const prev = st.suggested == null ? null : st.level;
        st.suggested = want; st.lastChangeS = t; st.reason = reason;
        const already = prev === want; // el usuario ya la había puesto ahí a mano
        st.level = want; st.manual = false;
        return already ? null : { level: want, prev, reason };
      },
      manual(delta) {
        st.level = clampLevel(st.level + (delta > 0 ? 1 : delta < 0 ? -1 : 0));
        st.manual = st.suggested != null && st.level !== st.suggested;
        return st.level;
      },
      get level() { return st.level; },
      get suggested() { return st.suggested; },
    };
  }

  // Pausas de hidratación en rodadas sin estructura: cada everyMin min, durante durationS s (el cronómetro sigue).
  // update(tS) -> { active, remainingS, started, ended }
  function createHydrationTimer(opts) {
    const o = opts || {};
    const every = (o.everyMin > 0 ? o.everyMin : 12) * 60;
    const dur = o.durationS > 0 ? o.durationS : 45;
    let active = false, endsAt = 0, next = every;
    return {
      update(tS) {
        let started = false, ended = false;
        if (active && tS >= endsAt) { active = false; ended = true; }
        if (!active && tS >= next) { active = true; started = true; endsAt = next + dur; next += every; }
        return { active, remainingS: active ? Math.max(0, endsAt - tS) : 0, started, ended, durationS: dur };
      },
    };
  }

  R.rideLogic = {
    smoothedGrade, virtualPower, readings, hrZone, HR_ZONES, HR_MAX_DEFAULT, createLevelAdvisor, createHydrationTimer, LEVELS,
    positionPill, computeViewInsets, createDoubleTap,
    fmtTime, fmtGap, fmtKm, ymd, ghostTimeAt, ghostGapS, ghostSpeed, createSampler, createEventDetector,
    windowAround, zoneSeconds, buildActivity, timedChoice, gradeArrow, pickTodayWorkout,
    RPE_SCALE, CAMERAS, durText, clamp,
  };

  if (typeof document === 'undefined') return;

  // ======================================================================
  // Parte 2 — Vista
  // ======================================================================
  const L = R.rideLogic;
  const BIKE_KG = 8;
  const MOBILE_MQ = '(max-width: 700px), (max-height: 500px)';
  const LOOP_MSG = 'La ruta se repite si pasas la meta.';
  const BT_NOTE = 'Para sensores usa la versión web en Chrome';
  let inst = null;

  function h(tag, attrs, kids) {
    const e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        const v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : v);
      });
    }
    (function add(list) {
      (Array.isArray(list) ? list : [list]).forEach((c) => {
        if (c == null || c === false) return;
        if (Array.isArray(c)) add(c);
        else e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
      });
    })(kids);
    return e;
  }

  const ICON = {
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg>',
    minus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 11h14v2H5z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>',
    camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4l-1.8 2H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-3.2L15 4zm3 4.5A4.5 4.5 0 1112 17.5 4.5 4.5 0 0112 8.5zm0 2A2.5 2.5 0 1014.5 13 2.5 2.5 0 0012 10.5z"/></svg>',
    stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h12v12H6z"/></svg>',
    spk: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9zm13.5 3A4.5 4.5 0 0014 8v8a4.5 4.5 0 002.5-4zM14 3.2v2.1a7 7 0 010 13.4v2.1a9 9 0 000-17.6z"/></svg>',
    spkOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 4V5L7 9zm12.6 3l2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z"/></svg>',
  };
  function icon(name) { const s = h('span', { class: 'rd-ico' }); s.innerHTML = ICON[name]; return s; }

  function setText(el, txt) { if (el._t !== txt) { el._t = txt; el.textContent = txt; } }
  function setStyle(el, prop, val) { const k = '_s' + prop; if (el[k] !== val) { el[k] = val; el.style[prop] = val; } }
  function setVar(el, name, val) { const k = '_v' + name; if (el[k] !== val) { el[k] = val; el.style.setProperty(name, val); } }

  function fitCanvas(cv) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(cv.clientWidth)), hh = Math.max(1, Math.round(cv.clientHeight));
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hh * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w, h: hh };
  }

  function zonePalette(ftp) { return R.training.zones(ftp); }
  function zoneColor(zones, powerW, ftp) { return zones[R.training.zoneFor(powerW, ftp) - 1].color; }

  // ---------- Vista 2D de respaldo (sin WebGL/THREE) ----------
  function createFallbackView(container, route) {
    const cv = h('canvas', { class: 'rd-fb', 'aria-label': 'Perfil de elevación con las posiciones de los ciclistas' });
    container.appendChild(cv);
    const prof = R.routes.profile(route, 260);
    let minE = Infinity, maxE = -Infinity;
    prof.forEach((p) => { if (p.ele < minE) minE = p.ele; if (p.ele > maxE) maxE = p.ele; });
    let riders = [];
    function render() {
      const f = fitCanvas(cv), g = f.g, w = f.w, hh = f.h;
      g.clearRect(0, 0, w, hh);
      const grd = g.createLinearGradient(0, 0, 0, hh);
      grd.addColorStop(0, '#16212c'); grd.addColorStop(1, '#0b1118');
      g.fillStyle = grd; g.fillRect(0, 0, w, hh);
      const x0 = w * 0.06, x1 = w * 0.94, yTop = hh * 0.34, yBot = hh * 0.62;
      const span = Math.max(1, maxE - minE);
      const X = (d) => x0 + (d / route.distanceM) * (x1 - x0);
      const Y = (e) => yBot - ((e - minE) / span) * (yBot - yTop);
      g.beginPath(); g.moveTo(X(0), hh * 0.8);
      prof.forEach((p) => g.lineTo(X(p.distM), Y(p.ele)));
      g.lineTo(X(route.distanceM), hh * 0.8); g.closePath();
      g.fillStyle = 'rgba(127,167,201,.16)'; g.fill();
      g.beginPath();
      prof.forEach((p, i) => { if (i) g.lineTo(X(p.distM), Y(p.ele)); else g.moveTo(X(p.distM), Y(p.ele)); });
      g.strokeStyle = 'rgba(238,243,247,.55)'; g.lineWidth = 2; g.stroke();
      const sorted = riders.slice().sort((a, b) => (a.kind === 'user') - (b.kind === 'user'));
      sorted.forEach((r) => {
        const d = Math.min(route.distanceM, Math.max(0, r.distM));
        const s = R.routes.sampleAt(route, d);
        const x = X(d), y = Y(s.ele);
        g.beginPath(); g.arc(x, y - 8, r.kind === 'user' ? 9 : 6, 0, Math.PI * 2);
        g.fillStyle = r.color; g.fill();
        if (r.kind !== 'bot') {
          g.fillStyle = '#EEF3F7'; g.font = '600 13px Inter, sans-serif'; g.textAlign = 'center';
          g.fillText(r.label || r.name || '', x, y - 24);
        }
      });
      g.fillStyle = 'rgba(238,243,247,.6)'; g.font = '500 14px Inter, sans-serif'; g.textAlign = 'left';
      g.fillText('Vista 3D no disponible en este navegador: sigues la rodada sobre el perfil de la ruta.', x0, hh * 0.9);
    }
    return {
      setRiders(list) { riders = list; }, setCameraMode() {}, render, resize() {},
      dispose() { if (cv.parentNode) cv.parentNode.removeChild(cv); },
      isFallback: true,
    };
  }

  // ======================================================================
  // Instancia de la vista
  // ======================================================================
  function createRide(container, ctx) {
    const store = R.store;
    const params = (ctx && ctx.params) || {};
    const navigate = (id, p) => { if (ctx && ctx.navigate) ctx.navigate(id, p); else if (R.ui && R.ui.navigate) R.ui.navigate(id, p); };
    const root = h('div', { class: 'rd' });
    container.appendChild(root);
    let disposed = false;
    const cleanups = [];
    const timers = new Set();
    function later(fn, ms) { const t = setTimeout(() => { timers.delete(t); if (!disposed) fn(); }, ms); timers.add(t); return t; }

    const state0 = store.get();
    const profile = state0.profile || null;
    const ftp = (profile && profile.ftp > 0) ? profile.ftp : 200;
    const weightKg = (profile && profile.weightKg > 0) ? profile.weightKg : 70;
    const massKg = weightKg + BIKE_KG;
    const settings = state0.settings || {};
    const zones = zonePalette(ftp);
    const routes = R.routes.list();
    // ciclistas del pelotón: 8..20 (14 por defecto), igual que store.js
    function botsCountOf(v) { return R.store.normalizeBotsCount ? R.store.normalizeBotsCount(v) : clamp(Math.round(Number(v)) || 14, 8, 20); }

    // ---------- avisos y diálogos propios (por encima de la pantalla completa) ----------
    let toastEl = null;
    function say(msg, kind) {
      if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
      toastEl = h('div', { class: 'rd-toast rd-toast--' + (kind || 'info'), role: 'status', text: msg });
      root.appendChild(toastEl);
      const mine = toastEl;
      later(() => { if (mine.parentNode) mine.parentNode.removeChild(mine); }, 5200);
    }

    let dialogEl = null;
    function dialog(o) {
      closeDialog();
      const actions = h('div', { class: 'rd-dlg-actions' });
      const box = h('div', { class: 'rd-dlg', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title }, [
        h('h2', { class: 'rd-dlg-title', text: o.title }),
        h('div', { class: 'rd-dlg-body' }, o.body),
        actions,
      ]);
      dialogEl = h('div', { class: 'rd-dlg-back' }, box);
      (o.actions || []).forEach((a) => {
        actions.appendChild(h('button', {
          type: 'button', class: 'rd-btn rd-btn--' + (a.kind || 'ghost'), text: a.label,
          onclick: () => { if (!a.keepOpen) closeDialog(); if (a.onClick) a.onClick(); },
        }));
      });
      dialogEl._onClose = o.onClose || null;
      root.appendChild(dialogEl);
      const first = actions.querySelector('button.rd-btn--primary') || actions.querySelector('button');
      if (first) first.focus();
      return dialogEl;
    }
    function closeDialog() {
      if (!dialogEl) return;
      const d = dialogEl; dialogEl = null;
      if (d.parentNode) d.parentNode.removeChild(d);
      if (d._onClose) d._onClose();
    }

    // ======================================================================
    // Preparación
    // ======================================================================
    const cfg = {
      tab: params.timed ? 'free' : params.workoutId ? 'workout' : params.routeId ? 'route' : 'workout',
      freeMode: 'tiempo', // pestaña Libre: 'tiempo' (sesión por tiempo disponible) | 'libre' (rodada sin estructura)
      timed: L.timedChoice(params.timed || settings.lastTimed),
      timedOther: false,
      workoutId: params.workoutId || null,
      routeId: params.routeId || null,
      ghost: true,
      bots: botsCountOf(settings.botsCount),
      camera: 'cerca',
    };
    if (!params.workoutId && !params.routeId) {
      const today = L.pickTodayWorkout(state0.plan, L.ymd());
      cfg.workoutId = today ? today.workoutId : 'resistencia-60';
    }
    if (!cfg.workoutId) cfg.workoutId = 'resistencia-60';
    if (!cfg.routeId || !R.routes.get(cfg.routeId)) cfg.routeId = routes.length ? routes[0].id : null;

    let phase = 'prep';

    const TIMED_DURS = [20, 30, 45, 60, 75, 90];
    const TIMED_FOCUS_OPTS = [
      ['auto', 'Recomendado'], ['hoy', 'Versión corta de hoy'], ['recuperacion', 'Recuperación'], ['resistencia', 'Resistencia'], ['tempo', 'Tempo'],
      ['sweetspot', 'Sweet spot'], ['umbral', 'Umbral'], ['vo2', 'VO2máx'], ['sprints', 'Sprints'], ['sorpresa', 'Sorpresa'],
    ];
    // Sesión generada por tiempo disponible (null si la duración no es válida)
    function genTimed() {
      const st = store.get();
      try {
        return R.training.timedWorkout({ durationMin: cfg.timed.durationMin, focus: cfg.timed.focus, ftp, profile, plan: st.plan, activities: st.activities || [], today: L.ymd() });
      } catch (e) { return null; }
    }
    function saveTimed() {
      if (cfg.timed.durationMin >= 15 && cfg.timed.durationMin <= 150) {
        try { store.set({ settings: { lastTimed: { durationMin: cfg.timed.durationMin, focus: cfg.timed.focus } } }); } catch (e) { /* sin guardar */ }
      }
    }
    // Sesión de hoy aún por hacer (si ya está hecha, "Versión corta de hoy" no aplica)
    function openTodaySession() {
      const st = store.get(), ymd = L.ymd();
      const t = L.pickTodayWorkout(st.plan, ymd);
      if (!t || t.status === 'hecho') return null;
      if ((st.activities || []).some((a) => L.ymd(new Date(a.date)) === ymd)) return null;
      return t;
    }
    const isTimedMode = () => cfg.tab === 'free' && cfg.freeMode === 'tiempo';

    function timedCard(todaySession, tw) {
      const chip = (label, on, onclick, extra) => h('button', Object.assign({ type: 'button', class: 'rd-chip' + (on ? ' is-on' : ''), 'aria-pressed': on ? 'true' : 'false', text: label, onclick: onclick }, extra || {}));
      const isOther = cfg.timedOther || TIMED_DURS.indexOf(cfg.timed.durationMin) < 0;
      const durRow = h('div', { class: 'rd-chips', role: 'group', 'aria-label': 'Tiempo disponible' }, TIMED_DURS.map((m) => chip(m + ' min', !isOther && cfg.timed.durationMin === m, () => {
        cfg.timed.durationMin = m; cfg.timedOther = false; saveTimed(); renderPrep();
      }, { 'data-key': 'dur-' + m })).concat([chip('Otro', isOther, () => { cfg.timedOther = true; renderPrep(); }, { 'data-key': 'dur-otro' })]));
      const kids = [h('h2', { class: 'rd-h', text: '¿Cuánto tiempo tienes?' }), durRow];
      if (isOther) {
        kids.push(h('label', { class: 'rd-lbl', for: 'rd-tmin', text: 'Minutos (15 a 150)' }));
        kids.push(h('input', {
          id: 'rd-tmin', 'data-key': 'tmin', class: 'rd-input rd-input--short', type: 'number', inputmode: 'numeric', min: '15', max: '150', step: '1', value: String(cfg.timed.durationMin),
          onchange: (e) => { cfg.timed.durationMin = Math.round(Number(e.target.value) || 0); saveTimed(); renderPrep(); },
        }));
      }
      kids.push(h('h2', { class: 'rd-h rd-h--sub', text: 'Enfoque' }));
      kids.push(h('div', { class: 'rd-chips', role: 'group', 'aria-label': 'Enfoque de la sesión' }, TIMED_FOCUS_OPTS
        .filter((o) => o[0] !== 'hoy' || todaySession)
        .map((o) => chip(o[1], cfg.timed.focus === o[0], () => { cfg.timed.focus = o[0]; saveTimed(); renderPrep(); }, { 'data-key': 'foc-' + o[0] }))));
      return h('section', { class: 'rd-card rd-timed' }, kids);
    }

    function timedPreview(tw) {
      if (!tw) return h('section', { class: 'rd-card' }, [h('p', { class: 'rd-warn', text: 'Elige una duración entre 15 y 150 minutos para armar tu sesión.' })]);
      const same = !tw.generated;
      return h('section', { class: 'rd-card rd-timed-prev', 'aria-live': 'polite' }, [
        h('h2', { class: 'rd-h', text: 'Tu sesión' }),
        h('div', { class: 'rd-wk-name', text: tw.name }),
        tw.notice ? h('p', { class: 'rd-warn', role: 'status', text: tw.notice }) : null,
        h('p', { class: 'rd-note', text: same ? 'Tu sesión de hoy ya cabe en ese tiempo: se rueda completa. ' + tw.description : tw.description }),
        workoutMiniProfile(tw),
        h('div', { class: 'rd-wk-meta', text: Math.round(tw.durationS / 60) + ' min · TSS ' + Math.round(tw.tss) + ' · FTP ' + ftp + ' W' }),
      ]);
    }

    function workoutMiniProfile(w) {
      const total = w.durationS;
      const wrap = h('div', { class: 'rd-mini', 'aria-hidden': 'true' });
      w.steps.forEach((s) => {
        const pct = (s.powerPct + (s.powerPctEnd != null ? s.powerPctEnd : s.powerPct)) / 2;
        const bar = h('i');
        bar.style.flexGrow = String(s.durationS / total);
        bar.style.height = Math.round(clamp(pct / 1.4, 8, 100)) + '%';
        bar.style.background = zoneColor(zones, (pct * ftp) / 100, ftp);
        wrap.appendChild(bar);
      });
      return wrap;
    }

    function renderPrep() {
      const ae = document.activeElement;
      const focusKey = ae && ae !== document.body && root.contains(ae) ? ae.getAttribute('data-key') : null;
      root.className = 'rd rd--prep';
      root.textContent = '';
      const tabs = [
        { id: 'workout', label: 'Hoy', aria: 'Entrenamiento de hoy' },
        { id: 'route', label: 'Rutas' },
        { id: 'free', label: 'Libre' },
      ];
      const tablist = h('div', { class: 'rd-tabs', role: 'tablist', 'aria-label': 'Tipo de rodada' }, tabs.map((t) => h('button', {
        type: 'button', role: 'tab', 'data-key': 'tab-' + t.id, class: 'rd-tab' + (cfg.tab === t.id ? ' is-on' : ''), 'aria-selected': cfg.tab === t.id ? 'true' : 'false',
        text: t.label, 'aria-label': t.aria || null, onclick: () => { cfg.tab = t.id; renderPrep(); },
      })));

      const main = h('div', { class: 'rd-prep-col' });
      // --- Libre: por tiempo / rodada libre
      let tw = null;
      if (cfg.tab === 'free') {
        const modes = [{ id: 'tiempo', label: 'Por tiempo' }, { id: 'libre', label: 'Rodada libre' }];
        main.appendChild(h('div', { class: 'rd-tabs rd-seg', role: 'group', 'aria-label': 'Modo de la pestaña Libre' }, modes.map((m) => h('button', {
          type: 'button', 'data-key': 'seg-' + m.id, class: 'rd-tab' + (cfg.freeMode === m.id ? ' is-on' : ''), 'aria-pressed': cfg.freeMode === m.id ? 'true' : 'false',
          text: m.label, onclick: () => { cfg.freeMode = m.id; renderPrep(); },
        }))));
        if (cfg.freeMode === 'tiempo') {
          const todaySession = openTodaySession();
          if (cfg.timed.focus === 'hoy' && !todaySession) cfg.timed.focus = 'auto';
          tw = genTimed();
          main.appendChild(timedCard(todaySession, tw));
          main.appendChild(timedPreview(tw));
        } else {
          main.appendChild(h('section', { class: 'rd-card' }, [
            h('h2', { class: 'rd-h', text: 'Rodada libre' }),
            h('p', { class: 'rd-note', text: 'Sin estructura ni meta: pedaleas el tiempo que quieras y fijas tu potencia a mano.' }),
          ]));
        }
      }
      // --- modo
      if (cfg.tab === 'workout') {
        const lib = R.training.library;
        const w = R.training.getWorkout(cfg.workoutId) || lib[0];
        const today = L.pickTodayWorkout(state0.plan, L.ymd());
        const sel = h('select', { id: 'rd-wk', class: 'rd-select', onchange: (e) => { cfg.workoutId = e.target.value; renderPrep(); } },
          lib.map((x) => h('option', { value: x.id, selected: x.id === w.id, text: x.name + ' · ' + Math.round(x.durationS / 60) + ' min' })));
        main.appendChild(h('section', { class: 'rd-card' }, [
          h('h2', { class: 'rd-h', text: today && today.workoutId === w.id ? 'Tu sesión de hoy' : 'Entrenamiento' }),
          h('div', { class: 'rd-wk-name', text: w.name }),
          h('p', { class: 'rd-note', text: w.description }),
          workoutMiniProfile(w),
          h('div', { class: 'rd-wk-meta', text: Math.round(w.durationS / 60) + ' min · TSS ' + Math.round(w.tss) + ' · FTP ' + ftp + ' W' }),
          h('label', { class: 'rd-lbl', for: 'rd-wk', text: 'Cambiar entrenamiento' }), sel,
        ]));
        if (!profile) main.appendChild(h('p', { class: 'rd-warn', text: 'Aún no configuras tu perfil: usamos un FTP de 200 W y 70 kg.' }));
      }
      if (cfg.tab === 'route') {
        main.appendChild(h('section', { class: 'rd-card' }, [
          h('h2', { class: 'rd-h', text: 'Elige una ruta' }),
          routes.length ? h('div', { class: 'rd-routes', role: 'radiogroup', 'aria-label': 'Ruta' }, routes.map((r) => {
            const best = (state0.bests || {})[r.id];
            const on = cfg.routeId === r.id;
            return h('button', {
              type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false', class: 'rd-route' + (on ? ' is-on' : ''),
              onclick: () => { cfg.routeId = r.id; renderPrep(); },
            }, [
              h('span', { class: 'rd-route-name', text: r.name }),
              h('span', { class: 'rd-route-meta', text: L.fmtKm(r.distanceM) + ' km · +' + Math.round(r.gainM) + ' m' + (best ? ' · mejor ' + L.fmtTime(best.totalTimeS) : '') }),
            ]);
          })) : h('p', { class: 'rd-warn', text: 'No hay rutas cargadas. Revisa la sección Rutas.' }),
        ]));
      } else if (routes.length) {
        main.appendChild(h('section', { class: 'rd-card' }, [
          h('label', { class: 'rd-h', for: 'rd-bg', text: 'Ruta de fondo (paisaje)' }),
          h('select', { id: 'rd-bg', class: 'rd-select', onchange: (e) => { cfg.routeId = e.target.value; renderPrep(); } },
            routes.map((r) => h('option', { value: r.id, selected: r.id === cfg.routeId, text: r.name + ' · ' + L.fmtKm(r.distanceM) + ' km' }))),
          h('p', { class: 'rd-note', text: cfg.tab === 'workout' || isTimedMode()
            ? 'Recorres el paisaje con la velocidad que da tu potencia en la pendiente real. La pendiente no se envía al rodillo: manda el entrenamiento. ' + LOOP_MSG
            : 'Sin meta: rueda el tiempo que quieras. ' + LOOP_MSG }),
        ]));
      }

      // --- cómo se controla la potencia (simulador)
      main.appendChild(h('section', { class: 'rd-card' }, [
        h('h2', { class: 'rd-h', text: 'Potencia' }),
        h('p', { class: 'rd-note', text: cfg.tab === 'workout' || isTimedMode()
          ? 'El simulador sigue solo la potencia objetivo de cada paso. Ajusta la intensidad con las flechas ↑ ↓ (±5 %) o con los botones − y +.'
          : 'Fija tu potencia con las flechas ↑ ↓ (±10 W), con los botones − y + o con el deslizador; la velocidad sale de la física según la pendiente.' }),
        h('p', { class: 'rd-note', text: 'Con el sensor de velocidad conectado (Ajustes › Sensores y rodillo), la potencia se estima con la velocidad de tu rueda y el nivel de la palanca. La app te sugiere el nivel (1 a 8); si no lo sigues, márcalo con − y + junto al nivel. La app sugiere el nivel; si no moviste la palanca, corrígelo con − / +.' }),
      ]));

      // --- opciones
      const best = cfg.routeId ? (state0.bests || {})[cfg.routeId] : null;
      const boost = settings.ghostBoost || 0;
      const opts = h('section', { class: 'rd-card' }, [h('h2', { class: 'rd-h', text: 'Opciones' })]);
      if (cfg.tab === 'route') {
        opts.appendChild(h('label', { class: 'rd-check' }, [
          h('input', { type: 'checkbox', checked: cfg.ghost && !!best, disabled: !best, onchange: (e) => { cfg.ghost = e.target.checked; } }),
          h('span', {}, [
            h('b', { text: 'Fantasma de tu mejor marca' + (boost ? ' (+' + String(boost).replace('.', ',') + ' %)' : '') }),
            h('small', { text: best ? 'Tu mejor tiempo: ' + L.fmtTime(best.totalTimeS) + (boost ? '; el fantasma va ' + String(boost).replace('.', ',') + ' % más rápido.' : '.') : 'Aún no tienes una marca en esta ruta: complétala una vez y aparecerá.' }),
          ]),
        ]));
        opts.appendChild(h('label', { class: 'rd-lbl', for: 'rd-bots', text: 'Ciclistas del pelotón (8 a 20)' }));
        opts.appendChild(h('input', {
          id: 'rd-bots', class: 'rd-input', type: 'number', min: '8', max: '20', step: '1', value: String(cfg.bots),
          onchange: (e) => { cfg.bots = botsCountOf(e.target.value); e.target.value = String(cfg.bots); },
        }));
        opts.appendChild(h('p', { class: 'rd-note', text: 'Cada 6 a 12 minutos el pelotón ataca: síguelo subiendo un nivel la palanca.' }));
      }
      opts.appendChild(h('label', { class: 'rd-lbl', for: 'rd-cam', text: 'Cámara (también con la tecla C)' }));
      opts.appendChild(h('select', { id: 'rd-cam', class: 'rd-select', onchange: (e) => { cfg.camera = e.target.value; } },
        L.CAMERAS.map((c) => h('option', { value: c.id, selected: c.id === cfg.camera, text: c.label }))));
      main.appendChild(opts);

      const ready = !!cfg.routeId && (!isTimedMode() || !!tw);
      const start = h('button', { type: 'button', class: 'rd-btn rd-btn--primary rd-start', disabled: !ready, onclick: () => beginCountdown(), text: 'Comenzar' });
      root.appendChild(h('header', { class: 'rd-prep-head' }, [h('h1', { class: 'rd-title', text: 'Rodar' })]));
      root.appendChild(tablist);
      root.appendChild(main);
      root.appendChild(h('div', { class: 'rd-startbar' }, [
        start, !cfg.routeId ? h('span', { class: 'rd-note', text: 'No hay rutas para rodar.' }) : null,
      ]));
      if (focusKey) { // el foco vuelve al control equivalente tras redibujar
        const again = root.querySelector('[data-key="' + focusKey + '"]');
        if (again) try { again.focus({ preventScroll: true }); } catch (e) { again.focus(); }
      }
    }

    // ======================================================================
    // Rodada
    // ======================================================================
    let ride = null;        // estado de la rodada
    let scene = null;
    let sim = null;
    let audio = null, coach = null, muted = false; // coach de voz (suena sobre la música, sin pausarla)
    let stage = null;       // referencias DOM del HUD
    let rafId = 0, hiddenIv = 0;
    let wakeLock = null;
    let moreOpen = readMore();   // "Más datos": se recuerda durante la sesión
    let layoutKey = '';
    let boardTimer = 0;
    let layoutRO = null;

    function readMore() { try { return window.sessionStorage.getItem('rodillator.hud.more') === '1'; } catch (e) { return false; } }
    function isMobile() { try { return !!(window.matchMedia && window.matchMedia(MOBILE_MQ).matches); } catch (e) { return false; } }
    function setMoreLabel() {
      if (!stage || !stage.moreBtn) return;
      stage.moreBtn.textContent = moreOpen ? 'Menos datos ▴' : 'Más datos ▾';
      stage.moreBtn.setAttribute('aria-expanded', moreOpen ? 'true' : 'false');
      stage.moreBtn.setAttribute('aria-label', moreOpen ? 'Ocultar cadencia, frecuencia cardíaca y trabajo' : 'Mostrar cadencia, frecuencia cardíaca y trabajo');
    }
    function toggleMore() {
      moreOpen = !moreOpen;
      try { window.sessionStorage.setItem('rodillator.hud.more', moreOpen ? '1' : '0'); } catch (e) { /* sin sessionStorage */ }
      root.classList.toggle('is-more', moreOpen);
      setMoreLabel();
      syncLayout(true);
    }
    function updatePillLabel() {
      if (!stage || !stage.pill) return;
      const open = stage.board.classList.contains('is-open');
      const lbl = 'Posiciones: ' + (stage.pill.textContent || '') + '. ' + (open ? 'Cerrar tabla' : 'Abrir tabla');
      if (stage.pill._lbl !== lbl) { stage.pill._lbl = lbl; stage.pill.setAttribute('aria-label', lbl); }
    }
    function closeBoard() {
      if (boardTimer) { clearTimeout(boardTimer); timers.delete(boardTimer); boardTimer = 0; }
      if (!stage) return;
      stage.board.classList.remove('is-open');
      stage.pill.setAttribute('aria-expanded', 'false');
      updatePillLabel();
    }
    function toggleBoard() {
      if (!stage) return;
      if (stage.board.classList.contains('is-open')) { closeBoard(); return; }
      stage.board.classList.add('is-open');
      stage.pill.setAttribute('aria-expanded', 'true');
      updatePillLabel();
      boardTimer = later(closeBoard, 5000); // se cierra sola a los 5 s
    }
    // Mide el HUD real: fija variables CSS de la zona libre y avisa a la escena 3D.
    function syncLayout(force) {
      if (!stage || !scene) return;
      const mobile = isMobile();
      const sc = stage.sceneEl.getBoundingClientRect();
      let ins = { top: 0, bottom: 0, left: 0, right: 0 };
      let vars = null;
      if (mobile) {
        const tr = stage.top.getBoundingClientRect();
        const br = stage.charts.parentNode.getBoundingClientRect();
        const cr = stage.controls.getBoundingClientRect();
        const lr = stage.lvl ? stage.lvl.getBoundingClientRect() : null;
        // la columna de controles va a la derecha (margen derecho); la del nivel del rodillo, a la izquierda
        ins = L.computeViewInsets({ scene: sc, top: { bottom: tr.bottom }, strip: { top: br.top }, controls: cr.width ? { left: cr.left } : null, level: lr && lr.width ? { right: lr.right } : null });
        vars = [Math.round(tr.bottom - sc.top) + 'px', Math.round(sc.bottom - br.top) + 'px'];
      }
      const vkey = vars ? vars.join('|') : '';
      if (vkey !== stage._vkey) {
        stage._vkey = vkey;
        if (vars) { root.style.setProperty('--rd-top-h', vars[0]); root.style.setProperty('--rd-bot-h', vars[1]); }
        else { root.style.removeProperty('--rd-top-h'); root.style.removeProperty('--rd-bot-h'); closeBoard(); }
      }
      const key = [mobile ? 1 : 0, ins.top, ins.bottom, ins.left, ins.right, Math.round(sc.width), Math.round(sc.height)].join(',');
      if (!force && key === layoutKey) return;
      layoutKey = key;
      if (scene.setViewInsets) scene.setViewInsets(ins);
    }

    function currentMode() { return isTimedMode() ? 'workout' : cfg.tab; } // 'workout' | 'route' | 'free' (por tiempo = entrenamiento)

    function beginCountdown() {
      const mode = currentMode();
      const route = R.routes.get(cfg.routeId);
      if (!route) { say('Elige una ruta para continuar.', 'warn'); return; }
      let workout = isTimedMode() ? genTimed() : mode === 'workout' ? R.training.getWorkout(cfg.workoutId) : null;
      if (workout && workout.generated) R.training.registerWorkout(workout);
      if (mode === 'workout' && !workout) { say('No encontramos ese entrenamiento.', 'warn'); return; }
      // ajustes vigentes (pueden haber cambiado en Ajustes desde que se abrió la vista)
      const curSet = store.get().settings || {};
      const trainerCfg = R.sensorsSettings ? R.sensorsSettings.normalizeTrainer(curSet.trainer) : { wheelCircMm: 2050, flatLevel: 3, powerScale: 1 };
      const hyd = R.store.normalizeHydration ? R.store.normalizeHydration(curSet.hydration) : { enabled: false, everyMin: 12, durationS: 45 };
      // hidratación: pausas dentro de los entrenamientos estructurados (no en tests de FTP)
      if (workout && hyd.enabled && workout.category !== 'test' && R.training.withHydration) {
        try { workout = R.training.withHydration(workout, { everyMin: hyd.everyMin, durationS: hyd.durationS }); } catch (e) { /* sin pausas */ }
      }

      ride = {
        mode, route, workout, tS: 0, distM: 0, routeDist: 0, v: 0, kJ: 0, paused: false, over: false,
        power: 0, hr: null, cad: null, latest: {}, intensity: 1, simTarget: Math.round(0.65 * ftp),
        sampler: L.createSampler(), grade: 0, ele: route.points[0][2],
        lastMs: null, bots: [], ghost: null, ghostGap: null, ghostLabel: '',
        lastStepIdx: -1,
        detector: null, msgUntil: 0, lastRank: [], camIdx: Math.max(0, L.CAMERAS.findIndex((c) => c.id === cfg.camera)),
        lastChart: 0, finishing: false, hidden: false,
        // rodillo mecánico y sensores
        trainer: trainerCfg, maxHr: (profile && profile.maxHr > 0) ? profile.maxHr : L.HR_MAX_DEFAULT,
        advisor: L.createLevelAdvisor({ flatLevel: trainerCfg.flatLevel }), levelFlashUntil: 0,
        dev: {}, devStatus: [], wheelKph: null, powerSource: 'sim', hrSource: null, unsubs: [],
        // pelotón e hidratación
        peloton: null, attack: null,
        hydTimer: !workout && hyd.enabled ? L.createHydrationTimer(hyd) : null, hydr: { active: false, remainingS: 0 }, simBeforeHyd: null,
      };
      ride.detector = L.createEventDetector({ mode, totalDistM: mode === 'route' ? route.distanceM : 0 });

      // ghost y bots (solo en modo ruta)
      if (mode === 'route') {
        const best = (store.get().bests || {})[route.id];
        if (cfg.ghost && best) {
          try {
            const boost = settings.ghostBoost || 0;
            ride.ghost = R.riders.createGhost(best, { boostPct: boost });
            ride.ghostLabel = 'Tu mejor marca' + (boost ? ' (+' + String(boost).replace('.', ',') + ' %)' : '');
          } catch (e) { say('No pudimos cargar tu mejor marca: ' + e.message, 'warn'); }
        }
        try {
          ride.peloton = R.riders.createPeloton({ count: botsCountOf(cfg.bots), ftp, massKg, route, seed: Math.floor(Date.now() / 60000), onAttack: onAttack });
          ride.bots = ride.peloton.bots;
        } catch (e) { say('No pudimos crear el pelotón: ' + e.message, 'warn'); }
      }

      // sensores reales (R.devices): la última lectura y el estado de conexión
      if (R.devices && R.devices.on) {
        ride.devStatus = R.devices.status ? R.devices.status() : [];
        const mine = ride;
        ride.unsubs.push(R.devices.on('data', (d) => { mine.dev = d || {}; }));
        ride.unsubs.push(R.devices.on('status', (list) => { mine.devStatus = list || []; }));
        // el modo del CSC (velocidad/cadencia) se conoce con el primer paquete: llega como 'cscMode', no como 'status'
        ride.unsubs.push(R.devices.on('cscMode', () => { mine.devStatus = R.devices.status ? R.devices.status() : mine.devStatus; }));
      }
      // simulador: respaldo sin sensores (y objetivo ERG de los entrenamientos)
      sim = R.devices.createSimulator({ ftp, maxHr: (profile && profile.maxHr) || undefined, massKg });
      sim.setTargetPower(workout ? R.training.targetPowerAt(workout, 0, ftp).watts : ride.simTarget);
      cleanups.push(sim.on('data', onData));
      sim.start();

      // coach: el audio se desbloquea aquí (clic en Comenzar) por la política de autoplay
      if (audio) { try { audio.dispose(); } catch (e) { /* nada */ } }
      const cs = R.coach.normalizeSettings(settings.coach);
      audio = R.coach.createAudio({ volume: cs.volume, voice: cs.voice, beeps: cs.beeps, natural: cs.natural });
      audio.unlock();
      muted = false;
      coach = R.coach.createCoach({ say: (t, o) => audio.say(t, o), beep: (k) => audio.beep(k), now: () => performance.now(), verbosity: cs.verbosity });

      phase = 'countdown';
      buildStage();
      noteBluetooth(); // después de buildStage(): este vacía root
      requestWake();
      runCountdown(3);
    }

    // Sin Web Bluetooth (p. ej. dentro de Claude): aviso breve, una vez por sesión.
    function noteBluetooth() {
      let has = false;
      try { has = typeof navigator !== 'undefined' && !!navigator.bluetooth; } catch (e) { has = false; }
      if (has) return;
      try { if (window.sessionStorage.getItem('rodillator.hud.btnote') === '1') return; window.sessionStorage.setItem('rodillator.hud.btnote', '1'); } catch (e) { /* sin sessionStorage */ }
      say(BT_NOTE, 'info');
    }

    // Callback del pelotón: evento del coach, banner y mensaje.
    function onAttack(phase, info) {
      if (!ride) return;
      const gapS = info && info.gapS != null ? info.gapS : 0;
      if (phase === 'start') ride.attack = { gapS };
      else if (phase === 'end') ride.attack = null;
      if (coach) coach.event('attack', { phase, gapS });
      if (stage && phase === 'caught') showMessage('¡Bien! Sigues con el grupo.', 'good');
      else if (stage && phase === 'dropped') showMessage('Se te escapó el grupo: ¡vamos!', 'bad');
    }

    function onData(d) {
      // en pausa y en la cuenta regresiva la lectura queda congelada
      if (ride && phase === 'ride' && !ride.paused) ride.latest = d;
    }

    function requestWake() {
      try {
        if (navigator.wakeLock && navigator.wakeLock.request) {
          navigator.wakeLock.request('screen').then((l) => { if (disposed) { try { l.release(); } catch (e) { /* nada */ } } else wakeLock = l; }).catch(() => {});
        }
      } catch (e) { /* sin WakeLock */ }
    }
    function releaseWake() { try { if (wakeLock) wakeLock.release().catch(() => {}); } catch (e) { /* nada */ } wakeLock = null; }

    // ---------- DOM del HUD ----------
    function buildStage() {
      root.className = 'rd rd--stage';
      root.textContent = '';
      const sceneEl = h('div', { class: 'rd-scene' });
      root.appendChild(sceneEl);
      root.classList.toggle('rd--wk', !!ride.workout);
      root.classList.toggle('rd--ghost', !!ride.ghost);
      root.classList.remove('has-hr', 'has-alert', 'has-alert-2'); root._hasAlert2 = false;
      root._hasHr = false; root._hasAlert = false; root._sensor = false; root.classList.remove('is-sensor');
      root.classList.toggle('is-more', moreOpen);
      // doble toque sobre la vista 3D = cambiar de cámara
      const dtap = L.createDoubleTap(320, 36);
      const active = new Set();
      let multi = false;   // hubo más de un puntero activo: no cuenta como toque
      sceneEl.addEventListener('pointerdown', (e) => { active.add(e.pointerId); if (active.size > 1) multi = true; });
      sceneEl.addEventListener('pointercancel', (e) => { active.delete(e.pointerId); if (!active.size) multi = false; dtap.reset(); });
      sceneEl.addEventListener('pointerup', (e) => {
        active.delete(e.pointerId);
        const wasMulti = multi;
        if (!active.size) multi = false;
        if (wasMulti) { dtap.reset(); return; }
        if (e.button > 0) return;
        if (dtap.tap(performance.now(), e.clientX, e.clientY)) cycleCamera();
      });
      try {
        if (R.Scene3D && R.Scene3D.isSupported()) {
          scene = R.Scene3D.create(sceneEl, ride.route, { quality: (R.store.normalizeGraphicsQuality || String)(settings.graphicsQuality || 'auto') });
          scene.setCameraMode(L.CAMERAS[ride.camIdx].id);
        } else scene = createFallbackView(sceneEl, ride.route);
      } catch (e) {
        scene = createFallbackView(sceneEl, ride.route);
        say('No pudimos iniciar la vista 3D; usamos el perfil de la ruta.', 'warn');
      }
      const S = stage = {};
      S.sceneEl = sceneEl;
      const m = (label, unit) => {
        const v = h('b', { class: 'rd-m-v', text: '–' });
        return { el: h('div', { class: 'rd-m' }, [h('span', { class: 'rd-m-l', text: label }), h('span', { class: 'rd-m-row' }, [v, unit ? h('small', { text: unit }) : null])]), v };
      };
      // potencia
      S.power = h('b', { class: 'rd-pw-n', text: '0' });
      S.zone = h('span', { class: 'rd-pw-zone', text: 'Z1 Recuperación' });
      S.wkg = h('span', { class: 'rd-pw-wkg', text: '0,00 W/kg' });
      S.ladder = h('div', { class: 'rd-ladder', role: 'img', 'aria-label': 'Zonas de potencia' });
      S.segFill = [];
      const MAXP = 170, bounds = [0, 55, 75, 90, 105, 120, 150, 170];
      for (let i = 0; i < 7; i++) {
        const fill = h('i');
        fill.style.background = zones[i].color;
        const seg = h('span', { class: 'rd-seg' }, fill);
        seg.style.flexGrow = String(bounds[i + 1] - bounds[i]);
        seg.style.setProperty('--zc', zones[i].color);
        S.ladder.appendChild(seg);
        S.segFill.push(fill);
      }
      S.bounds = bounds; S.maxp = MAXP;
      S.notch = h('em', { class: 'rd-notch' });
      S.ladder.appendChild(S.notch);
      S.target = h('div', { class: 'rd-target' });
      S.tNow = h('b', { text: '' }); S.tInfo = h('span', { text: '' }); S.tNext = h('span', { class: 'rd-t-next', text: '' });
      S.target.appendChild(h('div', { class: 'rd-t-top' }, [S.tNow, S.tInfo]));
      S.target.appendChild(S.tNext);
      const powerBox = h('section', { class: 'rd-panel rd-power' }, [
        h('div', { class: 'rd-pw-row' }, [S.power, h('small', { text: 'W' })]),
        h('div', { class: 'rd-pw-meta' }, [S.zone, S.wkg]), S.ladder,
        ride.workout ? S.target : null,
      ]);
      // brecha
      S.gapN = h('b', { class: 'rd-gap-n', text: '0 s' });
      S.gapT = h('span', { class: 'rd-gap-t', text: '' });
      S.gap = h('div', { class: 'rd-gap', 'aria-live': 'polite' }, [S.gapN, S.gapT]);
      // tabla
      S.rows = [];
      S.board = h('ol', { class: 'rd-board', 'aria-label': 'Posiciones' });
      for (let i = 0; i < 5; i++) {
        const dot = h('i'), name = h('span', { class: 'rd-r-name' }), gap = h('span', { class: 'rd-r-gap' });
        const li = h('li', {}, [h('span', { class: 'rd-r-pos' }), dot, name, gap]);
        S.board.appendChild(li);
        S.rows.push({ li, pos: li.firstChild, dot, name, gap });
      }
      S.msg = h('div', { class: 'rd-msg', 'aria-live': 'polite' });
      // métricas
      S.mCad = m('Cadencia', 'rpm'); S.mHr = m('FC', 'ppm'); S.mSpd = m('Velocidad', 'km/h'); S.mDist = m('Distancia', 'km');
      S.distOf = h('i', { class: 'rd-m-of', text: '' });
      S.mDist.el.querySelector('.rd-m-row').insertBefore(S.distOf, S.mDist.el.querySelector('small'));
      S.mTime = m('Tiempo', ''); S.mGrade = m('Pendiente', '%'); S.mKj = m('Trabajo', 'kJ');
      S.mHr.el.classList.add('rd-m--hr'); S.mGrade.el.classList.add('rd-m--grade');
      S.arrow = h('span', { class: 'rd-arrow', text: '→' });
      S.mGrade.el.querySelector('.rd-m-row').insertBefore(S.arrow, S.mGrade.v);
      const metrics = h('div', { class: 'rd-metrics' }, [S.mTime.el, S.mDist.el, S.mSpd.el, S.mGrade.el, S.mCad.el, S.mHr.el, S.mKj.el]);
      // gráficos
      S.profCv = h('canvas', { class: 'rd-cv rd-cv-prof', 'aria-label': 'Perfil de elevación con las posiciones' });
      S.wkCv = ride.workout ? h('canvas', { class: 'rd-cv rd-cv-wk', 'aria-label': 'Intervalos del entrenamiento y potencia real' }) : null;
      const charts = h('div', { class: 'rd-charts' }, [S.wkCv, S.profCv]);
      // controles
      const cbtn = (ic, label, fn, cls) => h('button', { type: 'button', class: 'rd-ctl ' + (cls || ''), 'aria-label': label, title: label, onclick: fn }, icon(ic));
      S.pauseBtn = cbtn('pause', 'Pausar (Espacio)', () => togglePause());
      S.minusBtn = cbtn('minus', ride.workout ? 'Bajar intensidad 5 % (↓)' : 'Bajar 10 W (↓)', () => adjust(-1));
      S.plusBtn = cbtn('plus', ride.workout ? 'Subir intensidad 5 % (↑)' : 'Subir 10 W (↑)', () => adjust(1));
      S.camBtn = cbtn('camera', 'Cambiar cámara (C). Actual: ' + L.CAMERAS[ride.camIdx].label, () => cycleCamera(), 'rd-ctl--cam');
      S.camCap = h('span', { class: 'rd-ctl-cap', text: L.CAMERAS[ride.camIdx].short });
      S.camBtn.title = 'Cambiar cámara (C)';
      S.camBtn.appendChild(S.camCap);
      S.muteBtn = cbtn('spk', 'Silenciar coach (M)', () => toggleMute());
      S.endBtn = cbtn('stop', 'Terminar rodada', () => askFinish(), 'rd-ctl--end');
      S.pauseBtn.classList.add('rd-o1'); S.plusBtn.classList.add('rd-o2'); S.minusBtn.classList.add('rd-o3');
      S.muteBtn.classList.add('rd-o6'); S.endBtn.classList.add('rd-o7');
      S.adj = h('span', { class: 'rd-adj', text: '' });
      S.slider = ride.workout ? null : h('input', {
        type: 'range', class: 'rd-slider', min: '0', max: String(Math.round(ftp * 2)), step: '5', value: String(ride.simTarget),
        'aria-label': 'Potencia objetivo del simulador', oninput: (e) => { if (sim) sim.setTargetPower(Number(e.target.value)); },
      });
      const controls = h('div', { class: 'rd-controls' }, [S.pauseBtn, S.minusBtn, S.plusBtn, S.adj, S.camBtn, S.muteBtn, S.endBtn, S.slider]);
      S.controls = controls;
      // nivel del rodillo mecánico: número + barra de 8 segmentos + −/+ (nivel real si no se siguió la sugerencia)
      S.lvlN = h('b', { class: 'rd-lvl-n', text: String(ride.advisor.level) });
      S.lvlBar = h('span', { class: 'rd-lvl-bar', 'aria-hidden': 'true' });
      S.lvlSegs = [];
      for (let i = 1; i <= L.LEVELS; i++) { const seg = h('i', { 'data-l': String(i) }); S.lvlBar.appendChild(seg); S.lvlSegs.push(seg); }
      S.lvlHint = h('span', { class: 'rd-lvl-h', text: 'Sugerido' });
      S.lvlMinus = h('button', { type: 'button', class: 'rd-lvl-b rd-lvl-b--minus', 'aria-label': 'Bajé la palanca un nivel', title: 'Bajé la palanca un nivel', onclick: () => manualLevel(-1) }, icon('minus'));
      S.lvlPlus = h('button', { type: 'button', class: 'rd-lvl-b rd-lvl-b--plus', 'aria-label': 'Subí la palanca un nivel', title: 'Subí la palanca un nivel', onclick: () => manualLevel(1) }, icon('plus'));
      S.lvl = h('section', { class: 'rd-panel rd-lvl', role: 'group', 'aria-label': 'Nivel del rodillo' }, [
        h('span', { class: 'rd-lvl-l', text: 'Nivel' }),
        h('span', { class: 'rd-lvl-v', role: 'status', 'aria-live': 'polite' }, [S.lvlN, h('small', { class: 'rd-lvl-of', text: '/8' })]),
        S.lvlBar, S.lvlHint, S.lvlPlus, S.lvlMinus,
      ]);
      // avisos de ataque e hidratación (bajo la barra superior, sin tapar al ciclista)
      const banner = (cls) => { const t = h('b'), sub = h('span'); return { el: h('div', { class: 'rd-alert ' + cls, role: 'status', hidden: true }, [t, sub]), t, sub }; };
      S.atk = banner('rd-alert--attack');
      S.hyd = banner('rd-alert--hydrate');
      S.alerts = h('div', { class: 'rd-alerts', 'aria-live': 'polite' }, [S.hyd.el, S.atk.el]);
      S.paused = h('div', { class: 'rd-paused', hidden: true }, [h('b', { text: 'En pausa' }), h('span', { text: 'Espacio para seguir' })]);
      S.count = h('div', { class: 'rd-count', 'aria-live': 'assertive' });
      // píldora de posiciones (solo móvil) y botón "Más datos" (solo móvil)
      S.pill = h('button', { type: 'button', class: 'rd-pill', 'aria-expanded': 'false', 'aria-label': 'Posiciones. Abrir tabla', onclick: () => toggleBoard() });
      S.moreBtn = h('button', { type: 'button', class: 'rd-more', 'aria-expanded': moreOpen ? 'true' : 'false', onclick: () => toggleMore() });
      S.top = h('div', { class: 'rd-top' }, [powerBox, ride.ghost ? S.gap : null, metrics]);
      root.appendChild(h('div', { class: 'rd-hud' }, [
        S.top, S.pill, S.moreBtn, h('div', { class: 'rd-right' }, [S.lvl, S.board, controls]), S.alerts, S.msg, h('div', { class: 'rd-bottom' }, [charts]),
      ]));
      S.charts = charts;
      setMoreLabel();
      if (typeof ResizeObserver !== 'undefined') {
        if (layoutRO) layoutRO.disconnect();
        layoutRO = new ResizeObserver(() => { if (stage && scene) syncLayout(false); });
        [sceneEl, S.top, S.controls, S.lvl, S.charts.parentNode].forEach((el) => layoutRO.observe(el));
      }
      root.appendChild(S.paused);
      root.appendChild(S.count);
      if (!ride.ghost) S.gap.hidden = true;
      // fondo del gráfico de perfil / intervalos
      S.prof = R.routes.profile(ride.route, 300);
      S.minE = Math.min.apply(null, S.prof.map((p) => p.ele));
      S.maxE = Math.max.apply(null, S.prof.map((p) => p.ele));
      S.profCache = null; S.wkCache = null;
      syncLayout(true);
      scene.setRiders(sceneRiders());
      scene.render(0.016);
    }

    function runCountdown(n) {
      if (disposed) return;
      const c = stage.count;
      c.classList.add('is-on');
      if (coach) coach.event('start', { n });
      if (n <= 0) {
        c.textContent = '¡Rueda!';
        c.classList.add('go');
        later(() => { c.classList.remove('is-on', 'go'); c.textContent = ''; }, 700);
        phase = 'ride';
        ride.startedAt = new Date().toISOString();
        ride.lastMs = performance.now();
        startLoop();
        return;
      }
      c.textContent = String(n);
      c.classList.remove('pop'); void c.offsetWidth; c.classList.add('pop');
      // la escena se sigue dibujando durante la cuenta
      scene.render(0.016);
      later(() => runCountdown(n - 1), 900);
    }

    function startLoop() {
      const frame = (now) => { rafId = 0; if (disposed || !ride || ride.over) return; tick(now); rafId = requestAnimationFrame(frame); };
      rafId = requestAnimationFrame(frame);
      hiddenIv = setInterval(() => { if (document.hidden && ride && !ride.over && !disposed) tick(performance.now()); }, 250);
    }

    function riderList() {
      const r = ride;
      const list = [{ id: 'user', name: (profile && profile.name) || 'Tú', label: (profile && profile.name) || 'Tú', kind: 'user', color: ACCENT, distM: r.distM, speedMps: r.v }];
      if (r.ghost) list.push({ id: 'ghost', name: r.ghostLabel, label: r.ghostLabel, kind: 'ghost', color: GHOST, distM: r.ghost.distAt(r.tS), speedMps: L.ghostSpeed(r.ghost, r.tS) });
      r.bots.forEach((b) => list.push({ id: b.id, name: b.name, label: b.label, kind: 'bot', color: BOT, distM: b.distM, speedMps: b.speedMps }));
      return list;
    }
    function sceneRiders() {
      const len = ride.route.distanceM;
      // cadenceRpm: solo el usuario (cadencia del simulador o sensor); bots y fantasma la estima la escena
      return riderList().map((x) => ({
        id: x.id, name: x.name, label: x.label, kind: x.kind, color: x.color, distM: ride.mode === 'route' ? x.distM : x.distM % len,
        cadenceRpm: x.kind === 'user' && ride.cad != null ? (ride.paused ? 0 : ride.cad) : undefined
      }));
    }

    function currentTarget() {
      if (!ride.workout) return null;
      return R.training.targetPowerAt(ride.workout, Math.min(ride.tS, ride.workout.durationS), ftp);
    }

    function tick(nowMs) {
      const r = ride;
      let dt = r.lastMs == null ? 0 : (nowMs - r.lastMs) / 1000;
      r.lastMs = nowMs;
      dt = clamp(dt, 0, 1.5);
      if (!r.paused && phase === 'ride' && !r.finishing) advance(dt, nowMs);
      if (r.over) return;
      if (r.paused && coach) coach.update({ paused: true });
      updateHud(nowMs);
      if (!document.hidden) {
        scene.setRiders(sceneRiders());
        scene.render(Math.min(dt || 0.016, 0.1));
      }
    }

    function advance(dt, nowMs) {
      const r = ride;
      r.tS += dt;

      // entrenamiento: ERG
      let tp = null;
      if (r.workout) {
        tp = R.training.targetPowerAt(r.workout, Math.min(r.tS, r.workout.durationS), ftp);
        const want = Math.round(tp.watts * r.intensity);
        if (sim && sim.getTargetPower() !== want) sim.setTargetPower(want);
        r.lastStepIdx = tp.stepIndex;
      }

      // hidratación: paso del entrenamiento o temporizador de la rodada libre
      updateHydration(tp);

      // nivel sugerido del rodillo (la app solo sugiere; el usuario mueve la palanca)
      const len = r.route.distanceM;
      const lvl = r.advisor.update({
        tS: r.tS,
        gradePct: tp ? null : L.smoothedGrade(r.route, r.distM, 150, r.mode !== 'route'),
        targetW: tp ? Math.round(tp.watts * r.intensity) : null,
        cadenceRpm: tp && tp.step && tp.step.cadence > 0 ? tp.step.cadence : 90,
        ftp, wheelCircMm: r.trainer.wheelCircMm, powerScale: r.trainer.powerScale,
        attacking: !!(r.peloton && r.peloton.state.attacking), hydrating: r.hydr.active,
      });
      if (lvl) {
        r.levelFlashUntil = nowMs + 2500;
        if (coach) coach.event('resistance', lvl);
      }

      // datos: sensores reales si los hay (potencia virtual con el nivel actual), si no el simulador
      const rd = L.readings({ sim: r.latest || {}, dev: r.dev, status: r.devStatus, level: r.advisor.level, powerScale: r.trainer.powerScale });
      r.power = rd.powerW; r.hr = rd.hr; r.cad = rd.cad;
      r.wheelKph = rd.wheelKph; r.powerSource = rd.powerSource; r.hrSource = rd.hrSource;

      // física
      const s = R.routes.sampleAt(r.route, r.mode === 'route' ? Math.min(r.distM, len) : r.distM % len);
      r.grade = s.gradePct; r.ele = s.ele;
      const v0 = r.v;
      r.v = R.physics.step({ v: v0, powerW: r.power, gradePct: s.gradePct, massKg, altitudeM: s.ele, dt });
      r.distM += ((v0 + r.v) / 2) * dt;
      r.kJ += (r.power * dt) / 1000;
      let reachedEnd = false;
      if (r.mode === 'route' && r.distM >= len) { r.distM = len; reachedEnd = true; }

      // pelotón y fantasma
      if (r.peloton) { r.peloton.update(dt, r.tS, r.distM); if (r.attack) r.attack.gapS = r.peloton.state.gapS; }
      else r.bots.forEach((b) => b.update(dt, r.tS));
      r.ghostGap = r.ghost ? L.ghostGapS(r.ghost, r.distM, r.tS) : null;

      // muestreo 1 Hz
      r.sampler.advance(r.tS, { powerW: r.power, hr: r.hr, cadence: r.cad, speedMps: r.v, distM: r.distM, eleM: s.ele });

      // mensajes
      const step = tp ? { index: tp.stepIndex, label: tp.step.label || ('Paso ' + (tp.stepIndex + 1)), watts: Math.round(tp.step.powerPct * ftp / 100 * r.intensity), durationS: tp.step.durationS, isLast: tp.stepIndex === r.workout.steps.length - 1 } : null;
      const ev = r.detector.update({ tS: r.tS, distM: r.distM, step, ghostGapS: r.ghostGap });
      if (coach) {
        ev.forEach((e) => { if (e.key === 'ghost-pass') coach.event('ghostPassed'); else if (e.key === 'ghost-lost') coach.event('ghostOvertook'); });
        coach.update({
          mode: r.mode, tS: r.tS, paused: false, workout: r.workout, ftp, stepIndex: tp ? tp.stepIndex : null,
          stepElapsedS: tp ? tp.stepElapsedS : 0, stepRemainingS: tp ? tp.stepRemainingS : 0, targetW: tp ? tp.watts : 0,
          powerW: r.power, gradePct: r.grade, distM: r.distM, routeLenM: len, speedMps: r.v, intensity: r.intensity,
          workoutRemainingS: r.workout ? r.workout.durationS - r.tS : 0,
        });
      }
      if (ev.length) showMessage(ev[ev.length - 1].text, ev[0].key.indexOf('ghost') === 0 ? (ev[0].key === 'ghost-pass' ? 'good' : 'bad') : '');

      if (reachedEnd) finishRide(true);
      else if (r.workout && r.tS >= r.workout.durationS) finishRide(true);
    }

    // Pausa de hidratación (no detiene el cronómetro: es pedaleo suave).
    function updateHydration(tp) {
      const r = ride;
      const was = r.hydr.active;
      let st;
      if (tp) st = { active: !!(tp.step && tp.step.hydrate), remainingS: tp.stepRemainingS, durationS: tp.step ? tp.step.durationS : 0 };
      else if (r.hydTimer) st = r.hydTimer.update(r.tS);
      else return;
      r.hydr = { active: st.active, remainingS: st.remainingS };
      if (st.active && !was) {
        if (coach) coach.event('hydrate', { durationS: Math.round(st.durationS) });
        // rodada libre con el simulador: pedaleo suave durante la pausa
        if (!tp && sim && r.powerSource === 'sim') { r.simBeforeHyd = sim.getTargetPower(); sim.setTargetPower(Math.round(0.5 * ftp)); }
      } else if (!st.active && was) {
        // solo si el objetivo sigue siendo el de la pausa (si el usuario lo cambió, se respeta)
        if (r.simBeforeHyd != null && sim && sim.getTargetPower() === Math.round(0.5 * ftp)) sim.setTargetPower(r.simBeforeHyd);
        r.simBeforeHyd = null;
      }
    }

    // El usuario indica el nivel real de la palanca (si no siguió la sugerencia).
    function manualLevel(sign) {
      if (!ride || phase !== 'ride') return;
      ride.advisor.manual(sign);
      if (stage) updateLevel(performance.now());
    }

    function showMessage(text, tone) {
      const el = stage.msg;
      el.textContent = text;
      el.className = 'rd-msg is-on' + (tone ? ' rd-msg--' + tone : '');
      ride.msgUntil = performance.now() + 5000;
    }

    // ---------- HUD ----------
    function updateHud(nowMs) {
      const r = ride, S = stage;
      if (r.msgUntil && nowMs > r.msgUntil) { r.msgUntil = 0; S.msg.classList.remove('is-on'); }
      const p = Math.round(r.power);
      const z = R.training.zoneFor(p, ftp);
      const zc = zones[z - 1];
      setText(S.power, String(p));
      setVar(S.power.closest('.rd-power'), '--zc', zc.color);
      setText(S.zone, 'Z' + z + ' ' + zc.name);
      setText(S.wkg, (p / weightKg).toFixed(2).replace('.', ',') + ' W/kg');
      const pct = (p / ftp) * 100;
      for (let i = 0; i < 7; i++) {
        const lo = S.bounds[i], hi = S.bounds[i + 1];
        setStyle(S.segFill[i], 'width', Math.round(clamp((pct - lo) / (hi - lo), 0, 1) * 100) + '%');
      }

      if (r.workout) {
        const tp = currentTarget();
        const want = Math.round(tp.watts * r.intensity);
        setStyle(S.notch, 'left', (clamp((want / ftp) * 100, 0, S.maxp) / S.maxp) * 100 + '%');
        S.notch.classList.add('is-on');
        setText(S.tNow, 'Objetivo ' + want + ' W');
        setText(S.tInfo, (tp.step.label || 'Paso') + ' · ' + L.fmtTime(tp.stepRemainingS) + ' restantes · ' + (tp.stepIndex + 1) + '/' + r.workout.steps.length);
        const nx = r.workout.steps[tp.stepIndex + 1];
        setText(S.tNext, nx ? 'Sigue: ' + (nx.label || 'siguiente paso') + ' ' + Math.round(nx.powerPct * ftp / 100 * r.intensity) + ' W' : 'Último paso');
        setText(S.adj, Math.round(r.intensity * 100) + ' %');
      } else if (r.powerSource === 'csc' || r.powerSource === 'device') {
        setText(S.adj, 'Sensor'); // la potencia sale de la rueda: el objetivo del simulador no se usa
      } else if (sim) {
        const tw = sim.getTargetPower();
        setText(S.adj, tw + ' W');
        if (S.slider && S.slider !== document.activeElement && S.slider._val !== tw) { S.slider._val = tw; S.slider.value = String(tw); }
      }

      // métricas
      setText(S.mTime.v, L.fmtTime(r.tS));
      setText(S.mDist.v, L.fmtKm(r.distM));
      setText(S.distOf, r.mode === 'route' ? ' / ' + L.fmtKm(r.route.distanceM) : '');
      setText(S.mSpd.v, (r.v * 3.6).toFixed(1).replace('.', ','));
      setText(S.mGrade.v, r.grade.toFixed(1).replace('.', ',').replace('-', MINUS_CH));
      setText(S.arrow, L.gradeArrow(r.grade));
      S.arrow.className = 'rd-arrow ' + (r.grade > 1 ? 'up' : r.grade < -1 ? 'down' : 'flat');
      setText(S.mCad.v, r.cad != null ? String(Math.round(r.cad)) : '–');
      setText(S.mHr.v, r.hr != null ? String(Math.round(r.hr)) : '–');
      // FC de la banda con color por zona (% de la FC máxima del perfil, 186 por defecto)
      const hz = r.hrSource === 'hr' ? L.hrZone(r.hr, r.maxHr) : null;
      setStyle(S.mHr.v, 'color', hz ? hz.color : '');
      if (S.mHr.el._z !== (hz ? hz.zone : 0)) {
        S.mHr.el._z = hz ? hz.zone : 0;
        S.mHr.el.title = hz ? 'Zona ' + hz.zone + ' de FC (' + hz.name + ')' : '';
      }
      const sensorPower = (r.powerSource === 'csc' || r.powerSource === 'device') && !r.workout;
      if (root._sensor !== sensorPower) { root._sensor = sensorPower; root.classList.toggle('is-sensor', sensorPower); }
      if (root._hasHr !== (r.hrSource === 'hr')) { root._hasHr = r.hrSource === 'hr'; root.classList.toggle('has-hr', root._hasHr); }
      updateLevel(nowMs);
      updateAlerts();
      setText(S.mKj.v, String(Math.round(r.kJ)));

      // brecha y tabla
      const list = riderList();
      const ranked = R.riders.ranking(list);
      const rows = L.windowAround(ranked, 'user', 5);
      for (let i = 0; i < 5; i++) {
        const row = S.rows[i], d = rows[i];
        if (!d) { row.li.hidden = true; continue; }
        row.li.hidden = false;
        setText(row.pos, String(d.pos));
        setStyle(row.dot, 'background', d.color);
        setText(row.name, d.id === 'user' ? d.name + ' (tú)' : d.name);
        setText(row.gap, d.pos === 1 ? 'líder' : '+' + Math.round(d.gapS) + ' s');
        row.li.className = d.kind === 'user' ? 'is-user' : d.kind === 'ghost' ? 'is-ghost' : '';
      }
      setText(S.pill, L.positionPill(ranked, 'user', r.ghost ? r.ghostGap : null));
      updatePillLabel();
      setText(S.camCap, L.CAMERAS[r.camIdx].short);
      if (r.ghost && r.ghostGap != null) {
        const g = r.ghostGap, a = Math.abs(g);
        setText(S.gapN, L.fmtGap(g));
        S.gap.className = 'rd-gap ' + (g < -0.5 ? 'is-ahead' : g > 0.5 ? 'is-behind' : 'is-even');
        setText(S.gapT, g < -0.5 ? '¡Vas ' + Math.round(a) + ' s por delante de tu mejor marca!' : g > 0.5 ? 'Vas ' + Math.round(a) + ' s detrás de tu mejor marca' : 'Al ritmo de tu mejor marca');
      }

      // gráficos (≈ 8 Hz)
      if (!layoutRO && nowMs - (r.lastLayout || 0) > 500) { r.lastLayout = nowMs; syncLayout(false); } // sin ResizeObserver
      if (nowMs - r.lastChart > 120) { r.lastChart = nowMs; drawProfile(list); if (r.workout) drawWorkoutChart(); }
    }
    const MINUS_CH = L.fmtGap(-5)[0]; // U+2212

    function updateLevel(nowMs) {
      const r = ride, S = stage;
      if (!r || !S || !S.lvl) return;
      const lv = r.advisor.level, sug = r.advisor.suggested;
      setText(S.lvlN, String(lv));
      if (S.lvl._lv !== lv) {
        S.lvl._lv = lv;
        S.lvlSegs.forEach((seg, i) => seg.classList.toggle('is-on', i < lv));
        S.lvl.setAttribute('data-level', String(lv));
        S.lvlMinus.disabled = lv <= 1;
        S.lvlPlus.disabled = lv >= L.LEVELS;
      }
      const manual = sug != null && lv !== sug;
      setText(S.lvlHint, manual ? 'Sugerido ' + sug : 'Sugerido');
      S.lvl.classList.toggle('is-manual', manual);
      S.lvl.classList.toggle('is-new', nowMs < r.levelFlashUntil);
    }

    function updateAlerts() {
      const r = ride, S = stage;
      const atkOn = !!r.attack, hydOn = !!(r.hydr && r.hydr.active);
      if (S.atk.el.hidden === atkOn) S.atk.el.hidden = !atkOn;
      if (S.hyd.el.hidden === hydOn) S.hyd.el.hidden = !hydOn;
      if (atkOn) {
        setText(S.atk.t, '¡Ataque! Sigue al grupo');
        const g = r.attack.gapS || 0;
        // brecha con el grupo en s (+ = el grupo va delante)
        setText(S.atk.sub, Math.abs(g) < 0.5 ? 'con el grupo' : g > 0 ? L.fmtGap(g) : Math.round(-g) + ' s por delante');
      }
      if (hydOn) {
        setText(S.hyd.t, 'Hidrátate');
        setText(S.hyd.sub, L.fmtTime(Math.ceil(r.hydr.remainingS)) + ' · pedaleo suave');
      }
      const any = atkOn || hydOn;
      if (root._hasAlert !== any) { root._hasAlert = any; root.classList.toggle('has-alert', any); }
      const two = atkOn && hydOn;
      if (root._hasAlert2 !== two) { root._hasAlert2 = two; root.classList.toggle('has-alert-2', two); }
    }

    function drawProfile(list) {
      const S = stage, f = fitCanvas(S.profCv), g = f.g, w = f.w, hh = f.h;
      const key = w + 'x' + hh;
      if (!S.profCache || S.profCache.key !== key) {
        const off = document.createElement('canvas'); off.width = S.profCv.width; off.height = S.profCv.height;
        const og = off.getContext('2d'); const dpr = off.width / w; og.setTransform(dpr, 0, 0, dpr, 0, 0);
        const span = Math.max(1, S.maxE - S.minE), top = Math.min(14, Math.round(hh * 0.25)), bot = hh - 4;
        const X = (d) => 6 + (d / ride.route.distanceM) * (w - 12), Y = (e) => bot - ((e - S.minE) / span) * (bot - top);
        og.beginPath(); og.moveTo(X(0), hh);
        S.prof.forEach((p) => og.lineTo(X(p.distM), Y(p.ele)));
        og.lineTo(X(ride.route.distanceM), hh); og.closePath();
        const gr = og.createLinearGradient(0, top, 0, hh); gr.addColorStop(0, 'rgba(238,243,247,.30)'); gr.addColorStop(1, 'rgba(238,243,247,.04)');
        og.fillStyle = gr; og.fill();
        og.beginPath(); S.prof.forEach((p, i) => (i ? og.lineTo(X(p.distM), Y(p.ele)) : og.moveTo(X(p.distM), Y(p.ele))));
        og.strokeStyle = 'rgba(238,243,247,.7)'; og.lineWidth = 1.5; og.stroke();
        S.profCache = { key, canvas: off, X, Y };
      }
      g.clearRect(0, 0, w, hh);
      g.drawImage(S.profCache.canvas, 0, 0, w, hh);
      const len = ride.route.distanceM;
      const order = list.slice().sort((a, b) => (a.kind === 'user') - (b.kind === 'user') || (a.kind === 'ghost') - (b.kind === 'ghost'));
      order.forEach((x) => {
        const d = ride.mode === 'route' ? Math.min(len, x.distM) : x.distM % len;
        const e = R.routes.sampleAt(ride.route, d).ele;
        const px = S.profCache.X(d), py = S.profCache.Y(e);
        g.beginPath(); g.arc(px, py, x.kind === 'user' ? 6 : x.kind === 'ghost' ? 5 : 3.5, 0, Math.PI * 2);
        g.fillStyle = x.color; g.fill();
        if (x.kind !== 'bot') { g.lineWidth = 2; g.strokeStyle = '#0D1319'; g.stroke(); }
      });
    }

    function drawWorkoutChart() {
      const S = stage, r = ride, w0 = r.workout, f = fitCanvas(S.wkCv), g = f.g, w = f.w, hh = f.h;
      g.clearRect(0, 0, w, hh);
      const total = w0.durationS, maxPct = Math.max(130, Math.max.apply(null, w0.steps.map((s) => Math.max(s.powerPct, s.powerPctEnd || 0)))) + 5;
      const X = (t) => (t / total) * w, Y = (pct) => hh - 2 - (pct / maxPct) * (hh - 6);
      let t = 0;
      w0.steps.forEach((s) => {
        const e = s.powerPctEnd != null ? s.powerPctEnd : s.powerPct;
        const col = zoneColor(zones, ((s.powerPct + e) / 2) * ftp / 100, ftp);
        g.beginPath(); g.moveTo(X(t), hh); g.lineTo(X(t), Y(s.powerPct)); g.lineTo(X(t + s.durationS), Y(e)); g.lineTo(X(t + s.durationS), hh); g.closePath();
        g.globalAlpha = t + s.durationS <= r.tS ? 0.35 : 0.85; g.fillStyle = col; g.fill();
        t += s.durationS;
      });
      g.globalAlpha = 1;
      // potencia real (suavizada 5 s)
      const smp = r.sampler.samples;
      if (smp.length > 1) {
        g.beginPath();
        const n = smp.length;
        for (let i = 0; i < n; i++) {
          let acc = 0, c = 0;
          for (let k = Math.max(0, i - 4); k <= i; k++) { acc += smp[k][1]; c++; }
          const x = X(smp[i][0]), y = Y(((acc / c) / ftp) * 100);
          if (i) g.lineTo(x, y); else g.moveTo(x, y);
        }
        g.strokeStyle = '#FFFFFF'; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
      }
      const px = X(Math.min(r.tS, total));
      g.fillStyle = ACCENT; g.fillRect(px - 1, 0, 2, hh);
    }

    // ---------- controles ----------
    function togglePause(force) {
      if (!ride || phase !== 'ride') return;
      ride.paused = force != null ? force : !ride.paused;
      stage.paused.hidden = !ride.paused;
      stage.pauseBtn.firstChild.innerHTML = ICON[ride.paused ? 'play' : 'pause'];
      stage.pauseBtn.setAttribute('aria-label', ride.paused ? 'Reanudar (Espacio)' : 'Pausar (Espacio)');
      if (audio && ride.paused) { try { audio.stop(); } catch (e) { /* nada */ } } // corta lo programado antes del aviso de pausa
      if (coach) coach.event(ride.paused ? 'pause' : 'resume');
    }

    function toggleMute() {
      if (!audio || !stage) return;
      muted = !muted;
      const cs = R.coach.normalizeSettings(settings.coach);
      audio.setEnabled({ voice: !muted && cs.voice, beeps: !muted && cs.beeps, natural: cs.natural });
      stage.muteBtn.firstChild.innerHTML = ICON[muted ? 'spkOff' : 'spk'];
      stage.muteBtn.setAttribute('aria-label', muted ? 'Activar coach (M)' : 'Silenciar coach (M)');
      stage.muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
    }

    function adjust(sign) {
      if (!ride || phase !== 'ride') return;
      if (ride.workout) {
        ride.intensity = clamp(Math.round((ride.intensity + sign * 0.05) * 100) / 100, 0.5, 1.5);
      } else if (sim) {
        sim.nudge(sign * 10);
      }
    }

    function cycleCamera() {
      if (!ride) return;
      ride.camIdx = (ride.camIdx + 1) % L.CAMERAS.length;
      try { scene.setCameraMode(L.CAMERAS[ride.camIdx].id); } catch (e) { /* fallback 2D */ }
      if (stage) setText(stage.camCap, L.CAMERAS[ride.camIdx].short);
      if (stage) stage.camBtn.setAttribute('aria-label', 'Cambiar cámara (C). Actual: ' + L.CAMERAS[ride.camIdx].label);
      if (!scene.isFallback && !isMobile()) say('Cámara: ' + L.CAMERAS[ride.camIdx].label, 'info');
    }

    const askState = { wasPaused: false };
    function askFinish() {
      if (!ride || phase !== 'ride' || ride.finishing) return;
      const wasPaused = ride.paused;
      askState.wasPaused = wasPaused;
      togglePause(true);
      dialog({
        title: '¿Terminar la rodada?',
        body: h('p', { text: 'Llevas ' + L.fmtTime(ride.tS) + ' y ' + L.fmtKm(ride.distM) + ' km. Puedes guardarla, descartarla o seguir.' }),
        actions: [
          { label: 'Seguir rodando', kind: 'primary', onClick: () => { if (!wasPaused) togglePause(false); } },
          { label: 'Descartar', kind: 'danger', onClick: () => discard() },
          { label: 'Terminar y guardar', kind: 'ghost', onClick: () => finishRide(false) },
        ],
        onClose: () => {},
      });
    }

    function stopEverything() {
      if (rafId) cancelAnimationFrame(rafId); rafId = 0;
      if (hiddenIv) clearInterval(hiddenIv); hiddenIv = 0;
      if (sim) { try { sim.stop(); } catch (e) { /* nada */ } }
      releaseWake();
      if (ride) { ride.over = true; (ride.unsubs || []).splice(0).forEach((u) => { try { u(); } catch (e) { /* nada */ } }); }
    }

    function disposeCoach() { if (audio) { try { audio.dispose(); } catch (e) { /* nada */ } } audio = null; coach = null; }
    function disposeScene() { if (scene) { try { scene.dispose(); } catch (e) { /* nada */ } scene = null; } }

    function discard() {
      stopEverything(); disposeScene(); disposeCoach();
      ride = null; phase = 'prep';
      say('Rodada descartada.', 'info');
      renderPrep();
    }

    // ======================================================================
    // Fin: RPE, guardado y resumen
    // ======================================================================
    function finishRide(auto) {
      if (!ride || ride.finishing) return;
      ride.finishing = true;
      closeDialog();
      const r = ride;
      r.sampler.flush(r.tS, { powerW: r.power, hr: r.hr, cadence: r.cad, speedMps: r.v, distM: r.distM, eleM: r.ele });
      const samples = r.sampler.samples.slice();
      stopEverything(); disposeScene();
      if (samples.length < 10) {
        say('La rodada fue muy corta para guardarla (menos de 10 s).', 'warn');
        ride = null; phase = 'prep'; renderPrep();
        return;
      }
      const name = r.mode === 'workout' ? r.workout.name : r.mode === 'route' ? r.route.name : 'Rodada libre · ' + r.route.name;
      const activity = L.buildActivity({
        type: r.mode, name, routeId: r.mode === 'route' ? r.route.id : null,
        workoutId: r.workout ? r.workout.id : null, samples, ftp, date: r.startedAt,
        workout: r.workout && r.workout.generated ? R.training.compactWorkout(r.workout) : null,
      });
      const completed = auto && ((r.mode === 'route' && r.distM >= r.route.distanceM - 1) || (r.workout && r.tS >= r.workout.durationS));
      if (completed && coach) coach.event('end');
      const result = { activity, improved: false, deltaS: 0, ghostWon: null, completed: !!completed, route: r.route, mode: r.mode, hadGhost: !!r.ghost };

      // guardar
      let st = store.get();
      const acts = (st.activities || []).concat([activity]);
      const patch = { activities: acts };
      if (r.mode === 'route') {
        try {
          const ub = R.riders.updateBest(st.bests || {}, r.route.id, activity, r.route);
          if (ub.improved) patch.bests = ub.bests;
          result.improved = ub.improved; result.deltaS = ub.deltaS;
        } catch (e) { /* sin marca */ }
      }
      try {
        store.set(patch);
      } catch (e) { say('No pudimos guardar la rodada: ' + e.message, 'error'); }
      showRpe(result);
    }

    function applyPlan() {
      const st = store.get();
      if (!st.plan || !profile) return;
      try { if (R.app && R.app.adaptStoredPlan) R.app.adaptStoredPlan(); } catch (e) { /* plan sin cambios */ }
    }

    function showRpe(result) {
      phase = 'rpe';
      root.className = 'rd rd--prep rd--summary';
      root.textContent = '';
      const a = result.activity;
      const choose = (n) => {
        a.rpe = n;
        if (n != null) {
          const st = store.get();
          store.set({ activities: (st.activities || []).map((x) => (x.id === a.id ? Object.assign({}, x, { rpe: n }) : x)) });
        }
        applyPlan();
        showSummary(result);
      };
      const grid = h('div', { class: 'rd-rpe', role: 'radiogroup', 'aria-label': 'Esfuerzo percibido' }, L.RPE_SCALE.map((x) => h('button', {
        type: 'button', role: 'radio', 'aria-checked': 'false', class: 'rd-rpe-b', onclick: () => choose(x.n),
      }, [h('b', { text: String(x.n) }), h('span', { text: x.label }), h('small', { text: x.desc })])));
      root.appendChild(h('div', { class: 'rd-wrap' }, [
        h('h1', { class: 'rd-title', text: result.completed ? '¡Terminaste!' : 'Rodada guardada' }),
        h('p', { class: 'rd-note', text: a.name + ' · ' + L.fmtTime(a.durationS) + ' · ' + L.fmtKm(a.distanceM) + ' km' }),
        h('h2', { class: 'rd-h', text: '¿Qué tan duro se sintió?' }),
        grid,
        h('div', { class: 'rd-startbar' }, [h('button', { type: 'button', class: 'rd-btn rd-btn--ghost', text: 'Omitir', onclick: () => choose(null) })]),
      ]));
      const first = grid.querySelector('button'); if (first) first.focus();
    }

    function fmtDelta(s) { return Math.abs(Math.round(s)) + ' s'; }

    function showSummary(result) {
      phase = 'summary';
      root.className = 'rd rd--prep rd--summary';
      root.textContent = '';
      const a = result.activity;
      const st = store.get();
      const tile = (l, v, u) => h('div', { class: 'rd-tile' }, [h('span', { text: l }), h('b', {}, [String(v), u ? h('small', { text: ' ' + u }) : null])]);
      const avgSpd = a.durationS ? (a.distanceM / a.durationS) * 3.6 : 0;
      const tiles = h('div', { class: 'rd-tiles' }, [
        tile('Duración', L.fmtTime(a.durationS)), tile('Distancia', L.fmtKm(a.distanceM), 'km'), tile('Potencia media', a.avgPower, 'W'),
        tile('Potencia normalizada', a.np, 'W'), tile('Factor de intensidad', Number(a.if).toFixed(2).replace('.', ',')), tile('TSS', Math.round(a.tss)),
        tile('Energía', a.kcal, 'kcal'), tile('FC media', a.avgHr != null ? a.avgHr : '–', a.avgHr != null ? 'ppm' : ''),
        tile('Cadencia media', a.avgCadence != null ? a.avgCadence : '–', a.avgCadence != null ? 'rpm' : ''), tile('Velocidad media', avgSpd.toFixed(1).replace('.', ','), 'km/h'),
        tile('Esfuerzo percibido', a.rpe != null ? a.rpe + ' / 10' : '–'),
      ]);
      const cv = h('canvas', { class: 'rd-cv rd-cv-sum', 'aria-label': 'Potencia y frecuencia cardíaca durante la rodada' });
      const zs = L.zoneSeconds(a.samples, ftp), ztot = Math.max(1, zs.reduce((x, y) => x + y, 0));
      const zbox = h('div', { class: 'rd-zones' }, zs.map((sec, i) => {
        const bar = h('i'); bar.style.width = Math.round((sec / ztot) * 100) + '%'; bar.style.background = zones[i].color;
        return h('div', { class: 'rd-zrow' }, [h('span', { text: 'Z' + (i + 1) + ' ' + zones[i].name }), h('span', { class: 'rd-ztrack' }, bar), h('b', { text: L.fmtTime(sec) + ' · ' + Math.round((sec / ztot) * 100) + ' %' })]);
      }));
      const wrap = h('div', { class: 'rd-wrap' });
      wrap.appendChild(h('h1', { class: 'rd-title', text: a.name }));
      if (result.mode === 'route' && result.completed) {
        const msg = result.improved
          ? (result.deltaS > 0 ? '¡Nueva mejor marca! Mejoraste en ' + fmtDelta(result.deltaS) + '.' : '¡Primera marca en esta ruta! Quedó guardada como tu mejor tiempo.')
          : 'Terminaste la ruta. Tu mejor marca sigue en pie' + (result.deltaS ? ' (te faltaron ' + fmtDelta(result.deltaS) + ').' : '.');
        wrap.appendChild(h('div', { class: 'rd-banner' + (result.improved ? ' is-gold' : '') , text: msg }));
      }
      wrap.appendChild(tiles);
      wrap.appendChild(h('section', { class: 'rd-card' }, [h('h2', { class: 'rd-h', text: 'Potencia y frecuencia cardíaca' }), cv]));
      wrap.appendChild(h('section', { class: 'rd-card' }, [h('h2', { class: 'rd-h', text: 'Tiempo en cada zona' }), zbox]));
      // FTP
      let sug = null;
      try { sug = R.training.suggestFtpUpdate(st.activities, st.profile); } catch (e) { sug = null; }
      if (sug && profile) {
        wrap.appendChild(h('section', { class: 'rd-card rd-ftp' }, [
          h('h2', { class: 'rd-h', text: 'Sugerencia: FTP de ' + sug.suggestedFtp + ' W' }),
          h('p', { class: 'rd-note', text: sug.reason }),
          h('button', { type: 'button', class: 'rd-btn rd-btn--primary', text: 'Aplicar ' + sug.suggestedFtp + ' W', onclick: (e) => {
            store.set({ profile: Object.assign({}, store.get().profile, { ftp: sug.suggestedFtp, ftpEstimated: false }) });
            e.target.disabled = true; e.target.textContent = 'FTP actualizado'; say('FTP actualizado a ' + sug.suggestedFtp + ' W.', 'ok');
          } }),
        ]));
      }
      wrap.appendChild(h('div', { class: 'rd-actions' }, [
        h('button', { type: 'button', class: 'rd-btn rd-btn--primary', text: 'Exportar a Strava (.TCX)', onclick: () => exportTcx(a) }),
        h('button', { type: 'button', class: 'rd-btn rd-btn--ghost', text: 'Ver estadísticas', onclick: () => navigate('estadisticas') }),
        h('button', { type: 'button', class: 'rd-btn rd-btn--ghost', text: 'Volver al inicio', onclick: () => navigate('inicio') }),
      ]));
      root.appendChild(wrap);
      drawSummaryChart(cv, a);
      const onResize = () => { if (phase === 'summary') drawSummaryChart(cv, a); };
      window.addEventListener('resize', onResize); cleanups.push(() => window.removeEventListener('resize', onResize));
      if (result.improved) confetti();
    }

    function drawSummaryChart(cv, a) {
      const f = fitCanvas(cv), g = f.g, w = f.w, hh = f.h, smp = a.samples;
      g.clearRect(0, 0, w, hh);
      if (smp.length < 2) return;
      const padL = 34, padB = 18, pw = w - padL - 6, ph = hh - padB - 6;
      const N = smp.length;
      const sm = (idx, win) => smp.map((_, i) => { let s = 0, c = 0; for (let k = Math.max(0, i - win + 1); k <= i; k++) { if (smp[k][idx] != null) { s += smp[k][idx]; c++; } } return c ? s / c : null; });
      const pw10 = sm(1, 10), hr = sm(2, 10);
      const maxP = Math.max(ftp * 1.3, Math.max.apply(null, pw10));
      const hrs = hr.filter((x) => x != null);
      const X = (i) => padL + (i / (N - 1)) * pw, YP = (v) => 6 + ph - (v / maxP) * ph;
      g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 1; g.fillStyle = 'rgba(238,243,247,.55)'; g.font = '11px Inter, sans-serif'; g.textAlign = 'right';
      for (let k = 0; k <= 4; k++) { const v = (maxP * k) / 4, y = YP(v); g.beginPath(); g.moveTo(padL, y); g.lineTo(w - 6, y); g.stroke(); g.fillText(String(Math.round(v)), padL - 4, y + 4); }
      g.textAlign = 'center';
      for (let k = 0; k <= 4; k++) { const i = Math.round(((N - 1) * k) / 4); g.fillText(L.fmtTime(smp[i][0]), clamp(X(i), padL + 14, w - 20), hh - 3); }
      g.beginPath(); g.moveTo(X(0), YP(0)); pw10.forEach((v, i) => g.lineTo(X(i), YP(v))); g.lineTo(X(N - 1), YP(0)); g.closePath();
      g.fillStyle = 'rgba(255,90,31,.28)'; g.fill();
      g.beginPath(); pw10.forEach((v, i) => (i ? g.lineTo(X(i), YP(v)) : g.moveTo(X(i), YP(v)))); g.strokeStyle = ACCENT; g.lineWidth = 2; g.stroke();
      if (hrs.length > 5) {
        const lo = Math.min.apply(null, hrs) - 5, hi = Math.max.apply(null, hrs) + 5, YH = (v) => 6 + ph - ((v - lo) / (hi - lo)) * ph;
        g.beginPath(); let started = false;
        hr.forEach((v, i) => { if (v == null) return; if (!started) { g.moveTo(X(i), YH(v)); started = true; } else g.lineTo(X(i), YH(v)); });
        g.strokeStyle = '#E8556D'; g.lineWidth = 1.8; g.stroke();
      }
    }

    function confetti() {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const box = h('div', { class: 'rd-confetti', 'aria-hidden': 'true' });
      const cols = [ACCENT, GHOST, '#EEF3F7', BOT];
      for (let i = 0; i < 48; i++) {
        const p = h('i');
        p.style.left = Math.random() * 100 + '%';
        p.style.background = cols[i % cols.length];
        p.style.animationDelay = Math.random() * 0.8 + 's';
        p.style.animationDuration = 2.4 + Math.random() * 2 + 's';
        p.style.setProperty('--dx', (Math.random() * 160 - 80) + 'px');
        p.style.transform = 'rotate(' + Math.random() * 360 + 'deg)';
        box.appendChild(p);
      }
      root.appendChild(box);
      later(() => { if (box.parentNode) box.parentNode.removeChild(box); }, 6500);
    }

    function exportTcx(a) {
      let tcx;
      try { tcx = R.integrations.toTCX(a, store.get().profile); } catch (e) { say('No pudimos generar el archivo: ' + e.message, 'error'); return; }
      const filename = 'rodillator-' + a.date.slice(0, 10) + '.tcx';
      Promise.resolve().then(() => R.integrations.saveFile({ filename, data: tcx, mime: 'application/vnd.garmin.tcx+xml' })).then((res) => {
        if (res && res.ok) { say('Archivo guardado: ' + filename + '. Súbelo en strava.com/upload.', 'ok'); return; }
        const ta = h('textarea', { class: 'rd-ta', readonly: true, rows: '8', 'aria-label': 'Contenido del archivo TCX' });
        ta.value = (res && res.data) || tcx;
        dialog({
          title: 'Copia el archivo y súbelo a Strava',
          body: h('div', {}, [
            h('p', { text: 'Este entorno no permite descargar archivos. Copia el contenido, pégalo en un archivo de texto con el nombre ' + filename + ' y súbelo a Strava.' }),
            ta,
            h('ol', { class: 'rd-steps' }, [
              h('li', { text: 'Pulsa "Copiar archivo" y pégalo en un editor de texto.' }),
              h('li', { text: 'Guárdalo como ' + filename + '.' }),
              h('li', {}, ['Entra a ', h('a', { href: R.integrations.stravaUploadUrl, target: '_blank', rel: 'noopener noreferrer', text: 'strava.com/upload' }), ' y selecciona el archivo. Si el enlace no abre, copia esta dirección en tu navegador:',
                h('input', { class: 'rd-input rd-url', type: 'text', readonly: true, value: R.integrations.stravaUploadUrl, 'aria-label': 'Dirección de Strava', onfocus: (e) => e.target.select() })]),
              h('li', { text: 'Sugerencia de nombre: ' + R.integrations.stravaActivityName(a) }),
            ]),
          ]),
          actions: [
            { label: 'Copiar archivo', kind: 'primary', keepOpen: true, onClick: () => {
              let ok = false;
              try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(ta.value).then(() => say('Copiado.', 'ok'), () => fallbackCopy()); ok = true; } } catch (e) { ok = false; }
              function fallbackCopy() { ta.removeAttribute('readonly'); ta.select(); let done = false; try { done = document.execCommand('copy'); } catch (e) { done = false; } ta.setAttribute('readonly', ''); say(done ? 'Copiado.' : 'Selecciona el texto y cópialo con Ctrl+C.', done ? 'ok' : 'warn'); }
              if (!ok) fallbackCopy();
            } },
            { label: 'Cerrar', kind: 'ghost' },
          ],
        });
      }).catch((e) => say('No pudimos guardar el archivo: ' + ((e && e.message) || 'error desconocido'), 'error'));
    }

    // ---------- teclado ----------
    function onKey(e) {
      if (disposed || phase !== 'ride' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (dialogEl) {
        if (e.key === 'Escape') { closeDialog(); if (ride && !askState.wasPaused) togglePause(false); }
        return;
      }
      if (e.key === 'Escape' && stage && stage.board.classList.contains('is-open')) { e.preventDefault(); closeBoard(); if (stage.pill) stage.pill.focus(); return; }
      const tag = e.target && e.target.tagName;
      const onControl = tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
      if (e.key === ' ' || e.code === 'Space') {
        if (onControl) return; // el control enfocado maneja su propia tecla: evita pausar y reanudar a la vez
        e.preventDefault(); if (!e.repeat) togglePause();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (tag === 'INPUT' || tag === 'SELECT') return; // el deslizador usa las flechas
        e.preventDefault(); if (!e.repeat) adjust(e.key === 'ArrowUp' ? 1 : -1);
      }
      else if (e.key === 'c' || e.key === 'C') cycleCamera();
      else if (e.key === 'm' || e.key === 'M') toggleMute();
      else if (e.key === 'Escape') askFinish();
    }
    document.addEventListener('keydown', onKey);
    cleanups.push(() => document.removeEventListener('keydown', onKey));
    cleanups.push(() => { if (layoutRO) { layoutRO.disconnect(); layoutRO = null; } });
    const onLayout = () => { if (stage && scene) syncLayout(false); };
    window.addEventListener('resize', onLayout);
    window.addEventListener('orientationchange', onLayout);
    cleanups.push(() => { window.removeEventListener('resize', onLayout); window.removeEventListener('orientationchange', onLayout); });
    // tocar fuera de la tabla de posiciones la cierra
    const onOutside = (e) => { if (stage && stage.board.classList.contains('is-open') && !stage.board.contains(e.target) && !stage.pill.contains(e.target)) closeBoard(); };
    document.addEventListener('pointerdown', onOutside);
    cleanups.push(() => document.removeEventListener('pointerdown', onOutside));
    const onVis = () => { if (!document.hidden && ride && !ride.over) requestWake(); };
    document.addEventListener('visibilitychange', onVis);
    cleanups.push(() => document.removeEventListener('visibilitychange', onVis));

    renderPrep();

    return {
      destroy() {
        if (disposed) return;
        disposed = true;
        stopEverything();
        disposeScene();
        disposeCoach();
        timers.forEach((t) => clearTimeout(t)); timers.clear();
        cleanups.splice(0).forEach((fn) => { try { fn(); } catch (e) { /* nada */ } });
        if (root.parentNode) root.parentNode.removeChild(root);
        ride = null;
      },
      // para pruebas y capturas
      _debug() { return { ride, cfg, get phase() { return phase; }, scene, sim, stage }; },
    };
  }

  function render(container, ctx) {
    destroy();
    inst = createRide(container, ctx);
  }
  function destroy() { if (inst) { inst.destroy(); inst = null; } }

  R.rideView = { render, destroy, _current: () => inst };
  if (R.ui && R.ui.registerView) {
    R.ui.registerView({
      id: 'rodar', title: 'Rodar',
      icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="16" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="16" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6 16l4-8h5l3 8M10 8l3 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
      render, destroy,
    });
  }
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
