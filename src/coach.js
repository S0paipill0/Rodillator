/* Rodillator — Coach de voz, cuenta regresiva y pitidos.
 * Parte 1: R.coach.createCoach (lógica pura, probada en Node).
 * Parte 2: R.coach.createAudio (Web Audio + speechSynthesis; mezcla con la música del teléfono). */
(function (R) {
  'use strict';

  // Prioridades: cuenta regresiva > resistencia > de pie/sentado > ataque > hidratación > resto
  var PRI = { COUNT: 7, RESIST: 6, POSTURE: 5, ATTACK: 4, HYDRATE: 3, NEXT: 2, REST: 1 };
  var MAX_VOLUME = 2;
  var DEFAULTS = { voice: true, beeps: true, volume: 1.6, verbosity: 'completo', natural: true };
  var VERBOSITIES = ['completo', 'esencial', 'off'];

  function normalizeSettings(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var v = Number(r.volume);
    return {
      voice: r.voice === undefined ? DEFAULTS.voice : !!r.voice,
      beeps: r.beeps === undefined ? DEFAULTS.beeps : !!r.beeps,
      volume: isFinite(v) && r.volume !== null && r.volume !== '' ? Math.min(MAX_VOLUME, Math.max(0, v)) : DEFAULTS.volume,
      verbosity: VERBOSITIES.indexOf(r.verbosity) >= 0 ? r.verbosity : DEFAULTS.verbosity,
      natural: r.natural === undefined ? DEFAULTS.natural : !!r.natural
    };
  }

  // ---------- texto hablado ----------
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  // 30 -> "30 segundos", 90 -> "1 minuto y medio", 240 -> "4 minutos"
  function spokenDuration(sec) {
    var s = Math.max(0, Math.round(sec));
    if (s < 60) return plural(s, 'segundo', 'segundos');
    if (s >= 3600) {
      var hh = Math.floor(s / 3600), mm = Math.round((s % 3600) / 60);
      return plural(hh, 'hora', 'horas') + (mm ? ' y ' + plural(mm, 'minuto', 'minutos') : '');
    }
    var m = Math.floor(s / 60), rest = s % 60;
    if (rest === 0) return plural(m, 'minuto', 'minutos');
    if (rest === 30) return plural(m, 'minuto', 'minutos') + ' y medio';
    return plural(m, 'minuto', 'minutos') + ' y ' + plural(rest, 'segundo', 'segundos');
  }

  function round5(w) { return Math.round(w / 5) * 5; }
  var WORDS = { 3: 'Tres', 2: 'Dos', 1: 'Uno' };
  function decimalEs(x) { return (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, '').replace('.', ' coma '); }

  function endPct(step) { return step.powerPctEnd != null ? step.powerPctEnd : step.powerPct; }
  // De pie: explícito (position) o inferido (≥ 120 % FTP y ≤ 60 s)
  function isStanding(step) {
    if (!step) return false;
    if (step.position === 'pie') return true;
    if (step.position) return false;
    return step.powerPct >= 120 && step.durationS <= 60;
  }
  function isLongEndurance(step) { return !!step && step.durationS >= 900 && step.powerPct < 80; }

  // vatios hablados: los que de verdad se piden (aplica el ajuste de intensidad de la rodada)
  function spokenWatts(pct, s) { return round5(pct * s.ftp * (s.intensity > 0 ? s.intensity : 1) / 100); }
  function nextAnnouncement(next, s) {
    var what = next.powerPct < 60 ? 'a ritmo suave' : 'a ' + spokenWatts(next.powerPct, s) + ' vatios';
    return 'Prepárate: ' + spokenDuration(next.durationS) + ' ' + what;
  }

  // ======================================================================
  // Parte 1 — lógica pura de avisos
  // ======================================================================
  function createCoach(opts) {
    var o = opts || {};
    var sayFn = o.say || function () {};
    var beepFn = o.beep || function () {};
    var nowFn = o.now || function () { return Date.now(); };
    var verbosity = VERBOSITIES.indexOf(o.verbosity) >= 0 ? o.verbosity : 'completo';

    var fired, queue, busyUntil, prev, lastMode;
    var wall, lastWallT, ghostSpeed, hydrateEndT;
    function reset() {
      fired = {}; queue = []; busyUntil = 0; prev = { stepIndex: null };
      wall = { standing: false, hiSince: null, loSince: null }; lastWallT = -Infinity; ghostSpeed = null;
      lastMode = null; hydrateEndT = null;
    }
    reset();

    function once(key) { if (fired[key]) return false; fired[key] = true; return true; }
    function allowed(pri) { return verbosity === 'completo' || (verbosity === 'esencial' && pri >= PRI.HYDRATE); }

    function beep(kind) { if (verbosity !== 'off') beepFn(kind); }
    function speak(text, pri) {
      if (!allowed(pri)) return;
      queue.push({ text: text, pri: pri, t: nowFn() });
    }

    function flush() {
      var t = nowFn();
      queue = queue.filter(function (q) { return q.pri > PRI.NEXT || t - q.t <= 3000; });
      // la cuenta regresiva no espera: corta lo que esté sonando
      var rest = [], counts = [];
      queue.forEach(function (q) { if (q.pri === PRI.COUNT) counts.push(q); else rest.push(q); });
      queue = rest;
      if (counts.length) { // varias a la vez: solo la más reciente
        var c = counts[counts.length - 1];
        sayFn(c.text, { priority: c.pri }); busyUntil = t + estimateMs(c.text);
      }
      if (!queue.length || t < busyUntil) return;
      var best = 0;
      for (var i = 1; i < queue.length; i++) if (queue[i].pri > queue[best].pri) best = i;
      var q = queue.splice(best, 1)[0];
      sayFn(q.text, { priority: q.pri });
      busyUntil = t + estimateMs(q.text);
    }
    function estimateMs(text) { return 350 + 62 * text.length; }

    function workoutUpdate(s) {
      var steps = s.workout && s.workout.steps;
      if (!steps || s.stepIndex == null || !steps[s.stepIndex]) return;
      var i = s.stepIndex, step = steps[i], next = steps[i + 1] || null;
      var changed = prev.stepIndex !== i;
      var before = changed && prev.stepIndex != null ? steps[prev.stepIndex] : null;

      if (changed) {
        if (before) {
          var up = step.powerPct - endPct(before);
          beep('go');
          if (Math.abs(up) < 10) {
            // cambio pequeño (p. ej. escalones del test de rampa): solo pitido y, en la rampa, el vatiaje
            if (s.workout.id === 'ramp-test') speak('Siguiente escalón: ' + spokenWatts(step.powerPct, s) + ' vatios', PRI.REST);
          } else if (up > 0) speak('¡Vamos!', PRI.COUNT); else speak('¡Recupera!', PRI.COUNT);
        }
        var stand = isStanding(step), wasStand = isStanding(before);
        if (stand && !wasStand) speak('¡Arriba! De pie', PRI.POSTURE);
        else if (!stand && wasStand) speak('Nos sentamos', PRI.POSTURE);
        if (step.cadence != null) speak('Cadencia ' + Math.round(step.cadence), PRI.REST);
      }
      prev.stepIndex = i;

      var dur = step.durationS, rem = s.stepRemainingS, el = s.stepElapsedS;
      var isLast = !next;
      // cuenta regresiva de los últimos 3 s (pasos ≥ 20 s)
      if (dur >= 20 && rem > 0 && rem <= 3) {
        var n = Math.ceil(rem - 1e-9);
        if (n >= 1 && once('cd:' + i + ':' + n)) {
          beep('tick');
          if (isLast) { if (n === 3 && once('final')) speak('Tres, dos, uno… ¡terminamos! Buen trabajo', PRI.COUNT); } else speak(WORDS[n], PRI.COUNT);
        }
      }
      // anuncio del siguiente intervalo (~10 s antes)
      if (next && dur >= 30 && rem > 3.5 && rem <= 10 && s.workout.id !== 'ramp-test' && once('next:' + i)) speak(nextAnnouncement(next, s), PRI.NEXT);
      // mitad / último minuto
      if (dur >= 180) {
        if (el >= dur / 2 && el < dur - 60 && once('half:' + i)) speak('Mitad del intervalo', PRI.REST);
        if (rem <= 60 && rem > 3.5 && once('min:' + i)) speak('Último minuto', PRI.REST);
      }
      // resistencia larga: soltar piernas cada 10 min
      if (isLongEndurance(step)) {
        var k = Math.floor(el / 600);
        if (k >= 1) {
          if (rem > 40 && once('leg:' + i + ':' + k)) speak('¡Arriba! 20 segundos de pie para soltar las piernas', PRI.POSTURE);
          // "Nos sentamos" sale siempre que el "¡Arriba!" correspondiente ya se dijo
          if (fired['leg:' + i + ':' + k] && el >= k * 600 + 20 && once('legs:' + i + ':' + k)) speak('Nos sentamos', PRI.POSTURE);
        }
      }
    }

    function routeUpdate(s) {
      var len = s.routeLenM, d = s.distM;
      if (!(len > 0)) return;
      var remM = len - d;
      // cuenta regresiva a la meta según velocidad actual
      var v = s.speedMps;
      if (v == null && prev.tS != null && s.tS > prev.tS) {
        var inst = (d - prev.distM) / (s.tS - prev.tS);
        ghostSpeed = ghostSpeed == null ? inst : ghostSpeed * 0.8 + inst * 0.2;
        v = ghostSpeed;
      }
      if (v > 1 && remM > 0) {
        var eta = remM / v;
        if (eta <= 3) {
          var n = Math.ceil(eta - 1e-9);
          if (n >= 1 && n <= 3 && once('rcd:' + n)) { beep('tick'); speak(WORDS[n], PRI.COUNT); }
        }
      }
      // kilómetros
      var km = Math.floor(d / 1000);
      if (km >= 1 && remM > 500 && once('km:' + km)) speak('Kilómetro ' + km + ', quedan ' + decimalEs(remM / 1000), PRI.REST);
      if (len > 1000 && remM <= 500 && remM > 0 && once('500')) speak('Últimos quinientos metros', PRI.REST);
      // muros
      var g = s.gradePct;
      if (g > 8) {
        wall.loSince = null;
        if (wall.hiSince == null) wall.hiSince = s.tS;
        if (!wall.standing && s.tS - wall.hiSince >= 8 && s.tS - lastWallT >= 120) {
          wall.standing = true; lastWallT = s.tS;
          speak('¡Arriba! Muro de ' + Math.round(g) + ' por ciento', PRI.POSTURE);
        }
      } else {
        wall.hiSince = null;
        if (wall.standing) {
          if (g < 5) {
            if (wall.loSince == null) wall.loSince = s.tS;
            if (s.tS - wall.loSince >= 8) { wall.standing = false; wall.loSince = null; speak('Nos sentamos', PRI.POSTURE); }
          } else wall.loSince = null;
        }
      }
    }

    function update(s) {
      if (!s || verbosity === 'off') return;
      lastMode = s.mode || lastMode;
      if (s.paused) { flush(); return; }
      // fin de la pausa de hidratación (el reloj es el de la rodada, así que la pausa de la rodada lo detiene)
      if (hydrateEndT != null && s.tS >= hydrateEndT) { hydrateEndT = null; speak('Seguimos', PRI.HYDRATE); }
      if (s.mode === 'workout') workoutUpdate(s);
      else if (s.mode === 'route') routeUpdate(s);
      prev.tS = s.tS; prev.distM = s.distM;
      flush();
    }

    function event(name, data) {
      if (verbosity === 'off') return;
      var d = data || {};
      switch (name) {
        case 'start': {
          var n = d.n == null ? 3 : d.n;
          if (!once('start:' + n)) break;
          if (n > 0) { beep('tick'); if (n === 3) speak('Tres, dos, uno, ¡vamos!', PRI.COUNT); } else beep('go');
          break;
        }
        case 'end':
          if (!once('end')) break;
          beep('end');
          if (lastMode === 'route') speak('¡Meta! ¡Bien hecho!', PRI.COUNT);
          else if (!fired.final) speak('¡Terminamos! Buen trabajo', PRI.COUNT);
          break;
        case 'ghostPassed': speak('¡Pasaste a tu mejor marca!', PRI.REST); break;
        case 'ghostOvertook': speak('Tu mejor marca se adelanta, ¡vamos!', PRI.REST); break;
        case 'pause': queue = []; speak('Pausa', PRI.REST); break;
        case 'resume': speak('Seguimos', PRI.REST); break;
        case 'resistance': {
          var lv = Math.round(Number(d.level));
          if (!isFinite(lv)) break;
          var pv = d.prev == null ? null : Math.round(Number(d.prev));
          if (pv == null || !isFinite(pv) || pv === lv) speak('Resistencia ' + lv, PRI.RESIST);
          else speak((lv > pv ? 'Sube a resistencia ' : 'Baja a resistencia ') + lv, PRI.RESIST);
          break;
        }
        case 'hydrate':
          if (d.phase === 'end') { hydrateEndT = null; speak('Seguimos', PRI.HYDRATE); break; }
          var hs = Number(d.durationS);
          if (!(hs > 0)) break;
          speak('Hidratación: toma agua, ' + spokenDuration(hs), PRI.HYDRATE);
          hydrateEndT = (prev.tS != null ? prev.tS : 0) + hs; // "Seguimos" al cumplirse la duración
          break;
        case 'attack':
          if (d.phase === 'start') speak('¡El pelotón ataca! Síguelos', PRI.ATTACK);
          else if (d.phase === 'caught') speak('Bien, sigues con el grupo', PRI.ATTACK);
          else if (d.phase === 'dropped') speak('Se te escapó el grupo, ¡vamos!', PRI.ATTACK);
          break;
      }
      flush();
    }

    return { update: update, event: event, reset: reset };
  }

  // ======================================================================
  // Parte 2 — motor de audio (navegador)
  // ======================================================================
  function localeRank(lang) {
    var l = String(lang || '').replace('_', '-').toLowerCase();
    if (l === 'es-cl') return 0;
    if (l === 'es-419' || l === 'es-us' || l === 'es-mx') return 1;
    if (l === 'es-es') return 2;
    if (l.indexOf('es') === 0 && (l.length === 2 || l.charAt(2) === '-')) return 3;
    return -1;
  }
  // es-CL > es-419/es-US/es-MX > es-ES > cualquier es-*
  function pickVoice(voices) {
    var best = null, bestRank = 99;
    (voices || []).forEach(function (v) {
      var r = localeRank(v.lang);
      if (r >= 0 && r < bestRank) { best = v; bestRank = r; }
    });
    return best;
  }

  function createAudio(opts) {
    var o = opts || {};
    var env = o.env || (typeof window !== 'undefined' ? window : {});
    var nav = env.navigator || {};
    var synth = env.speechSynthesis || null;
    var Utter = env.SpeechSynthesisUtterance || null;
    var Ctx = env.AudioContext || env.webkitAudioContext || null;
    var nowFn = o.now || function () { return Date.now(); };
    function clampVol(v) { return Math.min(MAX_VOLUME, Math.max(0, Number(v) || 0)); }
    var st = { volume: o.volume == null ? DEFAULTS.volume : clampVol(o.volume), voice: o.voice !== false, beeps: o.beeps !== false, natural: o.natural !== false };
    var pack = o.pack !== undefined ? o.pack : (env.R_VOICE || null);
    // voz pregrabada: buffers decodificados una vez; cadena master Gain -> DynamicsCompressor -> destino
    var buffers = {}, packState = pack && pack.clips ? 'idle' : 'none', packPromise = null, master = null, active = [], nextFree = 0;
    var ctx = null, voice = null, dog = null, speakingSince = null, disposed = false, deferred = [], deferTimer = null;

    function loadVoices() {
      if (!synth) return;
      try { voice = pickVoice(synth.getVoices()); } catch (e) { voice = null; }
    }
    if (synth) {
      loadVoices();
      try { synth.onvoiceschanged = loadVoices; } catch (e) { /* nada */ }
    }

    function watchdog() {
      if (!synth) return;
      var t = nowFn();
      var talking = false;
      try { talking = !!synth.speaking; } catch (e) { /* nada */ }
      if (!talking) { speakingSince = null; return; }
      if (speakingSince == null) speakingSince = t;
      // se mide la frase actual (marca en speak/onstart, se borra en onend), no el tiempo seguido hablando
      else if (t - speakingSince > 8000) { try { synth.cancel(); } catch (e) { /* nada */ } speakingSince = null; }
    }
    function startWatchdog() {
      if (dog || !synth || !env.setInterval) return;
      dog = env.setInterval(watchdog, 2000);
    }

    // 'suspended' (autoplay) e 'interrupted' (iOS) también se reanudan
    function resumeCtx() {
      if (!ctx || ctx.state === 'running' || !ctx.resume) return;
      try { var p = ctx.resume(); if (p && p.catch) p.catch(function () {}); } catch (e) { /* nada */ }
    }

    function unlock() {
      if (disposed) return;
      try {
        // 'ambient' mezcla con Spotify en Safari 16.4+/iOS 17 en vez de interrumpirlo
        if (!ctx && nav.audioSession) nav.audioSession.type = 'ambient';
      } catch (e) { /* nada */ }
      try {
        if (!ctx && Ctx) ctx = new Ctx();
        resumeCtx();
        if (ctx && !master) buildChain();
      } catch (e) { ctx = null; master = null; }
      if (ctx && master) loadPack();
      if (synth && Utter) {
        try { var u = new Utter(' '); u.volume = 0; synth.speak(u); } catch (e) { /* nada */ }
      }
      startWatchdog();
    }

    function buildChain() {
      try {
        var g = ctx.createGain(), c = ctx.createDynamicsCompressor();
        g.gain.value = st.volume;
        c.threshold.value = -18; c.ratio.value = 4; c.knee.value = 6;
        if (c.attack) c.attack.value = 0.003;
        if (c.release) c.release.value = 0.25;
        g.connect(c); c.connect(ctx.destination);
        master = g;
      } catch (e) { master = null; }
    }

    function b64ToBytes(b64) {
      var bin = env.atob ? env.atob(b64) : (typeof atob === 'function' ? atob(b64) : '');
      var u = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u.buffer;
    }
    function decode(key) {
      return new Promise(function (resolve) {
        try {
          var ab = b64ToBytes(pack.clips[key]);
          var done = function (buf) { if (buf) buffers[key] = buf; resolve(); };
          var p = ctx.decodeAudioData(ab, done, function () { resolve(); });
          if (p && p.then) p.then(done, function () { resolve(); });
        } catch (e) { resolve(); }
      });
    }
    function loadPack() {
      if (packState !== 'idle' || !ctx || !ctx.decodeAudioData) return;
      packState = 'loading';
      var keys = Object.keys(pack.clips);
      packPromise = Promise.all(keys.map(decode)).then(function () { packState = Object.keys(buffers).length ? 'ready' : 'failed'; });
    }

    // Reproduce clips pregrabados uno tras otro; false si no se puede (→ respaldo speechSynthesis)
    function playClips(text, priority) {
      if (!st.natural || packState !== 'ready' || !ctx || !master) return false;
      var vp = R.voicepack;
      if (!vp || !vp.compose) return false;
      var keys = vp.compose(text);
      if (!keys) return false;
      var bufs = [];
      for (var i = 0; i < keys.length; i++) { if (!buffers[keys[i]]) return false; bufs.push(buffers[keys[i]]); }
      try {
        resumeCtx();
        var now = ctx.currentTime;
        active = active.filter(function (a) { return a.end > now; });
        if (priority >= PRI.COUNT && active.length) { // la cuenta regresiva corta lo que esté sonando
          active.forEach(function (a) { try { a.src.stop(); } catch (e) { /* nada */ } });
          active = []; nextFree = now;
        }
        var t = Math.max(now + 0.02, nextFree);
        bufs.forEach(function (b) {
          var src = ctx.createBufferSource();
          src.buffer = b; src.connect(master); src.start(t);
          t += b.duration + 0.03;
          active.push({ src: src, end: t });
        });
        nextFree = t;
        return true;
      } catch (e) { return false; }
    }

    function flushDeferred() {
      deferTimer = null;
      var list = deferred.splice(0);
      if (disposed || !synth) return;
      list.forEach(function (u) { try { speakingSince = nowFn(); synth.speak(u); } catch (e) { /* nada */ } });
    }

    function say(text, sayOpts) {
      if (disposed || !st.voice || !text) return false;
      if (playClips(text, sayOpts && sayOpts.priority)) return true;
      if (!synth || !Utter) return false;
      try {
        if (!voice) loadVoices();
        var busy = !!(synth.speaking || synth.pending);
        var cancel = !!(sayOpts && sayOpts.priority >= PRI.COUNT) && busy;
        var u = new Utter(text);
        u.lang = voice ? voice.lang : 'es-CL';
        if (voice) u.voice = voice;
        u.rate = 1.08;
        u.volume = Math.min(1, st.volume); // speechSynthesis no admite más de 1.0
        u.onstart = function () { speakingSince = nowFn(); };
        u.onend = u.onerror = function () { speakingSince = null; };
        if (cancel) {
          synth.cancel();
          deferred.length = 0;
        }
        if ((cancel || deferred.length) && env.setTimeout) {
          // Chrome/Safari pierden el speak() que sigue de inmediato a cancel()
          deferred.push(u);
          if (deferTimer) env.clearTimeout(deferTimer);
          deferTimer = env.setTimeout(flushDeferred, 40);
        } else { speakingSince = nowFn(); synth.speak(u); }
        startWatchdog();
        return true;
      } catch (e) { return false; }
    }

    function tone(freq, startAt, dur, peak, type) {
      var osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, startAt);
      g.gain.linearRampToValueAtTime(peak, startAt + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(startAt); osc.stop(startAt + dur + 0.02);
    }
    function beep(kind) {
      if (disposed || !st.beeps || !ctx) return false;
      try {
        resumeCtx();
        var t = ctx.currentTime, peak = Math.min(0.9, 0.4 * st.volume);
        if (kind === 'tick') tone(880, t, 0.12, peak);
        else if (kind === 'go') tone(1320, t, 0.25, peak);
        else if (kind === 'end') [523.25, 659.25, 783.99].forEach(function (f) { tone(f, t, 0.3, peak * 0.7); });
        else return false;
        return true;
      } catch (e) { return false; }
    }

    return {
      unlock: unlock, say: say, beep: beep,
      setVolume: function (v) { st.volume = clampVol(v); if (master) { try { master.gain.value = st.volume; } catch (e) { /* nada */ } } },
      setEnabled: function (e) {
        if (e && e.voice !== undefined) { st.voice = !!e.voice; if (!st.voice && synth) { try { synth.cancel(); } catch (x) { /* nada */ } } }
        if (e && e.beeps !== undefined) st.beeps = !!e.beeps;
        if (e && e.natural !== undefined) st.natural = !!e.natural;
      },
      test: function () {
        unlock(); beep('tick');
        var phrase = '¡Arriba! Tres, dos, uno, ¡vamos!', go = function () { return say(phrase, { priority: PRI.COUNT }); };
        // el pack se decodifica en el primer toque: se espera antes de hablar para no caer al respaldo
        if (packState === 'loading' && packPromise) { packPromise.then(go); return true; }
        return go();
      },
      dispose: function () {
        disposed = true;
        if (dog && env.clearInterval) env.clearInterval(dog);
        dog = null;
        if (synth) { try { synth.cancel(); synth.onvoiceschanged = null; } catch (e) { /* nada */ } }
        if (deferTimer && env.clearTimeout) env.clearTimeout(deferTimer);
        deferred.length = 0;
        if (ctx && ctx.close) { try { var cp = ctx.close(); if (cp && cp.catch) cp.catch(function () {}); } catch (e) { /* nada */ } }
        ctx = null; master = null; active = [];
      },
      _watchdog: watchdog
    };
  }

  R.coach = {
    PRIORITY: PRI, DEFAULTS: DEFAULTS, normalizeSettings: normalizeSettings,
    spokenDuration: spokenDuration, isStanding: isStanding, pickVoice: pickVoice,
    MAX_VOLUME: MAX_VOLUME, createCoach: createCoach, createAudio: createAudio
  };
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
