(function (R) {
  'use strict';

  var el = R.ui.el;
  var U = R.ui.util;
  var PF = R.ui.profileForm;
  var ZONE_PCT = ['menos de 55 %', '56 a 75 %', '76 a 90 %', '91 a 105 %', '106 a 120 %', '121 a 150 %', 'más de 150 %'];
  var PLAN_FIELDS = ['goal', 'eventDate', 'hoursPerWeek', 'daysPerWeek', 'weeks', 'level'];

  function num(v) { return v === '' || v === null || v === undefined ? NaN : Number(v); }

  function section(id, title, sub, children) {
    return el('section', { 'class': 'card', 'aria-labelledby': id }, [
      el('h2', { id: id }, title), sub ? el('p', { 'class': 'card-sub' }, sub) : null, children
    ]);
  }

  var settingsView = {
    id: 'ajustes', title: 'Ajustes',
    render: function (container, ctx) {
      var unsubs = [];
      settingsView._unsubs = unsubs;
      var s = R.store.get();
      var profile = s.profile, settings = s.settings;
      container.appendChild(el('header', { 'class': 'view-head' }, el('div', null, [el('h1', null, 'Ajustes'), el('p', null, 'Tu perfil, tus zonas y cómo quieres rodar.')])));
      var grid = el('div', { 'class': 'set-grid' });
      container.appendChild(grid);

      function rerender() { container.textContent = ''; unsubs.splice(0).forEach(function (u) { u(); }); settingsView.render(container, ctx); }

      if (profile) {
        grid.appendChild(profileCard());
        grid.appendChild(zonesCard());
        grid.appendChild(remindersCard());
        grid.appendChild(rideCard());
        grid.appendChild(coachCard());
        grid.appendChild(simulatorCard());
      } else {
        grid.appendChild(section('no-profile', 'Todavía no tienes perfil', 'Crea tu perfil para ver tus zonas y ajustar tu plan. Si tienes un respaldo, puedes importarlo más abajo.',
          el('button', { type: 'button', 'class': 'btn btn-primary', onclick: function () { ctx.navigate('onboarding'); } }, 'Crear mi perfil')));
      }
      grid.appendChild(stravaCard());
      grid.appendChild(backupCard());

      // ---------- perfil ----------
      function profileCard() {
        var p = profile;
        var d = {
          name: p.name, age: p.age, sex: p.sex, weightKg: p.weightKg, heightCm: p.heightCm, level: p.level,
          knowsFtp: !p.ftpEstimated, ftp: p.ftp, maxHr: p.maxHr, goal: p.goal, eventDate: p.eventDate || '',
          hoursPerWeek: p.hoursPerWeek, daysPerWeek: p.daysPerWeek, weeks: p.weeks
        };
        var form = el('form', { novalidate: true, onsubmit: function (ev) { ev.preventDefault(); save(); } });
        var txt = function (name, type, extra) {
          return el('input', Object.assign({ id: 'f-' + name, type: type, value: d[name], oninput: function (ev) { d[name] = ev.target.value; if (name === 'ftp') { d.knowsFtp = true; } } }, extra || {}));
        };
        var sel = function (name, opts) {
          return el('select', { id: 'f-' + name, onchange: function (ev) { d[name] = ev.target.value; if (name === 'goal') evField(); } },
            opts.map(function (o) { return el('option', { value: o.id, selected: String(d[name]) === String(o.id) }, o.label); }));
        };
        var ftpInput = txt('ftp', 'number', { inputmode: 'numeric', min: 50, max: 600 });
        var ftpNote = el('span', null, p.ftpEstimated ? 'Valor estimado según tu nivel. Reemplázalo cuando conozcas tu FTP real.' : 'Actualízalo tras un test o cuando aceptes una sugerencia.');
        var evBox = el('div', { 'class': 'wide' });
        function evField() {
          evBox.textContent = '';
          if (PF.isEvent(d.goal)) evBox.appendChild(PF.field('eventDate', d.goal === 'evento' ? 'Fecha del evento' : 'Fecha del gran fondo (opcional)', txt('eventDate', 'date'), 'Entre 4 y 24 semanas desde hoy.'));
        }
        form.appendChild(el('div', { 'class': 'form-grid' }, [
          PF.field('name', 'Nombre', txt('name', 'text', { maxlength: 40 })),
          PF.field('age', 'Edad (años)', txt('age', 'number', { inputmode: 'numeric' })),
          PF.field('sex', 'Sexo', sel('sex', [{ id: 'masculino', label: 'Hombre' }, { id: 'femenino', label: 'Mujer' }, { id: 'otro', label: 'Otro' }])),
          PF.field('weightKg', 'Peso (kg)', txt('weightKg', 'number', { inputmode: 'decimal', step: 0.1 })),
          PF.field('heightCm', 'Altura (cm)', txt('heightCm', 'number', { inputmode: 'numeric' })),
          PF.field('level', 'Nivel', sel('level', PF.LEVELS.map(function (l) { return { id: l.id, label: l.name }; }))),
          el('div', { 'class': 'field' }, [
            el('label', { 'for': 'f-ftp' }, 'FTP (vatios)'), ftpInput,
            el('div', { 'class': 'hint' }, ftpNote),
            el('div', { 'class': 'field-error', 'data-err': 'ftp', role: 'alert' }),
            el('div', null, el('button', {
              type: 'button', 'class': 'btn btn-sm', onclick: function () {
                try {
                  var est = R.training.estimateFtp({ weightKg: num(d.weightKg), level: d.level, age: num(d.age) || 0 });
                  d.ftp = est.ftp; d.knowsFtp = false; ftpInput.value = est.ftp;
                  ftpNote.textContent = 'Estimado según tu peso, edad y nivel (' + est.wkg.toFixed(2).replace('.', ',') + ' W/kg).';
                } catch (e) { ctx.toast(e.message, 'error'); }
              }
            }, 'Estimar según mi nivel'))
          ]),
          PF.field('maxHr', 'Frecuencia cardíaca máxima (ppm)', txt('maxHr', 'number', { inputmode: 'numeric' }), 'Déjala vacía para usar la fórmula de Tanaka.'),
          PF.field('goal', 'Objetivo', sel('goal', PF.GOAL_LIST.map(function (g) { return { id: g.id, label: g.name }; }))),
          evBox,
          PF.field('hoursPerWeek', 'Horas por semana', txt('hoursPerWeek', 'number', { min: 2, max: 15 })),
          PF.field('daysPerWeek', 'Días por semana', txt('daysPerWeek', 'number', { min: 2, max: 7 })),
          PF.field('weeks', 'Duración del plan (semanas)', txt('weeks', 'number', { min: 4, max: 24 }))
        ]));
        evField();
        form.appendChild(el('div', { 'class': 'row' }, el('button', { type: 'submit', 'class': 'btn btn-primary' }, 'Guardar perfil')));

        function save() {
          var errs = PF.validate(d);
          if (Object.keys(errs).length) { PF.showErrors(form, errs, true); ctx.toast('Revisa los campos marcados.', 'warn'); return; }
          PF.showErrors(form, {}, false);
          var next;
          try { next = PF.toProfile(d); } catch (e) { ctx.toast(e.message, 'error'); return; }
          var changed = PLAN_FIELDS.some(function (f) { return String(next[f]) !== String(p[f]); });
          R.store.set({ profile: next });
          ctx.toast('Perfil guardado. Tus zonas se recalcularon con un FTP de ' + next.ftp + ' W.', 'ok');
          if (changed && R.store.get().plan) {
            R.ui.modal({
              title: '¿Regenerar tu plan?',
              body: 'Cambiaste datos que afectan tu plan (objetivo, nivel, tiempo disponible o duración). Puedes regenerarlo ahora con el perfil nuevo o mantener el actual.',
              actions: [
                { label: 'Mantener plan actual', onClick: function () { rerender(); } },
                {
                  label: 'Regenerar plan', kind: 'primary', onClick: function () {
                    try {
                      var plan = R.training.buildPlan({ profile: next, startDate: U.todayStr() });
                      R.store.set({ plan: plan });
                      ctx.toast('Plan regenerado: ' + plan.weeks.length + ' semanas.', 'ok');
                    } catch (e) { ctx.toast('No se pudo regenerar el plan: ' + e.message, 'error'); }
                    rerender();
                  }
                }
              ]
            });
          } else rerender();
        }
        return section('set-profile', 'Perfil', 'Si cambias tu FTP, tus zonas y los vatios objetivo se actualizan al instante.', form);
      }

      // ---------- zonas ----------
      function zonesCard() {
        var zs = R.training.zones(profile.ftp);
        var rows = zs.map(function (z, i) {
          var w = z.maxW == null ? 'más de ' + (z.minW - 1) + ' W' : (z.minW === 0 ? 'hasta ' + z.maxW + ' W' : z.minW + ' a ' + z.maxW + ' W');
          return el('tr', null, [
            el('td', null, [el('span', { 'class': 'zone-dot', style: { '--c': z.color } }), 'Z' + z.zone + ' ' + z.name]),
            el('td', null, ZONE_PCT[i]), el('td', { 'class': 'r' }, w)
          ]);
        });
        return section('set-zones', 'Zonas de potencia', 'Calculadas con tu FTP de ' + profile.ftp + ' W (método Coggan).', el('div', { 'class': 'table-wrap' }, el('table', { 'class': 'data' }, [
          el('caption', { 'class': 'sr-only' }, 'Zonas de potencia'),
          el('thead', null, el('tr', null, [el('th', { scope: 'col' }, 'Zona'), el('th', { scope: 'col' }, '% del FTP'), el('th', { scope: 'col', 'class': 'r' }, 'Vatios')])),
          el('tbody', null, rows)
        ])));
      }

      // ---------- recordatorios ----------
      function remindersCard() {
        var status = el('div', { 'class': 'hint', role: 'status' });
        function permText() {
          var p = (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported';
          status.textContent = p === 'granted' ? 'Notificaciones del sistema activadas.' : p === 'denied' ? 'Las notificaciones están bloqueadas en el navegador. Verás el recordatorio dentro de la app.'
            : p === 'default' ? 'Las notificaciones del sistema aún no están activadas.' : 'Este entorno no permite notificaciones del sistema. Verás el recordatorio dentro de la app.';
        }
        permText();
        var time = el('input', { id: 'f-reminderTime', type: 'time', value: settings.reminderTime || '19:00', onchange: function (ev) {
          if (!/^\d{1,2}:\d{2}$/.test(ev.target.value)) { ctx.toast('Elige una hora válida.', 'warn'); return; }
          R.store.set({ settings: { reminderTime: ev.target.value } }); ctx.toast('Hora del recordatorio guardada.', 'ok');
        } });
        return section('set-rem', 'Recordatorios', 'Te avisamos en la app los días y a la hora que elijas. También puedes llevarlos a tu calendario desde Plan.', [
          el('div', { 'class': 'form-grid' }, [
            el('div', { 'class': 'field' }, [el('label', { 'for': 'f-reminderTime' }, 'Hora'), time]),
            el('div', { 'class': 'field' }, [el('span', { 'class': 'label' }, 'Días'), PF.dayToggles(settings.reminderDays || [], function (days) { R.store.set({ settings: { reminderDays: days } }); })])
          ]),
          el('div', { 'class': 'row' }, [
            el('button', {
              type: 'button', 'class': 'btn', onclick: function () {
                R.integrations.requestNotificationPermission().then(function (r) {
                  permText();
                  if (r === 'granted') ctx.toast('Notificaciones activadas.', 'ok');
                  else if (r === 'denied') ctx.toast('El navegador bloqueó las notificaciones. Puedes habilitarlas en la configuración del sitio.', 'warn');
                  else ctx.toast('Este entorno no permite notificaciones del sistema.', 'warn');
                });
              }
            }, 'Activar notificaciones del sistema'), status
          ])
        ]);
      }

      // ---------- rodar ----------
      function rideCard() {
        function range(id, label, min, max, step, val, fmt, onSave, hint) {
          var out = el('output', { 'class': 'range-out', 'for': id }, fmt(val));
          var input = el('input', {
            id: id, type: 'range', min: min, max: max, step: step, value: val, 'aria-describedby': id + '-h',
            oninput: function (ev) { out.textContent = fmt(Number(ev.target.value)); },
            onchange: function (ev) { onSave(Number(ev.target.value)); }
          });
          return el('div', { 'class': 'field' }, [el('label', { 'for': id }, label), el('div', { 'class': 'range-row' }, [input, out]), el('div', { 'class': 'hint', id: id + '-h' }, hint)]);
        }
        return section('set-ride', 'Rodar', null, [
          range('f-ghost', 'Superar mi mejor marca por…', 0, 5, 0.5, settings.ghostBoost || 0,
            function (v) { return '+' + U.fmtNum(v, 1) + ' %'; },
            function (v) { R.store.set({ settings: { ghostBoost: v } }); ctx.toast('Fantasma ajustado a +' + U.fmtNum(v, 1) + ' %.', 'ok'); },
            'El fantasma dorado recorre la ruta a tu mejor marca más este porcentaje. Con 0 % iguala tu mejor tiempo.'),
          range('f-bots', 'Ciclistas rivales (bots)', 0, 12, 1, settings.botsCount == null ? 6 : settings.botsCount,
            function (v) { return String(v); },
            function (v) { R.store.set({ settings: { botsCount: v } }); ctx.toast(v + (v === 1 ? ' rival' : ' rivales') + ' en pantalla.', 'ok'); },
            'Los rivales azules te acompañan en las rutas. Con 0 ruedas solo.'),
          el('div', { 'class': 'field' }, [
            el('label', { 'for': 'f-gfx' }, 'Calidad gráfica'),
            el('select', { id: 'f-gfx', 'aria-describedby': 'f-gfx-h', onchange: function (ev) {
              R.store.set({ settings: { graphicsQuality: ev.target.value } });
              ctx.toast('Calidad gráfica: ' + ev.target.options[ev.target.selectedIndex].text + '.', 'ok');
            } }, [['auto', 'Automática'], ['alta', 'Alta (equipos potentes)'], ['media', 'Media'], ['baja', 'Baja']].map(function (o) {
              return el('option', { value: o[0], selected: (settings.graphicsQuality || 'auto') === o[0] }, o[1]);
            })),
            el('div', { 'class': 'hint', id: 'f-gfx-h' }, 'Paisaje 3D: árboles, pasto con viento y sombras. Automática usa Media en el celular y Alta en el computador, y baja sola si la escena va lenta.')
          ])
        ]);
      }

      // ---------- coach de voz ----------
      function coachCard() {
        var cs = R.coach.normalizeSettings(settings.coach);
        var testAudio = null;
        unsubs.push(function () { if (testAudio) { testAudio.dispose(); testAudio = null; } });
        function save(patch) {
          cs = Object.assign({}, cs, patch);
          R.store.set({ settings: { coach: Object.assign({}, cs, { volumeV2: true }) } });
        }
        function check(id, label, key) {
          return el('label', { 'class': 'row', 'for': id }, [
            el('input', { id: id, type: 'checkbox', checked: cs[key], onchange: function (ev) { save((function (o) { o[key] = ev.target.checked; return o; })({})); } }),
            ' ' + label
          ]);
        }
        var volOut = el('output', { 'class': 'range-out', 'for': 'f-coach-vol' }, Math.round(cs.volume * 100) + ' %');
        var vol = el('input', {
          id: 'f-coach-vol', type: 'range', min: 0, max: 2, step: 0.05, value: cs.volume,
          oninput: function (ev) { volOut.textContent = Math.round(Number(ev.target.value) * 100) + ' %'; },
          onchange: function (ev) { save({ volume: Number(ev.target.value) }); }
        });
        var verb = el('select', { id: 'f-coach-verb', onchange: function (ev) { save({ verbosity: ev.target.value }); } },
          [['completo', 'Completo'], ['esencial', 'Esencial'], ['off', 'Silencio']].map(function (o) {
            return el('option', { value: o[0], selected: cs.verbosity === o[0] }, o[1]);
          }));
        return section('set-coach', 'Coach de voz', 'Cuenta regresiva, avisos de intervalos y de pie o sentado mientras rodas.', [
          el('div', { 'class': 'form-grid' }, [
            el('div', { 'class': 'field' }, [check('f-coach-voice', 'Voz del coach', 'voice'), check('f-coach-natural', 'Voz natural (pregrabada)', 'natural'), check('f-coach-beeps', 'Pitidos', 'beeps')]),
            el('div', { 'class': 'field' }, [el('label', { 'for': 'f-coach-vol' }, 'Volumen'), el('div', { 'class': 'range-row' }, [vol, volOut])]),
            el('div', { 'class': 'field' }, [el('label', { 'for': 'f-coach-verb' }, 'Cuánto habla'), verb])
          ]),
          el('div', { 'class': 'row' }, el('button', {
            type: 'button', 'class': 'btn', onclick: function () {
              if (testAudio) testAudio.dispose();
              testAudio = R.coach.createAudio({ volume: cs.volume, voice: true, beeps: cs.beeps, natural: cs.natural });
              testAudio.test();
            }
          }, 'Probar voz')),
          el('p', { 'class': 'hint' }, 'La voz suena sobre tu música: Spotify sigue sonando mientras el coach habla. El volumen llega hasta 200 % con la voz natural (pregrabada); si la desactivas, la voz del teléfono no pasa de 100 %. En iPhone usa Safari actualizado.')
        ]);
      }

      // ---------- simulador de potencia ----------
      function simulatorCard() {
        return section('set-sim', 'Potencia', null,
          el('p', null, 'Rodillator usa el simulador de potencia: controla tu esfuerzo con las flechas o los botones +/−.'));
      }

      // ---------- Strava ----------
      function stravaCard() {
        return section('set-strava', 'Strava', null, [
          el('p', null, 'Al terminar una rodada puedes exportar el archivo .TCX y subirlo en Strava. No hace falta conectar tu cuenta.'),
          el('p', null, ['Súbelo en ', el('a', { href: R.integrations.stravaUploadUrl || 'https://www.strava.com/upload/select', target: '_blank', rel: 'noopener noreferrer' }, 'strava.com/upload'), '.']),
          el('p', { 'class': 'muted small' }, 'Si usas el conector de Strava de Claude, también puedes pedirle que analice tus actividades ya subidas.')
        ]);
      }

      // ---------- respaldo y borrado ----------
      function backupCard() {
        var fileInput = el('input', { type: 'file', accept: '.json,application/json', 'class': 'sr-only', tabindex: '-1', 'aria-label': 'Archivo de respaldo', onchange: onImport });
        function onImport(ev) {
          var file = ev.target.files && ev.target.files[0];
          ev.target.value = '';
          if (!file) return;
          var read = file.text ? file.text() : new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res(String(fr.result)); }; fr.onerror = function () { rej(new Error('No se pudo leer el archivo.')); }; fr.readAsText(file); });
          read.then(function (text) {
            R.ui.modal({
              title: 'Importar respaldo',
              body: 'Se reemplazarán tu perfil, plan, actividades y ajustes actuales por los del archivo "' + file.name + '". Esta acción no se puede deshacer.',
              actions: [{ label: 'Cancelar' }, {
                label: 'Importar', kind: 'primary', onClick: function () {
                  try {
                    var oldCustom = customIds();
                    R.store.importJSON(text);
                    oldCustom.forEach(function (id) { delete R.routes.registry[id]; });
                    R.ui.registerCustomRoutes();
                    ctx.toast('Respaldo importado.', 'ok');
                    ctx.navigate(R.store.get().profile ? 'inicio' : 'onboarding');
                  } catch (e) { ctx.toast(e.message, 'error'); return false; }
                }
              }]
            });
          }).catch(function (e) { ctx.toast((e && e.message) || 'No se pudo leer el archivo.', 'error'); });
        }
        function customIds() { return (R.store.get().settings.customRoutes || []).map(function (r) { return r.id; }); }
        var exp = el('button', {
          type: 'button', 'class': 'btn', onclick: function () {
            R.ui.saveOrCopy('rodillator-respaldo-' + U.todayStr() + '.json', R.store.exportJSON(), 'Respaldo exportado.',
              'Tu navegador no permite descargar archivos desde aquí. Copia este texto y guárdalo en un archivo .json. Luego podrás importarlo desde esta misma pantalla.');
          }
        }, 'Exportar respaldo');
        try { R.store.flush(); } catch (e) { /* ignorar */ }
        var persistent = !(R.store.isPersistent && !R.store.isPersistent());
        var sub = persistent
          ? 'Todo se guarda en este navegador. Exporta un respaldo para no perderlo o llevarlo a otro equipo.'
          : null;
        return section('set-backup', 'Tus datos', sub, [
          persistent ? null : el('p', { 'class': 'banner', role: 'alert' }, 'No se pudo guardar en este navegador; exporta un respaldo para no perder tus datos.'),
          el('div', { 'class': 'row' }, [
            exp,
            el('button', { type: 'button', 'class': 'btn', onclick: function () { fileInput.click(); } }, 'Importar respaldo'), fileInput,
            el('button', { type: 'button', 'class': 'btn btn-danger', onclick: confirmDelete }, 'Borrar todos mis datos')
          ])
        ]);
      }

      function confirmDelete() {
        R.ui.modal({
          title: 'Borrar todos tus datos',
          body: 'Se eliminan tu perfil, plan, actividades, marcas, rutas GPX y ajustes de este navegador. No se puede deshacer. Si quieres conservarlos, exporta un respaldo antes.',
          actions: [{ label: 'Cancelar' }, {
            label: 'Borrar todo', kind: 'danger', onClick: function () {
              (R.store.get().settings.customRoutes || []).forEach(function (r) { delete R.routes.registry[r.id]; });
              R.store.reset();
              R.store.flush();
              ctx.toast('Datos borrados.', 'ok');
              ctx.navigate('onboarding');
            }
          }]
        });
      }
    },
    destroy: function () {
      (settingsView._unsubs || []).splice(0).forEach(function (u) { try { u(); } catch (e) { /* ya liberado */ } });
    }
  };

  R.ui.registerView(settingsView);
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
