#!/usr/bin/env node
/**
 * Optimiza los modelos v2 del ciclista (Bernardino_Ciclista.glb / Bernardino_Ruta.glb) para la app.
 *
 *   node optimize_v2.mjs entrada.glb salida.glb
 *
 * Los modelos v2 ya traen las ruedas como pivotes (Rueda_Delantera / Rueda_Trasera, origen en el buje),
 * las mallas estaticas fusionadas por material y un esqueleto de piernas con el clip Pedaleo_60rpm.
 * Aqui solo se conserva la jerarquia y se reduce la geometria: simplificacion de las mallas densas sin piel
 * (error maximo absoluto ~1 mm), soldadura, deduplicacion, poda y remuestreo de la animacion.
 */
import fs from 'node:fs';
import { NodeIO, getBounds } from '@gltf-transform/core';
import { dedup, prune, weld, resample, simplifyPrimitive } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

const [IN, OUT] = process.argv.slice(2);
if (!IN || !OUT) { console.error('uso: node optimize_v2.mjs entrada.glb salida.glb'); process.exit(1); }
const SIMPLIFY = { minTriangles: 400, ratio: 0.25, errorM: 0.0012 };

function tris(doc) {
  let t = 0, d = 0;
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
    d++;
    const idx = p.getIndices();
    t += (idx ? idx.getCount() : p.getAttribute('POSITION').getCount()) / 3;
  }
  return { triangles: t, primitives: d };
}

await MeshoptSimplifier.ready;
const io = new NodeIO();
const doc = await io.read(IN);
const before = tris(doc);
await doc.transform(weld());
const root = doc.getRoot();
const skinned = new Set();
for (const n of root.listNodes()) if (n.getSkin() && n.getMesh()) skinned.add(n.getMesh());
let simplified = 0;
for (const mesh of root.listMeshes()) {
  if (skinned.has(mesh)) continue;
  for (const prim of mesh.listPrimitives()) {
    const idx = prim.getIndices();
    const n = (idx ? idx.getCount() : prim.getAttribute('POSITION').getCount()) / 3;
    if (n < SIMPLIFY.minTriangles) continue;
    // error relativo a la extension de la primitiva -> ~errorM metros
    const pos = prim.getAttribute('POSITION');
    const mn = pos.getMin([]), mx = pos.getMax([]);
    const ext = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
    simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio: SIMPLIFY.ratio, error: Math.min(0.05, SIMPLIFY.errorM / ext) });
    simplified++;
  }
}
await doc.transform(prune({ keepAttributes: false }), dedup(), resample());
await io.write(OUT, doc);
const after = tris(doc);
console.log(JSON.stringify({ in: IN, out: OUT, simplified, before, after, bytes: [fs.statSync(IN).size, fs.statSync(OUT).size] }));
