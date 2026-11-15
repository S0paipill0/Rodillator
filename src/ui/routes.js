(function (R) {
  'use strict';

  var el = R.ui.el;
  var U = R.ui.util;
  var thumbCache = {};
  var MAX_GPX_BYTES = 15 * 1024 * 1024;

  // ---------- rutas propias (GPX) ----------
  function customIds() {
    return (R.store.get().settings.customRoutes || []).map(function (r) { return r.id; });
  }

  // Registra las rutas GPX guardadas; el relieve se regenera (es determinista por id).
  function registerCustomRoutes() {
    var saved = R.store.get().settings.customRoutes;
    if (!Array.isArray(saved)) return 0;
    var n = 0;
    saved.forEach(function (r) {
      try {
        var route = Object.assign({}, r);
        route.terrain = R.routes.proceduralTerrain(route); // siempre se regenera: el almacenado puede estar obsoleto
        R.routes.register(route);
        n++;
      } catch (e) { /* una ruta guardada dañada no bloquea el arranque */ }
    });
    return n;
  }

  // ---------- miniatura ----------
  function fitTrack(route, w, h, pad) {
    var pts = route.points;
    var minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    pts.forEach(function (p) { minLat = Math.min(minLat, p[0]); maxLat = Math.max(maxLat, p[0]); minLon = Math.min(minLon, p[1]); maxLon = Math.max(maxLon, p[1]); });
    var k = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
    var spanX = Math.max(1e-6, (maxLon - minLon) * k), spanY = Math.max(1e-6, maxLat - minLat);
    var s = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
    var ox = (w - spanX * s) / 2, oy = (h - spanY * s) / 2;
    var step = Math.max(1, Math.floor(pts.length / 160));
    var out = [];
    for (var i = 0; i < pts.length; i += step) out.push([ox + (pts[i][1] - minLon) * k * s, oy + (maxLat - pts[i][0]) * s]);
    var l = pts[pts.length - 1];
    out.push([ox + (l[1] - minLon) * k * s, oy + (maxLat - l[0]) * s]);
    return out;
  }

  function trackSvg(route) {
    var pts = fitTrack(route, 160, 90, 14);
    var svg = el('svg:svg', { 'class': 'track', viewBox: '0 0 160 90', preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true', focusable: 'false' });
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join('');
    svg.appendChild(el('svg:path', { d: d, fill: 'none', stroke: '#0D0F12', 'stroke-width': 5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: .6 }));
    svg.appendChild(el('svg:path', { d: d, fill: 'none', stroke: '#FF5A1F', 'stroke-width': 2.6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    return svg;
  }

  // Recorta la textura satelital alrededor del trazado y dibuja la ruta encima.
  function satelliteThumb(route, holder) {
    var cached = thumbCache[route.id];
    if (cached) { holder.appendChild(el('img', { src: cached, alt: '', width: 640, height: 360 })); return; }
    var img = new Image();
    img.onload = function () {
      try {
        var W = 640, H = 360, ar = W / H;
        var b = route.terrain.bbox, iw = img.naturalWidth, ih = img.naturalHeight;
        var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        var toPx = function (p) { return [(p[1] - b[0]) / (b[2] - b[0]) * iw, (b[3] - p[0]) / (b[3] - b[1]) * ih]; };
        route.points.forEach(function (p) { var q = toPx(p); minX = Math.min(minX, q[0]); maxX = Math.max(maxX, q[0]); minY = Math.min(minY, q[1]); maxY = Math.max(maxY, q[1]); });
        var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        var w = Math.max((maxX - minX) * 1.3, iw * 0.25), h = (maxY - minY) * 1.3;
        if (w / h < ar) w = h * ar; else h = w / ar;
        if (w > iw) { w = iw; h = w / ar; }
        if (h > ih) { h = ih; w = h * ar; }
        var sx = Math.min(Math.max(cx - w / 2, 0), iw - w), sy = Math.min(Math.max(cy - h / 2, 0), ih - h);
        var cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        var g = cv.getContext('2d');
        g.drawImage(img, sx, sy, w, h, 0, 0, W, H);
        g.lineJoin = 'round'; g.lineCap = 'round';
        var step = Math.max(1, Math.floor(route.points.length / 300));
        var path = function () {
          g.beginPath();
          for (var i = 0; i < route.points.length; i += step) {
            var q = toPx(route.points[i]), x = (q[0] - sx) / w * W, y = (q[1] - sy) / h * H;
            if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
          }
          var l = toPx(route.points[route.points.length - 1]);
          g.lineTo((l[0] - sx) / w * W, (l[1] - sy) / h * H);
        };
        path(); g.strokeStyle = 'rgba(13,15,18,.75)'; g.lineWidth = 8; g.stroke();
        path(); g.strokeStyle = '#FF5A1F'; g.lineWidth = 4.5; g.stroke();
        thumbCache[route.id] = cv.toDataURL('image/jpeg', 0.82);
        holder.appendChild(el('img', { src: thumbCache[route.id], alt: '', width: W, height: H }));
      } catch (e) { holder.appendChild(trackSvg(route)); }
    };
    img.onerror = function () { holder.appendChild(trackSvg(route)); };
    img.src = route.terrain.texture;
  }

  function elevationSvg(route) {
    var prof = R.routes.profile(route, 120);
    var mn = Infinity, mx = -Infinity;
    prof.forEach(function (p) { mn = Math.min(mn, p.ele); mx = Math.max(mx, p.ele); });
    var span = Math.max(20, mx - mn), W = 200, H = 48;
    var pts = prof.map(function (p, i) { return [i / (prof.length - 1) * W, H - 3 - (p.ele - mn) / span * (H - 8)]; });
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join('');
    var svg = el('svg:svg', { 'class': 'elev', viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Perfil de elevación: de ' + Math.round(mn) + ' a ' + Math.round(mx) + ' metros' });
    svg.appendChild(el('svg:path', { d: line + 'L' + W + ' ' + H + 'L0 ' + H + 'Z', fill: 'rgba(255,90,31,.22)' }));
    svg.appendChild(el('svg:path', { d: line, fill: 'none', stroke: '#FF5A1F', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }));
    return svg;
  }

  function stat(value, unit, label) {
    return el('div', null, [el('div', null, [el('span', { 'class': 'num' }, value), el('span', { 'class': 'unit' }, unit)]), el('div', { 'class': 'kpi-label' }, label)]);
  }

  // ======================================================================
  var routesView = {
    id: 'rutas', title: 'Rutas',
    render: function (container, ctx) {
      var fileInput = el('input', { type: 'file', accept: '.gpx,application/gpx+xml,text/xml,application/xml', 'class': 'sr-only', id: 'gpx-file', tabindex: '-1', 'aria-label': 'Archivo GPX', onchange: onFile });
      container.appendChild(el('header', { 'class': 'view-head' }, [
        el('div', null, [el('h1', null, 'Rutas'), el('p', null, 'Elige un recorrido y rueda con tu potencia. Cada pedalada mueve a tu ciclista por el relieve real.')]),
        el('div', { 'class': 'head-actions' }, [el('button', { type: 'button', 'class': 'btn', onclick: function () { fileInput.click(); } }, 'Cargar GPX'), fileInput])
      ]));
      var grid = el('div', { 'class': 'route-grid' });
      container.appendChild(grid);
      var foot = el('div', { 'class': 'card', style: { 'margin-top': '20px' } });
      container.appendChild(foot);

      function draw() {
        grid.textContent = '';
        var routes = R.routes.list();
        var bests = R.store.get().bests || {};
        var custom = customIds();
        if (!routes.length) grid.appendChild(el('div', { 'class': 'card' }, [el('h2', null, 'No hay rutas disponibles'), el('p', { 'class': 'muted' }, 'Carga un archivo GPX para empezar.')]));
        routes.forEach(function (r) { grid.appendChild(routeCard(r, bests[r.id], custom.indexOf(r.id) >= 0)); });

        var attrs = [];
        routes.forEach(function (r) { var a = r.terrain && !r.terrain.procedural && r.terrain.attribution; if (a && attrs.indexOf(a) < 0) attrs.push(a); });
        foot.textContent = '';
        foot.appendChild(el('h3', null, 'Sobre el relieve y las imágenes'));
        foot.appendChild(el('p', { 'class': 'small', style: { 'margin-top': '8px' } }, 'Las rutas GPX usan relieve generado a partir de sus altitudes; las rutas predefinidas incluyen imagen satelital real (Sentinel-2) y relieve Copernicus.'));
        if (attrs.length) foot.appendChild(el('ul', { 'class': 'attrib', style: { 'padding-left': '18px', margin: '8px 0 0' } }, attrs.map(function (a) { return el('li', null, a); })));
      }

      function routeCard(r, best, isCustom) {
        var thumb = el('div', { 'class': 'thumb' });
        if (r.terrain && r.terrain.texture) satelliteThumb(r, thumb); else thumb.appendChild(trackSvg(r));
        if (r.synthetic) thumb.appendChild(el('span', { 'class': 'chip chip-warn', title: 'El trazado se generó de forma aproximada sobre el relieve real.' }, 'Trazado aproximado'));
        var grade = r.distanceM > 0 ? r.gainM / r.distanceM * 100 : 0;
        var place = [r.region, r.country].filter(Boolean).join(', ');
        return el('article', { 'class': 'card route-card', 'aria-label': r.name }, [
          thumb,
          el('div', { 'class': 'route-body' }, [
            el('div', null, [el('h3', null, r.name), place ? el('div', { 'class': 'muted small' }, place) : null]),
            el('div', { 'class': 'route-stats' }, [
              stat(U.fmtNum(r.distanceM / 1000, 1), 'km', 'Distancia'),
              stat(U.fmtNum(r.gainM), 'm', 'Desnivel'),
              stat(U.fmtNum(grade, 1), '%', 'Pendiente media')
            ]),
            elevationSvg(r),
            best ? el('div', { 'class': 'best' }, 'Tu mejor tiempo: ' + U.fmtClock(best.totalTimeS)) : el('div', { 'class': 'muted small' }, 'Aún sin marca en esta ruta'),
            el('div', { 'class': 'route-foot' }, [
              el('button', { type: 'button', 'class': 'btn btn-primary btn-sm', onclick: function () { ctx.navigate('rodar', { routeId: r.id }); } }, 'Rodar esta ruta'),
              isCustom ? el('button', { type: 'button', 'class': 'btn btn-ghost btn-sm', onclick: function () { confirmRemove(r); } }, 'Quitar') : null
            ]),
            el('div', { 'class': 'attrib' }, (r.terrain && r.terrain.attribution) || r.source || '')
          ])
        ]);
      }

      function confirmRemove(r) {
        R.ui.modal({
          title: 'Quitar "' + r.name + '"',
          body: 'La ruta se elimina de tu lista. Tus actividades y marcas ya guardadas no se borran.',
          actions: [{ label: 'Cancelar' }, {
            label: 'Quitar ruta', kind: 'danger', onClick: function () {
              delete R.routes.registry[r.id];
              var list = (R.store.get().settings.customRoutes || []).filter(function (c) { return c.id !== r.id; });
              R.store.set({ settings: { customRoutes: list } });
              ctx.toast('Ruta quitada.', 'ok');
              draw();
            }
          }]
        });
      }

      function onFile(ev) {
        var file = ev.target.files && ev.target.files[0];
        ev.target.value = '';
        if (!file) return;
        if (file.size > MAX_GPX_BYTES) { ctx.toast('El archivo pesa más de 15 MB. Usa un GPX más liviano.', 'error'); return; }
        readText(file).then(function (text) {
          var route = R.routes.fromGPX(text, { name: nameFromFile(file.name, text) });
          route.terrain = R.routes.proceduralTerrain(route);
          R.routes.register(route);
          var stored = Object.assign({}, route, { terrain: null });
          var list = (R.store.get().settings.customRoutes || []).concat([stored]);
          R.store.set({ settings: { customRoutes: list } });
          ctx.toast('Ruta cargada: ' + route.name + ' (' + U.fmtNum(route.distanceM / 1000, 1) + ' km).' + (route.flat ? ' El archivo no trae altitudes, así que el terreno es plano.' : ''), route.flat ? 'warn' : 'ok');
          draw();
        }).catch(function (e) { ctx.toast('No se pudo cargar el GPX: ' + ((e && e.message) || e), 'error'); });
      }

      function nameFromFile(fname, text) {
        if (/<name>\s*[^<\s]/i.test(text)) return undefined;   // el GPX trae su propio nombre
        return String(fname || '').replace(/\.gpx$/i, '').trim() || undefined;
      }

      function readText(file) {
        if (file.text) return file.text();
        return new Promise(function (res, rej) {
          var fr = new FileReader();
          fr.onload = function () { res(String(fr.result)); };
          fr.onerror = function () { rej(new Error('No se pudo leer el archivo.')); };
          fr.readAsText(file);
        });
      }

      draw();
    }
  };

  R.ui.registerCustomRoutes = registerCustomRoutes;
  R.ui.registerView(routesView);
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
