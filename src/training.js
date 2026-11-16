(function (R) {
  'use strict';

  // ======================================================================
  // Fechas ('YYYY-MM-DD' en hora local)
  // ======================================================================
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const fmtDate = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  function parseDate(s) {
    const p = s.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2], 12, 0, 0);
  }
  function addDays(s, n) {
    const d = parseDate(s);
    d.setDate(d.getDate() + n);
    return fmtDate(d);
  }
  function dayNum(s) {
    const p = s.split('-').map(Number);
    return Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / 86400000);
  }
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  function todayStr(today) {
    if (typeof today === 'string' && DATE_RE.test(today)) return today;
    if (typeof today === 'string' || today instanceof Date) return fmtDate(new Date(today));
    return fmtDate(new Date());
  }
  function localDate(iso) {
    return DATE_RE.test(iso) ? iso : fmtDate(new Date(iso));
  }
  const weekday = (s) => parseDate(s).getDay();
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const r1 = (x) => Math.round(x * 10) / 10;
  const r2 = (x) => Math.round(x * 100) / 100;

  // ======================================================================
  // FTP, zonas, FC
  // ======================================================================
  const LEVEL_WKG = { principiante: 2.0, intermedio: 2.8, avanzado: 3.5, competitivo: 4.2 };

  function estimateFtp(o) {
    if (!o || !(Number(o.weightKg) > 0)) throw new Error('Falta el peso (weightKg) para estimar el FTP.');
    const base = LEVEL_WKG[o.level] != null ? LEVEL_WKG[o.level] : LEVEL_WKG.intermedio;
    const factor = Math.max(0.6, 1 - 0.005 * Math.max(0, (o.age || 0) - 35));
    const ftp = Math.round(base * o.weightKg * factor);
    return { ftp: ftp, wkg: r2(ftp / o.weightKg) };
  }

  const ZONE_DEFS = [
    { zone: 1, name: 'Recuperación', hi: 55, color: '#8A8F98' },
    { zone: 2, name: 'Resistencia', hi: 75, color: '#3FA7D6' },
    { zone: 3, name: 'Tempo', hi: 90, color: '#59CD90' },
    { zone: 4, name: 'Umbral', hi: 105, color: '#FAC05E' },
    { zone: 5, name: 'VO2máx', hi: 120, color: '#F79D84' },
    { zone: 6, name: 'Anaeróbico', hi: 150, color: '#EE6352' },
    { zone: 7, name: 'Neuromuscular', hi: null, color: '#B83280' },
  ];

  function zones(ftp) {
    let prevMax = -1;
    return ZONE_DEFS.map((z) => {
      const maxW = z.hi == null ? null : Math.round((z.hi * ftp) / 100);
      const out = { zone: z.zone, name: z.name, minW: prevMax + 1, maxW: maxW, color: z.color };
      prevMax = maxW;
      return out;
    });
  }

  function zoneFor(powerW, ftp) {
    const w = Math.round(powerW);
    for (const z of ZONE_DEFS) {
      if (z.hi == null || w <= Math.round((z.hi * ftp) / 100)) return z.zone;
    }
    return 7;
  }

  const estimateMaxHr = (age) => Math.round(208 - 0.7 * age);

  // ======================================================================
  // Biblioteca de entrenamientos
  // ======================================================================
  function st(durationS, powerPct, label, extra) {
    const s = { durationS: Math.round(durationS), powerPct: powerPct, label: label };
    if (extra && extra.end != null) s.powerPctEnd = extra.end;
    if (extra && extra.cadence != null) s.cadence = extra.cadence;
    if (extra && extra.position) s.position = extra.position;
    return s;
  }
  const M = 60;
  const warm = (m, from, to) => st((m == null ? 10 : m) * M, from == null ? 45 : from, 'Calentamiento progresivo', { end: to == null ? 70 : to });
  const cool = (m) => st((m == null ? 5 : m) * M, 60, 'Vuelta a la calma', { end: 40 });
  // n repeticiones de `on(i, n)`, con `off(i, n)` entre ellas (no después de la última)
  function intervals(n, on, off) {
    const out = [];
    for (let i = 1; i <= n; i++) {
      out.push.apply(out, [].concat(on(i, n)));
      if (i < n && off) out.push.apply(out, [].concat(off(i, n)));
    }
    return out;
  }
  const flat = (parts) => [].concat.apply([], parts);
  const iv = (sec, pct, name, extra) => (i, n) => st(sec, pct, name + ' ' + i + '/' + n, extra);
  const rec = (sec, pct, label) => () => st(sec, pct == null ? 50 : pct, label || 'Recuperación suave');

  function stepTss(s) {
    const avg = (s.powerPct + (s.powerPctEnd != null ? s.powerPctEnd : s.powerPct)) / 2 / 100;
    return (s.durationS / 3600) * avg * avg * 100;
  }
  function mk(id, name, category, description, steps) {
    const durationS = steps.reduce((a, s) => a + s.durationS, 0);
    const tss = r1(steps.reduce((a, s) => a + stepTss(s), 0));
    return { id: id, name: name, category: category, description: description, durationS: durationS, tss: tss, steps: steps };
  }

  function rampTestSteps() {
    const steps = [st(5 * M, 40, 'Calentamiento suave', { end: 45 })];
    let n = 0;
    for (let pct = 45; ; pct = Math.min(150, pct + 6)) {
      n++;
      steps.push(st(M, pct, 'Escalón ' + n + ' (' + pct + ' % FTP)', { cadence: 90 }));
      if (pct >= 150) break;
    }
    steps.push(st(5 * M, 55, 'Vuelta a la calma', { end: 40 }));
    return steps;
  }

  const library = [
    // ---- Recuperación ----
    mk('recuperacion-30', 'Recuperación 30', 'recuperacion',
      'Media hora de pedaleo muy suave para soltar las piernas entre sesiones duras. Si te cuesta mantener la conversación fluida, baja un poco la potencia: hoy el objetivo es recuperar, no sumar.',
      [st(5 * M, 40, 'Entrada suave', { end: 50 }), st(20 * M, 50, 'Pedaleo suave y fluido', { cadence: 90 }), st(5 * M, 50, 'Soltar piernas', { end: 40 })]),
    mk('recuperacion-45', 'Recuperación activa 45', 'recuperacion',
      'Rodaje regenerativo con pequeños giros rápidos para mantener las piernas ágiles sin generar fatiga. Mantén la potencia bajo el 55 % de tu FTP.',
      flat([[st(5 * M, 40, 'Entrada suave', { end: 50 })],
        intervals(4, () => [st(8 * M, 50, 'Pedaleo suave'), st(M, 55, 'Giros rápidos', { cadence: 100 })]),
        [st(4 * M, 50, 'Soltar piernas', { end: 40 })]])),
    mk('recuperacion-60', 'Recuperación y cadencia 60', 'recuperacion',
      'Una hora de rodaje regenerativo trabajando la fluidez del pedaleo con cinco ráfagas de cadencia alta. Piernas sueltas, respiración tranquila y cero ego.',
      flat([[st(5 * M, 40, 'Entrada suave', { end: 50 })],
        intervals(5, () => [st(9 * M, 52, 'Pedaleo suave'), st(M, 55, 'Cadencia alta', { cadence: 100 })]),
        [cool(5)]])),

    // ---- Resistencia ----
    mk('resistencia-45', 'Resistencia 45', 'resistencia',
      'Base aeróbica en poco tiempo: 35 minutos constantes en zona 2. Ritmo cómodo, respiración controlada y cadencia estable.',
      [warm(5, 45, 65), st(35 * M, 65, 'Ritmo aeróbico estable', { cadence: 90 }), cool(5)]),
    mk('resistencia-60', 'Resistencia 60', 'resistencia',
      'La sesión que construye tu motor: una hora en zona 2 sin sobresaltos. Si puedes hablar en frases completas, vas en el punto justo.',
      [warm(10, 45, 65), st(45 * M, 68, 'Ritmo aeróbico estable', { cadence: 90 }), cool(5)]),
    mk('resistencia-90', 'Resistencia 90', 'resistencia',
      'Noventa minutos de zona 2 para ampliar tu capacidad aeróbica. Hidrátate cada 15 minutos y mantén la potencia pareja: la constancia es la clave.',
      [warm(10, 45, 65), st(70 * M, 68, 'Ritmo aeróbico estable', { cadence: 90 }), cool(10)]),
    mk('resistencia-120', 'Resistencia 120', 'resistencia',
      'La salida larga del rodillo: dos horas en zona 2. Planifica hidratación y nutrición, cambia de postura de vez en cuando y disfruta de la resistencia que estás construyendo.',
      [warm(10, 45, 65), st(100 * M, 68, 'Ritmo aeróbico estable', { cadence: 90 }), cool(10)]),
    mk('resistencia-cadencia-75', 'Resistencia con cadencia 75', 'resistencia',
      'Zona 2 jugando con la cadencia: bloques de 5 minutos a 80, 90 y 100 rpm. Mejora la eficiencia del pedaleo sin salir del rango aeróbico.',
      flat([[warm(10, 45, 65)],
        intervals(4, (i) => [st(5 * M, 65, 'Cadencia baja ' + i + '/4', { cadence: 80 }), st(5 * M, 65, 'Cadencia media ' + i + '/4', { cadence: 90 }), st(5 * M, 65, 'Cadencia alta ' + i + '/4', { cadence: 100 })]),
        [cool(5)]])),
    mk('resistencia-progresiva-90', 'Resistencia progresiva 90', 'resistencia',
      'Zona 2 con cuatro escalones suaves de 60 a 72 % de tu FTP, y un tramo final estable. Enseña a tu cuerpo a sostener el esfuerzo cuando se acumula la fatiga.',
      [warm(10, 45, 60), st(15 * M, 60, 'Escalón 1'), st(15 * M, 64, 'Escalón 2'), st(15 * M, 68, 'Escalón 3'), st(15 * M, 72, 'Escalón 4'), st(15 * M, 65, 'Tramo final estable'), cool(5)]),

    // ---- Tempo ----
    mk('tempo-45', 'Tempo continuo 45', 'tempo',
      'Treinta minutos continuos en zona 3. Un esfuerzo firme pero sostenible, ideal para entrenar el ritmo de rodada larga.',
      [warm(10), st(30 * M, 80, 'Tempo continuo', { cadence: 90 }), cool(5)]),
    mk('tempo-2x20', 'Tempo 2×20', 'tempo',
      'Dos bloques de 20 minutos en zona 3 con descanso intermedio. Mantén la potencia pareja desde el primer minuto: ese es el verdadero desafío.',
      flat([[warm(10)], intervals(2, iv(20 * M, 82, 'Tempo', { cadence: 90 }), rec(5 * M, 55)), [cool(5)]])),
    mk('tempo-3x15', 'Tempo 3×15', 'tempo',
      'Tres bloques de 15 minutos en zona 3. Más volumen a ritmo de grupo para construir resistencia muscular.',
      flat([[warm(10)], intervals(3, iv(15 * M, 83, 'Tempo', { cadence: 90 }), rec(5 * M, 55)), [cool(10)]])),
    mk('tempo-progresivo-75', 'Tempo progresivo 75', 'tempo',
      'Cuatro bloques de 15 minutos que suben de 76 a 88 % de tu FTP. Empieza controlado y termina fuerte, sin pasarte de la zona 3.',
      [warm(10), st(15 * M, 76, 'Tempo 1/4'), st(15 * M, 80, 'Tempo 2/4'), st(15 * M, 84, 'Tempo 3/4'), st(15 * M, 88, 'Tempo 4/4'), cool(5)]),

    // ---- Sweet Spot ----
    mk('sweetspot-3x12', 'Sweet Spot 3×12', 'sweetspot',
      'Tres bloques de 12 minutos al 90 % de tu FTP: el mejor equilibrio entre estímulo y fatiga. Aquí se gana mucha forma con poco desgaste.',
      flat([[warm(10)], intervals(3, iv(12 * M, 90, 'Sweet Spot', { cadence: 90 }), rec(5 * M, 55)), [cool(5)]])),
    mk('sweetspot-2x20', 'Sweet Spot 2×20', 'sweetspot',
      'Dos bloques de 20 minutos al 90 % de tu FTP. Sostén la cadencia y la postura: es tu entrenamiento clave para subir el umbral.',
      flat([[warm(10)], intervals(2, iv(20 * M, 90, 'Sweet Spot', { cadence: 90 }), rec(5 * M, 55)), [cool(5)]])),
    mk('sweetspot-4x10', 'Sweet Spot 4×10', 'sweetspot',
      'Cuatro bloques de 10 minutos al 91 % de tu FTP, con descansos cortos. Ideal para acumular tiempo de calidad en bloques manejables.',
      flat([[warm(10)], intervals(4, iv(10 * M, 91, 'Sweet Spot', { cadence: 90 }), rec(4 * M, 55)), [cool(5)]])),
    mk('sweetspot-3x15', 'Sweet Spot 3×15', 'sweetspot',
      'Tres bloques de 15 minutos al 89 % de tu FTP. Un paso más de volumen en la zona más rentable del entrenamiento.',
      flat([[warm(10)], intervals(3, iv(15 * M, 89, 'Sweet Spot', { cadence: 90 }), rec(5 * M, 55)), [cool(5)]])),
    mk('sweetspot-90', 'Sweet Spot largo 90', 'sweetspot',
      'Dos bloques de 30 minutos al 89 % de tu FTP dentro de una sesión de 90 minutos. Es tu sesión de resistencia a la fatiga: respira hondo y avanza minuto a minuto.',
      flat([[warm(15)], intervals(2, iv(30 * M, 89, 'Sweet Spot', { cadence: 90 }), rec(5 * M, 55)), [cool(10)]])),

    // ---- Umbral ----
    mk('umbral-2x20', 'Umbral 2×20', 'umbral',
      'El clásico para subir FTP: dos bloques de 20 minutos al 100 % de tu FTP. Duele de forma controlada y rinde muchísimo. Concéntrate en la respiración y no te pases de potencia en los primeros minutos.',
      flat([[warm(15)], intervals(2, iv(20 * M, 100, 'Umbral', { cadence: 90 }), rec(10 * M, 50)), [cool(10)]])),
    mk('umbral-3x10', 'Umbral 3×10', 'umbral',
      'Tres bloques de 10 minutos al 100 % de tu FTP. Una puerta de entrada al trabajo de umbral con descansos de 5 minutos.',
      flat([[warm(10)], intervals(3, iv(10 * M, 100, 'Umbral', { cadence: 90 }), rec(5 * M, 55)), [cool(5)]])),
    mk('umbral-4x8', 'Umbral 4×8', 'umbral',
      'Cuatro bloques de 8 minutos al 102 % de tu FTP. Volumen de umbral con pausas breves: mantén la cabeza fría y los hombros relajados.',
      flat([[warm(10)], intervals(4, iv(8 * M, 102, 'Umbral', { cadence: 90 }), rec(4 * M, 55)), [cool(5)]])),
    mk('umbral-1x30', 'Umbral 1×30', 'umbral',
      'Un solo bloque de 30 minutos al 98 % de tu FTP. Entrena la constancia mental y el ritmo de contrarreloj.',
      [warm(15), st(30 * M, 98, 'Umbral sostenido', { cadence: 90 }), cool(10)]),
    mk('over-unders', 'Over-unders', 'umbral',
      'Tres series de 12 minutos alternando 2 minutos al 95 % (under) y 1 minuto al 105 % (over). Aprendes a limpiar lactato mientras sigues rodando fuerte: la mejor preparación para los cambios de ritmo.',
      flat([[warm(15)],
        intervals(3, (s, ns) => intervals(4, (i) => [st(2 * M, 95, 'Under ' + i + '/4 (serie ' + s + '/' + ns + ')', { cadence: 90 }), st(M, 105, 'Over ' + i + '/4 (serie ' + s + '/' + ns + ')', { cadence: 90 })]),
          rec(6 * M, 50)),
        [cool(7)]])),

    // ---- VO2máx ----
    mk('vo2-5x4', 'VO2 5×4', 'vo2',
      'Cinco intervalos de 4 minutos al 115 % de tu FTP con 4 minutos de recuperación. La sesión por excelencia para aumentar tu capacidad aeróbica máxima. Sal con cabeza: los dos primeros minutos deben sentirse controlados.',
      flat([[warm(15)], intervals(5, iv(4 * M, 115, 'VO2', { cadence: 95 }), rec(4 * M, 50)), [cool(10)]])),
    mk('vo2-6x3', 'VO2 6×3', 'vo2',
      'Seis intervalos de 3 minutos al 118 % de tu FTP con recuperaciones iguales. Intensidad alta en bloques breves para empujar tu techo aeróbico.',
      flat([[warm(15)], intervals(6, iv(3 * M, 118, 'VO2', { cadence: 95 }), rec(3 * M, 50)), [cool(10)]])),
    mk('vo2-4x5', 'VO2 4×5', 'vo2',
      'Cuatro intervalos de 5 minutos al 112 % de tu FTP. Más tiempo cerca de tu VO2máx por intervalo: exigente, pero muy efectivo.',
      flat([[warm(15)], intervals(4, iv(5 * M, 112, 'VO2', { cadence: 95 }), rec(5 * M, 50)), [cool(10)]])),
    mk('vo2-30-30', 'VO2 30/30', 'vo2',
      'Tres series de diez repeticiones de 30 segundos al 130 % y 30 segundos suaves. Acumulas mucho tiempo a alta intensidad con una percepción de esfuerzo manejable.',
      flat([[warm(15)],
        intervals(3, (s, ns) => intervals(10, (i) => [st(30, 130, 'Fuerte ' + i + '/10 (serie ' + s + '/' + ns + ')', { cadence: 100 }), st(30, 50, 'Suave ' + i + '/10 (serie ' + s + '/' + ns + ')')]),
          rec(5 * M, 50)),
        [cool(10)]])),
    mk('vo2-piramide', 'VO2 Pirámide', 'vo2',
      'Intervalos de 2, 3, 4, 3 y 2 minutos entre 115 y 120 % de tu FTP, con 3 minutos de recuperación. Variedad para el cuerpo y para la cabeza.',
      flat([[warm(15)],
        [st(2 * M, 120, 'Pirámide 1/5', { cadence: 95 }), st(3 * M, 50, 'Recuperación suave'),
          st(3 * M, 118, 'Pirámide 2/5', { cadence: 95 }), st(3 * M, 50, 'Recuperación suave'),
          st(4 * M, 115, 'Pirámide 3/5 (cima)', { cadence: 95 }), st(3 * M, 50, 'Recuperación suave'),
          st(3 * M, 118, 'Pirámide 4/5', { cadence: 95 }), st(3 * M, 50, 'Recuperación suave'),
          st(2 * M, 120, 'Pirámide 5/5', { cadence: 95 })],
        [cool(10)]])),

    // ---- Anaeróbico ----
    mk('tabata', 'Tabata', 'anaerobico',
      'Tres bloques Tabata: 8 repeticiones de 20 segundos a fondo (170 % FTP) y 10 segundos suaves. Cuatro minutos que se sienten eternos, con 6 minutos de descanso entre bloques. Entrega todo en cada serie.',
      flat([[warm(15)],
        intervals(3, (b, nb) => intervals(8, (i) => [st(20, 170, 'Tabata ' + i + '/8 (bloque ' + b + '/' + nb + ')', { cadence: 105, position: 'pie' }), st(10, 40, 'Pausa ' + i + '/8')]),
          rec(6 * M, 50)),
        [cool(10)]])),
    mk('sprints-neuromusculares', 'Sprints neuromusculares', 'anaerobico',
      'Ocho sprints máximos de 10 segundos con recuperación completa de casi 4 minutos. Potencia pura y reclutamiento muscular, con cero fatiga acumulada. Sal de pie, con cadencia alta y a todo.',
      flat([[warm(20, 45, 75)],
        intervals(8, (i, n) => st(10, 200, 'Sprint ' + i + '/' + n, { cadence: 120, position: 'pie' }), rec(230, 50, 'Recuperación completa')),
        [cool(10)]])),
    mk('anaerobico-8x1', 'Anaeróbico 8×1', 'anaerobico',
      'Ocho esfuerzos de 1 minuto al 135 % de tu FTP con 3 minutos de recuperación. Entrena la capacidad anaeróbica y tu tolerancia al ácido láctico.',
      flat([[warm(15)], intervals(8, iv(M, 135, 'Esfuerzo', { cadence: 100 }), rec(3 * M, 50)), [cool(10)]])),
    mk('anaerobico-6x90', 'Anaeróbico 6×90 s', 'anaerobico',
      'Seis esfuerzos de 90 segundos al 130 % de tu FTP, con 3 minutos y medio de recuperación. Aprieta los dientes: son solo seis.',
      flat([[warm(15)], intervals(6, iv(90, 130, 'Esfuerzo', { cadence: 100 }), rec(210, 50)), [cool(10)]])),

    // ---- Tests ----
    mk('ramp-test', 'Test de rampa', 'test',
      'Escalones de 1 minuto desde el 45 % de tu FTP actual, subiendo 6 % cada minuto hasta el 150 %. Pedalea hasta que no puedas sostener la cadencia. Tu mejor minuto (x 0,75) estima tu FTP. Descansado, hidratado y con todo.',
      rampTestSteps()),
    mk('ftp-20', 'Test FTP 20 min', 'test',
      'El test clásico: calentamiento con activación, 5 minutos fuertes para limpiar piernas y 20 minutos a máxima potencia sostenible. Tu FTP estimado es el 95 % de la potencia media de esos 20 minutos. Dosifica: sal al ritmo que puedas sostener hasta el final.',
      [st(10 * M, 50, 'Calentamiento', { end: 70 }), st(60, 90, 'Activación 1', { cadence: 110 }), st(60, 55, 'Suave'),
        st(60, 90, 'Activación 2', { cadence: 110 }), st(60, 55, 'Suave'), st(5 * M, 105, 'Esfuerzo de apertura (5 min)', { cadence: 95 }),
        st(10 * M, 50, 'Recuperación completa'), st(20 * M, 100, 'Test: 20 minutos a máxima potencia sostenible', { cadence: 90 }),
        st(8 * M, 60, 'Vuelta a la calma', { end: 40 })]),
  ];

  const INTENSE = ['umbral', 'vo2', 'anaerobico'];
  const byId = {};
  library.forEach((w) => { byId[w.id] = w; });
  // Generados (entrenar por tiempo): registro en memoria + copia compacta guardada en la actividad.
  const registry = {};
  function registerWorkout(w) { if (w && w.id) registry[w.id] = w; return w; }
  function compactWorkout(w) {
    return { id: w.id, name: w.name, category: w.category, durationS: w.durationS, tss: w.tss, steps: JSON.parse(JSON.stringify(w.steps)) };
  }
  function getWorkout(id, activities) {
    if (byId[id]) return byId[id];
    if (registry[id]) return registry[id];
    const list = activities || [];
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i] && list[i].workout;
      if (c && c.id === id && Array.isArray(c.steps)) {
        return registerWorkout(Object.assign({ description: '', generated: true }, JSON.parse(JSON.stringify(c))));
      }
    }
    return null;
  }

  // ======================================================================
  // Plan
  // ======================================================================
  const PREF_DAYS = [2, 4, 6, 0, 1, 3, 5]; // ma, ju, sa, do, lu, mi, vi
  const GOAL_K = { forma: 50, peso: 50, ftp: 55, evento: 60, 'gran-fondo': 60 };
  const SLOT_W = [1, 1, 1.8, 0.7, 0.7, 0.8, 0.5];
  const UNLOAD = 0.6; // descarga y taper: -40 %

  function phaseFor(i, total, taper, event) {
    if (taper && i === total) return 'taper';
    if (i % 4 === 0) return 'descarga';
    const m = taper ? total - 1 : total;
    const blocks = Math.ceil(m / 4);
    const k = Math.floor((i - 1) / 4);
    if (event) {
      if (k === blocks - 1) return 'especifico';
      return k === 0 ? 'base' : 'construccion';
    }
    return ['base', 'construccion', 'especifico'][Math.min(k, 2)];
  }

  function rolesFor(goal, phase) {
    const RE = ['resistencia'], RC = ['recuperacion'], TE = ['tempo'];
    if (phase === 'taper') return [['vo2'], RE, RE, RC, RC, RC, RC];
    if (phase === 'descarga') return [['tempo', 'resistencia'], RE, RE, RC, RC, RE, RC];
    const g = goal === 'gran-fondo' ? 'evento' : goal;
    let q1, q2, d3 = ['resistencia', 'recuperacion'];
    if (g === 'peso') { q1 = ['tempo', 'sweetspot']; q2 = RE; d3 = RE; }
    else if (g === 'forma') {
      if (phase === 'base') { q1 = ['sweetspot', 'tempo']; q2 = ['resistencia', 'tempo']; }
      else if (phase === 'construccion') { q1 = ['sweetspot']; q2 = ['vo2']; }
      else { q1 = ['sweetspot']; q2 = ['umbral']; }
    } else if (g === 'ftp') {
      if (phase === 'base') { q1 = ['sweetspot']; q2 = ['sweetspot', 'tempo']; }
      else if (phase === 'construccion') { q1 = ['umbral']; q2 = ['sweetspot']; }
      else { q1 = ['vo2']; q2 = ['umbral']; }
    } else {
      if (phase === 'base') { q1 = ['sweetspot']; q2 = ['tempo', 'resistencia']; }
      else if (phase === 'construccion') { q1 = ['umbral']; q2 = ['sweetspot']; }
      else { q1 = ['umbral', 'vo2']; q2 = ['sweetspot', 'umbral']; }
    }
    return [q1, q2, RE, d3, TE, RE, RC];
  }

  const poolFor = (cats) => library.filter((w) => cats.indexOf(w.category) >= 0);

  const SOFT_CATS = ['recuperacion', 'resistencia', 'tempo', 'sweetspot'];

  // Variedad: penaliza workouts usados recientemente (history: id -> índice de la última semana en que se usó)
  function varietyPenalty(id, weekIdx, history) {
    const last = history[id];
    if (last == null) return 0;
    const dist = weekIdx - last;
    return dist <= 1 ? 0.4 : dist <= 4 ? 0.25 : dist <= 8 ? 0.1 : 0;
  }

  function buildWeek(o) {
    const dates = [];
    for (let k = 0; k < 7; k++) dates.push(addDays(o.weekStart, k));
    const allowed = PREF_DAYS.slice(0, o.days);
    const train = dates.filter((d) => allowed.indexOf(weekday(d)) >= 0);
    const assigned = {};
    const capS = o.hours * 3600 * 1.1;
    let used = 0, rampTss = 0;
    let slots = train.slice();
    const fixed = [];
    if (o.ramp) {
      const rd = o.ramp === 'first' ? train[0] : train[train.length - 1];
      const ramp = byId['ramp-test'];
      assigned[rd] = ramp.id;
      used += ramp.durationS;
      rampTss = ramp.tss;
      fixed.push(ramp.id);
      slots = train.filter((d) => d !== rd);
    }
    const scale = o.phase === 'descarga' || o.phase === 'taper' ? UNLOAD : 1;
    const hDes = Math.max(1, o.hours * 3600 * scale - used);
    const tDes = Math.max(1, o.targetTss - rampTss);
    const roles = rolesFor(o.goal, o.phase);
    const ordered = slots.map((d) => ({ date: d, pos: PREF_DAYS.indexOf(weekday(d)) })).sort((a, b) => a.pos - b.pos);
    const wSum = ordered.reduce((sum, x) => sum + SLOT_W[x.pos], 0);

    // candidatos por slot: los del rol (sin penalización) + alternativas suaves (penalizadas)
    const pools = ordered.map((slot) => {
      const cats = roles[slot.pos];
      const inRole = poolFor(cats).map((w) => ({ w: w, pen: 0 }));
      const soft = poolFor(SOFT_CATS).filter((w) => cats.indexOf(w.category) < 0).map((w) => ({ w: w, pen: 0.35 }));
      return inRole.concat(soft);
    });
    const cost = (pick) => {
      let dur = used, tss = rampTss, pen = 0;
      pick.forEach((c, i) => {
        dur += c.w.durationS;
        tss += c.w.tss;
        pen += c.pen + varietyPenalty(c.w.id, o.weekIdx, o.history) + (fixed.indexOf(c.w.id) >= 0 ? 1 : 0);
      });
      pick.forEach((c, i) => { if (pick.findIndex((d) => d.w.id === c.w.id) !== i) pen += 1; });
      const over = Math.max(0, dur - capS) / capS;
      return 6 * Math.abs(tss - o.targetTss) / o.targetTss + Math.abs(dur - hDes - used) / (hDes + used) + 1000 * over + pen;
    };
    // inicio voraz: duración más cercana a la parte que le corresponde
    let pick = ordered.map((slot, i) => {
      const des = hDes * (SLOT_W[slot.pos] / wSum);
      return pools[i].slice().sort((a, b) => (Math.abs(a.w.durationS - des) + a.pen * 1e4) - (Math.abs(b.w.durationS - des) + b.pen * 1e4))[0];
    });
    let best = cost(pick);
    for (let pass = 0; pass < 12; pass++) {
      let improved = false;
      for (let i = 0; i < pick.length; i++) {
        for (const c of pools[i]) {
          if (c === pick[i]) continue;
          const trial = pick.slice();
          trial[i] = c;
          const v = cost(trial);
          if (v < best - 1e-9) { pick = trial; best = v; improved = true; }
        }
      }
      if (!improved) break;
    }
    ordered.forEach((slot, i) => { assigned[slot.date] = pick[i].w.id; });
    return dates.map((d) => ({ date: d, workoutId: assigned[d] || null, status: 'pendiente' }));
  }

  function buildPlan(opts) {
    const profile = (opts && opts.profile) || {};
    const startDate = opts && opts.startDate;
    if (typeof startDate !== 'string' || !DATE_RE.test(startDate)) {
      throw new Error('startDate es obligatoria y debe tener formato AAAA-MM-DD.');
    }
    const goal = GOAL_K[profile.goal] != null ? profile.goal : 'forma';
    const hours = Math.max(1, Number(profile.hoursPerWeek) || 5);
    const days = clamp(Math.round(Number(profile.daysPerWeek) || 4), 2, 7);
    let n = clamp(Math.round(profile.weeks != null ? Number(profile.weeks) : 8) || 8, 4, 24);
    const event = (goal === 'evento' || goal === 'gran-fondo') && !!profile.eventDate;
    const taper = event;
    if (event) n = clamp(Math.ceil((dayNum(profile.eventDate) - dayNum(startDate)) / 7), 4, 24);
    const t0 = hours * GOAL_K[goal] * (profile.level === 'principiante' ? 0.85 : 1);
    // tope de realizabilidad: por horas y por días (sesiones de <=120 min rinden ~85 TSS como máximo en la práctica)
    const maxTss = Math.min(t0 * 1.6, hours * 1.1 * 72, days * 85);
    let lastLoad = Math.min(t0, maxTss);
    const history = {};
    const weeks = [];
    for (let i = 1; i <= n; i++) {
      const phase = phaseFor(i, n, taper, event);
      let target;
      if (phase === 'descarga' || phase === 'taper') target = lastLoad * UNLOAD;
      else {
        // la progresión se reinicia por bloque de 4 semanas: inicio x (1 + 0.05 k) x 1.08^j
        const k = Math.floor((i - 1) / 4), j = (i - 1) % 4;
        target = Math.min(t0 * (1 + 0.05 * k) * Math.pow(1.08, j), maxTss);
        lastLoad = target;
      }
      let ramp = null;
      if (phase === 'descarga') ramp = 'last';
      else if (i === 1 && profile.ftpEstimated) ramp = 'first';
      const wdays = buildWeek({
        weekStart: addDays(startDate, 7 * (i - 1)), weekIdx: i, phase: phase, goal: goal, hours: hours, days: days,
        targetTss: target, ramp: ramp, history: history,
      });
      wdays.forEach((d) => { if (d.workoutId) history[d.workoutId] = i; });
      weeks.push({ index: i, phase: phase, targetTss: r1(target), days: wdays });
    }
    const now = opts.now ? new Date(opts.now) : new Date();
    return { createdAt: now.toISOString(), goal: goal, weeks: weeks };
  }

  // ======================================================================
  // Métricas
  // ======================================================================
  const BEST_WINDOWS = [5, 60, 300, 1200, 3600];

  function bestMean(powers, w) {
    if (powers.length < w || w <= 0) return null;
    let sum = 0;
    for (let i = 0; i < w; i++) sum += powers[i];
    let best = sum;
    for (let i = w; i < powers.length; i++) {
      sum += powers[i] - powers[i - w];
      if (sum > best) best = sum;
    }
    return best / w;
  }

  function computeMetrics(samples, ftp) {
    const n = samples ? samples.length : 0;
    if (!n) return { durationS: 0, avgPower: 0, np: 0, if: 0, tss: 0, kcal: 0, bestEfforts: {} };
    const p = samples.map((s) => Math.max(0, Number(s[1]) || 0));
    const total = p.reduce((a, b) => a + b, 0);
    const avg = total / n;
    let np = avg;
    if (n >= 30) {
      let win = 0, acc = 0, cnt = 0;
      for (let i = 0; i < n; i++) {
        win += p[i];
        if (i >= 30) win -= p[i - 30];
        if (i >= 29) { const m = win / 30; acc += m * m * m * m; cnt++; }
      }
      np = Math.pow(acc / cnt, 0.25);
    }
    const IF = ftp > 0 ? np / ftp : 0;
    const tss = ftp > 0 ? ((n * np * IF) / (ftp * 3600)) * 100 : 0;
    const bestEfforts = {};
    BEST_WINDOWS.forEach((w) => {
      const b = bestMean(p, w);
      if (b != null) bestEfforts[String(w)] = Math.round(b);
    });
    return { durationS: n, avgPower: Math.round(avg), np: Math.round(np), if: r2(IF), tss: r1(tss), kcal: Math.round(total / 1000), bestEfforts: bestEfforts };
  }

  function pmc(activities, o) {
    const opt = o || {};
    const days = opt.days != null ? opt.days : 120;
    const end = todayStr(opt.today);
    const start = addDays(end, -(days - 1));
    const tssBy = {};
    let first = start;
    (activities || []).forEach((a) => {
      const d = localDate(a.date);
      if (d > end) return;
      tssBy[d] = (tssBy[d] || 0) + (a.tss || 0);
      if (d < first) first = d;
    });
    const out = [];
    let ctl = 0, atl = 0;
    for (let d = first; d <= end; d = addDays(d, 1)) {
      const tss = tssBy[d] || 0;
      const tsb = ctl - atl;
      ctl += (tss - ctl) / 42;
      atl += (tss - atl) / 7;
      if (d >= start) out.push({ date: d, tss: r2(tss), ctl: r2(ctl), atl: r2(atl), tsb: r2(tsb) });
    }
    return out;
  }

  function actPowers(a) {
    return a.samples && a.samples.length ? a.samples.map((s) => Math.max(0, Number(s[1]) || 0)) : null;
  }
  function effort(a, powers, d) {
    if (powers) {
      const b = bestMean(powers, d);
      if (b != null) return b;
    }
    const v = a.bestEfforts && a.bestEfforts[String(d)];
    return v != null ? v : null;
  }

  function powerCurve(activities, durations) {
    const ds = durations || [1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];
    const best = {};
    (activities || []).forEach((a) => {
      const powers = actPowers(a);
      ds.forEach((d) => {
        const w = effort(a, powers, d);
        if (w != null && (!best[d] || w > best[d].watts)) {
          best[d] = { durationS: d, watts: Math.round(w), activityId: a.id, date: a.date };
        }
      });
    });
    return ds.filter((d) => best[d]).map((d) => best[d]);
  }

  function suggestFtpUpdate(activities, profile, o) {
    const today = todayStr(o && o.today);
    const from = addDays(today, -42);
    const cur = profile && profile.ftp;
    let best = null;
    const consider = (ftp, d, reason, isTest) => {
      // solo un test puede bajar el FTP; un rodaje cualquiera solo puede subirlo
      if (!isTest && !(cur > 0 ? ftp > cur : true)) return;
      if (!best || ftp > best.ftp) best = { ftp: ftp, d: d, reason: reason };
    };
    (activities || []).forEach((a) => {
      const d = localDate(a.date);
      if (d < from || d > today) return;
      const powers = actPowers(a);
      if (a.workoutId === 'ramp-test') {
        const w1 = effort(a, powers, 60);
        if (w1 != null) {
          const f = Math.round(0.75 * w1);
          consider(f, d, 'Tu mejor minuto en el test de rampa (' + Math.round(w1) + ' W, ' + d + ') equivale a un FTP de ' + f + ' W (75 %).', true);
        }
        return;
      }
      const w20 = effort(a, powers, 1200);
      if (w20 != null) {
        const f = Math.round(0.95 * w20);
        consider(f, d, 'Tu mejor esfuerzo de 20 minutos (' + Math.round(w20) + ' W, ' + d + ') equivale a un FTP de ' + f + ' W (95 %).', a.workoutId === 'ftp-20');
      }
    });
    if (!best) return null;
    if (cur > 0 && Math.abs(best.ftp - cur) / cur <= 0.02) return null;
    return { suggestedFtp: best.ftp, reason: best.reason + (cur > 0 ? ' Tu FTP actual es ' + cur + ' W.' : '') };
  }

  // ======================================================================
  // Adaptación
  // ======================================================================
  function isIntenseActivity(a) {
    const w = a.workoutId ? getWorkout(a.workoutId, [a]) : null;
    if (w) return INTENSE.indexOf(w.category) >= 0;
    return (a.if || 0) >= 0.9;
  }

  function adaptPlan(plan, activities, profile, o) {
    const today = todayStr(o && o.today);
    const next = JSON.parse(JSON.stringify(plan));
    const acts = (activities || []).filter((a) => localDate(a.date) <= today);
    const byDay = {};
    const shortBy = {};
    acts.forEach((a) => {
      const dt = localDate(a.date);
      byDay[dt] = true;
      const m = /^tiempo-hoy-(\d+)-/.exec(a.workoutId || '');
      if (m) shortBy[dt] = +m[1];
    });
    const all = [];
    next.weeks.forEach((w) => w.days.forEach((d) => all.push(d)));
    all.forEach((d) => {
      if (!d.workoutId || d.date > today) return;
      if (byDay[d.date]) d.status = 'hecho';
      else if (d.date < today) d.status = 'saltado';
      else d.status = 'pendiente';
      // versión corta de la sesión del día (entrenar por tiempo): cuenta como hecha, con nota
      if (d.status === 'hecho' && shortBy[d.date]) d.note = 'versión corta (' + shortBy[d.date] + ' min)';
      else if (typeof d.note === 'string' && d.note.indexOf('versión corta') === 0) delete d.note;
    });

    const tsb = (pmc(acts, { days: 120, today: today }).pop() || { tsb: 0 }).tsb;
    const weekAgo = addDays(today, -6);
    const hardRpe = acts.filter((a) => localDate(a.date) >= weekAgo && a.rpe != null && a.rpe >= 9).length >= 2;
    const upcoming = all.filter((d) => d.date >= today && d.workoutId && d.status === 'pendiente');
    let reason = null;

    if (hardRpe || tsb < -30) {
      const target = upcoming.find((d) => INTENSE.indexOf(getWorkout(d.workoutId).category) >= 0);
      if (target) {
        const orig = getWorkout(target.workoutId);
        const cat = tsb < -30 ? 'recuperacion' : 'resistencia';
        let pool = library.filter((w) => w.category === cat);
        const fit = pool.filter((w) => w.durationS <= orig.durationS);
        pool = fit.length ? fit : pool.slice().sort((a, b) => a.durationS - b.durationS).slice(0, 1);
        const rep = pool.sort((a, b) => b.durationS - a.durationS)[0];
        target.workoutId = rep.id;
        reason = (hardRpe
          ? 'Reportaste un esfuerzo percibido (RPE) de 9 o más en dos sesiones de la última semana'
          : 'Tu fatiga acumulada es alta (TSB ' + Math.round(tsb) + ')')
          + '. Cambiamos tu próxima sesión intensa (' + orig.name + ') por "' + rep.name + '" para que te recuperes y llegues fresco a la siguiente.';
      }
    } else {
      const intense = acts.filter(isIntenseActivity).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 2);
      if (intense.length === 2 && intense.every((a) => a.rpe != null && a.rpe <= 4) && tsb > -10) {
        const target = upcoming.find((d) => getWorkout(d.workoutId).category !== 'test');
        if (target) {
          const orig = getWorkout(target.workoutId);
          const rep = library.filter((w) => w.category === orig.category && w.tss > orig.tss && w.durationS <= orig.durationS * 1.1).sort((a, b) => a.tss - b.tss)[0];
          if (rep) {
            target.workoutId = rep.id;
            reason = 'Tus dos últimas sesiones intensas se sintieron fáciles (RPE 4 o menos) y llegas fresco (TSB ' + Math.round(tsb) + '). Subimos tu próxima sesión de "' + orig.name + '" a "' + rep.name + '".';
          }
        }
      }
    }
    next.lastAdaptation = reason ? { date: today, reason: reason } : null;
    return next;
  }

  // Como adaptPlan, pero si el plan ya se adaptó hoy conserva las sesiones elegidas
  // (solo actualiza estados) para que dos pasadas el mismo día den un solo cambio.
  // Devuelve { plan, reason }: reason es el motivo nuevo a mostrar (o null).
  function adaptPlanOnce(plan, activities, profile, o) {
    const today = todayStr(o && o.today);
    const adapted = adaptPlan(plan, activities, profile, { today: today });
    const prev = plan.lastAdaptation;
    if (prev && prev.date === today) {
      const byDate = {};
      plan.weeks.forEach((w) => w.days.forEach((d) => { byDate[d.date] = d.workoutId; }));
      adapted.weeks.forEach((w) => w.days.forEach((d) => { if (d.date in byDate) d.workoutId = byDate[d.date]; }));
      adapted.lastAdaptation = prev;
    }
    const la = adapted.lastAdaptation;
    const reason = la && la.reason && !(prev && prev.date === today && prev.reason === la.reason) ? la.reason : null;
    return { plan: adapted, reason: reason };
  }

  // ======================================================================
  // Entrenar por tiempo disponible
  // ======================================================================
  const TIMED_FOCUS = ['hoy', 'recuperacion', 'resistencia', 'tempo', 'sweetspot', 'umbral', 'vo2', 'sprints', 'sorpresa', 'auto'];
  const FOCUS_CAT = { recuperacion: 'recuperacion', resistencia: 'resistencia', tempo: 'tempo', sweetspot: 'sweetspot', umbral: 'umbral', vo2: 'vo2', sprints: 'anaerobico' };
  const TIMED_LABEL = { recuperacion: 'Recuperación activa', resistencia: 'Resistencia', tempo: 'Tempo', sweetspot: 'Sweet spot', umbral: 'Umbral', vo2: 'VO2máx', anaerobico: 'Sprints' };
  const TIMED_INTRO = {
    recuperacion: 'Rodaje regenerativo con pequeños giros rápidos: piernas sueltas y cero fatiga.',
    resistencia: 'Base aeróbica a ritmo estable en zona 2: si puedes hablar en frases completas, vas en el punto justo.',
    tempo: 'Trabajo firme pero sostenible en zona 3 para entrenar el ritmo de rodada larga.',
    sweetspot: 'El mejor equilibrio entre estímulo y fatiga: mucha forma con poco desgaste.',
    umbral: 'Trabajo en tu FTP para subir el umbral: concentración y potencia pareja desde el primer minuto.',
    vo2: 'Intervalos cortos y exigentes para empujar tu techo aeróbico. Con menos tiempo hay menos repeticiones, pero la intensidad se mantiene.',
    anaerobico: 'Sprints máximos de 10 segundos, de pie y con recuperación casi completa: potencia pura sin fatiga acumulada.',
  };
  // Bloques escalables: la duración del bloque se estira hasta llenar el tiempo (hasta wMax); si sobra, se agregan repeticiones (hasta nMax).
  const STRETCH = {
    tempo: { pct: 80, cad: 90, recPct: 55, r: 240, wMax: 1800, nMax: 3, label: 'Tempo' },
    sweetspot: { pct: 90, cad: 90, recPct: 55, r: 240, wMax: 1200, nMax: 3, label: 'Sweet Spot' },
    umbral: { pct: 100, cad: 90, recPct: 50, r: 300, wMax: 1200, nMax: 3, label: 'Umbral' },
  };
  // VO2: [minutos del bloque principal desde, repeticiones, trabajo s, recuperación s]; menos tiempo = menos repeticiones, misma intensidad
  const VO2_TABLE = [[0, 3, 60, 90], [10, 3, 90, 90], [12, 4, 90, 90], [16, 4, 120, 150], [28, 5, 180, 180], [40, 5, 240, 240], [52, 6, 240, 240], [80, 6, 300, 300]];
  const PHASE_POOL = {
    base: ['resistencia', 'tempo', 'sweetspot'], construccion: ['sweetspot', 'umbral', 'tempo'],
    especifico: ['umbral', 'vo2', 'sweetspot'], descarga: ['resistencia', 'recuperacion'], taper: ['resistencia', 'recuperacion'],
  };
  const QUALITY = ['tempo', 'sweetspot', 'umbral', 'vo2', 'anaerobico'];

  const sumDur = (steps) => steps.reduce((a, s) => a + s.durationS, 0);
  const avgPct = (s) => (s.powerPct + (s.powerPctEnd != null ? s.powerPctEnd : s.powerPct)) / 2;
  function fmtSpan(sec) {
    if (sec < 60) return Math.round(sec) + ' s';
    const m = Math.floor(sec / 60), r = Math.round(sec % 60);
    return r ? m + ' min ' + r + ' s' : m + ' min';
  }

  // Elementos del bloque principal: { steps: [...], rec: bool }. padMain llena el tiempo exacto.
  function padMain(items, M, tailPct) {
    const recs = items.filter((i) => i.rec);
    let rem = M - items.reduce((a, i) => a + sumDur(i.steps), 0);
    if (rem > 0 && recs.length) {
      const mean = recs.reduce((a, i) => a + sumDur(i.steps), 0) / recs.length;
      const e = Math.min(Math.floor(rem / recs.length), Math.floor(0.5 * mean));
      recs.forEach((i) => { i.steps[0].durationS += e; });
      rem -= e * recs.length;
    }
    const steps = flat(items.map((i) => i.steps));
    if (rem >= 60) steps.push(st(rem, tailPct, 'Rodaje aeróbico suave', { cadence: 90 }));
    else if (rem !== 0 && steps.length) steps[steps.length - 1].durationS += rem;
    return steps;
  }

  // Calentamiento; en sesiones intensas con >= 8 min incluye 2 activaciones de 20 s al ~115 % al final.
  function warmSteps(cat, warmMin, endPct) {
    if ((cat === 'vo2' || cat === 'umbral' || cat === 'anaerobico') && warmMin >= 8) {
      return [st(warmMin * 60 - 120, 45, 'Calentamiento progresivo', { end: endPct }),
        st(20, 115, 'Activación 1/2', { cadence: 110 }), st(40, 50, 'Suave'), st(20, 115, 'Activación 2/2', { cadence: 110 }), st(40, 50, 'Suave')];
    }
    return [warm(warmMin, 45, endPct)];
  }
  // Frase sobre los pasos "de relleno" y las activaciones, para la descripción
  function fillerText(steps, min) {
    let t = '';
    if (steps.some((x) => /^Activación/.test(x.label))) t += ' El calentamiento termina con dos activaciones de 20 s.';
    const f = steps.filter((x) => x.label === 'Rodaje aeróbico suave')[0];
    if (f) t += ' Para completar los ' + min + ' min se agrega un rodaje aeróbico suave de ' + fmtSpan(f.durationS) + ' tras los intervalos.';
    return t;
  }

  function freshItems(cat, M) {
    const work = (steps) => ({ steps: [].concat(steps), rec: false });
    const rest = (step) => ({ steps: [step], rec: true });
    if (cat === 'resistencia') return { items: [work(st(M, M >= 2400 ? 68 : 65, 'Ritmo aeróbico estable', { cadence: 90 }))], plan: { kind: 'steady' } };
    if (cat === 'recuperacion') {
      const Mw = Math.min(M, 3600); // tope de 60 min de bloque: más tiempo no mejora una recuperación
      const n = Math.floor(Mw / 600), out = [];
      for (let i = 0; i < n; i++) out.push(st(540, 50, 'Pedaleo suave'), st(60, 55, 'Giros rápidos', { cadence: 100 }));
      if (Mw - n * 600 > 0) out.push(st(Mw - n * 600, 50, 'Pedaleo suave y fluido', { cadence: 90 }));
      if (M > Mw) out.push(st(M - Mw, 50, 'Opcional: puedes terminar antes', { cadence: 90 }));
      return { items: [work(out)], plan: { kind: 'steady' } };
    }
    let n, w, r, pct, rpct, name, ex;
    if (STRETCH[cat]) {
      const sp = STRETCH[cat];
      r = sp.r; pct = sp.pct; rpct = sp.recPct; name = sp.label; ex = { cadence: sp.cad };
      for (n = 1; n <= sp.nMax; n++) { w = (M - (n - 1) * r) / n; if (w <= sp.wMax) break; }
      if (n > sp.nMax) { n = sp.nMax; w = sp.wMax; }
      w = Math.floor(w / 10) * 10;
    } else if (cat === 'vo2') {
      const mm = M / 60;
      const row = VO2_TABLE.filter((x) => x[0] <= mm).pop();
      n = row[1]; w = row[2]; r = row[3]; pct = 115; rpct = 50; name = 'VO2'; ex = { cadence: 95 };
    } else { // anaerobico: sprints
      w = 10; r = 180; n = clamp(Math.floor((M + r) / (w + r)), 3, 8); pct = 200; rpct = 50; name = 'Sprint'; ex = { cadence: 120, position: 'pie' };
    }
    const items = [];
    for (let i = 1; i <= n; i++) {
      items.push(work(st(w, pct, n > 1 ? name + ' ' + i + '/' + n : name, ex)));
      if (i < n) items.push(rest(st(r, rpct, cat === 'anaerobico' ? 'Recuperación completa' : 'Recuperación suave')));
    }
    return { items: items, plan: { kind: 'blocks', n: n, w: w, r: r, pct: pct } };
  }

  function describeStructure(p) {
    if (p.kind !== 'blocks') return '';
    if (p.n === 1) return fmtSpan(p.w) + ' continuos al ' + p.pct + ' % de tu FTP';
    return p.n + '×' + fmtSpan(p.w) + ' al ' + p.pct + ' % de tu FTP con ' + fmtSpan(p.r) + ' de recuperación';
  }

  // Separa una sesión en calentamiento / principal / enfriamiento y el principal en grupos de trabajo y pausas largas.
  function splitSession(w) {
    const s = w.steps;
    let a = 0, b = s.length;
    if (s.length > 2 && /alentamiento|^Entrada/i.test(s[0].label || '')) a = 1;
    if (b - a > 1 && /^Vuelta|^Soltar/i.test(s[b - 1].label || '')) b--;
    const main = s.slice(a, b);
    const peak = Math.max.apply(null, main.map((x) => Math.max(x.powerPct, x.powerPctEnd != null ? x.powerPctEnd : 0)));
    const groups = [], breaks = [];
    let cur = [];
    main.forEach((x) => {
      if (avgPct(x) < 0.75 * peak && x.durationS >= 120 && cur.length) { groups.push(cur); breaks.push(x); cur = []; } else cur.push(x);
    });
    if (cur.length) groups.push(cur);
    else if (breaks.length) breaks.pop();
    return { groups: groups, breaks: breaks };
  }

  // Recorta un grupo de trabajo a la fracción s de su duración (un paso se acorta; varios pasos se cortan en un límite de paso).
  function scaleGroup(g, s) {
    const clone = g.map((x) => Object.assign({}, x));
    if (clone.length === 1) { clone[0].durationS = Math.max(10, Math.floor((clone[0].durationS * s) / 5) * 5); return clone; }
    const lim = sumDur(clone) * s, out = [];
    let acc = 0;
    for (const x of clone) { if (out.length && acc + x.durationS > lim) break; out.push(x); acc += x.durationS; }
    return out;
  }

  // Numeración coherente ("3/5", "(serie 1/2)") tras quitar repeticiones.
  function renumber(steps) {
    const SER = /\((serie|bloque) (\d+)\/(\d+)\)/, LEAD = / \d+\/\d+/;
    const sv = [];
    steps.forEach((x) => { const m = SER.exec(x.label || ''); if (m && sv.indexOf(m[1] + m[2]) < 0) sv.push(m[1] + m[2]); });
    steps.forEach((x) => { if (SER.test(x.label || '')) x.label = x.label.replace(SER, (_, wd, i) => '(' + wd + ' ' + (sv.indexOf(wd + i) + 1) + '/' + sv.length + ')'); });
    // las pausas internas ("Pausa 3/8") heredan la serie del paso de trabajo anterior
    let ser = '';
    const key = (x) => { const m = SER.exec(x.label || ''); if (m) ser = m[1] + m[2]; return x.label.replace(LEAD, ' #').replace(SER, '') + '|' + ser; };
    const total = {}, seen = {};
    const keys = steps.map((x) => (LEAD.test(x.label || '') || SER.test(x.label || '') ? key(x) : null));
    steps.forEach((x, i) => { if (keys[i] && LEAD.test(x.label || '')) total[keys[i]] = (total[keys[i]] || 0) + 1; });
    steps.forEach((x, i) => {
      if (!keys[i] || !LEAD.test(x.label || '')) return;
      seen[keys[i]] = (seen[keys[i]] || 0) + 1;
      x.label = x.label.replace(LEAD, ' ' + seen[keys[i]] + '/' + total[keys[i]]);
    });
  }

  function compressItems(orig, M) {
    const sp = splitSession(orig);
    const n = sp.groups.length;
    const gd = sp.groups.map(sumDur);
    const b = sp.breaks.length ? Math.round(sp.breaks.reduce((a, x) => a + x.durationS, 0) / sp.breaks.length) : 0;
    const brk = (dur) => Object.assign({}, sp.breaks[0] || {}, { durationS: dur });
    const need = (idx) => idx.reduce((a, i) => a + gd[i], 0) + (idx.length - 1) * b;
    // k grupos más largos, en su orden original
    const pickK = (k) => gd.map((d, i) => [d, i]).sort((x, y) => y[0] - x[0] || x[1] - y[1]).slice(0, k).map((x) => x[1]).sort((x, y) => x - y);
    let k = n;
    while (k > 1 && need(pickK(k)) > M) k--;
    let idx = pickK(k);
    let groups = idx.map((i) => sp.groups[i].map((x) => Object.assign({}, x)));
    let bdur = b, scaled = false;
    if (need(idx) > M || (k < Math.min(2, n))) {
      k = Math.min(2, n); idx = pickK(k);
      const s = M / need(idx);
      scaled = true;
      groups = idx.map((i) => scaleGroup(sp.groups[i], s));
      bdur = Math.max(60, Math.floor((b * s) / 5) * 5);
    }
    const items = [];
    groups.forEach((g, i) => {
      items.push({ steps: g, rec: false });
      if (i < groups.length - 1) items.push({ steps: [brk(bdur)], rec: true });
    });
    return { items: items, reps: [n, groups.length], scaled: scaled };
  }


  // ======================================================================
  // Pausas de hidratación
  // ======================================================================
  const HYD_INTENSE_PCT = 88;   // desde sweet spot hacia arriba un paso es "intenso" y no se corta
  const HYD_MIN_START_S = 8 * 60; // no insertar en los primeros 8 min
  const HYD_MIN_END_S = 5 * 60;   // ni en los últimos 5 min (del entrenamiento original)
  const HYD_MIN_FRAGMENT_S = 30;  // al partir un paso suave, cada trozo dura al menos esto
  const stepIntensity = (s) => Math.max(s.powerPct, s.powerPctEnd != null ? s.powerPctEnd : s.powerPct);

  // Devuelve una copia del entrenamiento con pausas { durationS, powerPct: 50, label: 'Hidratación', hydrate: true }
  // cada ~everyMin min de trabajo. Las pausas van entre pasos o dentro de un paso suave (que se parte en
  // dos); nunca dentro de un paso intenso (>= 88 % FTP; incluye todo paso >= 106 % y los intensos < 3 min).
  // Si el momento toca dentro de un bloque intenso continuo, la pausa va justo después del bloque.
  // Los tiempos se miden en el entrenamiento original (sin contar las pausas). Los tests se devuelven sin pausas.
  function withHydration(workout, opts) {
    opts = opts || {};
    const everyMin = isFinite(opts.everyMin) && opts.everyMin > 0 ? clamp(opts.everyMin, 5, 60) : 12;
    const pauseS = Math.round(isFinite(opts.durationS) && opts.durationS > 0 ? clamp(opts.durationS, 15, 120) : 45);
    const everyS = everyMin * 60;
    const src = workout.steps.map((s) => Object.assign({}, s));
    const T = sumDur(src);
    const pause = () => ({ durationS: pauseS, powerPct: 50, label: 'Hidratación', hydrate: true });
    const out = [];
    let count = 0;
    if (workout.category !== 'test') {
      let due = Math.max(everyS, HYD_MIN_START_S), pending = false, done = false, t = 0;
      const valid = (p) => p >= HYD_MIN_START_S && p <= T - HYD_MIN_END_S;
      const insertAt = (p) => { out.push(pause()); count++; due = p + everyS; pending = false; };
      src.forEach((step) => {
        const a = t, b = t + step.durationS;
        t = b;
        if (done) { out.push(step); return; }
        const soft = stepIntensity(step) < HYD_INTENSE_PCT;
        if (pending || due <= a) {
          if (soft) {
            if (a > T - HYD_MIN_END_S) done = true; else if (valid(a)) insertAt(a); else pending = true;
          } else pending = true;
        }
        if (!soft) { if (!done && due < b) pending = true; out.push(step); return; }
        // paso suave: puede partirse en el instante `due`
        let cur = step, ca = a;
        while (!done && due > ca && due < b) {
          if (due > T - HYD_MIN_END_S) { done = true; break; }
          const first = due - ca, second = b - due;
          if (first >= HYD_MIN_FRAGMENT_S && second >= HYD_MIN_FRAGMENT_S && valid(due)) {
            const p0 = cur.powerPct, p1 = cur.powerPctEnd != null ? cur.powerPctEnd : cur.powerPct;
            const mid = p0 + (p1 - p0) * (first / cur.durationS);
            const head = Object.assign({}, cur, { durationS: Math.round(first) });
            const tail = Object.assign({}, cur, { durationS: cur.durationS - head.durationS });
            if (cur.powerPctEnd != null) { head.powerPctEnd = mid; tail.powerPct = mid; }
            const p = due; out.push(head); insertAt(p); cur = tail; ca = p;
          } else if (first < HYD_MIN_FRAGMENT_S && valid(ca)) {
            insertAt(ca);
          } else if (second < HYD_MIN_FRAGMENT_S && valid(b)) {
            break; // la pausa va al inicio del siguiente paso (due <= b)
          } else { break; }
        }
        out.push(cur);
      });
    } else {
      src.forEach((s) => out.push(s));
    }
    const w = Object.assign({}, workout, { steps: out });
    w.durationS = sumDur(out);
    w.tss = r1(out.reduce((acc, s) => acc + stepTss(s), 0));
    w.hydration = { everyMin: everyMin, durationS: pauseS, count: count };
    return w;
  }

  function timedWorkout(o) {
    o = o || {};
    const min = o.durationMin;
    if (typeof min !== 'number' || !isFinite(min) || Math.floor(min) !== min) throw new Error('La duración debe ser un número entero de minutos entre 15 y 150.');
    if (min < 15 || min > 150) throw new Error('La duración debe estar entre 15 y 150 minutos.');
    const focus = o.focus == null ? 'auto' : o.focus;
    if (TIMED_FOCUS.indexOf(focus) < 0) throw new Error('Enfoque no válido: "' + focus + '".');
    const today = todayStr(o.today);
    const acts = o.activities || [];
    const T = min * 60;

    // forma y fatiga
    const tsb = (pmc(acts, { days: 120, today: today }).pop() || { tsb: 0 }).tsb;
    const yesterday = addDays(today, -1);
    const hardYesterday = acts.some((a) => localDate(a.date) === yesterday && a.rpe != null && a.rpe >= 9);

    // sesión de hoy y fase del plan
    let todayW = null, phase = null, todayStatus = null;
    const upcoming = [];
    if (o.plan && o.plan.weeks) {
      o.plan.weeks.forEach((wk) => wk.days.forEach((d) => {
        if (d.date === today) { phase = wk.phase; if (d.workoutId) { todayW = getWorkout(d.workoutId); todayStatus = d.status; } }
        else if (d.date > today && d.date <= addDays(today, 7) && d.workoutId && d.status === 'pendiente') upcoming.push(getWorkout(d.workoutId));
      }));
    }

    // la sesión de hoy ya hecha: hoy cuenta como día de descanso y su TSS suma a la fatiga
    const actsToday = acts.filter((a) => localDate(a.date) === today);
    const tssToday = actsToday.reduce((a, x) => a + (Number(x.tss) || 0), 0);
    const doneToday = !!todayW && (todayStatus === 'hecho' || actsToday.length > 0);
    const tsbEff = tsb - tssToday * (1 / 7 - 1 / 42);
    const tiredNow = tsbEff < -25;
    const soften = (cat) => {
      if (tiredNow) return cat === 'recuperacion' ? cat : 'recuperacion';
      if (hardYesterday) return cat === 'recuperacion' || cat === 'resistencia' ? cat : 'resistencia';
      return cat;
    };
    const fatigueNotice = tiredNow
      ? 'Tu fatiga acumulada es alta (TSB ' + Math.round(tsbEff) + '), así que hoy priorizamos recuperar con un rodaje suave.'
      : 'Ayer reportaste un esfuerzo percibido (RPE) de 9 o más, así que hoy bajamos la intensidad a un rodaje aeróbico.';

    let cat, notice = null, lead = '';
    let baseCat = null, base = null;
    const doneNotice = 'Ya completaste la sesión de hoy: te proponemos un rodaje suave para sumar sin acumular fatiga.';
    if (FOCUS_CAT[focus]) {
      cat = FOCUS_CAT[focus];
      // enfoque explícito: se respeta, con advertencia no bloqueante si la fatiga es alta
      if (tiredNow && cat !== 'recuperacion') notice = 'Tu fatiga es alta; considera Recuperación (TSB ' + Math.round(tsbEff) + ').';
      else if (hardYesterday && cat !== 'recuperacion' && cat !== 'resistencia') notice = 'Tu fatiga es alta; considera Recuperación (ayer reportaste un RPE de 9 o más).';
    } else {
      if (doneToday) { todayW = null; lead = ''; }
      if (focus === 'hoy') {
        if (todayW) { base = todayW; baseCat = todayW.category; }
        else {
          baseCat = tsbEff < -10 ? 'recuperacion' : 'resistencia';
          lead = doneToday ? '' : 'Hoy no tienes sesión en tu plan (día de descanso): te proponemos un rodaje suave de ' + min + ' min. ';
        }
      } else if (focus === 'auto') {
        if (todayW) baseCat = todayW.category === 'test' ? 'resistencia' : todayW.category;
        else if (doneToday) baseCat = tsbEff < -10 ? 'recuperacion' : 'resistencia';
        else if (tsb > 0) {
          const q = upcoming.filter((w) => w && QUALITY.indexOf(w.category) >= 0)[0];
          baseCat = q ? q.category : 'sweetspot';
          lead = 'Estás fresco (TSB ' + Math.round(tsb) + ')' + (q ? ' y esta semana te toca trabajo de ' + (TIMED_LABEL[q.category] || q.category).toLowerCase() : '') + ': aprovechamos el tiempo con calidad. ';
        } else baseCat = 'resistencia';
      } else { // sorpresa
        const pool = PHASE_POOL[phase] || PHASE_POOL.base;
        baseCat = pool[(dayNum(today) + min) % pool.length];
        lead = 'Sesión sorpresa acorde a tu fase' + (phase ? ' (' + phase + ')' : '') + '. ';
      }
      cat = soften(baseCat);
      if (cat !== baseCat) { notice = fatigueNotice; base = null; }
      if (doneToday && (focus === 'auto' || focus === 'hoy')) notice = doneNotice + (notice ? ' ' + notice : '');
    }
    const idFor = () => 'tiempo-' + focus + '-' + min + '-' + today.replace(/-/g, '');
    const finish = (w) => {
      w.durationS = sumDur(w.steps);
      w.tss = r1(w.steps.reduce((a, s) => a + stepTss(s), 0));
      if (w.durationS !== T) throw new Error('La sesión por tiempo no suma ' + min + ' min.');
      w.generated = true; w.focus = focus; w.notice = notice;
      return w;
    };

    // 'hoy': sesión del plan tal cual si cabe, comprimida si no
    if (focus === 'hoy' && base) {
      if (base.durationS <= T) return base;
      if (base.category === 'test') {
        cat = 'resistencia';
        notice = 'El test "' + base.name + '" dura ' + Math.round(base.durationS / 60) + ' min y no cabe en ' + min + ' min: hoy rodamos resistencia y dejas el test para un día con más tiempo.';
      } else {
        const warmMin = clamp(Math.round(0.15 * min), 5, 15), coolMin = Math.max(3, Math.round(0.1 * min));
        const M = T - (warmMin + coolMin) * 60;
        const cmp = compressItems(base, Math.max(M, 60));
        const mainSteps = padMain(cmp.items, Math.max(M, 60), base.category === 'recuperacion' ? 50 : 62);
        const steps = warmSteps(base.category, warmMin, base.category === 'recuperacion' ? 50 : 70).concat(mainSteps, [cool(coolMin)]);
        renumber(steps);
        const body = cmp.scaled || cmp.reps[1] === cmp.reps[0] ? 'bloques más cortos y recuperaciones proporcionales' : 'menos repeticiones (de ' + cmp.reps[0] + ' a ' + cmp.reps[1] + ') y recuperaciones proporcionales';
        return finish({
          id: idFor(), name: min + ' min · ' + base.name + ' (versión corta)', category: base.category,
          description: 'Versión de ' + min + ' min de "' + base.name + '" (' + Math.round(base.durationS / 60) + ' min): mismo tipo de trabajo y misma intensidad, con ' + body + '. Calentamiento de ' + warmMin + ' min y ' + coolMin + ' min de vuelta a la calma.' + fillerText(steps, min),
          basedOn: base.id, steps: steps,
        });
      }
    }

    // sesión nueva por categoría
    const warmMin = clamp(Math.round(0.15 * min), 5, 15), coolMin = Math.max(3, Math.round(0.1 * min));
    const M = T - (warmMin + coolMin) * 60;
    const fi = freshItems(cat, M);
    const soft = cat === 'recuperacion';
    if (soft && M > 3600) notice = (notice ? notice + ' ' : '') + 'Una recuperación rinde hasta ~60 min: puedes terminar antes, tras el bloque principal; el tramo final es opcional.';
    const steps = (soft ? [st(warmMin * 60, 40, 'Calentamiento progresivo', { end: 50 })] : warmSteps(cat, warmMin, cat === 'resistencia' ? 65 : 72))
      .concat(padMain(fi.items, M, soft ? 50 : 62), [soft ? st(coolMin * 60, 50, 'Vuelta a la calma', { end: 40 }) : cool(coolMin)]);
    const label = TIMED_LABEL[cat] + (min <= 45 ? ' exprés' : '');
    const struct = describeStructure(fi.plan);
    const description = lead + (notice ? notice + ' ' : '') + TIMED_INTRO[cat] + ' Calentamiento de ' + warmMin + ' min' + (struct ? ', ' + struct : ', ' + fmtSpan(M) + ' de trabajo continuo') + ' y ' + coolMin + ' min de vuelta a la calma.' + fillerText(steps, min);
    return finish({ id: idFor(), name: min + ' min · ' + label, category: cat, description: description, steps: steps });
  }

  // ======================================================================
  // Ejecución de un entrenamiento
  // ======================================================================
  function targetPowerAt(workout, tS, ftp) {
    const steps = workout.steps;
    const total = workout.durationS;
    const t = clamp(tS, 0, total);
    let start = 0;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const last = i === steps.length - 1;
      if (t < start + s.durationS || last) {
        const elapsed = clamp(t - start, 0, s.durationS);
        const end = s.powerPctEnd != null ? s.powerPctEnd : s.powerPct;
        const pct = s.powerPct + (end - s.powerPct) * (s.durationS ? elapsed / s.durationS : 0);
        return { watts: Math.round((pct * ftp) / 100), stepIndex: i, step: s, stepElapsedS: elapsed, stepRemainingS: s.durationS - elapsed };
      }
      start += s.durationS;
    }
    return null;
  }

  // ======================================================================
  // Motivación
  // ======================================================================
  const motivationPhrases = [
    'Cada pedalada de hoy es un depósito en tu cuenta de forma de mañana.',
    'La constancia le gana al talento cuando el talento no rueda.',
    'No hace falta que sea perfecto: hace falta que sea hoy.',
    'Tu yo del futuro te agradece cada minuto que le sumas al rodillo.',
    'Respira, cadencia estable y a disfrutar del proceso.',
    'El rodillo no tiene viento ni semáforos: solo tú y tu progreso.',
    'Los días en que menos ganas tienes son los que más construyen carácter.',
    'Una sesión a la vez, así se arma una temporada.',
    'La forma se construye en la suma de días normales.',
    'Si hoy toca suave, rodar suave también es entrenar bien.',
    'La recuperación es parte del plan: descansar es entrenar con inteligencia.',
    'Tu cuerpo se adapta a lo que le pides con regularidad. Pídele bien.',
    'Empieza el calentamiento y deja que las piernas te digan lo demás.',
    'Cada intervalo terminado es una pequeña victoria.',
    'Los grandes cambios empiezan con una sesión que casi no hiciste.',
    'Hidrátate, ventila bien la pieza y rueda con ganas.',
    'Mide tu progreso contra quien eras hace un mes, no contra nadie más.',
    'La paciencia también se entrena, y el rodillo es un gran gimnasio para eso.',
    'Rodar hoy es cuidar tu salud de largo plazo.',
    'Un buen calentamiento vale más que cinco minutos extra de intensidad.',
    'La potencia se gana en silencio, minuto a minuto.',
    'Tus piernas saben más de lo que crees: confía en el plan.',
    'Hoy no tienes que ser el más fuerte, solo el más constante.',
    'Cada sesión completada te acerca a tu próxima marca personal.',
    'Sube la música, baja la cabeza y pedalea.',
    'Cuando duela, recuerda por qué empezaste y da un pedalazo más.',
  ];

  const DURATION_LABEL = { 1: '1 s', 5: '5 s', 15: '15 s', 30: '30 s', 60: '1 min', 120: '2 min', 300: '5 min', 600: '10 min', 1200: '20 min', 1800: '30 min', 3600: '1 h' };

  function motivation(o) {
    const opt = o || {};
    const profile = opt.profile || {};
    const acts = opt.activities || [];
    const today = todayStr(opt.today);
    const seed = dayNum(today);
    const name = profile.name ? String(profile.name) : '';
    const capFirst = (t) => t.replace(/\p{L}/u, (c) => c.toUpperCase());
    const nameCap = capFirst(name);
    const cap = (t) => (nameCap ? nameCap + ', ' + t : capFirst(t));
    const parts = [];

    // racha
    const dates = new Set(acts.map((a) => localDate(a.date)));
    let d = dates.has(today) ? today : addDays(today, -1);
    let streak = 0;
    while (dates.has(d)) { streak++; d = addDays(d, -1); }
    if (streak >= 2) parts.push(cap('llevas ' + streak + ' días seguidos rodando, ¡qué racha!'));
    else if (dates.has(today)) parts.push(cap('hoy ya sumaste tu sesión, ¡bien hecho!'));

    // progreso de CTL
    const series = pmc(acts, { days: 29, today: today });
    if (series.length === 29) {
      const a = series[0].ctl, b = series[28].ctl;
      if (b - a >= 1) parts.push(cap('tu forma (CTL) subió de ' + Math.round(a) + ' a ' + Math.round(b) + ' en las últimas 4 semanas.'));
    }

    // próxima sesión
    if (opt.plan && opt.plan.weeks) {
      let nxt = null;
      opt.plan.weeks.forEach((w) => w.days.forEach((x) => {
        if (!nxt && x.date >= today && x.workoutId && x.status === 'pendiente') nxt = x;
      }));
      const wk = nxt && getWorkout(nxt.workoutId);
      if (wk) {
        const diff = dayNum(nxt.date) - seed;
        const when = diff === 0 ? 'hoy' : diff === 1 ? 'mañana' : 'el ' + nxt.date;
        parts.push(cap('tu próxima sesión es "' + wk.name + '" (' + Math.round(wk.durationS / 60) + ' min), ' + when + '.'));
      }
    }

    // récords recientes
    const cut = addDays(today, -6);
    const recent = acts.filter((a) => localDate(a.date) >= cut && localDate(a.date) <= today);
    const prior = acts.filter((a) => localDate(a.date) < cut);
    if (recent.length && prior.length) {
      const rc = powerCurve(recent), pc = powerCurve(prior);
      const pcBy = {};
      pc.forEach((x) => { pcBy[x.durationS] = x.watts; });
      const pb = rc.filter((x) => pcBy[x.durationS] != null && x.watts > pcBy[x.durationS]).sort((a, b) => b.durationS - a.durationS)[0];
      if (pb) parts.push(cap('nuevo récord personal esta semana: ' + pb.watts + ' W durante ' + DURATION_LABEL[pb.durationS] + '.'));
    }

    const base = motivationPhrases[seed % motivationPhrases.length];
    if (parts.length) return parts[seed % parts.length] + ' ' + base;
    return nameCap ? nameCap + ': ' + base : base;
  }

  R.training = {
    estimateFtp: estimateFtp,
    zones: zones,
    zoneFor: zoneFor,
    estimateMaxHr: estimateMaxHr,
    library: library,
    getWorkout: getWorkout,
    buildPlan: buildPlan,
    adaptPlan: adaptPlan,
    adaptPlanOnce: adaptPlanOnce,
    computeMetrics: computeMetrics,
    pmc: pmc,
    powerCurve: powerCurve,
    suggestFtpUpdate: suggestFtpUpdate,
    motivation: motivation,
    motivationPhrases: motivationPhrases,
    targetPowerAt: targetPowerAt,
    timedWorkout: timedWorkout,
    withHydration: withHydration,
    registerWorkout: registerWorkout,
    compactWorkout: compactWorkout,
    TIMED_FOCUS: TIMED_FOCUS,
  };
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
