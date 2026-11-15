#!/usr/bin/env python3
"""Ensambla dist/rodillator.html a partir de src/index.template.html (un solo HTML autocontenido)."""
import argparse
import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SCRIPT_ORDER = [
    'store', 'training', 'physics', 'routes', 'riders', 'scene3d', 'devices', 'integrations',
    'ui/shell', 'ui/onboarding', 'ui/plan', 'ui/routes', 'ui/settings', 'ui/ride', 'ui/stats', 'app',
]
THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.149.0/build/three.min.js'
CHART_URL = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def safe_script(text):
    """Evita que el contenido cierre la etiqueta <script> o <style> por accidente."""
    return re.sub(r'</(script|style)', lambda m: '<\\/' + m.group(1), text, flags=re.I)


def collect_css():
    files = sorted(glob.glob(os.path.join(ROOT, 'src', '**', '*.css'), recursive=True))
    first = os.path.join(ROOT, 'src', 'styles.css')
    files = [f for f in files if f != first]
    files.insert(0, first)
    return '\n'.join('/* @file %s */\n%s' % (os.path.relpath(f, ROOT).replace(os.sep, '/'), read(f)) for f in files if os.path.exists(f))


def collect_routes():
    parts = ['<script>window.R_ROUTES=[]</script>']
    for f in sorted(glob.glob(os.path.join(ROOT, 'data', 'routes', '*.json'))):
        data = json.loads(read(f))
        js = json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
        parts.append('<script>R_ROUTES.push(%s)</script>' % safe_script(js))
    return '\n'.join(parts)


def collect_scripts():
    parts = []
    for name in SCRIPT_ORDER:
        rel = 'src/%s.js' % name
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            print('AVISO: falta %s; se omite.' % rel)
            continue
        parts.append('<script>\n/* @file %s */\n%s\n</script>' % (rel, safe_script(read(path))))
    return '\n'.join(parts)


FORBIDDEN = [
    (re.compile(r'fetch\(\s*[\'"`]https?:', re.I), 'fetch() hacia un host externo'),
    (re.compile(r'<a\b[^>]*\bdownload\b', re.I), '<a download>'),
    (re.compile(r'(?<![.\w$])(alert|confirm|prompt)\s*\('), 'alert/confirm/prompt'),
    (re.compile(r'window\.open\s*\('), 'window.open'),
]


def validate(html):
    problems = []
    for rx, label in FORBIDDEN:
        m = rx.search(html)
        if m:
            line = html.count('\n', 0, m.start()) + 1
            problems.append('%s (línea %d del HTML)' % (label, line))
    for marker in ('<!-- @STYLES -->', '<!-- @ROUTES -->', '<!-- @SCRIPTS -->'):
        if marker in html:
            problems.append('marcador sin reemplazar: ' + marker)
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(ROOT, 'dist', 'rodillator.html'))
    ap.add_argument('--local-libs', help='Solo para pruebas: carpeta con three.min.js y chart.umd.min.js (reemplaza las URLs CDN por file://)')
    args = ap.parse_args()

    html = read(os.path.join(ROOT, 'src', 'index.template.html'))
    html = html.replace('<!-- @STYLES -->', collect_css())
    html = html.replace('<!-- @ROUTES -->', collect_routes())
    html = html.replace('<!-- @SCRIPTS -->', collect_scripts())

    problems = validate(html)
    if problems:
        for p in problems:
            print('ERROR: ' + p, file=sys.stderr)
        sys.exit(1)

    if args.local_libs:
        d = os.path.abspath(args.local_libs)
        html = html.replace(THREE_URL, 'file://' + d + '/three.min.js').replace(CHART_URL, 'file://' + d + '/chart.umd.min.js')

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as f:
        f.write(html)
    size = os.path.getsize(args.out)
    print('Generado %s (%.1f KB, %.2f MB)' % (os.path.relpath(args.out, ROOT), size / 1024, size / 1048576))


if __name__ == '__main__':
    main()
