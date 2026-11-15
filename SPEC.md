# Rodillator — Especificación

App web de entrenamiento de ciclismo en rodillo, entregada como **un solo archivo HTML autocontenido** (`dist/rodillator.html`) que se publica como artefacto de claude.ai.

## Restricciones globales (valores exactos, obligatorias para todas las tareas)

1. **Idioma de la interfaz**: español (Chile neutro, tuteo). Unidades métricas (km, m, km/h, kg, W, ppm). Código y nombres de variables en inglés.
2. **Entorno de ejecución (sandbox del artefacto)**:
   - Sin `fetch`/XHR/WebSocket a hosts externos. Sin imágenes remotas (solo `data:` y `blob:`).
   - Scripts externos permitidos SOLO estos dos:
     - `https://cdn.jsdelivr.net/npm/three@0.149.0/build/three.min.js` (expone `window.THREE`)
     - `https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js` (expone `window.Chart`)
   - Fuentes: Google Fonts (`fonts.googleapis.com`) permitido.
   - Bloqueados: `alert/confirm/prompt`, descargas por `<a download>`, `window.open`, service workers. Diálogos se construyen en la página.
   - `localStorage` puede faltar o lanzar: siempre envuelto en try/catch.
3. **Arquitectura de módulos**: JavaScript ES2020 plano (sin módulos ES, sin bundler, sin dependencias npm en runtime). Cada archivo de `src/` define propiedades en el espacio de nombres global `window.R` con el patrón:
   ```js
   (function (R) { 'use strict'; /* ... */ R.training = { ... }; })(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
   ```
   Así cada módulo puro se puede probar en Node (`node tests/<x>.test.js`) cargándolo con `require`.
4. **Pruebas**: Node 22, `node:test` + `node:assert`. Sin dependencias npm. Comando de suite completa: `node --test tests/`.
5. **Datos de rutas**: `data/routes/<id>.json` con el esquema RouteData (abajo). `build.py` los embebe en el HTML.
6. **Estética**: tema oscuro deportivo; color de acento del usuario `#FF5A1F` (naranja Rodillator); fantasma de mejor marca `#FFD23F` (dorado); bots `#7FA7C9`. Tipografías: "Barlow Condensed" (titulares/números) e "Inter" (texto), vía Google Fonts.
7. **Ciencia del entrenamiento** (valores exactos):
   - Zonas de potencia Coggan (% FTP): Z1 Recuperación <55; Z2 Resistencia 56–75; Z3 Tempo 76–90; Z4 Umbral 91–105; Z5 VO2máx 106–120; Z6 Anaeróbico 121–150; Z7 Neuromuscular >150.
   - NP: media móvil 30 s, potencia 4, media, raíz 4. IF = NP/FTP. TSS = (s × NP × IF)/(FTP × 3600) × 100.
   - CTL: EWMA constante 42 días; ATL: 7 días; TSB = CTL(ayer) − ATL(ayer).
   - FTP estimado si el usuario no lo sabe (W/kg por nivel): principiante 2.0, intermedio 2.8, avanzado 3.5, competitivo 4.2; ajuste por edad: −0.5 % por año sobre 35 (mínimo 0.6 del valor base).
8. **Física de velocidad**: g=9.8067, ρ=1.225 kg/m³ (corregir por altitud: ρ·exp(−alt/8500)), Crr=0.004, CdA=0.32 m², masa = peso usuario + 8 kg bicicleta, eficiencia transmisión 0.976.
9. **Persistencia**: `R.store` (ver contrato) sobre localStorage con clave `rodillator.v1`; si `claude.use('db')` resuelve, sincroniza también en `data/users/<id>/state/main`.

## Contratos entre módulos (interfaces)

### RouteData (JSON en data/routes/<id>.json; también lo produce R.routes.fromGPX)
```js
{
  id: "alpe-dhuez", name: "Alpe d'Huez", region: "Isère", country: "Francia",
  description: "…", source: "…atribución…", synthetic: false,
  distanceM: 13800, gainM: 1100, maxEleM: 1860, minEleM: 720,
  points: [[lat, lon, eleM, distM], ...],   // remuestreado cada ~20 m, distM acumulada desde 0
  terrain: {                                  // opcional (null para GPX sin hornear)
    bbox: [minLon, minLat, maxLon, maxLat],
    width: 256, height: 256,                  // grilla de alturas
    minEle: 600, maxEle: 2100,
    heights: "<base64 de Uint16 little-endian, valor = (ele-minEle)/(maxEle-minEle)*65535, fila 0 = norte>",
    texture: "data:image/jpeg;base64,…",       // imagen satelital 1024–2048 px cubriendo exactamente bbox (norte arriba)
    attribution: "Copernicus DEM GLO-30 © ESA/DLR; Sentinel-2 cloudless by EOX (CC BY-NC-SA 4.0)"
  }
}
```

### R.store
`R.store.get()` → estado completo; `R.store.set(patch)` fusiona y persiste; `R.store.subscribe(fn)` → unsubscribe. Estado:
```js
{ profile: { name, age, weightKg, heightCm, sex, level, ftp, ftpEstimated, maxHr, goal, hoursPerWeek, daysPerWeek, eventDate, weeks },
  plan: Plan|null, activities: Activity[], settings: { reminderTime:"19:00", reminderDays:[1,3,5], ghostBoost:0, botsCount:6, units:"metric" },
  bests: { [routeId]: { activityId, totalTimeS, splits: [[distM, timeS], ...] } } }
```

### Activity
```js
{ id, date: ISOString, type: "workout"|"route"|"free", name, routeId|null, workoutId|null,
  durationS, distanceM, avgPower, np, tss, if, avgHr|null, avgCadence|null, kcal, rpe|null,
  samples: [[tS, powerW, hr|null, cadence|null, speedMps, distM, eleM|null], ...]   // 1 Hz
  bestEfforts: { "5": W, "60": W, "300": W, "1200": W, "3600": W } }
```

### Workout / Plan (R.training)
```js
Workout = { id, name, category: "recuperacion"|"resistencia"|"tempo"|"sweetspot"|"umbral"|"vo2"|"anaerobico"|"test",
            description, durationS, tss, steps: [{ durationS, powerPct, powerPctEnd?, cadence?, label }] }
Plan = { createdAt, goal, weeks: [{ index, phase: "base"|"construccion"|"especifico"|"descarga"|"taper", targetTss,
          days: [{ date: "YYYY-MM-DD", workoutId|null, status: "pendiente"|"hecho"|"saltado" }] }] }
```

### Rider para escena 3D
`{ id, name, kind: "user"|"ghost"|"bot", distM, color, label, cadenceRpm? }` (cadenceRpm opcional: rpm para animar el pedaleo del modelo glTF; ride.js lo pasa para el usuario)
