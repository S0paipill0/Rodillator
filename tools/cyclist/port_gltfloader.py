#!/usr/bin/env python3
"""Porta examples/jsm/loaders/GLTFLoader.js (three r149, MIT) a un script clasico que usa window.THREE.

Uso: python3 tools/cyclist/port_gltfloader.py /ruta/a/three/package > src/vendor/gltfloader.js
"""
import re
import sys

pkg = sys.argv[1]
src = open(pkg + '/examples/jsm/loaders/GLTFLoader.js', encoding='utf-8').read()
bgu = open(pkg + '/examples/jsm/utils/BufferGeometryUtils.js', encoding='utf-8').read()

m = re.match(r'import \{([^}]*)\} from \'three\';\s*import \{ toTrianglesDrawMode \} from \'\.\./utils/BufferGeometryUtils\.js\';\s*', src)
assert m, 'cabecera de imports inesperada'
names = [n.strip() for n in m.group(1).split(',') if n.strip()]
body = src[m.end():]
assert body.rstrip().endswith('export { GLTFLoader };')
body = body.rstrip()[:-len('export { GLTFLoader };')]

# toTrianglesDrawMode de BufferGeometryUtils (misma version)
t = re.search(r'\nfunction toTrianglesDrawMode\( geometry, drawMode \) \{.*?\n\}\n', bgu, re.S)
assert t, 'toTrianglesDrawMode no encontrado'

out = []
out.append('''/**
 * GLTFLoader de three.js r149 (examples/jsm/loaders/GLTFLoader.js), portado a script clasico.
 * Incluye toTrianglesDrawMode de examples/jsm/utils/BufferGeometryUtils.js.
 *
 * The MIT License
 * Copyright (c) 2010-2023 three.js authors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
 * following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial
 * portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
 * LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
 * EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
 * IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
 * USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * Generado por tools/cyclist/port_gltfloader.py; registra THREE.GLTFLoader. No editar a mano.
 */
(function (THREE) {
\'use strict\';
if (!THREE || THREE.GLTFLoader) return;
''')
out.append('const {\n\t' + ',\n\t'.join(names) + '\n} = THREE;\n')
out.append(t.group(0))
out.append(body)
out.append('\nTHREE.GLTFLoader = GLTFLoader;\n\n})(typeof window !== \'undefined\' ? window.THREE : undefined);\n')
sys.stdout.write(''.join(out))
