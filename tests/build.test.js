const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const THREE = 'https://cdn.jsdelivr.net/npm/three@0.149.0/build/three.min.js';
const CHART = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
const ORDER = ['store', 'training', 'physics', 'routes', 'riders', 'vendor/gltfloader', 'cyclist', 'scene3d', 'devices', 'integrations', 'coach',
  'ui/shell', 'ui/onboarding', 'ui/plan', 'ui/routes', 'ui/settings', 'ui/ride', 'ui/stats', 'app'];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rodillator-build-'));
function build(extra) {
  const out = path.join(tmp, 'out-' + Math.random().toString(36).slice(2) + '.html');
  const r = spawnSync('python3', ['build.py', '--out', out].concat(extra || []), { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return { html: fs.readFileSync(out, 'utf8'), stdout: r.stdout };
}
// la suite no depende del modelo privado: se construye sin GLB (ruta inexistente)
const NO_GLB = ['--cyclist', path.join(tmp, 'no-existe.glb')];
const { html, stdout } = build(NO_GLB);

test('reemplaza todos los marcadores y arma el head', () => {
  assert.doesNotMatch(html, /<!-- @(STYLES|ROUTES|SCRIPTS) -->/);
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<title>Rodillator<\/title>/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /fonts\.googleapis\.com\/css2\?family=Barlow\+Condensed:wght@500;600;700;800&family=Inter:wght@400;500;600/);
  assert.match(stdout, /Generado .*KB/);
});

test('los dos scripts CDN van exactos, síncronos y antes de los módulos', () => {
  for (const url of [THREE, CHART]) {
    assert.equal(html.split(url).length - 1, 1);
    const tag = html.match(new RegExp('<script[^>]*' + url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^>]*>'))[0];
    assert.doesNotMatch(tag, /\b(defer|async)\b/);
    assert.ok(html.indexOf(url) < html.indexOf('/* @file src/store.js */'));
  }
});

test('orden exacto de scripts (omitiendo archivos inexistentes)', () => {
  const found = [...html.matchAll(/\/\* @file src\/(.+?)\.js \*\//g)].map((m) => m[1]);
  const expected = ORDER.filter((n) => fs.existsSync(path.join(ROOT, 'src', n + '.js')));
  assert.deepEqual(found, expected);
  assert.ok(found.indexOf('ui/shell') < found.indexOf('app'));
});

test('R_ROUTES se inicializa antes de los push y todo script es JS válido', () => {
  const init = html.indexOf('window.R_ROUTES=[]');
  assert.ok(init > 0);
  const firstPush = html.indexOf('R_ROUTES.push(');
  if (firstPush >= 0) assert.ok(init < firstPush);
  assert.ok(init < html.indexOf('/* @file src/store.js */'));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= ORDER.length - 2);
  scripts.forEach((code, i) => { assert.doesNotThrow(() => new vm.Script(code, { filename: 'script-' + i }), 'script ' + i); });
});

test('estilos: styles.css va primero', () => {
  const css = [...html.matchAll(/\/\* @file (src\/[^*]+\.css) \*\//g)].map((m) => m[1]);
  assert.equal(css[0], 'src/styles.css');
});

test('sin patrones prohibidos por el sandbox', () => {
  assert.doesNotMatch(html, /fetch\(\s*['"`]https?:/i);
  assert.doesNotMatch(html, /<a\b[^>]*\bdownload\b/i);
  assert.doesNotMatch(html, /(?<![.\w$])(alert|confirm|prompt)\s*\(/);
  assert.doesNotMatch(html, /window\.open\s*\(/);
  assert.doesNotMatch(html, /\bnew (XMLHttpRequest|WebSocket)\b/);
  assert.doesNotMatch(html, /<img[^>]+src=["']https?:/i);
});

test('--local-libs solo cambia las URLs de las librerías', () => {
  const local = build(['--local-libs', '/tmp/libs-x'].concat(NO_GLB)).html;
  assert.ok(local.includes('file:///tmp/libs-x/three.min.js'));
  assert.ok(local.includes('file:///tmp/libs-x/chart.umd.min.js'));
  assert.ok(!local.includes(THREE) && !local.includes(CHART));
});

test('safe_script escapa </script y <!-- en JS/JSON embebido', () => {
  const r = spawnSync('python3', ['-c', "import build; print(build.safe_script('a</script>b<!--c</STYLE>'))"], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim();
  assert.ok(!out.includes('<!--') && !/<\/script/i.test(out) && !/<\/style/i.test(out), out);
  assert.ok(out.includes('<\\!--'));
});

test('modelo del ciclista: sin GLB no embebe nada y avisa', () => {
  assert.ok(!html.includes('window.R_CYCLIST_GLB="'));
  assert.match(stdout, /AVISO: no se encontró el modelo del ciclista/);
});

test('modelo del ciclista: con GLB lo embebe en base64 antes de los módulos', () => {
  const fake = Buffer.concat([Buffer.from('glTF'), Buffer.from([2, 0, 0, 0]), Buffer.from('cuerpo de prueba <script></script>')]);
  const f = path.join(tmp, 'fake.glb');
  fs.writeFileSync(f, fake);
  const { html: h, stdout: out } = build(['--cyclist', f]);
  const m = h.match(/<script>window\.R_CYCLIST_GLB="([A-Za-z0-9+/=]+)"<\/script>/);
  assert.ok(m, 'script con el base64');
  assert.deepEqual(Buffer.from(m[1], 'base64'), fake);
  assert.ok(h.indexOf('window.R_CYCLIST_GLB="') < h.indexOf('/* @file src/store.js */'));
  assert.ok(h.indexOf('window.R_CYCLIST_GLB="') > h.indexOf('window.R_ROUTES=[]'));
  assert.match(out, /Modelo del ciclista: fake\.glb/);
});

test('modelo del ciclista: un archivo que no es GLB no se embebe', () => {
  const f = path.join(tmp, 'malo.glb');
  fs.writeFileSync(f, 'no soy un glb');
  const { html: h } = build(['--cyclist', f]);
  assert.ok(!h.includes('window.R_CYCLIST_GLB="'));
});

test('GLTFLoader portado: script clásico que registra THREE.GLTFLoader, con licencia MIT', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'vendor', 'gltfloader.js'), 'utf8');
  assert.match(src, /The MIT License/);
  assert.doesNotMatch(src, /^\s*(import|export)\b/m);
  assert.match(src, /THREE\.GLTFLoader = GLTFLoader;/);
  vm.runInNewContext(src, { window: {} });            // sin THREE: no lanza ni registra nada
  // THREE simulado: cualquier clase pedida existe; el script debe registrar GLTFLoader
  const backing = {};
  const THREE = new Proxy(backing, { get: (o, k) => (k in o ? o[k] : (k === 'GLTFLoader' ? undefined : class {})), set: (o, k, v) => { o[k] = v; return true; }, has: () => true });
  vm.runInNewContext(src, { window: { THREE } });
  assert.equal(typeof backing.GLTFLoader, 'function');
});

test('privacidad: ningún GLB ni asset privado está versionado', () => {
  const r = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return;                        // fuera de un repositorio git
  const files = r.stdout.split('\n').filter(Boolean);
  assert.deepEqual(files.filter((f) => /\.glb$/i.test(f)), []);
  assert.deepEqual(files.filter((f) => /^assets\/private\//.test(f)), []);
  assert.deepEqual(files.filter((f) => /\.(glb|gltf)$|cyclist\.opt/i.test(f)), []);
  const ig = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(ig, /^assets\/private\/$/m);
});

test('privacidad: src/ no contiene el modelo embebido', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(path.join(ROOT, 'src'))) {
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(!/Z2xURg/.test(t), 'base64 de un GLB en ' + f);          // "glTF" en base64
    assert.ok(!/R_CYCLIST_GLB\s*=\s*["']/.test(t), 'asignación del modelo en ' + f);
  }
});
