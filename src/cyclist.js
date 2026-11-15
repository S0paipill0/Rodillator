/*
 * Rodillator - Logica pura del ciclista 3D con modelo glTF (R.cyclist)
 * Sin dependencias de three.js: clasificacion de nodos del modelo, cadencia de la animacion,
 * eleccion de nivel de detalle y apariencia de los bots. La usan scene3d.js y tools/cyclist/optimize_cyclist.mjs.
 *
 * Convencion del modelo (Bernardino_Ciclista.glb): metros, +Y arriba, avance hacia -Z, derecha +X,
 * suelo en y = 0, buje trasero en z > 0 y delantero en z < 0.
 */
(function (R) {
  'use strict';

  var WHEEL_RADIUS_M = 0.34;          // m: radio de rueda por defecto (700c aprox.) si no se mide del modelo
  var LOD_MODEL_M = 60;               // m: modelo completo a menos de esta distancia de la camara
  var LOD_HYSTERESIS_M = 4;           // m: margen para no alternar en el borde
  var MIN_SPEED_MPS = 0.3;            // m/s: por debajo, el ciclista se considera detenido (animacion en pausa)
  var CLIP_RPM = 60;                  // el clip Pedaleo_60rpm dura 1 s = una vuelta de biela

  // piezas que giran con la rueda (nombres del modelo; "Rueda" = nodos ya fusionados por el optimizador)
  var WHEEL_PART_RX = /^(neumatico|llanta|buje|radio|disco freno|soporte disco|pinon|rueda)\b/i;
  var REAR_RX = /\btrasera/i, FRONT_RX = /\bdelantera/i;     // sin \b final: "Radio_Delantera001"

  function stripAccents(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  /**
   * Rueda a la que pertenece un nodo del modelo: 'rear' | 'front' | null.
   * Primero por nombre (… Trasera | … Delantera); las piezas de rueda sin lado en el nombre
   * ("Soporte disco", "Pinon") se asignan por posicion: z > 0 trasera, z < 0 delantera.
   * name acepta la forma saneada de three.js (espacios -> '_').
   */
  function classifyWheelNode(name, pos) {
    var n = stripAccents(name).replace(/_/g, ' ');
    if (!WHEEL_PART_RX.test(n)) return null;
    if (REAR_RX.test(n)) return 'rear';
    if (FRONT_RX.test(n)) return 'front';
    if (pos && isFinite(pos.z) && pos.z !== 0) return pos.z > 0 ? 'rear' : 'front';
    return null;
  }

  /** Velocidad del clip de 60 rpm para una cadencia: rpm/60; 0 (pausa) si no hay cadencia o el ciclista esta detenido. */
  function cadenceTimeScale(rpm, speedMps) {
    if (!(rpm > 0) || !isFinite(rpm)) return 0;
    if (speedMps != null && !(speedMps >= MIN_SPEED_MPS)) return 0;
    return rpm / CLIP_RPM;
  }

  function hashId(id) {
    var s = String(id == null ? '' : id), h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  /**
   * Cadencia (rpm) a usar para animar a un ciclista.
   * Si el Rider trae cadenceRpm se usa (usuario: la del simulador). Si no: bots y fantasma pedalean a
   * 85–95 rpm fijos segun su id; el usuario sin sensor de cadencia, 90 rpm. Detenido: 0.
   */
  function riderCadence(kind, cadenceRpm, speedMps, id) {
    if (cadenceRpm != null && isFinite(cadenceRpm)) return Math.max(0, +cadenceRpm);
    if (!(speedMps >= MIN_SPEED_MPS)) return 0;
    if (kind === 'user') return 90;
    return 85 + (hashId(id) % 11);
  }

  /** Velocidad angular de la rueda (rad/s): omega = v / r. */
  function wheelOmega(speedMps, radiusM) {
    var r = radiusM > 0.05 ? radiusM : WHEEL_RADIUS_M;
    return speedMps > 0 ? speedMps / r : 0;
  }

  /**
   * Nivel de detalle: 'model' (glTF completo) | 'proc' (ciclista procedural).
   * o = { distM, kind, quality, prev, modelReady }. Calidad baja: solo usuario y fantasma usan el modelo.
   * Con histeresis: un ciclista que ya usa el modelo lo conserva hasta LOD_MODEL_M + LOD_HYSTERESIS_M.
   */
  function chooseLod(o) {
    if (!o || !o.modelReady) return 'proc';
    if (o.quality === 'baja' && o.kind !== 'user' && o.kind !== 'ghost') return 'proc';
    var limit = o.prev === 'model' ? LOD_MODEL_M + LOD_HYSTERESIS_M : LOD_MODEL_M;
    return o.distM < limit ? 'model' : 'proc';
  }

  // equipos de bots: maillot, cuadro, cabello y piel (hex sRGB). Ninguno usa el naranja del usuario ni el dorado del fantasma.
  var BOT_TEAMS = [
    { name: 'celeste', jersey: 0x7FA7C9, frame: 0xE8EBEE, hair: 0x2A1E16, skin: 0xC99272 },
    { name: 'rojo',    jersey: 0xC62F3A, frame: 0x1D1F24, hair: 0x14110F, skin: 0xE0B08E },
    { name: 'verde',   jersey: 0x2F8F5B, frame: 0xD8DDE2, hair: 0x6B4A2E, skin: 0xB57C5A },
    { name: 'morado',  jersey: 0x6A4FB3, frame: 0x2B2F36, hair: 0xC9A66B, skin: 0xEAC3A2 },
    { name: 'blanco',  jersey: 0xEDEFF2, frame: 0x2E6FD8, hair: 0x3B2A1E, skin: 0x8D5A3E },
    { name: 'negro',   jersey: 0x22252B, frame: 0xD9C21F, hair: 0x9A9A98, skin: 0xD7A07D },
    { name: 'turquesa', jersey: 0x1FA7A1, frame: 0x14161A, hair: 0x5A3A22, skin: 0xC4865F },
    { name: 'rosado',  jersey: 0xD9578E, frame: 0xF2F2F2, hair: 0x1C1714, skin: 0xE6B997 }
  ];

  /** Equipo de un bot segun su orden de aparicion (index) o, si no hay, su id. */
  function botTeam(index, id) {
    var k = index >= 0 ? index : hashId(id);
    return BOT_TEAMS[k % BOT_TEAMS.length];
  }

  /** Papel de un material del modelo segun su nombre (y si lleva textura de rostro). */
  function materialRole(name, hasMap) {
    var n = stripAccents(name).toLowerCase();
    if (hasMap || /rostro/.test(n)) return 'face';
    if (/lente/.test(n)) return 'lenses';
    if (/maillot/.test(n)) return 'jersey';
    if (/cuadro/.test(n)) return 'frame';
    if (/cabello|pelo/.test(n)) return 'hair';
    if (/piel/.test(n)) return 'skin';
    return 'other';
  }

  R.cyclist = {
    WHEEL_RADIUS_M: WHEEL_RADIUS_M,
    LOD_MODEL_M: LOD_MODEL_M,
    LOD_HYSTERESIS_M: LOD_HYSTERESIS_M,
    MIN_SPEED_MPS: MIN_SPEED_MPS,
    BOT_TEAMS: BOT_TEAMS,
    classifyWheelNode: classifyWheelNode,
    cadenceTimeScale: cadenceTimeScale,
    riderCadence: riderCadence,
    wheelOmega: wheelOmega,
    chooseLod: chooseLod,
    botTeam: botTeam,
    materialRole: materialRole,
    hashId: hashId
  };
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
