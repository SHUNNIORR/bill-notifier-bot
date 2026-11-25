# Bill notifier 🧾

Bot de Telegram que te recuerda pagar tus servicios y te sigue avisando hasta que confirmes el pago.
Corre en **Cloudflare Workers** con base de datos **D1**. No necesita servidor propio.

## Cómo funciona

| Factura | Referencia | Vence aprox. |
|---|---|---|
| Internet Movistar | 2512455426 | día 20 |
| Luz CENS | 485064 | día 5 |
| Agua Veolia | 210712 | día 20 |
| Gas Gases del Oriente | 168979 | día 5 |

**Avisos** (8:00 a. m. y 6:00 p. m. hora Colombia):

- 5 días antes: un aviso.
- Desde 2 días antes: todos los días en la mañana.
- El día que vence y si ya venció: mañana y tarde, hasta que marques la factura como pagada.

Cada aviso trae la referencia lista para copiar (tócala), **💳 Ir a pagar**, que abre la pasarela, y **✅ Pagué**, que la silencia hasta el próximo mes.

**Comandos**

- `/pagos` muestra lo pendiente, lo próximo y lo pagado este mes.
- `/llego luz 04-12 85400` registra la fecha real (día-mes) y el valor cuando llega el recibo. También sirve `/llego luz 4`.
- `/pague gas` marca una factura como pagada sin tocar el botón.
- `/deshacer gas` sirve si la marcaste por error.
- `/probar` lanza la revisión de la mañana en el momento.

Si no registras la fecha real, el bot usa el día aproximado de la tabla.

## Instalación (unos 15 minutos)

Requisitos: Node.js 18 o superior y tu cuenta de Cloudflare.

### 1. Crea el bot en Telegram
1. En Telegram, abre **@BotFather**, envía `/newbot` y sigue los pasos.
2. Guarda el **token** que te da, algo como `123456:ABC...`.

### 2. Prepara el proyecto
```bash
cd bill-notifier
npm install
npx wrangler login
```

### 3. Crea la base de datos D1
```bash
npx wrangler d1 create bill-notifier
```
Copia el `database_id` que aparece y pégalo en `wrangler.toml`. Luego crea las tablas:
```bash
npm run db:init
```

### 4. Guarda los secretos
```bash
npx wrangler secret put TELEGRAM_TOKEN     # pega el token de BotFather
npx wrangler secret put WEBHOOK_SECRET     # inventa un texto largo, p. ej. bills-7f3k9q2m8x
```

### 5. Despliega
```bash
npm run deploy
```
Anota la URL que te da, algo como `https://bill-notifier.TU-USUARIO.workers.dev`.

### 6. Conecta Telegram con el Worker
Reemplaza TOKEN, URL y SECRETO, y ejecuta:
```bash
curl "https://api.telegram.org/botTOKEN/setWebhook" \
  -d "url=https://bill-notifier.TU-USUARIO.workers.dev/webhook" \
  -d "secret_token=SECRETO"
```
Opcional, para que aparezca el menú de comandos en Telegram:
```bash
curl "https://api.telegram.org/botTOKEN/setMyCommands" -H "content-type: application/json" \
  -d '{"commands":[{"command":"pagos","description":"Ver estado de facturas"},{"command":"llego","description":"Registrar recibo: factura DD-MM valor"},{"command":"pague","description":"Marcar como pagada"},{"command":"deshacer","description":"Deshacer pago"},{"command":"probar","description":"Probar avisos ahora"}]}'
```

### 7. Restringe el bot a tu chat
1. Escríbele cualquier cosa a tu bot. Te responde con tu `chat_id`.
2. Pégalo en `CHAT_ID` dentro de `wrangler.toml` y vuelve a desplegar con `npm run deploy`.
3. Envía `/pagos` para confirmar que todo funciona.

Desde aquí el bot ignora a cualquier otra persona.

## Mantenimiento

- **Ver errores en vivo:** `npm run logs`
- **Cambiar el día aproximado de una factura:**
  ```bash
  npx wrangler d1 execute bill-notifier --remote --command "UPDATE facturas SET dia_habitual = 18 WHERE clave = 'internet'"
  ```
  Afecta los meses que aún no se han creado. Para el mes en curso usa `/llego`.
- **Cambiar un link de pago:** usa el mismo comando con `SET url_pago = '...'`.
- **Pruebas locales:** `npm test` (simula D1 y Telegram, no envía nada real).

## Notas

- Las facturas del mes en que instalas el bot que ya vencieron quedan como *omitidas* y no generan avisos. Si alguna sigue sin pagar, regístrala con `/llego` y vuelve a quedar pendiente.
- **No** ejecutes `npm run db:init` otra vez después de instalar: borra el historial.
- Cloudflare programa los crons en UTC: `0 13 * * *` = 8:00 a. m. y `0 23 * * *` = 6:00 p. m. en Colombia.
