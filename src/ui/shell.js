(function (R) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  // ======================================================================
  // Utilidades
  // ======================================================================
  function el(tag, attrs, children) {
    var isSvg = typeof tag === 'string' && tag.indexOf('svg:') === 0;
    var node = isSvg ? document.createElementNS(SVG_NS, tag.slice(4)) : document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class' || k === 'className') node.setAttribute('class', v);
        else if (k === 'text') node.textContent = v;
        else if (k === 'style' && typeof v === 'object') Object.keys(v).forEach(function (s) { node.style.setProperty(s, v[s]); });
        else if (k === 'dataset') Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; });
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (!isSvg && (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'htmlFor')) node[k] = v;
        else node.setAttribute(k, v === true ? '' : String(v));
      });
    }
    appendChildren(node, children);
    return node;
  }

  function appendChildren(node, children) {
    if (children === null || children === undefined || children === false) return;
    if (Array.isArray(children)) { children.forEach(function (c) { appendChildren(node, c); }); return; }
    if (children.nodeType) node.appendChild(children);
    else node.appendChild(document.createTextNode(String(children)));
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function dateStr(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayStr() { return dateStr(new Date()); }
  function localDate(iso) { return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : dateStr(new Date(iso)); }
  function parseDate(s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2], 12, 0, 0); }
  function addDays(s, n) { var d = parseDate(s); d.setDate(d.getDate() + n); return dateStr(d); }
  function daysBetween(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }

  function fmtDateEs(s, opts) {
    try { return parseDate(s).toLocaleDateString('es-CL', opts || { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, ''); }
    catch (e) { return s; }
  }
  function fmtDur(sec) {
    var m = Math.round(sec / 60);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60), r = m % 60;
    return h + ' h' + (r ? ' ' + pad2(r) + ' min' : '');
  }
  function fmtClock(sec) {
    sec = Math.round(sec);
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? h + ':' + pad2(m) + ':' + pad2(s) : m + ':' + pad2(s);
  }
  function fmtNum(n, dec) {
    return Number(n).toLocaleString('es-CL', { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0 });
  }

  var CATEGORIES = {
    recuperacion: 'Recuperación', resistencia: 'Resistencia', tempo: 'Tempo', sweetspot: 'Sweet spot',
    umbral: 'Umbral', vo2: 'VO2máx', anaerobico: 'Anaeróbico', test: 'Test'
  };
  var PHASES = {
    base: { label: 'Base', color: '#3FA7D6' },
    construccion: { label: 'Construcción', color: '#FAC05E' },
    especifico: { label: 'Específico', color: '#FF5A1F' },
    descarga: { label: 'Descarga', color: '#59CD90' },
    taper: { label: 'Puesta a punto', color: '#B9A8FF' }
  };
  var GOALS = {
    forma: 'Mejorar mi forma', peso: 'Bajar de peso', ftp: 'Subir mi FTP', evento: 'Preparar un evento', 'gran-fondo': 'Gran fondo'
  };

  function zoneColor(pct) {
    var z = R.training.zones(100);
    return z[R.training.zoneFor(pct, 100) - 1].color;
  }

  // Perfil de intervalos: un polígono por tramo, coloreado por zona (% FTP).
  function workoutProfile(workout, opts) {
    var steps = workout.steps || [];
    var total = steps.reduce(function (a, s) { return a + s.durationS; }, 0) || 1;
    var maxPct = steps.reduce(function (a, s) { return Math.max(a, s.powerPct, s.powerPctEnd || 0); }, 0);
    var scale = Math.max(125, maxPct);
    var H = 40, x = 0;
    var svg = el('svg:svg', {
      'class': 'wprofile' + (opts && opts.className ? ' ' + opts.className : ''), viewBox: '0 0 200 ' + H,
      preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false'
    });
    steps.forEach(function (s) {
      var w = (s.durationS / total) * 200;
      var p0 = s.powerPct, p1 = s.powerPctEnd != null ? s.powerPctEnd : s.powerPct;
      var y0 = H - Math.max(2, (p0 / scale) * H), y1 = H - Math.max(2, (p1 / scale) * H);
      var pts = [x, H, x, y0, x + w, y1, x + w, H].map(function (v) { return Math.round(v * 100) / 100; }).join(' ');
      svg.appendChild(el('svg:polygon', { points: pts, fill: zoneColor((p0 + p1) / 2) }));
      x += w;
    });
    return svg;
  }

  // ======================================================================
  // Iconos
  // ======================================================================
  var ICON_PATHS = {
    inicio: ['M3 11.5 12 4l9 7.5', 'M5.5 10v9.5h4.5v-5.5h4v5.5h4.5V10'],
    plan: ['M4 6.5h16v13H4z', 'M4 10.5h16', 'M8.5 3.5v5', 'M15.5 3.5v5'],
    rodar: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M10 8.5v7l5.5-3.5z'],
    rutas: ['M2.5 19.5 9 8l4 6.5 2.5-3.5 6 8.5z'],
    estadisticas: ['M5 20V11', 'M12 20V4', 'M19 20v-7'],
    ajustes: ['M4 7h9', 'M17 7h3', 'M4 17h3', 'M11 17h9', 'M15 4.5v5', 'M9 14.5v5']
  };
  function icon(id) {
    var svg = el('svg:svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
    (ICON_PATHS[id] || ICON_PATHS.inicio).forEach(function (d) { svg.appendChild(el('svg:path', { d: d })); });
    return svg;
  }

  // Logo: rueda con radios sobre rodillo.
  function logo() {
    var s = el('svg:svg', { 'class': 'logo-svg', viewBox: '0 0 40 40', 'aria-hidden': 'true', focusable: 'false' });
    s.appendChild(el('svg:circle', { cx: 20, cy: 18, r: 13, fill: 'none', stroke: '#F2F4F7', 'stroke-width': 3 }));
    s.appendChild(el('svg:path', { d: 'M20 18 9.5 11M20 18l11-6M20 18v13M20 18l-9 9', stroke: '#FF5A1F', 'stroke-width': 2.2, 'stroke-linecap': 'round', fill: 'none' }));
    s.appendChild(el('svg:circle', { cx: 20, cy: 18, r: 3, fill: '#FF5A1F' }));
    s.appendChild(el('svg:rect', { x: 6, y: 34, width: 28, height: 4, rx: 2, fill: '#FF5A1F' }));
    return s;
  }

  // ======================================================================
  // Registro de vistas y navegación
  // ======================================================================
  var NAV = [
    { id: 'inicio', title: 'Inicio' }, { id: 'plan', title: 'Plan' }, { id: 'rodar', title: 'Rodar' },
    { id: 'rutas', title: 'Rutas' }, { id: 'estadisticas', title: 'Estadísticas' }, { id: 'ajustes', title: 'Ajustes' }
  ];
  var views = {};
  var current = null;      // { id, view }
  var started = false;
  var navLinks = {};

  function registerView(view) {
    if (!view || !view.id || typeof view.render !== 'function') throw new Error('Vista inválida: necesita id y render().');
    views[view.id] = view;
    if (started && current && current.id === view.id && current.placeholder) go(view.id, {});
    refreshNavState();
    return view;
  }

  function mainEl() { return document.getElementById('main'); }

  function buildNav() {
    var nav = document.getElementById('nav');
    nav.textContent = '';
    nav.appendChild(el('div', { 'class': 'brand' }, [logo(), el('div', { 'class': 'wordmark' }, ['RODILL', el('span', null, 'A'), 'TOR'])]));
    var ul = el('ul', { 'class': 'nav-list' });
    NAV.forEach(function (n) {
      var a = el('a', { 'class': 'nav-link', href: '#' + n.id, onclick: function (ev) { ev.preventDefault(); navigate(n.id); } }, [icon(n.id), el('span', null, (views[n.id] && views[n.id].title) || n.title)]);
      navLinks[n.id] = a;
      ul.appendChild(el('li', null, a));
    });
    nav.appendChild(ul);
    refreshNavState();
  }

  function refreshNavState() {
    NAV.forEach(function (n) {
      var a = navLinks[n.id];
      if (!a) return;
      if (current && current.id === n.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
      if (views[n.id]) a.removeAttribute('aria-disabled'); else a.setAttribute('aria-disabled', 'true');
    });
  }

  function placeholderView(id) {
    return {
      id: id, title: 'Sección no disponible',
      render: function (c) {
        c.appendChild(el('div', { 'class': 'card' }, [el('h2', null, 'Esta sección aún no está disponible'), el('p', { 'class': 'muted' }, 'No se cargó la vista "' + id + '". Vuelve al inicio e inténtalo de nuevo.')]));
      }
    };
  }

  function go(id, params) {
    var state = R.store.get();
    if (!state.profile && id !== 'onboarding' && id !== 'ajustes') id = 'onboarding';
    else if (state.profile && id === 'onboarding') id = 'inicio';   // el perfil se cambia desde Ajustes
    var view = views[id], placeholder = false;
    if (!view) { view = placeholderView(id); placeholder = true; }
    if (current && current.view && typeof current.view.destroy === 'function') {
      try { current.view.destroy(); } catch (e) { /* una vista defectuosa no bloquea la navegación */ }
    }
    var main = mainEl();
    main.textContent = '';
    var container = el('div', { 'class': 'view view-' + id });
    main.appendChild(container);
    current = { id: id, view: view, placeholder: placeholder };
    params = params || {};
    document.body.classList.toggle('no-nav', id === 'onboarding');
    document.title = (view.title && id !== 'inicio' ? view.title + ' · ' : '') + 'Rodillator';
    try {
      view.render(container, { store: R.store, navigate: navigate, params: params, toast: toast });
    } catch (e) {
      container.textContent = '';
      container.appendChild(el('div', { 'class': 'card' }, [el('h2', null, 'No se pudo mostrar esta sección'), el('p', { 'class': 'muted' }, String((e && e.message) || e))]));
      if (typeof console !== 'undefined') console.error(e);
    }
    refreshNavState();
    try { window.scrollTo(0, 0); main.focus({ preventScroll: true }); } catch (e) { /* sin foco */ }
    return current;
  }

  function navigate(id, params) {
    go(id, params);
    if ('#' + current.id !== window.location.hash) {
      try { window.location.hash = current.id; } catch (e) { /* hash no disponible en este entorno */ }
    }
  }

  function onHashChange() {
    var id = (window.location.hash || '').replace(/^#/, '');
    var known = !!views[id] || NAV.some(function (n) { return n.id === id; });
    if (!id || !known || (current && current.id === id)) return;
    go(id, {});
    if ('#' + current.id !== window.location.hash) {
      try { window.location.hash = current.id; } catch (e) { /* hash no disponible */ }
    }
  }

  // ======================================================================
  // Toasts y modales
  // ======================================================================
  function toast(msg, kind) {
    kind = kind || 'info';
    var root = document.getElementById('toast-root');
    if (!root) return null;
    while (root.children.length >= 4) root.removeChild(root.firstChild);
    var t = el('div', { 'class': 'toast toast-' + kind, role: kind === 'error' || kind === 'warn' ? 'alert' : 'status' }, [
      el('span', null, msg),
      el('button', { type: 'button', 'aria-label': 'Cerrar aviso', onclick: function () { remove(); } }, '×')
    ]);
    function remove() { if (t.parentNode) t.parentNode.removeChild(t); }
    root.appendChild(t);
    setTimeout(remove, kind === 'error' ? 9000 : 5500);
    return { close: remove };
  }

  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function modal(opts) {
    opts = opts || {};
    var root = document.getElementById('modal-root');
    var previous = document.activeElement;
    var titleId = 'modal-title-' + Math.random().toString(36).slice(2, 8);
    var bodyEl = el('div', { 'class': 'modal-body' });
    var actionsEl = el('div', { 'class': 'modal-actions' });
    var closed = false;
    var dialog = el('div', { 'class': 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, [
      el('div', { 'class': 'modal-head' }, el('h2', { id: titleId }, opts.title || '')),
      bodyEl, actionsEl
    ]);
    var backdrop = el('div', { 'class': 'modal-backdrop', onmousedown: function (ev) { if (ev.target === backdrop) close(); } }, dialog);

    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      try { if (previous && previous.focus) previous.focus(); } catch (e) { /* sin foco */ }
    }
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); close(); return; }
      if (ev.key !== 'Tab') return;
      var items = Array.prototype.filter.call(dialog.querySelectorAll(FOCUSABLE), function (n) { return n.offsetParent !== null || n === document.activeElement; });
      if (!items.length) { ev.preventDefault(); return; }
      var first = items[0], last = items[items.length - 1];
      if (ev.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { ev.preventDefault(); first.focus(); }
    }

    if (typeof opts.body === 'function') opts.body(bodyEl);
    else if (opts.body && opts.body.nodeType) bodyEl.appendChild(opts.body);
    else if (opts.body) bodyEl.appendChild(el('p', null, String(opts.body)));

    var actions = opts.actions && opts.actions.length ? opts.actions : [{ label: 'Cerrar' }];
    var primaryBtn = null;
    actions.forEach(function (a) {
      var cls = 'btn' + (a.kind === 'primary' ? ' btn-primary' : a.kind === 'danger' ? ' btn-danger' : '');
      var b = el('button', {
        type: 'button', 'class': cls, onclick: function () {
          var keep = false;
          if (typeof a.onClick === 'function') { try { keep = a.onClick(handle) === false; } catch (e) { toast(String((e && e.message) || e), 'error'); keep = true; } }
          if (!keep) close();
        }
      }, a.label);
      if (a.kind === 'primary' && !primaryBtn) primaryBtn = b;
      actionsEl.appendChild(b);
    });

    root.appendChild(backdrop);
    document.addEventListener('keydown', onKey, true);
    var focusTarget = dialog.querySelector('input, select, textarea') || primaryBtn || actionsEl.querySelector('button') || dialog;
    try { focusTarget.focus({ preventScroll: true }); } catch (e) { /* sin foco */ }
    var handle = { close: close, el: dialog, body: bodyEl };
    return handle;
  }

  // ======================================================================
  // Vista: inicio
  // ======================================================================
  function computeStreak(activities, today) {
    var set = {};
    activities.forEach(function (a) { set[localDate(a.date)] = true; });
    var d = set[today] ? today : addDays(today, -1), n = 0;
    while (set[d]) { n++; d = addDays(d, -1); }
    return n;
  }

  function planDays(plan) {
    var out = [];
    ((plan && plan.weeks) || []).forEach(function (w) { (w.days || []).forEach(function (d) { out.push(d); }); });
    return out;
  }

  function greeting(name) {
    var h = new Date().getHours();
    var g = h < 12 ? 'Buenos días' : h < 20 ? 'Buenas tardes' : 'Buenas noches';
    return name ? g + ', ' + name : g;
  }

  var dismissedFtp = {};

  var inicioView = {
    id: 'inicio', title: 'Inicio',
    render: function (container, ctx) {
      var state = R.store.get();
      var profile = state.profile, plan = state.plan, acts = state.activities || [];
      var today = todayStr();
      var done = {};
      acts.forEach(function (a) { done[localDate(a.date)] = true; });

      // cabecera
      var msg = '';
      try { msg = R.training.motivation({ profile: profile, activities: acts, plan: plan, today: today }); } catch (e) { msg = ''; }
      container.appendChild(el('header', { 'class': 'view-head hello' }, el('div', null, [
        el('h1', null, greeting(profile && profile.name)),
        msg ? el('p', { 'class': 'lead' }, msg) : null
      ])));

      var grid = el('div', { 'class': 'home-grid' });
      container.appendChild(grid);

      // sesión de hoy
      var days = planDays(plan);
      var todayDay = days.filter(function (d) { return d.date === today && d.workoutId; })[0] || null;
      var todayW = todayDay ? R.training.getWorkout(todayDay.workoutId) : null;
      var card = el('section', { 'class': 'card today', 'aria-labelledby': 'today-h' });
      if (todayW) {
        var isDone = todayDay.status === 'hecho' || !!done[today];
        card.appendChild(el('div', { 'class': 'row' }, [
          el('span', { 'class': 'chip' }, 'Sesión de hoy'),
          el('span', { 'class': 'chip' }, [el('i', { style: { '--c': zoneColor(todayW.steps.reduce(function (a, s) { return Math.max(a, s.powerPct); }, 0)) } }), CATEGORIES[todayW.category] || todayW.category]),
          isDone ? el('span', { 'class': 'chip status-hecho' }, 'Completada') : null
        ]));
        card.appendChild(el('h2', { id: 'today-h' }, todayW.name));
        card.appendChild(el('div', { 'class': 'today-meta' }, [
          el('div', null, [el('div', { 'class': 'num' }, fmtDur(todayW.durationS)), el('div', { 'class': 'kpi-label' }, 'Duración')]),
          el('div', null, [el('div', { 'class': 'num' }, fmtNum(todayW.tss)), el('div', { 'class': 'kpi-label' }, 'TSS')])
        ]));
        card.appendChild(workoutProfile(todayW));
        card.appendChild(el('div', { 'class': 'row' }, [
          el('button', { type: 'button', 'class': 'btn btn-primary', onclick: function () { ctx.navigate('rodar', { workoutId: todayW.id }); } }, isDone ? 'Rodar otra vez' : 'Rodar'),
          el('button', { type: 'button', 'class': 'btn', onclick: function () { ctx.navigate('plan'); } }, 'Ver plan')
        ]));
        // poco tiempo: versión corta de la sesión de hoy
        var quick = [20, 30, 45].filter(function (m) { return m * 60 < todayW.durationS; });
        if (!isDone && quick.length) {
          card.appendChild(el('div', { 'class': 'row quick-time', role: 'group', 'aria-label': '¿Poco tiempo? Hazla en…' }, [
            el('span', { 'class': 'quick-label' }, '¿Poco tiempo? Hazla en…')
          ].concat(quick.map(function (m) {
            return el('button', {
              type: 'button', 'class': 'btn btn-sm', 'aria-label': 'Hacer la sesión de hoy en ' + m + ' minutos',
              onclick: function () { ctx.navigate('rodar', { timed: { durationMin: m, focus: 'hoy' } }); }
            }, m + ' min');
          }))));
        }
      } else {
        var next = days.filter(function (d) { return d.date > today && d.workoutId && d.status === 'pendiente'; })[0];
        var nextW = next ? R.training.getWorkout(next.workoutId) : null;
        card.appendChild(el('span', { 'class': 'chip' }, 'Sesión de hoy'));
        card.appendChild(el('h2', { id: 'today-h' }, plan ? 'Hoy toca descansar' : 'Aún no tienes un plan'));
        card.appendChild(el('p', { 'class': 'muted' }, nextW
          ? 'Tu próxima sesión es "' + nextW.name + '" (' + fmtDur(nextW.durationS) + ') el ' + fmtDateEs(next.date, { weekday: 'long', day: 'numeric', month: 'long' }) + '.'
          : plan ? 'Tu plan no tiene más sesiones pendientes. Genera uno nuevo desde la vista Plan.' : 'Crea un plan desde la vista Plan.'));
        card.appendChild(el('div', { 'class': 'row' }, [
          el('button', { type: 'button', 'class': 'btn btn-primary', onclick: function () { ctx.navigate('plan'); } }, 'Ver plan')
        ]));
      }
      grid.appendChild(card);

      // forma (CTL / ATL / TSB) y racha
      var pm = { ctl: 0, atl: 0, tsb: 0 };
      try { pm = R.training.pmc(acts, { days: 120, today: today }).pop() || pm; } catch (e) { /* sin datos */ }
      var streak = computeStreak(acts, today);
      grid.appendChild(el('section', { 'class': 'card', 'aria-labelledby': 'form-h' }, [
        el('h2', { id: 'form-h' }, 'Tu forma'),
        el('p', { 'class': 'card-sub' }, 'Cómo vienes de carga y de frescura.'),
        el('div', { 'class': 'kpi-trio' }, [
          kpi(Math.round(pm.ctl), 'Forma (CTL)'), kpi(Math.round(pm.atl), 'Fatiga (ATL)'), kpi((pm.tsb > 0 ? '+' : '') + Math.round(pm.tsb), 'Frescura (TSB)')
        ]),
        el('div', { 'class': 'streak' }, [
          el('span', { 'class': 'num' }, String(streak)),
          el('span', null, streak === 1 ? 'día seguido rodando' : 'días seguidos rodando')
        ])
      ]));

      // sugerencia de FTP
      var sug = null;
      try { sug = R.training.suggestFtpUpdate(acts, profile, { today: today }); } catch (e) { sug = null; }
      if (sug && !dismissedFtp[sug.suggestedFtp]) {
        var box = el('section', { 'class': 'card suggest span-2', 'aria-labelledby': 'ftp-h' }, [
          el('h2', { id: 'ftp-h' }, 'Tu FTP podría ser ' + sug.suggestedFtp + ' W'),
          el('p', null, sug.reason),
          el('div', { 'class': 'row' }, [
            el('button', {
              type: 'button', 'class': 'btn btn-primary btn-sm', onclick: function () {
                R.store.set({ profile: Object.assign({}, R.store.get().profile, { ftp: sug.suggestedFtp, ftpEstimated: false }) });
                ctx.toast('FTP actualizado a ' + sug.suggestedFtp + ' W. Tus zonas se recalcularon.', 'ok');
                container.textContent = ''; inicioView.render(container, ctx);
              }
            }, 'Aplicar'),
            el('button', { type: 'button', 'class': 'btn btn-sm', onclick: function () { dismissedFtp[sug.suggestedFtp] = true; box.remove(); } }, 'Ahora no')
          ])
        ]);
        grid.appendChild(box);
      }

      // últimas actividades
      var last = acts.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; }).slice(0, 3);
      var actCard = el('section', { 'class': 'card span-2', 'aria-labelledby': 'acts-h' }, el('h2', { id: 'acts-h' }, 'Últimas actividades'));
      if (!last.length) {
        actCard.appendChild(el('p', { 'class': 'muted' }, 'Todavía no has registrado rodadas. Cuando termines tu primera sesión aparecerá aquí.'));
      } else {
        actCard.appendChild(el('ul', { 'class': 'list' }, last.map(function (a) {
          return el('li', null, [
            el('div', null, [el('div', { 'class': 't' }, a.name || 'Rodada'), el('div', { 'class': 'muted small' }, fmtDateEs(localDate(a.date), { weekday: 'long', day: 'numeric', month: 'long' }))]),
            el('div', { 'class': 'small', style: { 'text-align': 'right' } }, [fmtDur(a.durationS || 0), ' · ', Math.round(a.avgPower || 0) + ' W · TSS ' + Math.round(a.tss || 0)])
          ]);
        })));
      }
      grid.appendChild(actCard);
    }
  };

  function kpi(value, label) {
    return el('div', { 'class': 'kpi' }, [el('span', { 'class': 'num' }, String(value)), el('span', { 'class': 'kpi-label' }, label)]);
  }

  // ======================================================================
  // Arranque del shell
  // ======================================================================
  function start(initialId) {
    buildNav();
    started = true;
    window.addEventListener('hashchange', onHashChange);
    var skip = document.querySelector('.skip-link');
    if (skip) skip.addEventListener('click', function (ev) { ev.preventDefault(); try { mainEl().focus(); } catch (e) { /* sin foco */ } });
    var fromHash = (window.location.hash || '').replace(/^#/, '');
    var id = initialId || fromHash || 'inicio';
    go(id, {});
    if ('#' + current.id !== window.location.hash) {
      try { window.location.hash = current.id; } catch (e) { /* hash no disponible */ }
    }
  }

  R.ui = {
    registerView: registerView,
    navigate: navigate,
    toast: toast,
    modal: modal,
    el: el,
    // Extensiones internas del shell (usadas por app.js y las vistas propias)
    start: start,
    currentId: function () { return current && current.id; },
    util: {
      todayStr: todayStr, localDate: localDate, addDays: addDays, parseDate: parseDate, daysBetween: daysBetween,
      fmtDateEs: fmtDateEs, fmtDur: fmtDur, fmtClock: fmtClock, fmtNum: fmtNum,
      workoutProfile: workoutProfile, zoneColor: zoneColor, logo: logo,
      CATEGORIES: CATEGORIES, PHASES: PHASES, GOALS: GOALS, planDays: planDays
    }
  };

  registerView(inicioView);
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
