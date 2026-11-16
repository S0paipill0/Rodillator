# Rodillator 🚴

App web de entrenamiento de ciclismo en rodillo: plan adaptativo, rodadas con paisaje 3D satelital, fantasma de tu mejor marca, estadísticas interactivas y exportación a Strava (.TCX).

Se entrega como **un único HTML autocontenido** (`dist/rodillator.html`) pensado para publicarse como artefacto de claude.ai.

## Estructura
| Ruta | Contenido |
|---|---|
| `src/*.js` | Módulos del núcleo en el espacio de nombres `window.R`: `store`, `training`, `physics`, `routes`, `riders`, `scene3d`, `devices`, `integrations` |
| `src/ui/` | Vistas: shell, onboarding, plan, rutas, ajustes, rodada, estadísticas |
| `data/routes/*.json` | Rutas horneadas con relieve y textura satelital |
| `tools/bake_routes.py` | Generador de rutas (Copernicus DEM GLO-30 + Sentinel-2 cloudless) |
| `build.py` | Ensambla `dist/rodillator.html` |
| `tests/` | Pruebas `node:test` |
| `SPEC.md`, `PLAN.md` | Especificación y plan de tareas |

## Uso
```bash
node --test            # pruebas (Node 22)
python3 build.py       # genera dist/rodillator.html
python3 tools/bake_routes.py   # regenera data/routes (requiere red a AWS y EOX)
```

## Datos y licencias
- Relieve: Copernicus DEM GLO-30 © ESA/DLR.
- Imagen: Sentinel-2 cloudless by EOX — CC BY-NC-SA 4.0 (uso no comercial).
- Traza de Alpe d'Huez: paquete R `rayshaderanimate` (GPL ≥ 2).
- Voz del coach: modelo Piper es_MX "claude" (high), dataset HirCoir/Piper-TTS-Spanish (https://huggingface.co/spaces/HirCoir/Piper-TTS-Spanish), licencia Apache-2.0 según su MODEL_CARD; los clips de `data/voice/es-mx.json` se generan por síntesis con `tools/bake_voice.py`.
- Las rutas chilenas tienen trazado aproximado, generado sobre el relieve real.

## Limitaciones actuales
- Sin Bluetooth: la potencia viene de un simulador (teclado/botones).
- Strava: exportación .TCX y subida manual en https://www.strava.com/upload/select.
- Los GPX subidos por el usuario usan relieve procedural (el sandbox del artefacto bloquea la red).
