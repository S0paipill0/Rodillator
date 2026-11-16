'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '..', 'data', 'routes');
const CLASSES = ['roca', 'suelo', 'pasto', 'matorral', 'arbol', 'agua', 'nieve', 'urbano'];
const M = 111194.9266;

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  test('landcover ' + file, () => {
    const r = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const lc = r.terrain.landcover;
    assert.ok(lc, 'falta terrain.landcover');
    assert.strictEqual(lc.width, 256);
    assert.strictEqual(lc.height, 256);
    assert.deepStrictEqual(lc.classes, CLASSES);
    const d = Buffer.from(lc.data, 'base64');
    assert.strictEqual(d.length, 256 * 256);
    const present = new Set();
    for (const v of d) { assert.ok(v <= 7); present.add(v); }
    assert.ok(present.size >= 2);
    if (r.id === 'el-yeso' || r.id === 'ch115-laguna-del-maule') assert.ok(present.has(5), r.id + ' sin agua');
    if (['cuesta-la-dormida', 'cuesta-mallarauco', 'ch115-laguna-del-maule'].includes(r.id)) {
      assert.ok(present.has(0) && present.has(1), r.id + ' sin roca/suelo');
    }
    // franja de 15 m: ninguna celda cuyo centro (nodo) esté a <= 15 m del trazado puede ser árbol
    const [x0, y0, x1, y1] = r.terrain.bbox;
    const lat0 = (y0 + y1) / 2, kx = M * Math.cos(lat0 * Math.PI / 180);
    const cx = (x1 - x0) * kx / 255, cy = (y1 - y0) * M / 255;
    for (const [lat, lon] of r.points) {
      const gj = (lon - x0) / (x1 - x0) * 255, gi = (y1 - lat) / (y1 - y0) * 255;
      const j0 = Math.max(0, Math.floor(gj - 15 / cx)), j1 = Math.min(255, Math.ceil(gj + 15 / cx));
      const i0 = Math.max(0, Math.floor(gi - 15 / cy)), i1 = Math.min(255, Math.ceil(gi + 15 / cy));
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const dx = (j - gj) * cx, dy = (i - gi) * cy;
        if (Math.hypot(dx, dy) <= 15) assert.notStrictEqual(d[i * 256 + j], 4, 'árbol en la berma ' + i + ',' + j);
      }
    }
  });
}
