(function (R) {
  'use strict';

  var el = R.ui.el;
  var U = R.ui.util;

  var LEVELS = [
    { id: 'principiante', name: 'Principiante', desc: 'Estoy empezando o retomando el ciclismo.' },
    { id: 'intermedio', name: 'Intermedio', desc: 'Ruedo con regularidad desde hace meses.' },
    { id: 'avanzado', name: 'Avanzado', desc: 'Entreno con estructura y conozco mis zonas.' },
    { id: 'competitivo', name: 'Competitivo', desc: 'Compito o persigo metas exigentes.' }
  ];
  var GOAL_LIST = [
    { id: 'forma', name: 'Mejorar forma', desc: 'Rodar mejor y con más energía, sin una meta fija.' },
    { id: 'peso', name: 'Bajar de peso', desc: 'Sesiones largas a ritmo cómodo y constancia.' },
    { id: 'ftp', name: 'Subir FTP', desc: 'Más potencia sostenida con trabajo de umbral.' },
    { id: 'evento', name: 'Preparar un evento', desc: 'Llegar en punta a una fecha concreta.' },
    { id: 'gran-fondo', name: 'Gran fondo', desc: 'Resistencia para una prueba larga.' }
  ];
  var WEEKDAYS = [
    { v: 1, s: 'L', n: 'lunes' }, { v: 2, s: 'M', n: 'martes' }, { v: 3, s: 'X', n: 'miércoles' }, { v: 4, s: 'J', n: 'jueves' },
    { v: 5, s: 'V', n: 'viernes' }, { v: 6, s: 'S', n: 'sábado' }, { v: 0, s: 'D', n: 'domingo' }
  ];
  var SCOPES = { 1: ['name', 'age', 'sex', 'weightKg', 'heightCm'], 2: ['level', 'ftp', 'maxHr'], 3: ['goal', 'eventDate'], 4: ['hoursPerWeek', 'daysPerWeek', 'weeks'] };

  function isEvent(goal) { return goal === 'evento' || goal === 'gran-fondo'; }
  function num(v) { return v === '' || v === null || v === undefined ? NaN : Number(v); }
  function inRange(v, a, b) { return isFinite(v) && v >= a && v <= b; }
  function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }

  // Semanas del plan: si hay evento con fecha, se ajusta a la fecha.
  function weeksFor(d, today) {
    if (isEvent(d.goal) && d.eventDate) return clamp(Math.ceil(U.daysBetween(today, d.eventDate) / 7), 4, 24);
    return clamp(Math.round(num(d.weeks)) || 8, 4, 24);
  }

  // Devuelve { campo: mensaje } con los errores de los campos indicados (todos si no se pasa `fields`).
  function validate(d, fields, today) {
    today = today || U.todayStr();
    var all = !fields;
    var want = function (f) { return all || fields.indexOf(f) >= 0; };
    var e = {};
    if (want('name') && (!String(d.name || '').trim() || String(d.name).trim().length > 40)) e.name = 'Escribe tu nombre (hasta 40 caracteres).';
    if (want('age') && !(inRange(num(d.age), 14, 90) && Math.round(num(d.age)) === num(d.age))) e.age = 'Ingresa tu edad en años (entre 14 y 90).';
    if (want('sex') && !d.sex) e.sex = 'Elige una opción.';
    if (want('weightKg') && !inRange(num(d.weightKg), 30, 200)) e.weightKg = 'Ingresa tu peso en kg (entre 30 y 200).';
    if (want('heightCm') && !inRange(num(d.heightCm), 120, 220)) e.heightCm = 'Ingresa tu altura en cm (entre 120 y 220).';
    if (want('level') && !d.level) e.level = 'Elige tu nivel.';
    if (want('ftp')) {
      if (d.knowsFtp === null || d.knowsFtp === undefined) e.ftp = 'Indica si conoces tu FTP.';
      else if (d.knowsFtp && !inRange(num(d.ftp), 50, 600)) e.ftp = 'Ingresa tu FTP en vatios (entre 50 y 600 W).';
    }
    if (want('maxHr') && String(d.maxHr || '') !== '' && !inRange(num(d.maxHr), 120, 230)) e.maxHr = 'La frecuencia cardíaca máxima debe estar entre 120 y 230 ppm, o déjala vacía.';
    if (want('goal') && !d.goal) e.goal = 'Elige un objetivo.';
    if (want('eventDate') && isEvent(d.goal)) {
      if (!d.eventDate) {
        if (d.goal === 'evento') e.eventDate = 'Indica la fecha de tu evento.';
      } else {
        var diff = U.daysBetween(today, d.eventDate);
        if (diff < 28 || diff > 168) e.eventDate = 'La fecha debe estar entre 4 y 24 semanas desde hoy para que el plan llegue bien preparado al evento.';
      }
    }
    var hours = num(d.hoursPerWeek), days = num(d.daysPerWeek);
    if (want('hoursPerWeek')) {
      if (!inRange(hours, 2, 15)) e.hoursPerWeek = 'Elige entre 2 y 15 horas por semana.';
      else if (inRange(days, 2, 7) && hours > days * 2) {
        e.hoursPerWeek = 'Con ' + days + ' días por semana puedes entrenar como máximo ' + (days * 2) + ' h (2 h por sesión). Sube los días o baja las horas.';
      }
    }
    if (want('daysPerWeek') && !inRange(days, 2, 7)) e.daysPerWeek = 'Elige entre 2 y 7 días por semana.';
    if (want('weeks') && !(isEvent(d.goal) && d.eventDate) && !inRange(num(d.weeks), 4, 24)) e.weeks = 'La duración del plan va de 4 a 24 semanas.';
    return e;
  }

  // Convierte el borrador en un perfil. Puede lanzar Error (p. ej. al estimar el FTP).
  function toProfile(d, today) {
    today = today || U.todayStr();
    var age = Math.round(num(d.age)), weight = num(d.weightKg);
    var ftp, estimated;
    if (d.knowsFtp) { ftp = Math.round(num(d.ftp)); estimated = false; }
    else { ftp = R.training.estimateFtp({ weightKg: weight, level: d.level, age: age }).ftp; estimated = true; }
    return {
      name: String(d.name).trim(), age: age, sex: d.sex, weightKg: weight, heightCm: num(d.heightCm), level: d.level,
      ftp: ftp, ftpEstimated: estimated,
      maxHr: String(d.maxHr || '') !== '' ? Math.round(num(d.maxHr)) : R.training.estimateMaxHr(age),
      goal: d.goal, hoursPerWeek: num(d.hoursPerWeek), daysPerWeek: num(d.daysPerWeek),
      eventDate: isEvent(d.goal) && d.eventDate ? d.eventDate : null,
      weeks: weeksFor(d, today)
    };
  }

  // ---------- controles reutilizables ----------
  function dayToggles(selected, onChange) {
    var sel = selected.slice();
    var wrap = el('div', { 'class': 'toggle-days', role: 'group', 'aria-label': 'Días de recordatorio' });
    WEEKDAYS.forEach(function (w) {
      var b = el('button', {
        type: 'button', 'class': 'day-toggle', 'aria-pressed': String(sel.indexOf(w.v) >= 0), 'aria-label': w.n,
        onclick: function () {
          var i = sel.indexOf(w.v);
          if (i >= 0) sel.splice(i, 1); else sel.push(w.v);
          b.setAttribute('aria-pressed', String(sel.indexOf(w.v) >= 0));
          onChange(sel.slice().sort());
        }
      }, w.s);
      wrap.appendChild(b);
    });
    return wrap;
  }

  function field(name, label, control, hint) {
    return el('div', { 'class': 'field' }, [
      el('label', { 'for': 'f-' + name }, label), control,
      hint ? el('div', { 'class': 'hint', id: 'h-' + name }, hint) : null,
      el('div', { 'class': 'field-error', 'data-err': name, role: 'alert' })
    ]);
  }

  function radioGroup(name, legend, options, value, onChange, cls) {
    var fs = el('fieldset', null, el('legend', { 'class': 'label' }, legend));
    var box = el('div', { 'class': cls || 'seg' });
    options.forEach(function (o) {
      box.appendChild(el('label', null, [
        el('input', { type: 'radio', name: name, value: o.id, checked: String(value) === String(o.id), onchange: function () { onChange(o.id); } }),
        el('span', null, o.label)
      ]));
    });
    fs.appendChild(box);
    fs.appendChild(el('div', { 'class': 'field-error', 'data-err': name, role: 'alert' }));
    return fs;
  }

  function showErrors(root, errs, focusFirst) {
    var first = null;
    Array.prototype.forEach.call(root.querySelectorAll('[data-err]'), function (n) {
      var f = n.getAttribute('data-err');
      n.textContent = errs[f] || '';
      var input = root.querySelector('#f-' + f);
      if (input) { if (errs[f]) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
      if (errs[f] && !first) first = input || n.parentNode.querySelector('input, button');
    });
    if (first && focusFirst) { try { first.focus(); } catch (e) { /* sin foco */ } }
  }

  // ======================================================================
  // Vista
  // ======================================================================
  var onboardingView = {
    id: 'onboarding', title: 'Bienvenida',
    render: function (container, ctx) {
      var today = U.todayStr();
      var st = R.store.get().settings;
      var d = {
        name: '', age: '', sex: '', weightKg: '', heightCm: '', level: '', knowsFtp: null, ftp: '', maxHr: '',
        goal: '', eventDate: '', hoursPerWeek: 5, daysPerWeek: 4, weeks: 8,
        reminderTime: st.reminderTime || '19:00', reminderDays: (st.reminderDays || [1, 3, 5]).slice()
      };
      var step = 1;
      var root = el('div', { 'class': 'ob' });
      container.appendChild(root);

      function bindText(name, type, extra) {
        return el('input', Object.assign({
          id: 'f-' + name, type: type, value: d[name], 'aria-describedby': 'h-' + name,
          oninput: function (ev) { d[name] = ev.target.value; }
        }, extra || {}));
      }

      // ----- pasos -----
      function stepBody() {
        var box = el('div');
        if (step === 1) {
          box.appendChild(el('h1', null, 'Cuéntanos de ti'));
          box.appendChild(el('p', { 'class': 'muted' }, 'Con estos datos calculamos tus zonas, tu velocidad en pantalla y el esfuerzo de cada sesión.'));
          box.appendChild(el('div', { 'class': 'form-grid' }, [
            field('name', 'Nombre', bindText('name', 'text', { autocomplete: 'given-name', maxlength: 40 })),
            field('age', 'Edad (años)', bindText('age', 'number', { inputmode: 'numeric', min: 14, max: 90 })),
            radioGroup('sex', 'Sexo', [{ id: 'masculino', label: 'Hombre' }, { id: 'femenino', label: 'Mujer' }, { id: 'otro', label: 'Otro' }], d.sex, function (v) { d.sex = v; }),
            el('div'),
            field('weightKg', 'Peso (kg)', bindText('weightKg', 'number', { inputmode: 'decimal', min: 30, max: 200, step: 0.1 })),
            field('heightCm', 'Altura (cm)', bindText('heightCm', 'number', { inputmode: 'numeric', min: 120, max: 220 }))
          ]));
        } else if (step === 2) {
          box.appendChild(el('h1', null, 'Tu nivel y tu FTP'));
          box.appendChild(el('div', { 'class': 'callout' }, [el('b', null, 'FTP: '), 'la potencia máxima que podrías sostener durante cerca de una hora. Define todas tus zonas de entrenamiento.']));
          var lvl = el('fieldset', null, el('legend', { 'class': 'label' }, 'Nivel'));
          var grid = el('div', { 'class': 'goal-grid' });
          LEVELS.forEach(function (l) {
            grid.appendChild(el('label', { 'class': 'goal-card' }, [
              el('input', { type: 'radio', name: 'level', value: l.id, checked: d.level === l.id, onchange: function () { d.level = l.id; updateFtp(); } }),
              el('span', { 'class': 'goal-body' }, [el('b', null, l.name), el('span', null, l.desc)])
            ]));
          });
          lvl.appendChild(grid);
          lvl.appendChild(el('div', { 'class': 'field-error', 'data-err': 'level', role: 'alert' }));
          box.appendChild(lvl);

          box.appendChild(radioGroup('knowsFtp', '¿Conoces tu FTP?', [{ id: 'si', label: 'Sí, lo conozco' }, { id: 'no', label: 'No, estímalo por mí' }],
            d.knowsFtp === null ? '' : d.knowsFtp ? 'si' : 'no', function (v) { d.knowsFtp = v === 'si'; updateFtp(); }));
          var ftpArea = el('div', { id: 'ftp-area', 'aria-live': 'polite' });
          box.appendChild(ftpArea);
          box.appendChild(el('div', { 'class': 'field-error', 'data-err': 'ftp', role: 'alert' }));
          var maxHint = el('span', { id: 'maxhr-hint' });
          box.appendChild(field('maxHr', 'Frecuencia cardíaca máxima (ppm), opcional', bindText('maxHr', 'number', { inputmode: 'numeric', min: 120, max: 230, oninput: function (ev) { d.maxHr = ev.target.value; updateMaxHint(); } }), maxHint));
          box._after = function () { updateFtp(); updateMaxHint(); };
        } else if (step === 3) {
          box.appendChild(el('h1', null, '¿Qué quieres lograr?'));
          box.appendChild(el('p', { 'class': 'muted' }, 'Elegimos el tipo de sesiones y la progresión según tu objetivo.'));
          var gs = el('fieldset', null, el('legend', { 'class': 'sr-only' }, 'Objetivo'));
          var gg = el('div', { 'class': 'goal-grid' });
          GOAL_LIST.forEach(function (g) {
            gg.appendChild(el('label', { 'class': 'goal-card' }, [
              el('input', { type: 'radio', name: 'goal', value: g.id, checked: d.goal === g.id, onchange: function () { d.goal = g.id; updateDate(); } }),
              el('span', { 'class': 'goal-body' }, [el('b', null, g.name), el('span', null, g.desc)])
            ]));
          });
          gs.appendChild(gg);
          gs.appendChild(el('div', { 'class': 'field-error', 'data-err': 'goal', role: 'alert' }));
          box.appendChild(gs);
          box.appendChild(el('div', { id: 'date-area', style: { 'margin-top': '16px' } }));
          box._after = updateDate;
        } else if (step === 4) {
          box.appendChild(el('h1', null, 'Tu tiempo disponible'));
          box.appendChild(el('p', { 'class': 'muted' }, 'Ajustamos el plan a las horas y los días que de verdad puedes entrenar.'));
          box.appendChild(rangeField('hoursPerWeek', 'Horas por semana', 2, 15, 1, ' h'));
          box.appendChild(radioGroup('daysPerWeek', 'Días por semana', [2, 3, 4, 5, 6, 7].map(function (n) { return { id: n, label: String(n) }; }), d.daysPerWeek, function (v) { d.daysPerWeek = Number(v); liveTime(); }));
          var wk = rangeField('weeks', 'Duración del plan', 4, 24, 1, ' sem');
          box.appendChild(wk);
          box.appendChild(el('div', { 'class': 'hint', id: 'weeks-note' }));
          box.appendChild(el('div', { 'class': 'form-grid', style: { 'margin-top': '14px' } }, [
            field('reminderTime', 'Hora del recordatorio', bindText('reminderTime', 'time')),
            el('div', { 'class': 'field' }, [el('span', { 'class': 'label' }, 'Días de recordatorio'), dayToggles(d.reminderDays, function (s) { d.reminderDays = s; })])
          ]));
          box._after = function () { liveTime(); };
        }
        return box;
      }

      function rangeField(name, label, min, max, stepV, unit) {
        var out = el('output', { 'class': 'range-out', id: 'o-' + name, 'for': 'f-' + name }, d[name] + unit);
        var input = el('input', {
          id: 'f-' + name, type: 'range', min: min, max: max, step: stepV, value: d[name], 'aria-describedby': 'h-' + name,
          oninput: function (ev) { d[name] = Number(ev.target.value); out.textContent = d[name] + unit; liveTime(); }
        });
        return el('div', { 'class': 'field' }, [
          el('label', { 'for': 'f-' + name }, label),
          el('div', { 'class': 'range-row' }, [input, out]),
          el('div', { 'class': 'field-error', 'data-err': name, role: 'alert' })
        ]);
      }

      // ----- actualizaciones parciales -----
      function updateFtp() {
        var area = root.querySelector('#ftp-area');
        if (!area) return;
        area.textContent = '';
        if (d.knowsFtp === true) {
          area.appendChild(el('div', { 'class': 'field' }, [
            el('label', { 'for': 'f-ftp' }, 'Tu FTP (vatios)'),
            bindText('ftp', 'number', { inputmode: 'numeric', min: 50, max: 600 })
          ]));
        } else if (d.knowsFtp === false) {
          var txt;
          try {
            var est = R.training.estimateFtp({ weightKg: num(d.weightKg), level: d.level || 'intermedio', age: num(d.age) || 0 });
            txt = 'FTP estimado: ' + est.ftp + ' W (' + est.wkg.toFixed(2).replace('.', ',') + ' W/kg). Incluiremos un test de rampa en la primera semana para afinarlo.';
          } catch (e) { txt = 'No pudimos estimar tu FTP: ' + e.message; }
          area.appendChild(el('div', { 'class': 'callout' }, txt));
        }
      }
      function updateMaxHint() {
        var h = root.querySelector('#maxhr-hint') || root.querySelector('#h-maxHr');
        if (!h) return;
        var age = num(d.age);
        h.textContent = String(d.maxHr || '') !== '' ? 'Usaremos este valor para tus zonas de pulso.'
          : isFinite(age) ? 'Si lo dejas vacío usamos la fórmula de Tanaka (208 − 0,7 × edad): ' + R.training.estimateMaxHr(age) + ' ppm.' : 'Si lo dejas vacío usamos la fórmula de Tanaka (208 − 0,7 × edad).';
      }
      function updateDate() {
        var area = root.querySelector('#date-area');
        if (!area) return;
        area.textContent = '';
        if (isEvent(d.goal)) {
          area.appendChild(field('eventDate', d.goal === 'evento' ? 'Fecha del evento' : 'Fecha del gran fondo (opcional)',
            bindText('eventDate', 'date', { min: U.addDays(today, 28), max: U.addDays(today, 168) }),
            'El plan se arma hacia atrás desde esa fecha, con una semana final de puesta a punto. Debe estar entre 4 y 24 semanas desde hoy.'));
        }
      }
      function liveTime() {
        var errs = validate(d, ['hoursPerWeek'], today);
        showErrors(root, Object.assign({ hoursPerWeek: '' }, errs), false);
        var note = root.querySelector('#weeks-note');
        var range = root.querySelector('#f-weeks');
        if (!note || !range) return;
        if (isEvent(d.goal) && d.eventDate) {
          var n = weeksFor(d, today);
          range.disabled = true; range.value = n;
          root.querySelector('#o-weeks').textContent = n + ' sem';
          note.textContent = 'Tu plan dura ' + n + ' semanas porque llega hasta la fecha de tu evento.';
        } else { range.disabled = false; note.textContent = ''; }
      }

      // ----- navegación entre pasos -----
      function draw() {
        root.textContent = '';
        root.appendChild(el('div', { 'class': 'ob-top' }, [U.logo(), el('div', { 'class': 'wordmark' }, ['RODILL', el('span', null, 'A'), 'TOR'])]));
        root.appendChild(el('div', { 'class': 'progress', role: 'progressbar', 'aria-valuemin': 1, 'aria-valuemax': 4, 'aria-valuenow': step, 'aria-label': 'Progreso' }, el('div', { style: { width: (step / 4 * 100) + '%' } })));
        root.appendChild(el('div', { 'class': 'ob-step-label' }, 'Paso ' + step + ' de 4'));
        var body = stepBody();
        var wrap = el('div', { 'class': 'ob-step card' }, body);
        root.appendChild(wrap);
        root.appendChild(el('div', { 'class': 'ob-actions' }, [
          step > 1 ? el('button', { type: 'button', 'class': 'btn', onclick: function () { step--; draw(); } }, 'Atrás') : el('span'),
          el('button', { type: 'button', 'class': 'btn btn-primary', onclick: next }, step === 4 ? 'Crear mi plan' : 'Siguiente')
        ]));
        if (body._after) body._after();
        var h = wrap.querySelector('h1');
        if (h) { h.setAttribute('tabindex', '-1'); try { h.focus({ preventScroll: true }); } catch (e) { /* sin foco */ } }
        window.scrollTo(0, 0);
      }

      function next() {
        var errs = validate(d, SCOPES[step], today);
        if (step === 2 && d.knowsFtp === false) { try { R.training.estimateFtp({ weightKg: num(d.weightKg), level: d.level, age: num(d.age) }); } catch (e) { errs.ftp = e.message; } }
        if (Object.keys(errs).length) { showErrors(root, errs, true); return; }
        if (step < 4) { step++; draw(); return; }
        finish();
      }

      function finish() {
        // revalida todo por si algún paso quedó inconsistente
        var all = validate(d, null, today);
        var bad = Object.keys(all);
        if (bad.length) {
          for (var s = 1; s <= 4; s++) {
            if (SCOPES[s].some(function (f) { return all[f]; })) { step = s; draw(); showErrors(root, all, true); return; }
          }
        }
        var profile, plan;
        try {
          profile = toProfile(d, today);
          plan = R.training.buildPlan({ profile: profile, startDate: today });
        } catch (e) {
          ctx.toast('No se pudo crear tu plan: ' + e.message, 'error');
          return;
        }
        R.store.set({ profile: profile, plan: plan, settings: { reminderTime: d.reminderTime || '19:00', reminderDays: d.reminderDays } });
        summary(profile, plan);
      }

      function summary(profile, plan) {
        root.textContent = '';
        var sessions = 0, firstDay = null;
        plan.weeks.forEach(function (w) { w.days.forEach(function (day) { if (day.workoutId) { sessions++; if (!firstDay) firstDay = day; } }); });
        var fw = firstDay ? R.training.getWorkout(firstDay.workoutId) : null;
        var segs = [];
        plan.weeks.forEach(function (w) {
          var l = segs[segs.length - 1];
          if (l && l.phase === w.phase) l.n++; else segs.push({ phase: w.phase, n: 1 });
        });
        root.appendChild(el('div', { 'class': 'ob-top' }, [U.logo(), el('div', { 'class': 'wordmark' }, ['RODILL', el('span', null, 'A'), 'TOR'])]));
        var card = el('div', { 'class': 'card' }, [
          el('h1', { tabindex: '-1', id: 'ob-done' }, 'Tu plan está listo, ' + profile.name),
          el('div', { 'class': 'summary-nums' }, [
            el('div', null, [el('div', { 'class': 'num' }, String(plan.weeks.length)), el('div', { 'class': 'kpi-label' }, 'semanas')]),
            el('div', null, [el('div', { 'class': 'num' }, String(sessions)), el('div', { 'class': 'kpi-label' }, 'sesiones')]),
            el('div', null, [el('div', { 'class': 'num' }, profile.ftp + ' W'), el('div', { 'class': 'kpi-label' }, profile.ftpEstimated ? 'FTP estimado' : 'tu FTP')])
          ]),
          el('div', { 'class': 'phase-bar', role: 'img', 'aria-label': 'Fases del plan' }, segs.map(function (s) { return el('div', { style: { flex: String(s.n), background: U.PHASES[s.phase].color } }); })),
          el('div', { 'class': 'row' }, segs.map(function (s) { return el('span', { 'class': 'chip' }, [el('i', { style: { '--c': U.PHASES[s.phase].color } }), U.PHASES[s.phase].label + ' · ' + s.n + ' sem']); })),
          fw ? el('p', { style: { 'margin-top': '16px' } }, ['Tu primera sesión: ', el('b', null, fw.name), ' (' + U.fmtDur(fw.durationS) + '), ' + U.fmtDateEs(firstDay.date, { weekday: 'long', day: 'numeric', month: 'long' }) + '.']) : null,
          profile.ftpEstimated ? el('p', { 'class': 'muted' }, 'La primera semana incluye un test de rampa: con su resultado te sugeriremos un FTP más preciso.') : null
        ]);
        root.appendChild(card);
        root.appendChild(el('div', { 'class': 'ob-actions' }, [el('span'), el('button', { type: 'button', 'class': 'btn btn-primary', onclick: function () { ctx.navigate('inicio'); } }, 'Ir al inicio')]));
        var h = card.querySelector('h1');
        try { h.focus({ preventScroll: true }); } catch (e) { /* sin foco */ }
      }

      draw();
    }
  };

  R.ui.profileForm = { validate: validate, toProfile: toProfile, weeksFor: weeksFor, dayToggles: dayToggles, field: field, radioGroup: radioGroup, showErrors: showErrors, LEVELS: LEVELS, GOAL_LIST: GOAL_LIST, isEvent: isEvent };
  R.ui.registerView(onboardingView);
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
