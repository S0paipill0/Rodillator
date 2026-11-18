#!/usr/bin/env python3
"""Ensambla dist/rodillator.html a partir de src/index.template.html (un solo HTML autocontenido)."""
import argparse
import base64
import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SCRIPT_ORDER = [
    'sensors-settings', 'store', 'training', 'physics', 'trainer', 'routes', 'riders', 'vendor/gltfloader', 'cyclist', 'scene3d', 'devices', 'integrations', 'voicepack', 'coach',
    'ui/shell', 'ui/onboarding', 'ui/plan', 'ui/routes', 'ui/sensors-card', 'ui/settings', 'ui/ride', 'ui/stats', 'app',
]
MAX_HTML_BYTES = 14 * 1024 * 1024
# Modelos 3D del ciclista v2 (sin rostro fotografico; versionados en assets/cyclist/):
#   hibrida.glb = el usuario y su fantasma (su bicicleta); ruta.glb = los bots del peloton.
# assets/private/ (modelos antiguos con rostro) sigue fuera de git y solo se usa como respaldo.
CYCLIST_CANDIDATES = [
    os.path.join(ROOT, 'assets', 'cyclist', 'hibrida.glb'),
    os.path.join(ROOT, 'assets', 'private', 'cyclist.opt.glb'),
    os.path.join(ROOT, 'assets', 'private', 'Bernardino_Ciclista.glb'),
]
CYCLIST_BOT_CANDIDATES = [
    os.path.join(ROOT, 'assets', 'cyclist', 'ruta.glb'),
]
THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.149.0/build/three.min.js'
CHART_URL = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def safe_script(text):
    """Evita que el contenido cierre la etiqueta <script> o <style> por accidente."""
    text = re.sub(r'</(script|style)', lambda m: '<\\/' + m.group(1), text, flags=re.I)
    return text.replace('<!--', '<\\!--')


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


def collect_voice():
    """Paquete de voz pregrabado (tools/bake_voice.py) como window.R_VOICE; sin archivo, el coach usa speechSynthesis."""
    path = os.path.join(ROOT, 'data', 'voice', 'es-mx.json')
    if not os.path.isfile(path):
        print('AVISO: falta data/voice/es-mx.json (python3 tools/bake_voice.py); el coach usará la voz del sistema.')
        return ''
    data = json.loads(read(path))
    js = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    print('Paquete de voz: %d clips (%.0f KB)' % (len(data.get('clips', {})), len(js) / 1024))
    return '<script>window.R_VOICE=%s</script>\n' % safe_script(js)


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


def find_glb(explicit, candidates):
    """Ruta del GLB a embeber: la indicada o el primer candidato existente; None si no hay."""
    if explicit is not None:
        return explicit if os.path.isfile(explicit) else None
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None


def find_cyclist(explicit=None):
    return find_glb(explicit, CYCLIST_CANDIDATES)


def embed_glb(path, var, label):
    with open(path, 'rb') as f:
        data = f.read()
    if data[:4] != b'glTF':
        print('AVISO: %s no es un GLB válido; se omite.' % os.path.basename(path))
        return ''
    print('%s: %s (%.0f KB)' % (label, os.path.basename(path), len(data) / 1024))
    return '<script>window.%s="%s"</script>\n' % (var, base64.b64encode(data).decode('ascii'))


def collect_cyclist(explicit=None, explicit_bot=None):
    path = find_cyclist(explicit)
    if not path:
        print('AVISO: no se encontró el modelo del ciclista (assets/cyclist/hibrida.glb); se usan ciclistas procedurales.')
        return ''
    out = embed_glb(path, 'R_CYCLIST_GLB', 'Modelo del ciclista')
    if not out:
        return ''
    # modelo de los bots: el indicado, el de ruta por defecto (solo si el del usuario es el por defecto) o ninguno (usan el del usuario)
    bot = find_glb(explicit_bot, CYCLIST_BOT_CANDIDATES if explicit is None else [])
    if bot:
        out += embed_glb(bot, 'R_CYCLIST_BOT_GLB', 'Modelo de los bots')
    return out


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
    ap.add_argument('--cyclist', help='GLB del ciclista a embeber (por defecto assets/cyclist/hibrida.glb); si no existe, no se embebe nada')
    ap.add_argument('--cyclist-bot', help='GLB de los bots (por defecto assets/cyclist/ruta.glb); sin él, los bots usan el modelo del ciclista')
    ap.add_argument('--local-libs', help='Solo para pruebas: carpeta con three.min.js y chart.umd.min.js (reemplaza las URLs CDN por file://)')
    args = ap.parse_args()

    html = read(os.path.join(ROOT, 'src', 'index.template.html'))
    html = html.replace('<!-- @STYLES -->', collect_css())
    html = html.replace('<!-- @ROUTES -->', collect_routes())
    html = html.replace('<!-- @SCRIPTS -->', collect_cyclist(args.cyclist, args.cyclist_bot) + collect_voice() + collect_scripts())

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
    if size >= MAX_HTML_BYTES:
        print('ERROR: el HTML supera 14 MB', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
