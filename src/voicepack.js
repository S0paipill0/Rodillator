/* Rodillator — Paquete de voz pregrabado (vocabulario y composición de frases).
 * Los clips se generan offline con tools/bake_voice.py (Piper es_MX "claude") a partir de R.voicepack.VOCAB
 * y se embeben en window.R_VOICE = { voice, license, clips: { clave: base64 mp3 } }.
 * compose(texto) → lista de claves de clips, o null si la frase no se puede componer (→ respaldo speechSynthesis). */
(function (R) {
  'use strict';

  var UNITS = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince',
    'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis',
    'veintisiete', 'veintiocho', 'veintinueve'];
  var TENS = { 3: 'treinta', 4: 'cuarenta', 5: 'cincuenta', 6: 'sesenta', 7: 'setenta', 8: 'ochenta', 9: 'noventa' };
  var HUNDREDS = { 2: 'doscientos', 3: 'trescientos', 4: 'cuatrocientos', 5: 'quinientos', 6: 'seiscientos', 7: 'setecientos', 8: 'ochocientos', 9: 'novecientos' };

  function numberWords(n) { // 0..100
    if (n === 100) return 'cien';
    if (n < 30) return UNITS[n];
    var t = Math.floor(n / 10), u = n % 10;
    return TENS[t] + (u ? ' y ' + UNITS[u] : '');
  }

  // Frases fijas: key, text (lo que se graba) y match (opcional: texto con el que se reconoce en el aviso)
  var PHRASES = [
    ['vamos', '¡Vamos!'], ['recupera', '¡Recupera!'], ['arriba', '¡Arriba!'], ['arriba_de_pie', '¡Arriba! De pie'], ['nos_sentamos', 'Nos sentamos'],
    ['de_pie_soltar_piernas', 'de pie para soltar las piernas'],
    ['preparate', 'Prepárate:'], ['siguiente_escalon', 'Siguiente escalón:'], ['mitad_intervalo', 'Mitad del intervalo'], ['ultimo_minuto', 'Último minuto'],
    ['cadencia', 'Cadencia'], ['vatios', 'vatios'], ['segundos', 'segundos'], ['segundo', 'segundo'], ['minuto', 'minuto'], ['minutos', 'minutos'], ['y_medio', 'y medio'],
    ['y', 'y'], ['a', 'a'], ['kilometro', 'Kilómetro'], ['quedan', 'quedan'], ['coma', 'coma'],
    ['ultimos_500', 'Últimos 500 metros', 'Últimos quinientos metros'],
    ['meta', '¡Meta! ¡Bien hecho!'], ['terminamos', '¡Terminamos! Buen trabajo'],
    ['cuenta_terminamos', 'Tres, dos, uno… ¡terminamos! Buen trabajo'],
    ['pausa', 'Pausa'], ['seguimos', 'Seguimos'],
    ['pasaste_marca', '¡Pasaste a tu mejor marca!'], ['marca_adelanta', 'Tu mejor marca se adelanta, ¡vamos!'],
    ['resistencia', 'Resistencia'], ['sube_resistencia', 'Sube a resistencia'], ['baja_resistencia', 'Baja a resistencia'],
    ['hidratacion', 'Hidratación: toma agua'],
    ['pelo_ataca', '¡El pelotón ataca! Síguelos'], ['pelo_sigues', 'Bien, sigues con el grupo'], ['pelo_escapo', 'Se te escapó el grupo, ¡vamos!'],
    ['ritmo_suave', 'a ritmo suave'], ['muro_de', 'Muro de'], ['por_ciento', 'por ciento']
  ];

  var VOCAB = [];
  var table = []; // { tokens, keys }
  var MASC = { minuto: 1, minutos: 1, segundo: 1, segundos: 1, vatios: 1, metros: 1, kilómetros: 1 };

  function tokenize(text) {
    return String(text).toLowerCase().replace(/[¡!¿?.,:;…"“”()]/g, ' ').split(/\s+/).filter(Boolean);
  }

  PHRASES.forEach(function (p) {
    VOCAB.push({ key: p[0], text: p[1] });
    table.push({ tokens: tokenize(p[2] || p[1]), keys: [p[0]] });
  });
  // "Uno/Dos/Tres" de la cuenta regresiva son los clips numéricos n1..n3
  var i;
  // Presupuesto de tamaño (≤ 700 KB): clip propio para 0–30 y las decenas hasta 100; 31–99 = decena + "y" + unidad
  for (i = 0; i <= 100; i++) if (i <= 30 || i % 10 === 0) VOCAB.push({ key: 'n' + i, text: numberWords(i) });
  VOCAB.push({ key: 'un', text: 'un' });
  VOCAB.push({ key: 'n21un', text: 'veintiún' });
  VOCAB.push({ key: 'ciento', text: 'ciento' });
  Object.keys(HUNDREDS).forEach(function (h) { VOCAB.push({ key: 'c' + h, text: HUNDREDS[h] }); });
  VOCAB.push({ key: 'mil', text: 'mil' });

  // frases más largas primero (gana la coincidencia más larga)
  table.sort(function (a, b) { return b.tokens.length - a.tokens.length; });

  var NUMWORD = { uno: 1, dos: 2, tres: 3 };

  function below100(n, masc) {
    if (masc && n === 1) return ['un'];
    if (masc && n === 21) return ['n21un'];
    if (n <= 30 || n % 10 === 0) return ['n' + n];
    var u = n % 10;
    return ['n' + (n - u), 'y', masc && u === 1 ? 'un' : 'n' + u];
  }
  function numberKeys(n, masc) {
    if (n <= 100) return below100(n, masc);
    if (n === 1000) return ['mil'];
    if (n > 999) return null;
    var h = Math.floor(n / 100), r = n % 100;
    var head = h === 1 ? 'ciento' : 'c' + h;
    return r === 0 ? [head] : [head].concat(below100(r, masc));
  }

  function compose(text) {
    if (typeof text !== 'string') return null;
    var tk = tokenize(text);
    if (!tk.length) return null;
    var out = [], pos = 0;
    while (pos < tk.length) {
      var hit = null, j;
      for (j = 0; j < table.length && !hit; j++) {
        var t = table[j].tokens, ok = t.length <= tk.length - pos;
        for (var k = 0; ok && k < t.length; k++) if (t[k] !== tk[pos + k]) ok = false;
        if (ok) hit = table[j];
      }
      if (hit) { out.push.apply(out, hit.keys); pos += hit.tokens.length; continue; }
      var w = tk[pos], n = null;
      if (/^\d+$/.test(w)) n = parseInt(w, 10);
      else if (NUMWORD[w]) n = NUMWORD[w];
      if (n === null) return null;
      var keys = numberKeys(n, !!MASC[tk[pos + 1]]);
      if (!keys) return null;
      out.push.apply(out, keys); pos++;
    }
    return out;
  }

  R.voicepack = { VOCAB: VOCAB, compose: compose, numberWords: numberWords };
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
