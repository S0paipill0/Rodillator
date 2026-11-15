/*
 * Rodillator - Escena 3D (R.Scene3D)
 * Paisaje (terreno DEM + textura satelital), camino, ciclistas y camaras.
 * Requiere three.js r149 global (window.THREE). Sin assets externos.
 *
 * Convencion de proyeccion (compartida con routes.js): equirectangular,
 *   x = este en metros, z = -norte en metros, y = elevacion (m) menos la base,
 *   origen = centro de route.terrain.bbox si existe; si no, centro del bbox de los puntos.
 * Marco local de cada ciclista: +x adelante, +y arriba, +z a la derecha.
 */
(function (R) {
  'use strict';

  var G = typeof window !== 'undefined' ? window : globalThis;

  var EARTH_R = 6371000;            // m, radio medio
  var DEG = Math.PI / 180;
  var ROAD_WIDTH = 6;               // m
  var ROAD_LIFT = 0.4;              // m sobre el terreno (evita z-fighting)
  var LANE_SPACING = 1.1;           // m entre ciclistas que comparten distM
  var LANE_HALF = 2.4;              // m maximo desde el eje (camino de 6 m)
  var CLUSTER_M = 2.5;              // m: ciclistas mas cerca que esto se reparten en el carril
  var KIND_COLORS = { user: 0xFF5A1F, ghost: 0xFFD23F, bot: 0x7FA7C9 };
  var CAMERA_MODES = ['persecucion', 'aerea', 'lateral'];
  var QUALITIES = ['auto', 'alta', 'media', 'baja'];

  /* ------------------------------------------------------------------ */
  /* Funciones puras (sin THREE): se prueban en Node                     */
  /* ------------------------------------------------------------------ */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function base64ToBytes(b64) {
    var out, i, n;
    if (typeof atob === 'function') {
      var bin = atob(b64);
      n = bin.length;
      out = new Uint8Array(n);
      for (i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
    throw new Error('Scene3D: no hay decodificador base64');
  }

  /** base64 de Uint16 little-endian (fila 0 = norte) -> Float32Array de elevaciones en metros. */
  function decodeHeights(b64, width, height, minEle, maxEle) {
    var bytes = base64ToBytes(b64);
    var n = width * height;
    if (bytes.length !== n * 2) {
      throw new Error('Scene3D: heights tiene ' + bytes.length + ' bytes, se esperaban ' + (n * 2));
    }
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var out = new Float32Array(n);
    var span = maxEle - minEle;
    for (var i = 0; i < n; i++) out[i] = minEle + (dv.getUint16(i * 2, true) / 65535) * span;
    return out;
  }

  /** Proyeccion equirectangular local: x = este (m), z = -norte (m). */
  function projectPoint(lat, lon, originLat, originLon) {
    var k = DEG * EARTH_R;
    return {
      x: (lon - originLon) * k * Math.cos(originLat * DEG),
      z: -(lat - originLat) * k
    };
  }

  function originOf(route) {
    var t = route.terrain, bb = t && t.bbox;
    if (bb) return { lat: (bb[1] + bb[3]) / 2, lon: (bb[0] + bb[2]) / 2 };
    var p = route.points, minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (var i = 0; i < p.length; i++) {
      if (p[i][0] < minLat) minLat = p[i][0];
      if (p[i][0] > maxLat) maxLat = p[i][0];
      if (p[i][1] < minLon) minLon = p[i][1];
      if (p[i][1] > maxLon) maxLon = p[i][1];
    }
    return { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
  }

  /** Interpola points [[lat,lon,ele,distM],...] en distM (acotado a [0, total]). */
  function sampleRoute(points, distM) {
    var n = points.length;
    if (!n) return null;
    if (n === 1) return { lat: points[0][0], lon: points[0][1], ele: points[0][2], distM: points[0][3], index: 0 };
    var d = clamp(distM, points[0][3], points[n - 1][3]);
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (points[mid][3] <= d) lo = mid; else hi = mid;
    }
    var a = points[lo], b = points[hi];
    var span = b[3] - a[3];
    var t = span > 0 ? (d - a[3]) / span : 0;
    return {
      lat: a[0] + (b[0] - a[0]) * t,
      lon: a[1] + (b[1] - a[1]) * t,
      ele: a[2] + (b[2] - a[2]) * t,
      distM: d,
      index: lo
    };
  }

  /** Desplazamiento lateral (m, + = derecha) del ciclista `index` de `count` que comparten distM. */
  function laneOffset(index, count) {
    if (count <= 1) return 0;
    var spacing = Math.min(LANE_SPACING, (2 * LANE_HALF) / (count - 1));
    return (index - (count - 1) / 2) * spacing;
  }

  function srgbToLinear(c) { return Math.pow(c, 2.2); }

  var ELE_STOPS = (function () {
    // [elevacion m, hex sRGB]: verde valle -> cafe -> gris roca -> nieve (> 3000 m)
    var raw = [[0, 0x4a7c3a], [900, 0x5c8b3e], [1600, 0x8a6d46], [2300, 0x7a7774], [2900, 0x8a8885], [3000, 0xf1f4f8]];
    return raw.map(function (s) {
      return [s[0], srgbToLinear(((s[1] >> 16) & 255) / 255), srgbToLinear(((s[1] >> 8) & 255) / 255), srgbToLinear((s[1] & 255) / 255)];
    });
  })();

  /** Escribe en out[o..o+2] el color (lineal) por altura; noise en [-0.5, 0.5]. */
  function elevationColor(ele, noise, out, o) {
    var s = ELE_STOPS, i = 0;
    while (i < s.length - 2 && ele > s[i + 1][0]) i++;
    var a = s[i], b = s[i + 1];
    var t = clamp((ele - a[0]) / (b[0] - a[0]), 0, 1);
    var f = 1 + noise * 0.3;
    out[o] = (a[1] + (b[1] - a[1]) * t) * f;
    out[o + 1] = (a[2] + (b[2] - a[2]) * t) * f;
    out[o + 2] = (a[3] + (b[3] - a[3]) * t) * f;
    return out;
  }

  function baseElevation(route) {
    var t = route.terrain;
    if (t && t.heights && t.bbox) return t.minEle;
    var m = Infinity;
    for (var i = 0; i < route.points.length; i++) if (route.points[i][2] < m) m = route.points[i][2];
    return m;
  }

  /**
   * Grilla de alturas en coordenadas de mundo. Con route.terrain usa el DEM (fila 0 = norte);
   * sin terreno genera un plano ondulado que sigue la elevacion de la ruta (IDW de sus puntos).
   * data[] ya esta en metros de mundo (elevacion - base) * verticalScale.
   */
  function makeHeightGrid(route, origin, verticalScale) {
    var vs = verticalScale > 0 ? verticalScale : 1;
    var base = baseElevation(route);
    var t = route.terrain, i, j;
    if (t && t.heights && t.bbox) {
      var elev = decodeHeights(t.heights, t.width, t.height, t.minEle, t.maxEle);
      var nw = projectPoint(t.bbox[3], t.bbox[0], origin.lat, origin.lon);
      var se = projectPoint(t.bbox[1], t.bbox[2], origin.lat, origin.lon);
      var data = new Float32Array(elev.length);
      for (i = 0; i < elev.length; i++) data[i] = (elev[i] - base) * vs;
      return { w: t.width, h: t.height, x0: nw.x, z0: nw.z, x1: se.x, z1: se.z, data: data, base: base, vs: vs, real: true };
    }
    var P = route.points, step = Math.max(1, Math.ceil(P.length / 600));
    var sx = [], sz = [], sy = [], minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (i = 0; i < P.length; i += step) {
      var q = projectPoint(P[i][0], P[i][1], origin.lat, origin.lon);
      sx.push(q.x); sz.push(q.z); sy.push((P[i][2] - base) * vs);
      if (q.x < minX) minX = q.x;
      if (q.x > maxX) maxX = q.x;
      if (q.z < minZ) minZ = q.z;
      if (q.z > maxZ) maxZ = q.z;
    }
    var pad = Math.max(2500, 0.35 * Math.max(maxX - minX, maxZ - minZ));
    var W = 129, H = 129;
    var gx0 = minX - pad, gx1 = maxX + pad, gz0 = minZ - pad, gz1 = maxZ + pad;
    var out = new Float32Array(W * H);
    var eps = 40 * 40;
    for (j = 0; j < H; j++) {
      var z = gz0 + (gz1 - gz0) * j / (H - 1);
      for (i = 0; i < W; i++) {
        var x = gx0 + (gx1 - gx0) * i / (W - 1);
        var num = 0, den = 0, dmin = Infinity;
        for (var k = 0; k < sx.length; k++) {
          var dx = x - sx[k], dz = z - sz[k], dd = dx * dx + dz * dz;
          if (dd < dmin) dmin = dd;
          var w = 1 / (dd + eps);
          num += sy[k] * w; den += w;
        }
        var tt = clamp((Math.sqrt(dmin) - 150) / 750, 0, 1), sm = tt * tt * (3 - 2 * tt);
        var wave = Math.sin(x * 0.0041) * Math.cos(z * 0.0033) * 45 + Math.sin(x * 0.011 + z * 0.007) * 12;
        out[j * W + i] = num / den + wave * sm * vs;
      }
    }
    return { w: W, h: H, x0: gx0, z0: gz0, x1: gx1, z1: gz1, data: out, base: base, vs: vs, real: false };
  }

  /** Altura (y de mundo) del terreno en (x, z), bilineal; acotada a la grilla. */
  function gridHeight(grid, x, z) {
    var w = grid.w, h = grid.h;
    var fx = clamp((x - grid.x0) / (grid.x1 - grid.x0), 0, 1) * (w - 1);
    var fz = clamp((z - grid.z0) / (grid.z1 - grid.z0), 0, 1) * (h - 1);
    var i = Math.min(Math.floor(fx), w - 2), j = Math.min(Math.floor(fz), h - 2);
    var tx = fx - i, tz = fz - j, d = grid.data, o = j * w + i;
    var a = d[o] + (d[o + 1] - d[o]) * tx;
    var b = d[o + w] + (d[o + w + 1] - d[o + w]) * tx;
    return a + (b - a) * tz;
  }

  /** Camino proyectado sobre el terreno: arreglos D (distM), X, Z, Y (eje del camino, ya con +ROAD_LIFT). */
  function buildRoadPath(route, origin, grid) {
    var P = route.points, n = P.length;
    var D = new Float64Array(n), X = new Float64Array(n), Z = new Float64Array(n), Y = new Float64Array(n);
    var raw = new Float64Array(n), i, j;
    for (i = 0; i < n; i++) {
      var q = projectPoint(P[i][0], P[i][1], origin.lat, origin.lon);
      D[i] = P[i][3]; X[i] = q.x; Z[i] = q.z;
      raw[i] = gridHeight(grid, q.x, q.z);       // el camino siempre abraza la superficie del terreno
    }
    for (i = 0; i < n; i++) {           // media movil de 5 puntos (quita ruido del DEM)
      var s = 0, c = 0;
      for (j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) { s += raw[j]; c++; }
      var sm = s / c;
      Y[i] = Math.max(sm, raw[i] - 0.25) + ROAD_LIFT;
    }
    return { n: n, D: D, X: X, Z: Z, Y: Y };
  }

  /** Posicion sobre el camino a distM -> out {x,y,z,i}. Sin allocations. */
  function pathAt(path, distM, out) {
    var n = path.n, D = path.D;
    if (n === 1) { out.x = path.X[0]; out.y = path.Y[0]; out.z = path.Z[0]; out.i = 0; return out; }
    var d = clamp(distM, D[0], D[n - 1]);
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (D[mid] <= d) lo = mid; else hi = mid;
    }
    var span = D[hi] - D[lo], t = span > 0 ? (d - D[lo]) / span : 0;
    out.x = path.X[lo] + (path.X[hi] - path.X[lo]) * t;
    out.y = path.Y[lo] + (path.Y[hi] - path.Y[lo]) * t;
    out.z = path.Z[lo] + (path.Z[hi] - path.Z[lo]) * t;
    out.i = lo;
    return out;
  }

  var _pa = { x: 0, y: 0, z: 0, i: 0 }, _pb = { x: 0, y: 0, z: 0, i: 0 };

  /** Posicion + rumbo (hx,hz horizontal unitario) + tangente 3D unitaria (tx,ty,tz) a distM. */
  function pathPose(path, distM, out) {
    pathAt(path, distM, out);
    pathAt(path, distM - 5, _pa);
    pathAt(path, distM + 5, _pb);
    var dx = _pb.x - _pa.x, dy = _pb.y - _pa.y, dz = _pb.z - _pa.z;
    var hl = Math.sqrt(dx * dx + dz * dz);
    if (hl < 1e-6) { out.hx = 1; out.hz = 0; out.tx = 1; out.ty = 0; out.tz = 0; return out; }
    out.hx = dx / hl; out.hz = dz / hl;
    var tl = Math.sqrt(dx * dx + dy * dy + dz * dz);
    out.tx = dx / tl; out.ty = dy / tl; out.tz = dz / tl;
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Soporte WebGL                                                       */
  /* ------------------------------------------------------------------ */

  var _supported = false;
  function isSupported() {
    if (_supported) return true;
    try {
      if (typeof document === 'undefined' || !G.THREE) return false;
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return false;
      var ext = gl.getExtension && gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
      _supported = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Escena                                                              */
  /* ------------------------------------------------------------------ */

  function create(container, route, opts) {
    if (!isSupported()) throw new Error('Scene3D: WebGL o THREE no disponible');
    if (!route || !route.points || route.points.length < 2) throw new Error('Scene3D: la ruta necesita al menos 2 puntos');
    opts = opts || {};
    var T = G.THREE;
    var quality = QUALITIES.indexOf(opts.quality) >= 0 ? opts.quality : 'auto';
    var vScale = opts.verticalScale > 0 ? opts.verticalScale : 1;
    var shadowsOn = quality === 'auto' || quality === 'alta';
    var disposed = false, contextLost = false;
    var own = [];                                   // geometrias / materiales / texturas propios
    function track(x) { own.push(x); return x; }
    function lin(hex) { return new T.Color(hex).convertSRGBToLinear(); }
    function newCanvas(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
    function canvasTex(canvas) {
      var t = track(new T.CanvasTexture(canvas));
      t.encoding = T.sRGBEncoding;
      return t;
    }

    /* ---- datos ---- */
    var origin = originOf(route);
    var grid = makeHeightGrid(route, origin, vScale);
    var path = buildRoadPath(route, origin, grid);
    var totalDist = path.D[path.n - 1];

    /* ---- renderer / escena / camara ---- */
    var dpr = G.devicePixelRatio || 1;
    var pixelRatio = quality === 'baja' ? 1 : (quality === 'media' ? Math.min(dpr, 1.5) : Math.min(dpr, 2));
    var renderer = new T.WebGLRenderer({ antialias: quality !== 'baja', powerPreference: 'high-performance' });
    renderer.outputEncoding = T.sRGBEncoding;
    renderer.shadowMap.enabled = shadowsOn;
    if (shadowsOn) renderer.shadowMap.type = T.PCFSoftShadowMap;
    var canvasEl = renderer.domElement;
    canvasEl.style.width = '100%';
    canvasEl.style.height = '100%';
    canvasEl.style.display = 'block';
    container.appendChild(canvasEl);

    var scene = new T.Scene();
    var camera = new T.PerspectiveCamera(58, 16 / 9, 0.5, 30000);

    /* ---- cielo, niebla, luces ---- */
    var HORIZON = 0xcfe3f2, ZENITH = 0x3f7fc4;
    var minHalf = Math.min(grid.x1 - grid.x0, grid.z1 - grid.z0) / 2;
    scene.fog = new T.FogExp2(lin(HORIZON), 2.3 / Math.max(1500, minHalf * 0.9));
    var skyMat = track(new T.ShaderMaterial({
      uniforms: { top: { value: new T.Color(ZENITH) }, horizon: { value: new T.Color(HORIZON) } },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 horizon; varying vec3 vDir; void main(){ float h = clamp(vDir.y, 0.0, 1.0); gl_FragColor = vec4(mix(horizon, top, pow(h, 0.55)), 1.0); }',
      side: T.BackSide, depthWrite: false, fog: false
    }));
    var sky = new T.Mesh(track(new T.SphereGeometry(20000, 24, 12)), skyMat);
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    scene.add(sky);

    scene.add(new T.HemisphereLight(lin(0xbcd8ff), lin(0x6b6650), 0.8));
    var sun = new T.DirectionalLight(lin(0xfff1d6), 1.1);
    var SUN_DIR = new T.Vector3(0.5, 0.8, 0.35).normalize();
    scene.add(sun);
    scene.add(sun.target);
    sun.position.copy(SUN_DIR).multiplyScalar(250);
    if (shadowsOn) {
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      var sc = sun.shadow.camera;
      sc.left = -60; sc.right = 60; sc.top = 60; sc.bottom = -60; sc.near = 10; sc.far = 700;
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.3;
    }

    /* ---- terreno ---- */
    var hasTexture = !!(route.terrain && route.terrain.texture && grid.real);
    var terrainMat = track(new T.MeshLambertMaterial(hasTexture ? { color: lin(0x6b7a52) } : { vertexColors: true }));
    (function buildTerrain() {
      var stride = quality === 'baja' && grid.w > 128 ? 2 : 1;
      var cols = [], rows = [], c, r;
      for (c = 0; c < grid.w; c += stride) cols.push(c);
      if (cols[cols.length - 1] !== grid.w - 1) cols.push(grid.w - 1);
      for (r = 0; r < grid.h; r += stride) rows.push(r);
      if (rows[rows.length - 1] !== grid.h - 1) rows.push(grid.h - 1);
      var nc = cols.length, nr = rows.length, nv = nc * nr;
      var pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
      var col = hasTexture ? null : new Float32Array(nv * 3);
      var v = 0;
      for (var rr = 0; rr < nr; rr++) {
        var gr = rows[rr];
        for (var cc = 0; cc < nc; cc++, v++) {
          var gc = cols[cc];
          var y = grid.data[gr * grid.w + gc];
          pos[v * 3] = grid.x0 + (grid.x1 - grid.x0) * gc / (grid.w - 1);
          pos[v * 3 + 1] = y;
          pos[v * 3 + 2] = grid.z0 + (grid.z1 - grid.z0) * gr / (grid.h - 1);
          uv[v * 2] = gc / (grid.w - 1);
          uv[v * 2 + 1] = 1 - gr / (grid.h - 1);
          if (col) {
            var nz = Math.sin(gc * 12.9898 + gr * 78.233) * 43758.5453;
            elevationColor(y / grid.vs + grid.base, (nz - Math.floor(nz)) - 0.5, col, v * 3);
          }
        }
      }
      var idx = new (nv > 65535 ? Uint32Array : Uint16Array)((nc - 1) * (nr - 1) * 6), k = 0;
      for (var a = 0; a < nr - 1; a++) {
        for (var b = 0; b < nc - 1; b++) {
          var i0 = a * nc + b, i1 = i0 + nc, i2 = i0 + 1, i3 = i1 + 1;
          idx[k++] = i0; idx[k++] = i1; idx[k++] = i2;
          idx[k++] = i2; idx[k++] = i1; idx[k++] = i3;
        }
      }
      var g = track(new T.BufferGeometry());
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      g.setAttribute('uv', new T.BufferAttribute(uv, 2));
      if (col) g.setAttribute('color', new T.BufferAttribute(col, 3));
      g.setIndex(new T.BufferAttribute(idx, 1));
      g.computeVertexNormals();
      g.computeBoundingSphere();
      var mesh = new T.Mesh(g, terrainMat);
      mesh.receiveShadow = shadowsOn;
      scene.add(mesh);
    })();

    if (hasTexture) {
      var img = new Image();
      img.onload = function () {
        if (disposed) return;
        var tex = track(new T.Texture(img));
        tex.encoding = T.sRGBEncoding;
        tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        tex.needsUpdate = true;
        terrainMat.map = tex;
        terrainMat.color.set(0xffffff);
        terrainMat.needsUpdate = true;
      };
      img.src = route.terrain.texture;
    }

    /* ---- camino ---- */
    var roadTex = (function () {
      var c = newCanvas(64, 128), x = c.getContext('2d'), i;
      x.fillStyle = '#3d4045'; x.fillRect(0, 0, 64, 128);
      for (i = 0; i < 900; i++) {
        var s = Math.round(Math.random() * 40 + 44);
        x.fillStyle = 'rgba(' + s + ',' + s + ',' + (s + 4) + ',0.35)';
        x.fillRect(Math.random() * 64, Math.random() * 128, 1, 1);
      }
      x.fillStyle = 'rgba(235,235,235,0.7)';
      x.fillRect(2, 0, 1, 128); x.fillRect(61, 0, 1, 128);       // bordes
      x.fillStyle = '#f4f4f4';
      x.fillRect(31, 0, 2, 43);                                   // linea central discontinua (4 m de 12 m)
      var t = canvasTex(c);
      t.wrapT = T.RepeatWrapping;
      t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      return t;
    })();
    (function buildRoad() {
      var n = path.n, pos = new Float32Array(n * 6), uv = new Float32Array(n * 4);
      var idx = new (n * 2 > 65535 ? Uint32Array : Uint16Array)((n - 1) * 6);
      var hw = ROAD_WIDTH / 2, i;
      for (i = 0; i < n; i++) {
        var a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
        var dx = path.X[b] - path.X[a], dz = path.Z[b] - path.Z[a];
        var l = Math.sqrt(dx * dx + dz * dz) || 1;
        var rx = -dz / l, rz = dx / l;                              // derecha del rumbo
        var lx = path.X[i] - rx * hw, lz = path.Z[i] - rz * hw;
        var qx = path.X[i] + rx * hw, qz = path.Z[i] + rz * hw;
        // si el DEM sube hacia el borde, el borde sube para no enterrarse
        pos[i * 6] = lx; pos[i * 6 + 1] = Math.max(path.Y[i], gridHeight(grid, lx, lz) + 0.2); pos[i * 6 + 2] = lz;
        pos[i * 6 + 3] = qx; pos[i * 6 + 4] = Math.max(path.Y[i], gridHeight(grid, qx, qz) + 0.2); pos[i * 6 + 5] = qz;
        uv[i * 4] = 0; uv[i * 4 + 1] = path.D[i] / 12;
        uv[i * 4 + 2] = 1; uv[i * 4 + 3] = path.D[i] / 12;
      }
      for (i = 0; i < n - 1; i++) {
        var l0 = i * 2, r0 = l0 + 1, l1 = l0 + 2, r1 = l0 + 3, k = i * 6;
        idx[k] = l0; idx[k + 1] = r0; idx[k + 2] = l1;
        idx[k + 3] = r0; idx[k + 4] = r1; idx[k + 5] = l1;
      }
      var g = track(new T.BufferGeometry());
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      g.setAttribute('uv', new T.BufferAttribute(uv, 2));
      g.setIndex(new T.BufferAttribute(idx, 1));
      g.computeVertexNormals();
      g.computeBoundingSphere();
      var m = track(new T.MeshLambertMaterial({ map: roadTex, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      var mesh = new T.Mesh(g, m);
      mesh.receiveShadow = shadowsOn;
      scene.add(mesh);
    })();

    /* ---- marcadores: arcos de salida/meta y postes de km ---- */
    var _pose = { x: 0, y: 0, z: 0, i: 0, hx: 1, hz: 0, tx: 1, ty: 0, tz: 0 };
    // Grupo orientado: +x = rumbo, +z = derecha
    function orientedGroup(distM, rightOffset) {
      pathPose(path, distM, _pose);
      var g = new T.Group();
      g.position.set(_pose.x - _pose.hz * rightOffset, _pose.y, _pose.z + _pose.hx * rightOffset);
      g.rotation.y = Math.atan2(-_pose.hz, _pose.hx);
      scene.add(g);
      return g;
    }
    function textTexture(w, h, draw) {
      var c = newCanvas(w, h);
      draw(c.getContext('2d'), w, h);
      return canvasTex(c);
    }
    var FONT = '"Barlow Condensed", "Arial Narrow", Arial, sans-serif';
    var postMat = track(new T.MeshLambertMaterial({ color: lin(0x9aa0a8) }));
    var postGeo = track(new T.BoxGeometry(0.14, 1, 0.14));
    var signGeo = track(new T.PlaneGeometry(0.95, 0.6));
    var bannerGeo = track(new T.PlaneGeometry(ROAD_WIDTH + 1.6, 1.3));

    function makeArch(text, distM) {
      var g = orientedGroup(distM, 0);
      var tex = textTexture(1024, 200, function (x, w, h) {
        x.fillStyle = '#15181d'; x.fillRect(0, 0, w, h);
        x.fillStyle = '#FF5A1F'; x.fillRect(0, 0, w, 14); x.fillRect(0, h - 14, w, 14);
        x.fillStyle = '#ffffff'; x.font = '700 150px ' + FONT; x.textAlign = 'center'; x.textBaseline = 'middle';
        x.fillText(text, w / 2, h / 2 + 6);
      });
      var bm = track(new T.MeshBasicMaterial({ map: tex, side: T.DoubleSide, fog: false }));
      var banner = new T.Mesh(bannerGeo, bm);
      banner.position.set(0, 10, 0);                                  // por encima de la cámara de persecución (~5 m)
      banner.rotation.y = -Math.PI / 2;                              // cara hacia quien llega
      g.add(banner);
      for (var s = -1; s <= 1; s += 2) {
        var p = new T.Mesh(postGeo, postMat);
        p.scale.set(2, 10.7, 2);
        p.position.set(0, 5.35, s * (ROAD_WIDTH / 2 + 0.7));
        g.add(p);
      }
    }
    makeArch('SALIDA', 0);
    makeArch('META', totalDist);

    function makeKmPost(km) {
      var kg = orientedGroup(km * 1000, ROAD_WIDTH / 2 + 1.6);
      var post = new T.Mesh(postGeo, postMat);
      post.scale.set(1, 2.3, 1); post.position.y = 1.15;
      kg.add(post);
      var stex = textTexture(160, 100, function (x, w, h) {
        x.fillStyle = '#15181d'; x.fillRect(0, 0, w, h);
        x.strokeStyle = '#FF5A1F'; x.lineWidth = 6; x.strokeRect(3, 3, w - 6, h - 6);
        x.fillStyle = '#ffffff'; x.textAlign = 'center'; x.textBaseline = 'middle';
        x.font = '700 62px ' + FONT; x.fillText(String(km), w / 2, h / 2 - 8);
        x.fillStyle = '#FF5A1F'; x.font = '600 24px ' + FONT; x.fillText('KM', w / 2, h - 20);
      });
      var sign = new T.Mesh(signGeo, track(new T.MeshBasicMaterial({ map: stex, side: T.DoubleSide })));
      sign.position.set(0, 2.1, 0);
      sign.rotation.y = -Math.PI / 2;
      kg.add(sign);
    }
    for (var km = 1; km * 1000 < totalDist - 40; km++) makeKmPost(km);

    /* ---- ciclistas (geometria compartida; materiales por tipo) ---- */
    var WHEEL_R = 0.335, WHEEL_TUBE = 0.02;
    var HIP_X = -0.15, HIP_Y = 0.86, BB_X = 0, BB_Y = 0.30, CRANK = 0.1725, SEG = 0.43;
    var geo = {
      wheel: track(new T.TorusGeometry(WHEEL_R, WHEEL_TUBE, 6, 22)),
      spoke: track(new T.BoxGeometry(WHEEL_R * 2, 0.012, 0.012)),
      tube: track(new T.CylinderGeometry(0.014, 0.014, 1, 6)),
      torso: track(new T.CylinderGeometry(0.11, 0.09, 1, 8)),
      arm: track(new T.CylinderGeometry(0.036, 0.03, 1, 6)),
      thigh: track(new T.CylinderGeometry(0.07, 0.056, 1, 8)),
      shin: track(new T.CylinderGeometry(0.05, 0.04, 1, 8)),
      ball: track(new T.SphereGeometry(1, 10, 8)),
      saddle: track(new T.BoxGeometry(0.24, 0.045, 0.12)),
      foot: track(new T.BoxGeometry(0.22, 0.05, 0.09))
    };
    var kindMats = {};
    function matsFor(kind) {
      if (kindMats[kind]) return kindMats[kind];
      var ghost = kind === 'ghost', col = KIND_COLORS[kind];
      function mk(hex, emissive) {
        var m = new T.MeshLambertMaterial({ color: lin(hex) });
        if (ghost) {
          m.transparent = true; m.opacity = 0.55; m.depthWrite = false;
          if (emissive) { m.emissive = lin(KIND_COLORS.ghost); m.emissiveIntensity = 0.45; }
        }
        return track(m);
      }
      var halo = track(new T.MeshBasicMaterial({ color: lin(KIND_COLORS.ghost), transparent: true, opacity: 0.16, blending: T.AdditiveBlending, depthWrite: false, fog: false }));
      kindMats[kind] = {
        jersey: mk(col, true), helmet: mk(col, true), frame: mk(col, true),
        shorts: mk(0x1c1f24, false), skin: mk(0xd9a37a, false), tire: mk(0x15171a, false), halo: halo
      };
      return kindMats[kind];
    }

    var _v1 = new T.Vector3(), _yAxis = new T.Vector3(0, 1, 0), _m4 = new T.Matrix4();
    var _bx = new T.Vector3(), _by = new T.Vector3(), _bz = new T.Vector3();
    // cilindro unitario (eje y) entre dos puntos 3D del marco del ciclista
    function limb(mesh, x1, y1, z1, x2, y2, z2) {
      _v1.set(x2 - x1, y2 - y1, z2 - z1);
      var len = _v1.length();
      mesh.position.set((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2);
      mesh.quaternion.setFromUnitVectors(_yAxis, _v1.divideScalar(len));
      mesh.scale.y = len;
    }
    // cilindro unitario en el plano xy (z fijo)
    function limb2D(mesh, x1, y1, x2, y2, z) {
      var dx = x2 - x1, dy = y2 - y1;
      mesh.position.set((x1 + x2) / 2, (y1 + y2) / 2, z);
      mesh.rotation.z = Math.atan2(-dx, dy);
      mesh.scale.y = Math.sqrt(dx * dx + dy * dy);
    }
    function placeLeg(thigh, shin, foot, z, phase) {
      var px = BB_X + CRANK * Math.cos(phase), py = BB_Y + CRANK * Math.sin(phase);
      var ax = px - 0.03, ay = py + 0.09;                          // tobillo
      var dx = ax - HIP_X, dy = ay - HIP_Y;
      var d = Math.sqrt(dx * dx + dy * dy);
      var ux = dx / d, uy = dy / d, half = d / 2;
      var h = Math.sqrt(Math.max(0, SEG * SEG - half * half));
      var kx = HIP_X + ux * half - uy * h, ky = HIP_Y + uy * half + ux * h;   // rodilla hacia adelante
      limb2D(thigh, HIP_X, HIP_Y, kx, ky, z);
      limb2D(shin, kx, ky, ax, ay, z);
      foot.position.set(px + 0.04, py + 0.02, z);
    }
    function placeLegs(st) {
      placeLeg(st.thighs[0], st.shins[0], st.feet[0], -0.11, st.phase);
      placeLeg(st.thighs[1], st.shins[1], st.feet[1], 0.11, st.phase + Math.PI);
    }

    var riderList = [], riderById = {}, seenToken = 0, simTime = 0;
    function normKind(k) { return KIND_COLORS[k] !== undefined ? k : 'bot'; }

    function makeLabelSprite(st) {
      var w = st.kind === 'user' ? 3.4 : (st.kind === 'ghost' ? 2.9 : 2.0);
      var canvas = newCanvas(512, 128);
      var tex = canvasTex(canvas);
      var mat = track(new T.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
      var sp = new T.Sprite(mat);
      sp.renderOrder = 10;
      sp.scale.set(w, w / 4, 1);
      st.labelW = w; st.labelCanvas = canvas; st.labelTex = tex; st.labelMat = mat;
      return sp;
    }
    function drawLabel(st, text) {
      var c = st.labelCanvas, x = c.getContext('2d'), size = st.kind === 'bot' ? 54 : 66;
      x.clearRect(0, 0, c.width, c.height);
      x.textAlign = 'center'; x.textBaseline = 'middle';
      do { x.font = '700 ' + size + 'px ' + FONT; size -= 4; } while (x.measureText(text).width > 440 && size > 20);
      var tw = x.measureText(text).width + 44;
      var rx = (c.width - tw) / 2, ry = 20, rh = c.height - 40, rad = rh / 2;
      x.beginPath();
      x.moveTo(rx + rad, ry); x.lineTo(rx + tw - rad, ry); x.arc(rx + tw - rad, ry + rad, rad, -Math.PI / 2, Math.PI / 2);
      x.lineTo(rx + rad, ry + rh); x.arc(rx + rad, ry + rad, rad, Math.PI / 2, -Math.PI / 2); x.closePath();
      x.fillStyle = 'rgba(12,14,18,0.78)'; x.fill();
      x.lineWidth = 5; x.strokeStyle = '#' + ('000000' + KIND_COLORS[st.kind].toString(16)).slice(-6); x.stroke();
      x.fillStyle = '#ffffff'; x.fillText(text, c.width / 2, c.height / 2 + 3);
      st.labelTex.needsUpdate = true;
      st.labelText = text;
    }

    function createRider(r) {
      var kind = normKind(r.kind);
      var m = matsFor(kind);
      var root = new T.Group();
      var body = new T.Group();
      root.add(body);
      var st = {
        id: r.id, kind: kind, root: root, token: 0, distM: r.distM, lastD: r.distM, lastT: simTime, speed: 0,
        phase: Math.random() * Math.PI * 2, tx: 0, ty: 0, tz: 0, tq: new T.Quaternion(), hx: 1, hz: 0, fresh: true,
        wheels: [], thighs: [], shins: [], feet: [], labelText: null, label: null
      };
      function part(g, mat) { var me = new T.Mesh(g, mat); me.castShadow = shadowsOn && kind !== 'ghost'; body.add(me); return me; }
      var i, w;
      for (i = 0; i < 2; i++) {                                    // ruedas
        w = part(geo.wheel, m.tire);
        w.position.set(i ? 0.5 : -0.5, WHEEL_R + WHEEL_TUBE, 0);
        w.add(new T.Mesh(geo.spoke, m.frame));
        st.wheels.push(w);
      }
      // cuadro (BB, asiento, direccion, bujes)
      var seat = [-0.13, 0.74], head = [0.42, 0.70], rear = [-0.5, 0.355], front = [0.5, 0.355];
      var tubes = [[BB_X, BB_Y, seat[0], seat[1]], [seat[0], seat[1], head[0], head[1]], [BB_X, BB_Y, head[0] - 0.02, head[1] - 0.04],
        [BB_X, BB_Y, rear[0], rear[1]], [seat[0], seat[1], rear[0], rear[1]], [head[0], head[1] + 0.03, front[0], front[1]]];
      for (i = 0; i < tubes.length; i++) {
        limb(part(geo.tube, m.frame), tubes[i][0], tubes[i][1], 0, tubes[i][2], tubes[i][3], 0);
      }
      var bar = part(geo.tube, m.tire); bar.scale.set(1.2, 1, 1.2);
      limb(bar, 0.46, 0.76, -0.2, 0.46, 0.76, 0.2);
      limb(part(geo.tube, m.tire), head[0], head[1] + 0.03, 0, 0.46, 0.76, 0);
      part(geo.saddle, m.shorts).position.set(-0.15, 0.755, 0);
      // ciclista
      limb(part(geo.torso, m.jersey), HIP_X, HIP_Y, 0, 0.30, 1.16, 0);
      var headMesh = part(geo.ball, m.skin); headMesh.scale.setScalar(0.09); headMesh.position.set(0.41, 1.27, 0);
      var helmet = part(geo.ball, m.helmet); helmet.scale.set(0.14, 0.095, 0.11); helmet.position.set(0.39, 1.32, 0);
      for (i = -1; i <= 1; i += 2) {
        limb(part(geo.arm, m.jersey), 0.30, 1.14, i * 0.17, 0.46, 0.77, i * 0.2);
        st.thighs.push(part(geo.thigh, m.shorts));
        st.shins.push(part(geo.shin, m.skin));
        st.feet.push(part(geo.foot, m.tire));
      }
      if (kind === 'ghost') {
        var halo = new T.Mesh(geo.ball, m.halo);
        halo.scale.set(1.15, 0.95, 0.55); halo.position.set(0.05, 0.85, 0);
        body.add(halo);
      }
      st.label = makeLabelSprite(st);
      st.label.position.y = 2.4;
      root.add(st.label);
      scene.add(root);
      placeLegs(st);
      return st;
    }

    function removeRider(st) {
      scene.remove(st.root);
      st.labelTex.dispose(); st.labelMat.dispose();
      delete riderById[st.id];
    }

    function setRiders(list) {
      if (disposed) return;
      var token = ++seenToken, i, j, st, r;
      for (i = 0; i < list.length; i++) {
        r = list[i];
        st = riderById[r.id];
        if (st && st.kind !== normKind(r.kind)) {
          removeRider(st);
          riderList.splice(riderList.indexOf(st), 1);
          st = null;
        }
        if (!st) {
          st = createRider(r);
          riderById[r.id] = st;
          riderList.push(st);
        }
        st.token = token;
        st.distM = r.distM;
        var text = r.label != null ? String(r.label) : (r.name != null ? String(r.name) : '');
        if (text !== st.labelText) drawLabel(st, text);
      }
      for (i = riderList.length - 1; i >= 0; i--) {
        if (riderList[i].token !== token) { removeRider(riderList[i]); riderList.splice(i, 1); }
      }
      // objetivos de pose, con reparto en el carril para quienes comparten distM
      var n = riderList.length, A;
      for (i = 0; i < n; i++) {
        A = riderList[i];
        var idx = 0, cnt = 1;
        for (j = 0; j < n; j++) {
          if (j === i) continue;
          if (Math.abs(riderList[j].distM - A.distM) < CLUSTER_M) { cnt++; if (j < i) idx++; }
        }
        pathPose(path, A.distM, _pose);
        var off = laneOffset(idx, cnt);
        A.tx = _pose.x - _pose.hz * off; A.tz = _pose.z + _pose.hx * off; A.ty = _pose.y;
        A.hx = _pose.hx; A.hz = _pose.hz;
        // base: x = tangente, z = derecha (tangente x arriba), y = z x x
        _bx.set(_pose.tx, _pose.ty, _pose.tz);
        _bz.crossVectors(_bx, _yAxis).normalize();
        _by.crossVectors(_bz, _bx);
        _m4.makeBasis(_bx, _by, _bz);
        A.tq.setFromRotationMatrix(_m4);
        // velocidad estimada para animar pedaleo y ruedas
        var el = simTime - A.lastT;
        if (el > 1e-4) {
          var v = (A.distM - A.lastD) / el;
          if (v >= 0 && v < 40) A.speed += (v - A.speed) * 0.35;
          A.lastD = A.distM; A.lastT = simTime;
        }
        if (A.fresh) {
          A.root.position.set(A.tx, A.ty, A.tz); A.root.quaternion.copy(A.tq); A.fresh = false;
        }
      }
    }

    /* ---- camara ---- */
    var cameraMode = 'persecucion';
    var camPos = new T.Vector3(), camLook = new T.Vector3(), wantPos = new T.Vector3(), wantLook = new T.Vector3();
    var camReady = false, _ahead = { x: 0, y: 0, z: 0, i: 0 };

    function userState() {
      for (var i = 0; i < riderList.length; i++) if (riderList[i].kind === 'user') return riderList[i];
      return riderList.length ? riderList[0] : null;
    }

    function updateCamera(dt) {
      var u = userState(), px, py, pz, hx, hz, d;
      if (u) {
        px = u.root.position.x; py = u.root.position.y; pz = u.root.position.z; hx = u.hx; hz = u.hz; d = u.distM;
      } else {
        pathPose(path, 0, _pose); px = _pose.x; py = _pose.y; pz = _pose.z; hx = _pose.hx; hz = _pose.hz; d = 0;
      }
      var kPos = 5, kLook = 7;
      if (cameraMode === 'aerea') {
        wantPos.set(px, py + 400, pz + 160); wantLook.set(px, py, pz);
        kPos = 2.5; kLook = 4;
      } else if (cameraMode === 'lateral') {
        wantPos.set(px - hz * 9, py + 1.9, pz + hx * 9);           // 9 m a la derecha del rumbo
        wantLook.set(px + hx * 2, py + 1, pz + hz * 2);
      } else {
        wantPos.set(px - hx * 12, py + 5, pz - hz * 12);           // 12 m atras, 5 m arriba
        pathAt(path, d + 20, _ahead);                              // mira 20 m adelante
        wantLook.set(_ahead.x, _ahead.y + 1.2, _ahead.z);
      }
      var gy = gridHeight(grid, wantPos.x, wantPos.z) + 2;
      if (wantPos.y < gy) wantPos.y = gy;
      if (!camReady) {
        camPos.copy(wantPos); camLook.copy(wantLook); camReady = true;
      } else {
        camPos.lerp(wantPos, 1 - Math.exp(-dt * kPos));
        camLook.lerp(wantLook, 1 - Math.exp(-dt * kLook));
      }
      camera.position.copy(camPos);
      camera.lookAt(camLook);
    }

    function setCameraMode(mode) {
      if (CAMERA_MODES.indexOf(mode) < 0) throw new TypeError('Scene3D: modo de camara invalido: ' + mode);
      cameraMode = mode;
    }

    /* ---- tamano, calidad automatica ---- */
    function resize() {
      if (disposed) return;
      var w = container.clientWidth || 640, h = container.clientHeight || 360;
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    var ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(function () { resize(); });
      ro.observe(container);
    }
    function onLost(e) { e.preventDefault(); contextLost = true; }
    function onRestored() { contextLost = false; }
    canvasEl.addEventListener('webglcontextlost', onLost);
    canvasEl.addEventListener('webglcontextrestored', onRestored);
    resize();

    var dtAvg = 0.016, frames = 0, downgraded = false;

    /* ---- render ---- */
    function render(dtS) {
      if (disposed || contextLost) return;
      var dt = clamp(dtS > 0 ? dtS : 0, 0, 0.1);
      simTime += dt;

      if (quality === 'auto' && !downgraded) {
        dtAvg += ((dtS > 0 ? dtS : 0.016) - dtAvg) * 0.05;
        if (++frames > 90 && dtAvg > 0.022) {
          downgraded = true;
          if (pixelRatio > 1) { pixelRatio = 1; resize(); }
        }
      }

      var kr = 1 - Math.exp(-dt * 18), i, st;
      var cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
      for (i = 0; i < riderList.length; i++) {
        st = riderList[i];
        var p = st.root.position;
        var ddx = st.tx - p.x, ddy = st.ty - p.y, ddz = st.tz - p.z;
        if (ddx * ddx + ddy * ddy + ddz * ddz > 900) {              // salto grande: sin suavizado
          p.set(st.tx, st.ty, st.tz); st.root.quaternion.copy(st.tq);
        } else {
          p.x += ddx * kr; p.y += ddy * kr; p.z += ddz * kr;
          st.root.quaternion.slerp(st.tq, kr);
        }
        if (st.speed > 0.05) {
          var rev = clamp(st.speed / 8 * 1.4, 0, 2.2);              // rev/s de cadencia segun velocidad
          st.phase += rev * 2 * Math.PI * dt;
          if (st.phase > 62831) st.phase -= 62831;
          var roll = st.speed / WHEEL_R * dt;
          st.wheels[0].rotation.z -= roll; st.wheels[1].rotation.z -= roll;
          placeLegs(st);
        }
        // etiqueta: tamano aparente constante a partir de 16 m de la camara
        var lx = p.x - cx, ly = p.y - cy, lz = p.z - cz;
        var s = Math.sqrt(lx * lx + ly * ly + lz * lz) / 16;
        if (s < 1) s = 1;
        st.label.scale.set(st.labelW * s, st.labelW * s / 4, 1);
        st.label.position.y = 2.4 + 0.6 * (s - 1);
      }
      if (kindMats.ghost) kindMats.ghost.halo.opacity = 0.16 + 0.07 * Math.sin(simTime * 3);

      updateCamera(dt);
      sky.position.copy(camera.position);
      if (shadowsOn) {
        var u = userState(), ux = camPos.x, uy = 0, uz = camPos.z;
        if (u) { ux = u.root.position.x; uy = u.root.position.y; uz = u.root.position.z; }
        sun.target.position.set(ux, uy, uz);
        sun.position.set(ux + SUN_DIR.x * 250, uy + SUN_DIR.y * 250, uz + SUN_DIR.z * 250);
      }
      renderer.render(scene, camera);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (ro) ro.disconnect();
      canvasEl.removeEventListener('webglcontextlost', onLost);
      canvasEl.removeEventListener('webglcontextrestored', onRestored);
      for (var i = 0; i < own.length; i++) own[i].dispose();
      own.length = 0;
      riderList.length = 0; riderById = {};
      if (scene.clear) scene.clear();
      renderer.dispose();
      if (renderer.forceContextLoss) renderer.forceContextLoss();
      if (canvasEl.parentNode) canvasEl.parentNode.removeChild(canvasEl);
    }

    return { setRiders: setRiders, setCameraMode: setCameraMode, render: render, resize: resize, dispose: dispose };
  }

  R.Scene3D = {
    isSupported: isSupported,
    create: create,
    _internals: {
      decodeHeights: decodeHeights,
      projectPoint: projectPoint,
      originOf: originOf,
      sampleRoute: sampleRoute,
      laneOffset: laneOffset,
      elevationColor: elevationColor,
      makeHeightGrid: makeHeightGrid,
      gridHeight: gridHeight,
      buildRoadPath: buildRoadPath,
      pathAt: pathAt,
      pathPose: pathPose
    }
  };
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
