/**
 * Bill notifier — Cloudflare Worker + D1 + Telegram
 *
 * - scheduled(): corre a las 8:00 a. m. y 6:00 p. m. hora Colombia y envía recordatorios.
 * - fetch():     recibe el webhook de Telegram (comandos y botones).
 *
 * Variables (wrangler.toml / secrets):
 *   TELEGRAM_TOKEN  (secret)  token de @BotFather
 *   WEBHOOK_SECRET  (secret)  texto aleatorio para validar que las llamadas vienen de Telegram
 *   CHAT_ID         (var)     tu chat_id; el bot ignora a cualquier otra persona
 *   DB              (binding) base de datos D1
 */

const OFFSET_COLOMBIA_MS = -5 * 60 * 60 * 1000; // Colombia no tiene horario de verano
const DIA_MS = 24 * 60 * 60 * 1000;
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// ───────────────────────── Fechas ─────────────────────────

export function hoyColombia(now = Date.now()) {
  return new Date(now + OFFSET_COLOMBIA_MS).toISOString().slice(0, 10);
}

function horaColombia(now = Date.now()) {
  return new Date(now + OFFSET_COLOMBIA_MS).getUTCHours();
}

function diasEntre(desde, hasta) {
  return Math.round((Date.parse(hasta + 'T00:00:00Z') - Date.parse(desde + 'T00:00:00Z')) / DIA_MS);
}

function sumarMeses(mes, n) {
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

function fechaDelMes(mes, dia) {
  const [a, m] = mes.split('-').map(Number);
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return `${mes}-${String(Math.min(dia, ultimo)).padStart(2, '0')}`;
}

function fechaCorta(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MESES[m - 1]}`;
}

/** Acepta "8", "08-12" / "8/12" (día-mes, como en Colombia) o "2026-12-08". Si falta mes/año, toma la próxima fecha que coincida. */
export function interpretarFecha(texto, hoy) {
  let m;
  if ((m = texto.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  }
  const mesHoy = hoy.slice(0, 7);
  if ((m = texto.match(/^(\d{1,2})[-/](\d{1,2})$/))) {
    const [dia, mesN] = [Number(m[1]), Number(m[2])];
    if (mesN < 1 || mesN > 12 || dia < 1 || dia > 31) return null;
    let anio = Number(hoy.slice(0, 4));
    let f = `${anio}-${String(mesN).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
    if (diasEntre(hoy, f) < -60) f = `${anio + 1}${f.slice(4)}`;
    return f;
  }
  if ((m = texto.match(/^(\d{1,2})$/))) {
    const dia = Number(m[1]);
    const f = fechaDelMes(mesHoy, dia);
    return diasEntre(hoy, f) < -10 ? fechaDelMes(sumarMeses(mesHoy, 1), dia) : f;
  }
  return null;
}

function interpretarValor(texto) {
  if (!texto) return null;
  const limpio = texto.replace(/[$.\s,]/g, '');
  return /^\d+$/.test(limpio) ? Number(limpio) : null;
}

function pesos(n) {
  return '$' + n.toLocaleString('es-CO').replace(/,/g, '.');
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ───────────────────────── Datos ─────────────────────────

/** Crea (si no existen) los ciclos del mes actual y el siguiente con la fecha estimada. */
export async function asegurarCiclos(db, hoy) {
  const { results: facturas } = await db.prepare('SELECT clave, dia_habitual, fecha_fija FROM facturas WHERE activa = 1').all();
  const mesActual = hoy.slice(0, 7);
  const stmts = [];
  for (const mes of [mesActual, sumarMeses(mesActual, 1)]) {
    for (const f of facturas) {
      const fecha = fechaDelMes(mes, f.dia_habitual);
      // Un ciclo que nace con la fecha ya pasada (p. ej. el primer día que instalas el bot) no genera avisos.
      const estado = fecha < hoy ? 'omitida' : 'pendiente';
      stmts.push(
        db.prepare('INSERT OR IGNORE INTO ciclos (factura, mes, fecha_limite, estado, estimada) VALUES (?, ?, ?, ?, ?)')
          .bind(f.clave, mes, fecha, estado, f.fecha_fija ? 0 : 1),
      );
    }
  }
  if (stmts.length) await db.batch(stmts);
}

async function ciclosPendientes(db) {
  const { results } = await db.prepare(
    `SELECT c.*, f.nombre, f.referencia, f.url_pago
       FROM ciclos c JOIN facturas f ON f.clave = c.factura
      WHERE c.estado = 'pendiente' AND f.activa = 1
      ORDER BY c.fecha_limite`,
  ).all();
  return results;
}

// ───────────────────────── Mensajes ─────────────────────────

function estadoTexto(dias) {
  if (dias < 0) return `⚠️ <b>VENCIDA hace ${-dias} día${dias === -1 ? '' : 's'}</b>`;
  if (dias === 0) return '🔴 <b>Vence HOY</b>';
  if (dias === 1) return '🟠 Vence <b>mañana</b>';
  if (dias <= 2) return `🟠 Vence en <b>${dias} días</b>`;
  return `🟡 Vence en ${dias} días`;
}

export function mensajeRecordatorio(c, hoy) {
  const dias = diasEntre(hoy, c.fecha_limite);
  const lineas = [
    `<b>${esc(c.nombre)}</b>`,
    `${estadoTexto(dias)} (${fechaCorta(c.fecha_limite)}${c.estimada ? ', fecha aprox.' : ''})`,
  ];
  if (c.valor) lineas.push(`Valor: ${pesos(c.valor)}`);
  lineas.push('Referencia:', `<code>${esc(c.referencia)}</code>`);
  if (c.estimada) {
    lineas.push('', `<i>Cuando llegue el recibo: /llego ${c.factura} DD-MM valor</i>`);
  }
  return {
    text: lineas.join('\n'),
    reply_markup: {
      inline_keyboard: [[
        { text: '💳 Ir a pagar', url: c.url_pago },
        { text: '✅ Pagué', callback_data: `pague:${c.id}` },
      ]],
    },
  };
}

/** Reglas: mañana avisa a 5 días y luego todos los días desde 2 días antes; tarde solo si vence hoy o ya venció. */
export function debeAvisar(dias, turno) {
  if (turno === 'tarde') return dias <= 0;
  return dias === 5 || dias <= 2;
}

// ───────────────────────── Telegram ─────────────────────────

async function tg(env, metodo, cuerpo) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${metodo}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  if (!res.ok) console.error(`Telegram ${metodo} falló`, res.status, await res.text());
  return res;
}

function enviar(env, texto, extra = {}) {
  return tg(env, 'sendMessage', {
    chat_id: env.CHAT_ID,
    text: texto,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

// ───────────────────────── Recordatorios ─────────────────────────

export async function correrRecordatorios(env, now = Date.now()) {
  const hoy = hoyColombia(now);
  const turno = horaColombia(now) < 12 ? 'manana' : 'tarde';
  await asegurarCiclos(env.DB, hoy);
  const pendientes = await ciclosPendientes(env.DB);
  let enviados = 0;
  for (const c of pendientes) {
    if (debeAvisar(diasEntre(hoy, c.fecha_limite), turno)) {
      const m = mensajeRecordatorio(c, hoy);
      await enviar(env, m.text, { reply_markup: m.reply_markup });
      enviados++;
    }
  }
  return enviados;
}

// ───────────────────────── Comandos ─────────────────────────

const AYUDA = [
  '<b>Bill notifier</b> 🧾',
  '',
  '/pagos: estado de todas las facturas con sus botones',
  '/llego <i>factura fecha [valor]</i>: registra la fecha real del recibo',
  '   ej: <code>/llego luz 04-12 85400</code> (día-mes; también vale <code>/llego luz 4</code>)',
  '/pague <i>factura</i>: marca como pagada la más próxima',
  '/deshacer <i>factura</i>: vuelve a pendiente el último pago',
  '/ayuda: este mensaje',
  '',
  'Facturas: <code>internet</code>, <code>luz</code>, <code>agua</code>, <code>gas</code>, <code>casa</code>',
].join('\n');

async function marcarPagada(db, id, hoy) {
  const r = await db.prepare(
    "UPDATE ciclos SET estado = 'pagada', fecha_pago = ? WHERE id = ? AND estado = 'pendiente'",
  ).bind(hoy, id).run();
  return r.meta?.changes > 0;
}

async function cmdPagos(env, hoy) {
  await asegurarCiclos(env.DB, hoy);
  const pendientes = await ciclosPendientes(env.DB);
  const { results: pagadas } = await env.DB.prepare(
    `SELECT c.*, f.nombre FROM ciclos c JOIN facturas f ON f.clave = c.factura
      WHERE c.estado = 'pagada' AND c.fecha_pago >= ? ORDER BY c.fecha_pago DESC`,
  ).bind(hoy.slice(0, 7) + '-01').all();

  // Tarjeta completa para lo de los próximos 15 días; lo demás en una sola línea
  const cercanas = pendientes.filter((c) => diasEntre(hoy, c.fecha_limite) <= 15);
  const lejanas = pendientes.filter((c) => {
    const d = diasEntre(hoy, c.fecha_limite);
    return d > 15 && d <= 35;
  });
  if (!cercanas.length) {
    await enviar(env, '🎉 Nada por pagar en los próximos 15 días.');
  }
  for (const c of cercanas) {
    const m = mensajeRecordatorio(c, hoy);
    await enviar(env, m.text, { reply_markup: m.reply_markup });
  }
  if (lejanas.length) {
    const lista = lejanas.map((c) => `🗓 ${esc(c.nombre)}: ${fechaCorta(c.fecha_limite)}${c.estimada ? ' aprox.' : ''}`);
    await enviar(env, '<b>Más adelante</b>\n' + lista.join('\n'));
  }
  if (pagadas.length) {
    const lista = pagadas.map((c) => `✅ ${esc(c.nombre)} (${fechaCorta(c.fecha_pago)}${c.valor ? ', ' + pesos(c.valor) : ''})`);
    await enviar(env, '<b>Pagadas este mes</b>\n' + lista.join('\n'));
  }
}

async function buscarFactura(db, clave) {
  if (!clave) return null;
  return db.prepare('SELECT * FROM facturas WHERE clave = ?').bind(clave.toLowerCase()).first();
}

async function cmdLlego(env, args, hoy) {
  const [clave, fechaTxt, valorTxt] = args;
  const f = await buscarFactura(env.DB, clave);
  const fecha = fechaTxt && interpretarFecha(fechaTxt, hoy);
  if (!f || !fecha) {
    return enviar(env, 'Uso: <code>/llego luz 04-12 85400</code> (día-mes)\nFacturas: internet, luz, agua, gas, casa');
  }
  const valor = interpretarValor(valorTxt);
  const mes = fecha.slice(0, 7);
  await env.DB.prepare(
    `INSERT INTO ciclos (factura, mes, fecha_limite, estimada, valor) VALUES (?, ?, ?, 0, ?)
     ON CONFLICT (factura, mes) DO UPDATE SET fecha_limite = excluded.fecha_limite, estimada = 0,
       valor = COALESCE(excluded.valor, ciclos.valor),
       estado = CASE WHEN ciclos.estado = 'omitida' THEN 'pendiente' ELSE ciclos.estado END`,
  ).bind(f.clave, mes, fecha, valor).run();
  const c = await env.DB.prepare(
    `SELECT c.*, f.nombre, f.referencia, f.url_pago FROM ciclos c JOIN facturas f ON f.clave = c.factura
      WHERE c.factura = ? AND c.mes = ?`,
  ).bind(f.clave, mes).first();
  const m = mensajeRecordatorio(c, hoy);
  await enviar(env, '📥 Registrado.\n\n' + m.text, { reply_markup: m.reply_markup });
}

async function cmdPague(env, args, hoy) {
  const f = await buscarFactura(env.DB, args[0]);
  if (!f) return enviar(env, 'Uso: <code>/pague luz</code>');
  const c = await env.DB.prepare(
    "SELECT id FROM ciclos WHERE factura = ? AND estado = 'pendiente' ORDER BY fecha_limite LIMIT 1",
  ).bind(f.clave).first();
  if (!c || !(await marcarPagada(env.DB, c.id, hoy))) {
    return enviar(env, `No hay facturas pendientes de ${esc(f.nombre)}.`);
  }
  await enviar(env, `✅ ${esc(f.nombre)} marcada como pagada. No te vuelvo a avisar hasta el próximo recibo.`);
}

async function cmdDeshacer(env, args) {
  const f = await buscarFactura(env.DB, args[0]);
  if (!f) return enviar(env, 'Uso: <code>/deshacer luz</code>');
  const c = await env.DB.prepare(
    "SELECT id FROM ciclos WHERE factura = ? AND estado = 'pagada' ORDER BY fecha_pago DESC, fecha_limite DESC LIMIT 1",
  ).bind(f.clave).first();
  if (!c) return enviar(env, `No hay pagos de ${esc(f.nombre)} para deshacer.`);
  await env.DB.prepare("UPDATE ciclos SET estado = 'pendiente', fecha_pago = NULL WHERE id = ?").bind(c.id).run();
  await enviar(env, `↩️ ${esc(f.nombre)} volvió a pendiente.`);
}

export async function manejarUpdate(update, env, now = Date.now()) {
  const hoy = hoyColombia(now);

  // Botón "✅ Pagué"
  if (update.callback_query) {
    const q = update.callback_query;
    if (String(q.message?.chat?.id) !== String(env.CHAT_ID)) return;
    const [accion, id] = (q.data || '').split(':');
    if (accion === 'pague') {
      const ok = await marcarPagada(env.DB, Number(id), hoy);
      await tg(env, 'answerCallbackQuery', {
        callback_query_id: q.id,
        text: ok ? '✅ Marcada como pagada' : 'Ya estaba pagada',
      });
      if (ok) {
        const f = await env.DB.prepare(
          'SELECT f.nombre FROM ciclos c JOIN facturas f ON f.clave = c.factura WHERE c.id = ?',
        ).bind(Number(id)).first();
        await tg(env, 'editMessageText', {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id,
          text: `✅ <s>${esc(f?.nombre || 'Factura')}</s> pagada el ${fechaCorta(hoy)}`,
          parse_mode: 'HTML',
        });
      }
    }
    return;
  }

  const msg = update.message;
  if (!msg?.text) return;
  const chatId = String(msg.chat.id);

  // Configuración inicial: si aún no hay CHAT_ID, le dice al usuario cuál es el suyo
  if (!env.CHAT_ID) {
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: `Tu chat_id es ${chatId}. Ponlo en CHAT_ID dentro de wrangler.toml y vuelve a desplegar.`,
    });
    return;
  }
  if (chatId !== String(env.CHAT_ID)) return; // ignora a cualquier otra persona

  const [cmdRaw, ...args] = msg.text.trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase().split('@')[0];
  switch (cmd) {
    case '/pagos': return cmdPagos(env, hoy);
    case '/llego': return cmdLlego(env, args, hoy);
    case '/pague': return cmdPague(env, args, hoy);
    case '/deshacer': return cmdDeshacer(env, args);
    case '/probar': return correrRecordatoriosForzado(env, now);
    default: return enviar(env, AYUDA);
  }
}

/** /probar: envía como si fuera la corrida de la mañana, para comprobar que todo funciona. */
async function correrRecordatoriosForzado(env, now) {
  const n = await correrRecordatorios(env, now - (horaColombia(now) >= 12 ? 12 * 3600 * 1000 : 0));
  if (!n) await enviar(env, 'Corrida de prueba: hoy no toca ningún recordatorio. Usa /pagos para ver todo.');
}

// ───────────────────────── Entradas del Worker ─────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/webhook') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const update = await request.json();
      try {
        await manejarUpdate(update, env);
      } catch (e) {
        console.error(e);
      }
      return new Response('ok'); // siempre 200 para que Telegram no reintente en bucle
    }
    return new Response('Bill notifier activo', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(correrRecordatorios(env, event.scheduledTime));
  },
};
