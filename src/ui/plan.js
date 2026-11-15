(function (R) {
  'use strict';

  var el = R.ui.el;
  var U = R.ui.util;

  var DUR_FILTERS = [
    { id: 'all', label: 'Cualquier duración', test: function () { return true; } },
    { id: 'u45', label: 'Hasta 45 min', test: function (m) { return m <= 45; } },
    { id: 'u60', label: '46 a 60 min', test: function (m) { return m > 45 && m <= 60; } },
    { id: 'u90', label: '61 a 90 min', test: function (m) { return m > 60 && m <= 90; } },
    { id: 'o90', label: 'Más de 90 min', test: function (m) { return m > 90; } }
  ];

  function maxPct(w) { return w.steps.reduce(function (a, s) { return Math.max(a, s.powerPct, s.powerPctEnd || 0); }, 0); }
  function catChip(w) {
    return el('span', { 'class': 'chip' }, [el('i', { style: { '--c': U.zoneColor(maxPct(w)) } }), U.CATEGORIES[w.category] || w.category]);
  }

  // ---------- copiar al portapapeles con respaldo ----------
  function copyText(text, ta) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(ta); });
      }
    } catch (e) { /* se usa el respaldo */ }
    return Promise.resolve(legacyCopy(ta));
  }
  function legacyCopy(ta) {
    try { ta.focus(); ta.select(); return document.execCommand('copy'); } catch (e) { return false; }
  }

  // Muestra el contenido en un cuadro para copiar cuando no se puede guardar un archivo.
  function copyModal(title, intro, filename, data) {
    var ta;
    R.ui.modal({
      title: title,
      body: function (b) {
        b.appendChild(el('p', null, intro));
        ta = el('textarea', { readonly: true, 'aria-label': 'Contenido del archivo ' + filename, value: data });
        b.appendChild(ta);
      },
      actions: [
        { label: 'Cerrar' },
        {
          label: 'Copiar', kind: 'primary', onClick: function () {
            copyText(data, ta).then(function (ok) { R.ui.toast(ok ? 'Copiado al portapapeles.' : 'No se pudo copiar. Selecciona el texto y cópialo a mano.', ok ? 'ok' : 'warn'); });
            return false;
          }
        }
      ]
    });
  }

  function saveOrCopy(filename, data, okMsg, copyIntro) {
    return R.integrations.saveFile({ filename: filename, data: data }).then(function (r) {
      if (r && r.ok) R.ui.toast(okMsg, 'ok');
      else copyModal('Copia el archivo', copyIntro, filename, (r && r.data) || data);
    });
  }

  // ======================================================================
  var planView = {
    id: 'plan', title: 'Plan',
    render: function (container, ctx) {
      var tab = 'calendario';
      var libCat = 'all', libDur = 'all';
      var head = el('header', { 'class': 'view-head' });
      var tabs = el('div', { 'class': 'tabs', role: 'tablist', 'aria-label': 'Secciones del plan' });
      var panel = el('div', { id: 'plan-panel', role: 'tabpanel' });
      container.appendChild(head); container.appendChild(tabs); container.appendChild(panel);

      function state() { return R.store.get(); }

      function drawHead() {
        var s = state(), plan = s.plan, p = s.profile;
        head.textContent = '';
        var sub = plan ? (U.GOALS[plan.goal] || plan.goal) + ' · ' + plan.weeks.length + ' semanas · FTP ' + p.ftp + ' W' : 'Todavía no tienes un plan.';
        head.appendChild(el('div', null, [el('h1', null, 'Plan de entrenamiento'), el('p', null, sub)]));
        head.appendChild(el('div', { 'class': 'head-actions' }, [
          el('button', { type: 'button', 'class': 'btn', onclick: exportIcs, disabled: !plan }, 'Exportar recordatorios (.ics)'),
          el('button', { type: 'button', 'class': 'btn', onclick: confirmRegenerate }, plan ? 'Regenerar plan' : 'Crear plan')
        ]));
      }

      function drawTabs() {
        tabs.textContent = '';
        [{ id: 'calendario', label: 'Calendario' }, { id: 'biblioteca', label: 'Biblioteca' }].forEach(function (t) {
          tabs.appendChild(el('button', {
            type: 'button', 'class': 'tab', role: 'tab', id: 'tab-' + t.id, 'aria-selected': String(tab === t.id), 'aria-controls': 'plan-panel',
            tabindex: tab === t.id ? '0' : '-1',
            onclick: function () { tab = t.id; drawTabs(); drawPanel(); },
            onkeydown: function (ev) {
              if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
                tab = tab === 'calendario' ? 'biblioteca' : 'calendario'; drawTabs(); drawPanel();
                var n = tabs.querySelector('[aria-selected="true"]'); if (n) n.focus();
              }
            }
          }, t.label));
        });
      }

      function drawPanel() {
        panel.textContent = '';
        panel.setAttribute('aria-labelledby', 'tab-' + tab);
        if (tab === 'calendario') drawCalendar(); else drawLibrary();
      }

      // ----- calendario -----
      function drawCalendar() {
        var s = state(), plan = s.plan;
        if (!plan) {
          panel.appendChild(el('div', { 'class': 'card' }, [el('h2', null, 'Aún no hay plan'), el('p', { 'class': 'muted' }, 'Crea un plan con tu perfil actual y empieza hoy.'),
            el('button', { type: 'button', 'class': 'btn btn-primary', onclick: confirmRegenerate }, 'Crear plan')]));
          return;
        }
        var today = U.todayStr();
        var actsByDate = {}, tssByDate = {};
        (s.activities || []).forEach(function (a) { var d = U.localDate(a.date); actsByDate[d] = true; tssByDate[d] = (tssByDate[d] || 0) + (a.tss || 0); });
        var currentCard = null;
        plan.weeks.forEach(function (w) {
          var d0 = w.days[0] && w.days[0].date, d1 = w.days[w.days.length - 1] && w.days[w.days.length - 1].date;
          var real = 0;
          w.days.forEach(function (day) { real += tssByDate[day.date] || 0; });
          var isCurrent = d0 && d1 && today >= d0 && today <= d1;
          var ph = U.PHASES[w.phase] || { label: w.phase, color: '#888' };
          var pct = w.targetTss > 0 ? Math.min(100, Math.round(real / w.targetTss * 100)) : 0;
          var card = el('section', { 'class': 'card week' + (isCurrent ? ' current' : ''), 'aria-label': 'Semana ' + w.index }, [
            el('div', { 'class': 'week-head' }, [
              el('h3', null, 'Semana ' + w.index),
              el('span', { 'class': 'chip' }, [el('i', { style: { '--c': ph.color } }), ph.label]),
              el('span', { 'class': 'muted small' }, d0 ? U.fmtDateEs(d0, { day: 'numeric', month: 'short' }) + ' al ' + U.fmtDateEs(d1, { day: 'numeric', month: 'short' }) : ''),
              el('div', { 'class': 'tss-meter' }, [
                el('div', { 'class': 'small' }, [el('b', null, Math.round(real) + ' TSS'), ' de ' + Math.round(w.targetTss) + ' objetivo']),
                el('div', { 'class': 'tss-bar', role: 'img', 'aria-label': pct + ' % del TSS objetivo' }, el('div', { style: { width: pct + '%' } }))
              ])
            ]),
            el('div', { 'class': 'days' }, w.days.map(function (day) { return dayCell(day, today, actsByDate); }))
          ]);
          if (isCurrent) currentCard = card;
          panel.appendChild(card);
        });
        if (currentCard) setTimeout(function () { try { currentCard.scrollIntoView({ block: 'start' }); window.scrollBy(0, -12); } catch (e) { /* sin scroll */ } }, 0);
      }

      function dayCell(day, today, actsByDate) {
        var dateLabel = U.fmtDateEs(day.date, { weekday: 'short', day: 'numeric' });
        var isToday = day.date === today;
        var cls = 'day' + (isToday ? ' today-cell' : '');
        if (!day.workoutId) {
          return el('div', { 'class': cls + ' rest' }, [el('div', { 'class': 'day-date' }, dateLabel), el('div', { 'class': 'day-meta' }, 'Descanso')]);
        }
        var w = R.training.getWorkout(day.workoutId);
        if (!w) return el('div', { 'class': cls + ' rest' }, [el('div', { 'class': 'day-date' }, dateLabel), el('div', { 'class': 'day-meta' }, 'Sesión no encontrada')]);
        var status = day.status === 'hecho' || actsByDate[day.date] ? 'hecho' : day.status === 'saltado' ? 'saltado' : '';
        return el('button', {
          type: 'button', 'class': cls, 'aria-label': dateLabel + ': ' + w.name + ', ' + U.fmtDur(w.durationS) + (status ? ', ' + status : ''),
          onclick: function () { openDetail(w, day); }
        }, [
          el('div', { 'class': 'day-date' }, [el('span', null, dateLabel), isToday ? el('span', { 'class': 'status', style: { color: 'var(--gold)' } }, 'Hoy') : status ? el('span', { 'class': 'status status-' + status }, status === 'hecho' ? 'Hecha' : 'Saltada') : null]),
          el('div', { 'class': 'day-name' }, w.name),
          el('div', { 'class': 'day-meta' }, U.fmtDur(w.durationS) + ' · ' + Math.round(w.tss) + ' TSS'),
          U.workoutProfile(w)
        ]);
      }

      // ----- detalle de una sesión -----
      function openDetail(w, day) {
        var ftp = state().profile.ftp;
        var actions = [{ label: 'Cerrar' }];
        if (day && day.status !== 'hecho') actions.push({ label: 'Cambiar por otro', onClick: function () { setTimeout(function () { openSwap(w, day); }, 0); } });
        actions.push({ label: 'Rodar ahora', kind: 'primary', onClick: function () { ctx.navigate('rodar', { workoutId: w.id }); } });
        R.ui.modal({
          title: w.name,
          body: function (b) {
            b.appendChild(el('div', { 'class': 'row', style: { 'margin-bottom': '10px' } }, [catChip(w), el('span', { 'class': 'chip' }, U.fmtDur(w.durationS)), el('span', { 'class': 'chip' }, Math.round(w.tss) + ' TSS')]));
            if (w.description) b.appendChild(el('p', null, w.description));
            b.appendChild(U.workoutProfile(w, { className: 'big' }));
            b.lastChild.style.height = '90px'; b.lastChild.style.margin = '6px 0 14px';
            var rows = w.steps.map(function (s) {
              var p1 = s.powerPctEnd != null ? s.powerPctEnd : s.powerPct;
              var avg = (s.powerPct + p1) / 2;
              var pcts = s.powerPctEnd != null && s.powerPctEnd !== s.powerPct ? Math.round(s.powerPct) + ' a ' + Math.round(p1) + ' %' : Math.round(s.powerPct) + ' %';
              var watts = s.powerPctEnd != null && s.powerPctEnd !== s.powerPct
                ? Math.round(s.powerPct * ftp / 100) + ' a ' + Math.round(p1 * ftp / 100) + ' W' : Math.round(s.powerPct * ftp / 100) + ' W';
              return el('tr', { 'class': 'step-row' }, [
                el('td', null, [el('span', { 'class': 'zone-dot', style: { '--c': U.zoneColor(avg) } }), s.label || 'Tramo']),
                el('td', { 'class': 'r' }, U.fmtClock(s.durationS)), el('td', { 'class': 'r' }, pcts), el('td', { 'class': 'r' }, watts)
              ]);
            });
            b.appendChild(el('div', { 'class': 'table-wrap' }, el('table', { 'class': 'data' }, [
              el('caption', { 'class': 'sr-only' }, 'Pasos del entrenamiento con zonas en vatios según tu FTP de ' + ftp + ' W'),
              el('thead', null, el('tr', null, [el('th', { scope: 'col' }, 'Tramo'), el('th', { scope: 'col', 'class': 'r' }, 'Duración'), el('th', { scope: 'col', 'class': 'r' }, '% FTP'), el('th', { scope: 'col', 'class': 'r' }, 'Vatios')])),
              el('tbody', null, rows)
            ])));
          },
          actions: actions
        });
      }

      function openSwap(w, day) {
        var options = R.training.library.filter(function (x) { return x.category === w.category && x.id !== w.id; });
        var modalHandle = R.ui.modal({
          title: 'Cambiar "' + w.name + '"',
          body: function (b) {
            b.appendChild(el('p', { 'class': 'muted' }, 'Sesiones de la misma categoría (' + (U.CATEGORIES[w.category] || w.category) + ').'));
            if (!options.length) { b.appendChild(el('p', null, 'No hay otras sesiones en esta categoría.')); return; }
            var list = el('div', { 'class': 'pick-list' });
            options.forEach(function (o) {
              list.appendChild(el('button', {
                type: 'button', 'class': 'lib-item', onclick: function () { swapWorkout(day.date, o); modalHandle.close(); }
              }, [el('b', null, o.name), el('div', { 'class': 'day-meta' }, U.fmtDur(o.durationS) + ' · ' + Math.round(o.tss) + ' TSS'), U.workoutProfile(o)]));
            });
            b.appendChild(list);
          },
          actions: [{ label: 'Cancelar' }]
        });
      }

      function swapWorkout(date, workout) {
        var plan = JSON.parse(JSON.stringify(state().plan));
        var done = false;
        plan.weeks.forEach(function (wk) { wk.days.forEach(function (d) { if (d.date === date) { d.workoutId = workout.id; done = true; } }); });
        if (!done) return;
        R.store.set({ plan: plan });
        ctx.toast('Sesión cambiada por "' + workout.name + '".', 'ok');
        drawPanel();
      }

      // ----- regenerar / exportar -----
      function confirmRegenerate() {
        var p = state().profile;
        var warn = p && R.ui.profileForm.isEvent(p.goal) && p.eventDate && U.daysBetween(U.todayStr(), p.eventDate) < 28;
        R.ui.modal({
          title: state().plan ? 'Regenerar plan' : 'Crear plan',
          body: function (b) {
            b.appendChild(el('p', null, 'Crearemos un plan nuevo desde hoy con tu perfil actual (' + p.hoursPerWeek + ' h por semana, ' + p.daysPerWeek + ' días). Tus actividades registradas se conservan.'));
            if (state().plan) b.appendChild(el('p', { 'class': 'muted' }, 'El plan actual y los cambios que hiciste en él se reemplazan.'));
            if (warn) b.appendChild(el('div', { 'class': 'callout callout-warn' }, 'La fecha de tu evento ya pasó o está a menos de 4 semanas. El plan durará 4 semanas como mínimo; puedes cambiar la fecha en Ajustes.'));
          },
          actions: [
            { label: 'Cancelar' },
            {
              label: 'Regenerar', kind: 'primary', onClick: function () {
                try {
                  var plan = R.training.buildPlan({ profile: p, startDate: U.todayStr() });
                  R.store.set({ plan: plan });
                  ctx.toast('Plan regenerado: ' + plan.weeks.length + ' semanas.', 'ok');
                  drawHead(); drawPanel();
                } catch (e) { ctx.toast('No se pudo regenerar el plan: ' + e.message, 'error'); }
              }
            }
          ]
        });
      }

      function exportIcs() {
        var s = state();
        var ics;
        try { ics = R.integrations.toICS({ plan: s.plan, settings: s.settings, profile: s.profile }); }
        catch (e) { ctx.toast('No se pudo generar el calendario: ' + e.message, 'error'); return; }
        saveOrCopy('rodillator-plan.ics', ics, 'Recordatorios exportados (.ics).',
          'Tu navegador no permite descargar archivos desde aquí. Copia este texto, pégalo en un archivo llamado rodillator-plan.ics e impórtalo en tu calendario.');
      }

      // ----- biblioteca -----
      function drawLibrary() {
        var cats = [{ id: 'all', label: 'Todas' }].concat(Object.keys(U.CATEGORIES).map(function (k) { return { id: k, label: U.CATEGORIES[k] }; }));
        var durTest = DUR_FILTERS.filter(function (f) { return f.id === libDur; })[0].test;
        var items = R.training.library.filter(function (w) { return (libCat === 'all' || w.category === libCat) && durTest(Math.round(w.durationS / 60)); });
        var catSel = el('select', { id: 'lib-cat', onchange: function (ev) { libCat = ev.target.value; drawPanel(); } }, cats.map(function (c) { return el('option', { value: c.id, selected: c.id === libCat }, c.label); }));
        var durSel = el('select', { id: 'lib-dur', onchange: function (ev) { libDur = ev.target.value; drawPanel(); } }, DUR_FILTERS.map(function (f) { return el('option', { value: f.id, selected: f.id === libDur }, f.label); }));
        panel.appendChild(el('div', { 'class': 'filters' }, [
          el('div', { 'class': 'field', style: { margin: 0, 'min-width': '200px' } }, [el('label', { 'for': 'lib-cat' }, 'Categoría'), catSel]),
          el('div', { 'class': 'field', style: { margin: 0, 'min-width': '200px' } }, [el('label', { 'for': 'lib-dur' }, 'Duración'), durSel]),
          el('span', { 'class': 'muted', role: 'status' }, items.length + (items.length === 1 ? ' entrenamiento' : ' entrenamientos'))
        ]));
        if (!items.length) { panel.appendChild(el('p', { 'class': 'muted' }, 'Ningún entrenamiento cumple esos filtros. Prueba con otra categoría o duración.')); return; }
        var grid = el('div', { 'class': 'lib-grid' });
        items.forEach(function (w) {
          grid.appendChild(el('button', { type: 'button', 'class': 'lib-item', onclick: function () { openDetail(w, null); } }, [
            el('b', null, w.name),
            el('div', { 'class': 'row', style: { gap: '6px' } }, [catChip(w), el('span', { 'class': 'day-meta' }, U.fmtDur(w.durationS) + ' · ' + Math.round(w.tss) + ' TSS')]),
            U.workoutProfile(w)
          ]));
        });
        panel.appendChild(grid);
      }

      drawHead(); drawTabs(); drawPanel();
    }
  };

  R.ui.saveOrCopy = saveOrCopy;
  R.ui.registerView(planView);
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
