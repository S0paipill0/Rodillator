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
const ORDER = ['store', 'training', 'physics', 'routes', 'riders', 'scene3d', 'devices', 'integrations',
  'ui/shell', 'ui/onboarding', 'ui/plan', 'ui/routes', 'ui/settings', 'ui/ride', 'ui/stats', 'app'];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rodillator-build-'));
function build(extra) {
  const out = path.join(tmp, 'out-' + Math.random().toString(36).slice(2) + '.html');
  const r = spawnSync('python3', ['build.py', '--out', out].concat(extra || []), { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return { html: fs.readFileSync(out, 'utf8'), stdout: r.stdout };
}
const { html, stdout } = build();

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
  const local = build(['--local-libs', '/tmp/libs-x']).html;
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
