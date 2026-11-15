#!/usr/bin/env node
/**
 * Optimiza el modelo glTF del ciclista para la app (offline; no es dependencia de runtime).
 *
 *   cd tools/cyclist && npm install && npm run optimize
 *   node optimize_cyclist.mjs [entrada.glb] [salida.glb]
 *
 * Por defecto lee assets/private/Bernardino_Ciclista.glb y escribe assets/private/cyclist.opt.glb
 * (ambos ignorados por git: el modelo lleva la foto del rostro del usuario).
 *
 * Pasos: dedup, prune, weld, simplify ligero (solo piezas densas), recorte de la textura del rostro a su
 * zona UV y reduccion a <= 512 px (JPEG), fusion de mallas estaticas por material (cuerpo, rueda trasera
 * y rueda delantera por separado; los nodos animados y sus descendientes no se tocan), resample de la
 * animacion. Las ruedas fusionadas quedan como nodos "Rueda Trasera|Delantera · <material>" con origen en
 * el centro del buje, listos para girar.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { NodeIO, getBounds } from '@gltf-transform/core';
import { dedup, prune, weld, resample, joinPrimitives, transformPrimitive, simplifyPrimitive } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const require = createRequire(import.meta.url);
require(path.join(ROOT, 'src', 'cyclist.js'));
const C = globalThis.R.cyclist;

const IN = path.resolve(process.argv[2] || path.join(ROOT, 'assets', 'private', 'Bernardino_Ciclista.glb'));
const OUT = path.resolve(process.argv[3] || path.join(ROOT, 'assets', 'private', 'cyclist.opt.glb'));

const FACE_TEX = { width: 256, height: 512, quality: 88, marginUv: 0.015 };   // potencia de 2, <= 512 px
// simplify ligero: solo piezas densas, con error maximo absoluto de 1 mm en el mundo (imperceptible a la distancia de camara)
const SIMPLIFY = { minTriangles: 300, ratio: 0.2, errorM: 0.001 };

function stats(doc, bytes) {
  let draws = 0, tris = 0, meshNodes = 0;
  for (const scene of doc.getRoot().listScenes()) {
    scene.traverse((n) => {
      const m = n.getMesh();
      if (!m) return;
      meshNodes++;
      for (const p of m.listPrimitives()) {
        draws++;
        const idx = p.getIndices();
        tris += (idx ? idx.getCount() : p.getAttribute('POSITION').getCount()) / 3;
      }
    });
  }
  const tex = doc.getRoot().listTextures().map((t) => ({ name: t.getName(), mime: t.getMimeType(), size: t.getSize(), bytes: t.getImage().byteLength }));
  return { bytes, meshNodes, drawCalls: draws, triangles: tris, materials: doc.getRoot().listMaterials().length, textures: tex };
}

function cloneAccessors(prim) {
  const c = prim.clone();
  for (const s of c.listSemantics()) c.setAttribute(s, c.getAttribute(s).clone());
  if (c.getIndices()) c.setIndices(c.getIndices().clone());
  return c;
}

function mat4Translate(tx, ty, tz) { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1]; }
function mat4Mul(a, b) {             // column-major: a * b
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

async function main() {
  await MeshoptSimplifier.ready;
  const io = new NodeIO();
  const inBytes = fs.statSync(IN).size;
  const doc = await io.read(IN);
  const before = stats(doc, inBytes);
  const root = doc.getRoot();
  const scene = root.getDefaultScene() || root.listScenes()[0];

  // 1. limpieza basica
  await doc.transform(dedup(), prune({ keepAttributes: false }), weld());

  // 2. simplify ligero: se aplica a cada pieza ya ubicada (paso 4) o, en los nodos animados, con su escala
  let simplified = 0;
  function primTriangles(prim) {
    const idx = prim.getIndices();
    return (idx ? idx.getCount() : prim.getAttribute('POSITION').getCount()) / 3;
  }
  function primExtent(prim, scale) {
    const pos = prim.getAttribute('POSITION');
    const mn = pos.getMin([]), mx = pos.getMax([]);
    return Math.max((mx[0] - mn[0]) * scale, (mx[1] - mn[1]) * scale, (mx[2] - mn[2]) * scale, 1e-6);
  }
  function simplifyLight(prim, scale) {
    if (primTriangles(prim) < SIMPLIFY.minTriangles) return;
    if (prim.getMaterial() && prim.getMaterial().getBaseColorTexture()) return;      // el rostro no se toca
    const error = Math.min(0.01, SIMPLIFY.errorM / primExtent(prim, scale));
    simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio: SIMPLIFY.ratio, error, lockBorder: true });
    simplified++;
  }

  // 3. textura del rostro: recorte a la zona UV usada + reduccion a <= 512 px (JPEG)
  for (const mat of root.listMaterials()) {
    const tex = mat.getBaseColorTexture();
    if (!tex) continue;
    const prims = [];
    for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) if (p.getMaterial() === mat) prims.push(p);
    let u0 = 1, v0 = 1, u1 = 0, v1 = 0;
    const e = [0, 0];
    for (const p of prims) {
      const uv = p.getAttribute('TEXCOORD_0');
      for (let i = 0; i < uv.getCount(); i++) {
        uv.getElement(i, e);
        u0 = Math.min(u0, e[0]); v0 = Math.min(v0, e[1]); u1 = Math.max(u1, e[0]); v1 = Math.max(v1, e[1]);
      }
    }
    u0 = Math.max(0, u0 - FACE_TEX.marginUv); v0 = Math.max(0, v0 - FACE_TEX.marginUv);
    u1 = Math.min(1, u1 + FACE_TEX.marginUv); v1 = Math.min(1, v1 + FACE_TEX.marginUv);
    const [W, H] = tex.getSize();
    const left = Math.floor(u0 * W), top = Math.floor(v0 * H);
    const width = Math.ceil(u1 * W) - left, height = Math.ceil(v1 * H) - top;
    const jpg = await sharp(Buffer.from(tex.getImage()))
      .extract({ left, top, width, height })
      .resize(FACE_TEX.width, FACE_TEX.height, { fit: 'fill', kernel: 'lanczos3' })
      .jpeg({ quality: FACE_TEX.quality, mozjpeg: true })
      .toBuffer();
    tex.setImage(new Uint8Array(jpg)).setMimeType('image/jpeg').setURI('').setName('rostro');
    // reasigna UV al recorte (pixeles exactos del recorte)
    const pu0 = left / W, pv0 = top / H, pu = width / W, pv = height / H;
    const done = new Set();
    for (const p of prims) {
      let uv = p.getAttribute('TEXCOORD_0');
      if (done.has(uv)) continue;
      if (uv.listParents().filter((x) => x.propertyType === 'Primitive').length > 1) { uv = uv.clone(); p.setAttribute('TEXCOORD_0', uv); }
      for (let i = 0; i < uv.getCount(); i++) {
        uv.getElement(i, e);
        uv.setElement(i, [(e[0] - pu0) / pu, (e[1] - pv0) / pv]);
      }
      done.add(uv);
    }
    console.log('Textura %s: %dx%d PNG -> recorte %dx%d -> %dx%d JPEG (%d KB)', mat.getName(), W, H, width, height, FACE_TEX.width, FACE_TEX.height, Math.round(jpg.length / 1024));
  }

  // 4. fusion de mallas estaticas por material (respetando nodos animados y sus descendientes)
  const animated = new Set();
  for (const a of root.listAnimations()) for (const ch of a.listChannels()) if (ch.getTargetNode()) animated.add(ch.getTargetNode());
  function underAnimated(n) { for (let p = n; p; p = p.getParentNode()) if (animated.has(p)) return true; return false; }

  const groups = new Map();       // key -> { side, material, prims: [] }
  const wheelNodes = { rear: [], front: [] };
  const victims = [];
  scene.traverse((n) => {
    if (!n.getMesh() || underAnimated(n) || n.listChildren().length) return;
    const side = C.classifyWheelNode(n.getName(), { x: n.getWorldTranslation()[0], y: n.getWorldTranslation()[1], z: n.getWorldTranslation()[2] });
    if (side) wheelNodes[side].push(n);
    victims.push({ node: n, side });
  });
  const hubs = {};
  for (const side of ['rear', 'front']) {
    if (!wheelNodes[side].length) continue;
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const n of wheelNodes[side]) {
      const b = getBounds(n);
      for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], b.min[k]); mx[k] = Math.max(mx[k], b.max[k]); }
    }
    hubs[side] = { center: [0, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2], radius: (mx[1] - mn[1]) / 2 };
  }
  for (const { node, side } of victims) {
    let m = node.getWorldMatrix();
    if (side) { const h = hubs[side].center; m = mat4Mul(mat4Translate(-h[0], -h[1], -h[2]), m); }
    for (const prim of node.getMesh().listPrimitives()) {
      const key = (side || 'body') + '|' + root.listMaterials().indexOf(prim.getMaterial());
      if (!groups.has(key)) groups.set(key, { side, material: prim.getMaterial(), prims: [] });
      const c = cloneAccessors(prim);
      transformPrimitive(c, m);
      simplifyLight(c, 1);
      groups.get(key).prims.push(c);
    }
  }
  for (const { node } of victims) node.dispose();
  // nodos animados: sus mallas (pueden compartirse entre nodos de distinta escala: se usa la mayor)
  const animScale = new Map();
  for (const n of animated) {
    if (!n.getMesh()) continue;
    const sc = Math.max(...n.getScale().map(Math.abs));
    animScale.set(n.getMesh(), Math.max(animScale.get(n.getMesh()) || 0, sc));
  }
  for (const [mesh, sc] of animScale) for (const prim of mesh.listPrimitives()) simplifyLight(prim, sc);
  const SIDE_NAME = { rear: 'Rueda Trasera', front: 'Rueda Delantera' };
  for (const g of groups.values()) {
    const joined = g.prims.length > 1 ? joinPrimitives(g.prims) : g.prims[0];
    if (g.prims.length > 1) g.prims.forEach((p) => p.dispose());
    const matName = g.material ? g.material.getName() : 'sin material';
    const name = (g.side ? SIDE_NAME[g.side] : 'Cuerpo') + ' · ' + matName;
    const mesh = doc.createMesh(name).addPrimitive(joined);
    const node = doc.createNode(name).setMesh(mesh);
    if (g.side) node.setTranslation(hubs[g.side].center);
    scene.addChild(node);
  }

  // 5. limpieza final y animacion
  await doc.transform(prune({ keepAttributes: false }), dedup(), weld(), resample());

  await io.write(OUT, doc);
  const after = stats(doc, fs.statSync(OUT).size);
  const report = { input: path.relative(ROOT, IN), output: path.relative(ROOT, OUT), simplifiedPrimitives: simplified, hubs, before, after };
  console.log(JSON.stringify(report, null, 2));
  if (after.bytes > 1.2 * 1024 * 1024) console.warn('AVISO: salida sobre 1,2 MB');
  if (after.drawCalls > 40) console.warn('AVISO: mas de 40 draw calls');
}

main().catch((e) => { console.error(e); process.exit(1); });
