# Rodillator — Plan

Especificación: `SPEC.md` (restricciones globales y contratos; son autoridad).

| # | Tarea | Archivos propios | Ola |
|---|---|---|---|
| 1 | Horneado geoespacial de rutas (DEM + satélite) | `tools/bake_routes.py`, `data/routes/*.json`, `tests/test_routes_data.test.js` | 1 |
| 2 | Motor de entrenamiento | `src/training.js`, `tests/training.test.js` | 1 |
| 3 | Física, rutas GPX, fantasmas y bots | `src/physics.js`, `src/routes.js`, `src/riders.js`, `tests/physics.test.js`, `tests/routes.test.js`, `tests/riders.test.js` | 1 |
| 4 | Escena 3D | `src/scene3d.js`, `tests/scene3d.test.js` (solo API/headless-safe) | 1 |
| 5 | Dispositivos e integraciones | `src/devices.js`, `src/integrations.js`, `src/store.js`, `tests/integrations.test.js`, `tests/store.test.js` | 1 |
| 6 | Shell de UI, onboarding, plan, ajustes, build | `src/app.js`, `src/ui/shell.js`, `src/ui/onboarding.js`, `src/ui/plan.js`, `src/ui/settings.js`, `src/ui/routes.js`, `src/styles.css`, `src/index.template.html`, `build.py` | 2 |
| 7 | Pantalla de rodada | `src/ui/ride.js`, `src/ui/ride.css` | 2 |
| 8 | Estadísticas | `src/ui/stats.js`, `src/ui/stats.css` | 2 |

Contrato de vistas (ola 2): `R.ui.registerView({ id, title, icon, render(container, ctx), destroy?() })` definido por la Tarea 6 en `src/ui/shell.js`; `ctx = { store: R.store, navigate(id, params), params, toast(msg, kind) }`. Ride y Stats solo registran su vista. Rutas de hash: `#inicio`, `#plan`, `#rodar`, `#rutas`, `#estadisticas`, `#ajustes`.
