// Prueba local: simula D1 con SQLite de Node y captura las llamadas a Telegram.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import worker, { correrRecordatorios, manejarUpdate, interpretarFecha } from '../src/index.js';

function crearD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    first: async () => db.prepare(sql).get(...params) ?? null,
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...params).changes) } }),
  });
  return { prepare: (sql) => stmt(sql), batch: async (s) => Promise.all(s.map((x) => x.run())), raw: db };
}

let enviados = [];
globalThis.fetch = async (url, opts) => {
  enviados.push({ metodo: url.split('/').pop(), ...JSON.parse(opts.body) });
  return new Response('{"ok":true}');
};

const env = { DB: crearD1(), TELEGRAM_TOKEN: 'x', CHAT_ID: '111', WEBHOOK_SECRET: 's3cret' };
const a = (iso, horaCol) => Date.parse(`${iso}T${String(horaCol + 5).padStart(2, '0')}:00:00Z`); // hora Colombia → epoch
const textos = () => enviados.filter((e) => e.metodo === 'sendMessage').map((e) => e.text);

// 1. Fechas
assert.equal(interpretarFecha('04-12', '2026-11-25'), '2026-12-04');
assert.equal(interpretarFecha('4', '2026-11-25'), '2026-12-04');
assert.equal(interpretarFecha('28', '2026-11-25'), '2026-11-28');
assert.equal(interpretarFecha('05/01', '2026-12-20'), '2027-01-05');

// 1b. Instalación el 25 nov: lo de noviembre ya pasó → no avisa nada vencido
enviados = [];
assert.equal(await correrRecordatorios(env, a('2026-11-25', 8)), 0);

// 2. 30 nov 8am: luz y gas vencen el 5 dic → 5 días → avisa ambas
enviados = [];
assert.equal(await correrRecordatorios(env, a('2026-11-30', 8)), 2);
assert.match(textos()[0], /Luz CENS|Gas/);
assert.match(textos()[0], /<code>(485064|168979)<\/code>/);

// 3. 1 dic: 4 días → no avisa
enviados = [];
assert.equal(await correrRecordatorios(env, a('2026-12-01', 8)), 0);

// 4. Registro fecha real de luz: 4 dic, $85.400
enviados = [];
await manejarUpdate({ message: { chat: { id: 111 }, text: '/llego luz 04-12 85.400' } }, env, a('2026-12-01', 9));
assert.match(textos()[0], /Registrado[\s\S]*Vence en 3 días \(4 dic\)[\s\S]*\$85\.400/);

// 5. 2 dic mañana: luz a 2 días y gas a 3 → solo luz
enviados = [];
assert.equal(await correrRecordatorios(env, a('2026-12-02', 8)), 1);
const boton = enviados[0].reply_markup.inline_keyboard[0];
assert.equal(boton[0].url, 'https://sites.placetopay.com/censcentraleselectricasdelns/login');

// 6. Toco "✅ Pagué"
enviados = [];
await manejarUpdate({ callback_query: { id: 'q', data: boton[1].callback_data, message: { chat: { id: 111 }, message_id: 9 } } }, env, a('2026-12-02', 10));
assert.deepEqual(enviados.map((e) => e.metodo), ['answerCallbackQuery', 'editMessageText']);
assert.match(enviados[1].text, /Luz CENS.*pagada el 2 dic/);

// 7. 5 dic: gas vence hoy (mañana y tarde), luz ya no
enviados = [];
assert.equal(await correrRecordatorios(env, a('2026-12-05', 8)), 1);
assert.equal(await correrRecordatorios(env, a('2026-12-05', 18)), 1);
assert.match(textos()[1], /Gas[\s\S]*Vence HOY/);

// 8. 7 dic: gas vencida → insiste
enviados = [];
assert.equal(await correrRecordatorios(env, a('2026-12-07', 8)), 1);
assert.match(textos()[0], /VENCIDA hace 2 días/);

// 9. /pague gas y /pagos
await manejarUpdate({ message: { chat: { id: 111 }, text: '/pague gas' } }, env, a('2026-12-07', 9));
enviados = [];
await manejarUpdate({ message: { chat: { id: 111 }, text: '/pagos' } }, env, a('2026-12-07', 9));
const t = textos().join('\n---\n');
assert.match(t, /Internet Movistar[\s\S]*Agua Veolia/);      // pendientes del 20 dic
assert.match(t, /Más adelante<\/b>\n🗓 Luz CENS: 5 ene aprox\./); // enero va resumido
assert.doesNotMatch(t, /20 ene/);                                // más de 35 días: no aparece
assert.match(t, /Pagadas este mes<\/b>\n✅ Gas[^\n]*\n✅ Luz CENS \(2 dic, \$85\.400\)/);

// 10. Extraño → ignorado; webhook sin secreto → 403
enviados = [];
await manejarUpdate({ message: { chat: { id: 999 }, text: '/pagos' } }, env);
assert.equal(enviados.length, 0);
const r = await worker.fetch(new Request('https://x/webhook', { method: 'POST', body: '{}' }), env);
assert.equal(r.status, 403);

console.log('✅ Todas las pruebas pasaron');
