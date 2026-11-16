'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
require('../src/voicepack.js');
const V = globalThis.R.voicepack;

// Reconstruye el texto hablado a partir de las claves, usando el texto de cada clip
const textOf = Object.fromEntries(V.VOCAB.map((e) => [e.key, e.text]));
const say = (keys) => keys.map((k) => textOf[k]).join(' ');

test('vocabulario: claves únicas y todas las del brief presentes', () => {
  const keys = V.VOCAB.map((e) => e.key);
  assert.strictEqual(new Set(keys).size, keys.length);
  for (const p of ['¡Vamos!', '¡Recupera!', '¡Arriba! De pie', 'Nos sentamos', 'Prepárate:', 'Siguiente escalón:', 'Mitad del intervalo', 'Último minuto',
    'Cadencia', 'vatios', 'segundos', 'minuto', 'minutos', 'y medio', 'Kilómetro', 'quedan', 'coma', 'Últimos 500 metros', '¡Meta! ¡Bien hecho!',
    'Tres, dos, uno… ¡terminamos! Buen trabajo', 'Pausa', 'Seguimos', '¡Pasaste a tu mejor marca!', 'Tu mejor marca se adelanta, ¡vamos!', 'Resistencia',
    'Sube a resistencia', 'Baja a resistencia', 'Hidratación: toma agua', '¡El pelotón ataca! Síguelos', 'Bien, sigues con el grupo',
    'Se te escapó el grupo, ¡vamos!', 'a ritmo suave', 'Muro de', 'por ciento']) {
    assert.ok(V.VOCAB.some((e) => e.text === p), 'falta ' + p);
  }
});

test('números 0–100: clip propio hasta 30 y decenas; 31–99 = decena + y + unidad', () => {
  for (let n = 0; n <= 100; n++) {
    const k = V.compose(String(n));
    assert.strictEqual(k.length, n <= 30 || n % 10 === 0 ? 1 : 3, 'n=' + n);
    k.forEach((x) => assert.ok(textOf[x], 'n=' + n));
  }
  assert.strictEqual(say(V.compose('55')), 'cincuenta y cinco');
  assert.strictEqual(say(V.compose('100')), 'cien');
});

test('números compuestos 101–999 y mil', () => {
  assert.strictEqual(say(V.compose('255')), 'doscientos cincuenta y cinco');
  assert.deepStrictEqual(V.compose('255'), ['c2', 'n50', 'y', 'n5']);
  assert.strictEqual(say(V.compose('101')), 'ciento uno');
  assert.strictEqual(say(V.compose('150')), 'ciento cincuenta');
  assert.strictEqual(say(V.compose('300')), 'trescientos');
  assert.strictEqual(say(V.compose('999')), 'novecientos noventa y nueve');
  assert.strictEqual(say(V.compose('1000')), 'mil');
  assert.strictEqual(V.compose('1001'), null);
  for (let n = 0; n <= 999; n++) assert.ok(V.compose(String(n)), 'n=' + n);
});

test('uno concordado con sustantivos masculinos (un minuto, veintiún segundos)', () => {
  assert.strictEqual(say(V.compose('1 minuto')), 'un minuto');
  assert.strictEqual(say(V.compose('21 segundos')), 'veintiún segundos');
  assert.strictEqual(say(V.compose('31 segundos')), 'treinta y un segundos');
  assert.strictEqual(say(V.compose('101 vatios')), 'ciento un vatios');
  assert.strictEqual(say(V.compose('Kilómetro 1')), 'Kilómetro uno');
});

test('frases del coach se componen', () => {
  assert.strictEqual(say(V.compose('Resistencia 5')), 'Resistencia cinco');
  assert.strictEqual(say(V.compose('Sube a resistencia 6')), 'Sube a resistencia seis');
  assert.strictEqual(say(V.compose('Baja a resistencia 3')), 'Baja a resistencia tres');
  assert.strictEqual(say(V.compose('Hidratación: toma agua, 45 segundos')), 'Hidratación: toma agua cuarenta y cinco segundos');
  assert.strictEqual(say(V.compose('Prepárate: 4 minutos a 215 vatios')), 'Prepárate: cuatro minutos a doscientos quince vatios');
  assert.strictEqual(say(V.compose('Prepárate: 1 minuto y medio a ritmo suave')), 'Prepárate: un minuto y medio a ritmo suave');
  assert.strictEqual(say(V.compose('Prepárate: 1 minuto y 15 segundos a 300 vatios')), 'Prepárate: un minuto y quince segundos a trescientos vatios');
  assert.strictEqual(say(V.compose('Kilómetro 3, quedan 4 coma 5')), 'Kilómetro tres quedan cuatro coma cinco');
  assert.strictEqual(say(V.compose('¡Arriba! Muro de 12 por ciento')), '¡Arriba! Muro de doce por ciento');
  assert.strictEqual(say(V.compose('Cadencia 95')), 'Cadencia noventa y cinco');
  assert.strictEqual(say(V.compose('Siguiente escalón: 180 vatios')), 'Siguiente escalón: ciento ochenta vatios');
  assert.strictEqual(V.compose('Tres').length, 1);
  assert.strictEqual(say(V.compose('Tres, dos, uno, ¡vamos!')), 'tres dos uno ¡Vamos!');
  assert.ok(V.compose('¡Arriba! Tres, dos, uno, ¡vamos!'));
  assert.ok(V.compose('¡Arriba! 20 segundos de pie para soltar las piernas'));
  for (const t of ['¡Vamos!', '¡Recupera!', '¡Arriba! De pie', 'Nos sentamos', 'Mitad del intervalo', 'Último minuto', 'Últimos quinientos metros',
    '¡Meta! ¡Bien hecho!', '¡Terminamos! Buen trabajo', 'Tres, dos, uno… ¡terminamos! Buen trabajo', 'Pausa', 'Seguimos',
    '¡Pasaste a tu mejor marca!', 'Tu mejor marca se adelanta, ¡vamos!', '¡El pelotón ataca! Síguelos', 'Bien, sigues con el grupo', 'Se te escapó el grupo, ¡vamos!']) {
    assert.ok(V.compose(t), t);
  }
});

test('frase más larga gana: "Arriba de pie" es un solo clip', () => {
  assert.strictEqual(V.compose('¡Arriba! De pie').length, 1);
  assert.strictEqual(V.compose('Últimos quinientos metros').length, 1);
});

test('frases desconocidas o vacías devuelven null (respaldo speechSynthesis)', () => {
  assert.strictEqual(V.compose('No pudimos guardar la rodada'), null);
  assert.strictEqual(V.compose('Pausa extraterrestre'), null);
  assert.strictEqual(V.compose(''), null);
  assert.strictEqual(V.compose(null), null);
  assert.strictEqual(V.compose('Resistencia 5000'), null);
});

test('data/voice/es-mx.json (si existe) trae exactamente las claves del vocabulario y ≤ 700 KB', () => {
  const f = path.join(__dirname, '..', 'data', 'voice', 'es-mx.json');
  if (!fs.existsSync(f)) return;
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(j.voice && j.license);
  assert.deepStrictEqual(Object.keys(j.clips).sort(), V.VOCAB.map((e) => e.key).sort());
  assert.ok(fs.statSync(f).size <= 700 * 1024, 'pack demasiado grande');
});
