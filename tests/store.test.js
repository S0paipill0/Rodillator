const test = require('node:test');
const assert = require('node:assert');
require('../src/store.js');
const S = globalThis.R.store;

function fakeStorage(opts = {}) {
  const m = new Map();
  return {
    m, writes: 0,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem(k, v) {
      this.writes++;
      if (opts.quotaFirst && !this.threw) { this.threw = true; const e = new Error('q'); e.name = 'QuotaExceededError'; throw e; }
      if (opts.maxLen && v.length > opts.maxLen) { const e = new Error('q'); e.name = 'QuotaExceededError'; throw e; }
      m.set(k, v);
    },
    removeItem: (k) => m.delete(k)
  };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('sin localStorage funciona solo en memoria', () => {
  assert.equal(typeof localStorage, 'undefined');
  S.reset();
  const st = S.get();
  assert.equal(st.profile, null);
  assert.equal(st.plan, null);
  assert.deepEqual(st.activities, []);
  assert.deepEqual(st.bests, {});
  assert.equal(st.schemaVersion, 1);
  assert.deepEqual(st.settings, { reminderTime: '19:00', reminderDays: [1, 3, 5], ghostBoost: 0, botsCount: 6, units: 'metric' });
  S.set({ profile: { name: 'Ana' } });
  S.flush();
  assert.equal(S.get().profile.name, 'Ana');
});

test('set fusiona superficial, settings a 1 nivel, y notifica a suscriptores', () => {
  S.reset();
  const calls = [];
  const un = S.subscribe((s) => calls.push(s.settings.botsCount));
  S.set({ settings: { botsCount: 3 } });
  assert.equal(S.get().settings.botsCount, 3);
  assert.equal(S.get().settings.reminderTime, '19:00'); // se conserva
  S.set({ activities: [{ id: 'a1' }] });
  S.set({ activities: [{ id: 'a2' }] });
  assert.deepEqual(S.get().activities, [{ id: 'a2' }]); // reemplazo superficial
  assert.equal(calls.length, 3);
  un();
  S.set({ settings: { botsCount: 9 } });
  assert.equal(calls.length, 3);
});

test('persiste en localStorage con debounce de 300 ms', async () => {
  const ls = fakeStorage();
  globalThis.localStorage = ls;
  S.reset(); S.flush(); ls.writes = 0;
  S.set({ profile: { name: 'Beto' } });
  S.set({ settings: { units: 'metric', botsCount: 2 } });
  assert.equal(ls.writes, 0);
  await wait(450);
  assert.equal(ls.writes, 1);
  const saved = JSON.parse(ls.m.get('rodillator.v1'));
  assert.equal(saved.profile.name, 'Beto');
  assert.equal(saved.settings.botsCount, 2);
  // recarga desde storage
  S.set({ profile: null }); S.flush();
  S.set({ profile: { name: 'otro' } }); // no flush: storage conserva null
  S.load();
  assert.equal(S.get().profile, null);
  delete globalThis.localStorage;
});

test('localStorage que lanza no rompe nada', () => {
  globalThis.localStorage = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } };
  S.reset(); S.set({ profile: { name: 'C' } }); S.flush(); S.load();
  assert.ok(S.get());
  delete globalThis.localStorage;
});

function bigActivity(id, daysAgo, n) {
  const samples = [];
  for (let i = 0; i < n; i++) samples.push([i, 200, 140, 90, 8, i * 8, null]);
  return { id, date: new Date(Date.now() - daysAgo * 86400000).toISOString(), samples };
}

test('recorta samples de actividades >60 días a 1 de cada 5 al guardar', () => {
  const ls = fakeStorage();
  globalThis.localStorage = ls;
  S.reset();
  S.set({ activities: [bigActivity('old', 90, 1000), bigActivity('new', 5, 1000)] });
  S.flush();
  const saved = JSON.parse(ls.m.get('rodillator.v1'));
  const old = saved.activities.find((a) => a.id === 'old');
  const nw = saved.activities.find((a) => a.id === 'new');
  assert.ok(old.samples.length <= 201 && old.samples.length >= 200);
  assert.equal(nw.samples.length, 1000);
  assert.equal(S.get().activities[0].samples.length, 1000); // memoria intacta
  delete globalThis.localStorage;
});

test('QuotaExceeded: recorta más y reintenta una vez', () => {
  const ls = fakeStorage({ quotaFirst: true });
  globalThis.localStorage = ls;
  S.reset();
  ls.threw = false; ls.writes = 0;
  S.set({ activities: [bigActivity('old', 90, 1000), bigActivity('mid', 30, 1000)] });
  S.flush();
  assert.equal(ls.writes, 2);
  const saved = JSON.parse(ls.m.get('rodillator.v1'));
  assert.ok(saved.activities.find((a) => a.id === 'old').samples.length <= 51);
  assert.ok(saved.activities.find((a) => a.id === 'mid').samples.length <= 201);
  delete globalThis.localStorage;
});

test('exportJSON / importJSON ida y vuelta y validación', () => {
  S.reset();
  S.set({ profile: { name: 'D', ftp: 220 }, activities: [{ id: 'x', samples: [] }], settings: { botsCount: 1 } });
  const txt = S.exportJSON();
  S.reset();
  assert.equal(S.get().profile, null);
  S.importJSON(txt);
  assert.equal(S.get().profile.ftp, 220);
  assert.equal(S.get().settings.botsCount, 1);
  assert.equal(S.get().settings.units, 'metric');
  assert.throws(() => S.importJSON('no es json'), /JSON/);
  assert.throws(() => S.importJSON('[1,2]'), /formato/);
  assert.throws(() => S.importJSON(JSON.stringify({ activities: 'x' })), /Actividades/);
  assert.throws(() => S.importJSON(JSON.stringify({ schemaVersion: 99 })), /compatible/);
  assert.equal(S.get().profile.ftp, 220); // estado intacto tras fallos
});

function fakeDb(initial) {
  const docs = new Map(initial ? Object.entries(initial) : []);
  return {
    docs,
    doc(path) {
      return {
        get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
        set: async (v) => { docs.set(path, JSON.parse(JSON.stringify(v))); }
      };
    }
  };
}

test('attachDb: adopta el remoto si es más reciente', async () => {
  S.reset();
  const remote = { updatedAt: Date.now() + 100000, state: { profile: { name: 'Remoto' }, activities: [], settings: { botsCount: 4 } } };
  const db = fakeDb({ 'data/users/u1/state/main': remote });
  let notified = 0;
  S.subscribe(() => notified++);
  const adopted = await S.attachDb(db, 'u1');
  assert.equal(adopted, true);
  assert.equal(S.get().profile.name, 'Remoto');
  assert.equal(S.get().settings.botsCount, 4);
  assert.ok(notified >= 1);
});

test('attachDb: sube el local si es más reciente o no hay remoto', async () => {
  S.reset();
  S.set({ profile: { name: 'Local' } });
  const db = fakeDb();
  const adopted = await S.attachDb(db, 'u2');
  assert.equal(adopted, false);
  const stored = db.docs.get('data/users/u2/state/main');
  assert.equal(stored.state.profile.name, 'Local');
  assert.equal(stored.updatedAt, S.get().updatedAt);
});

test('attachDb: errores del db no lanzan', async () => {
  const db = { doc() { throw new Error('boom'); } };
  assert.equal(await S.attachDb(db, 'u3'), false);
});

test('attachDb: si get() falla no activa la sincronización ni sube el local', async () => {
  S.reset(); S.set({ profile: { name: 'L' } });
  let sets = 0;
  const db = { doc: () => ({ get: async () => { throw new Error('red'); }, set: async () => { sets++; } }) };
  assert.equal(await S.attachDb(db, 'u4'), false);
  S.set({ profile: { name: 'L2' } });
  await wait(3300);
  assert.equal(sets, 0);
});

test('attachDb: remoto inválido no se sobrescribe', async () => {
  S.reset(); S.set({ profile: { name: 'L' } });
  let sets = 0;
  const db = { doc: () => ({ get: async () => ({ exists: true, data: () => ({ updatedAt: 1, state: { activities: 'mal' } }) }), set: async () => { sets++; } }) };
  assert.equal(await S.attachDb(db, 'u5'), false);
  assert.equal(sets, 0);
  assert.equal(S.get().profile.name, 'L');
});

test('pushDb: sube sin samples las actividades de más de 14 días', async () => {
  S.reset();
  S.set({ activities: [bigActivity('old', 30, 100), bigActivity('new', 3, 100)] });
  const db = fakeDb();
  await S.attachDb(db, 'u6');
  const st = db.docs.get('data/users/u6/state/main').state;
  const old = st.activities.find((a) => a.id === 'old'), nw = st.activities.find((a) => a.id === 'new');
  assert.equal(old.samples, undefined);
  assert.equal(nw.samples.length, 100);
  assert.equal(S.get().activities[0].samples.length, 100);
});

test('isPersistent: false sin localStorage o si la escritura falla, true si guarda', () => {
  S.reset();
  assert.equal(S.isPersistent(), false, 'sin localStorage');
  const prev = globalThis.localStorage;
  try {
    globalThis.localStorage = fakeStorage();
    S.set({ settings: { botsCount: 3 } }); S.flush();
    assert.equal(S.isPersistent(), true);
    globalThis.localStorage = fakeStorage({ maxLen: 1 });
    S.set({ settings: { botsCount: 4 } }); S.flush();
    assert.equal(S.isPersistent(), false, 'escritura rechazada');
  } finally {
    if (prev === undefined) delete globalThis.localStorage; else globalThis.localStorage = prev;
  }
});
