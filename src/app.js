(function (R) {
  'use strict';

  var VALID_VIEWS = ['inicio', 'plan', 'rodar', 'rutas', 'estadisticas', 'ajustes'];

  function registerRoutes() {
    var n = 0;
    (window.R_ROUTES || []).forEach(function (r) {
      try { R.routes.register(r); n++; } catch (e) { /* una ruta inválida no frena el arranque */ }
    });
    if (typeof R.ui.registerCustomRoutes === 'function') R.ui.registerCustomRoutes();
    return n;
  }

  // Aplica adaptPlan al cargar. Si ya se adaptó hoy, conserva las sesiones elegidas y solo actualiza estados.
  function adaptStoredPlan() {
    var st = R.store.get();
    if (!st.plan || !st.profile) return;
    var today = R.ui.util.todayStr();
    var adapted;
    try { adapted = R.training.adaptPlan(st.plan, st.activities || [], st.profile, { today: today }); }
    catch (e) { return; }
    var prev = st.plan.lastAdaptation;
    if (prev && prev.date === today) {
      var byDate = {};
      st.plan.weeks.forEach(function (w) { w.days.forEach(function (d) { byDate[d.date] = d.workoutId; }); });
      adapted.weeks.forEach(function (w) { w.days.forEach(function (d) { if (d.date in byDate) d.workoutId = byDate[d.date]; }); });
      adapted.lastAdaptation = prev;
    }
    if (JSON.stringify(adapted) !== JSON.stringify(st.plan)) R.store.set({ plan: adapted });
    if (adapted.lastAdaptation && adapted.lastAdaptation.reason && !(prev && prev.date === today && prev.reason === adapted.lastAdaptation.reason)) {
      R.ui.toast(adapted.lastAdaptation.reason, 'info');
    }
  }

  function showBanner(text) {
    var root = document.getElementById('banner-root');
    if (!root) return;
    root.textContent = '';
    var el = R.ui.el;
    var b = el('div', { 'class': 'banner', role: 'status' }, [
      el('span', null, text),
      el('button', { type: 'button', 'class': 'btn btn-sm', onclick: function () { root.textContent = ''; } }, 'Entendido')
    ]);
    root.appendChild(b);
  }

  function startReminders() {
    if (!R.integrations || !R.integrations.createReminderScheduler) return null;
    var sched = R.integrations.createReminderScheduler({
      getState: function () { return R.store.get(); },
      onFire: function (p) {
        R.ui.toast(p.body, 'info');
        var st = R.store.get(), msg = p.body;
        try { msg += ' ' + R.training.motivation({ profile: st.profile, activities: st.activities, plan: st.plan }); } catch (e) { /* sin frase */ }
        showBanner(msg);
      }
    });
    sched.start();
    return sched;
  }

  // Sincronización opcional con la base del artefacto; nunca bloquea el arranque.
  async function attachCloud() {
    try {
      var c = window.claude;
      if (!c || typeof c.use !== 'function') return;
      var db = await c.use('db');
      var user = await c.use('user');
      if (!db || !user) return;
      var id = await user.id();
      var adopted = await R.store.attachDb(db, id);
      if (adopted) {
        if (typeof R.ui.registerCustomRoutes === 'function') R.ui.registerCustomRoutes();
        adaptStoredPlan();
        var cur = R.ui.currentId();
        R.ui.navigate(R.store.get().profile ? (cur === 'onboarding' ? 'inicio' : cur || 'inicio') : 'onboarding');
      }
    } catch (e) { /* sin sincronización: la app sigue con localStorage */ }
  }

  function boot() {
    registerRoutes();
    adaptStoredPlan();
    startReminders();
    var profile = R.store.get().profile;
    var hash = (window.location.hash || '').replace(/^#/, '');
    R.ui.start(profile ? (VALID_VIEWS.indexOf(hash) >= 0 && hash !== 'rodar' ? hash : 'inicio') : 'onboarding');
    attachCloud();
  }

  R.app = { boot: boot, adaptStoredPlan: adaptStoredPlan };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
