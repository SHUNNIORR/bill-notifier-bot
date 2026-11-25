-- Bill notifier: esquema D1
DROP TABLE IF EXISTS ciclos;
DROP TABLE IF EXISTS facturas;

-- Catálogo fijo de facturas
CREATE TABLE facturas (
  clave        TEXT PRIMARY KEY,          -- nombre corto para comandos: internet, luz, agua, gas, casa
  nombre       TEXT NOT NULL,
  referencia   TEXT NOT NULL,             -- contrato / ID de usuario
  url_pago     TEXT NOT NULL,
  dia_habitual INTEGER NOT NULL,          -- día del mes en que suele vencer (respaldo)
  activa       INTEGER NOT NULL DEFAULT 1,
  fecha_fija   INTEGER NOT NULL DEFAULT 0  -- 1 = siempre vence el mismo día (no pide /llego)
);

-- Un registro por factura por mes
CREATE TABLE ciclos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  factura      TEXT NOT NULL REFERENCES facturas(clave),
  mes          TEXT NOT NULL,             -- 'AAAA-MM'
  fecha_limite TEXT NOT NULL,             -- 'AAAA-MM-DD'
  estimada     INTEGER NOT NULL DEFAULT 1,-- 1 = calculada con dia_habitual, 0 = la registraste con /llego
  valor        INTEGER,                   -- pesos, opcional
  estado       TEXT NOT NULL DEFAULT 'pendiente', -- 'pendiente' | 'pagada' | 'omitida' (ya vencida al instalar el bot)
  fecha_pago   TEXT,
  UNIQUE (factura, mes)
);

INSERT INTO facturas (clave, nombre, referencia, url_pago, dia_habitual, fecha_fija) VALUES
  ('internet', 'Internet Movistar',             '2512455426',  'https://mi.tigo.com.co/pago-express/facturas?origin=web',                  20, 0),
  ('luz',      'Luz CENS',                      '485064',      'https://sites.placetopay.com/censcentraleselectricasdelns/login',          8, 0),
  ('agua',     'Agua Veolia',                   '210712',      'https://appexp.akc.co/appexp/servlet/serviciosEnLinea/pago/#/',            20, 0),
  ('gas',      'Gas Gases del Oriente',         '168979',      'https://pasarelapagos.gasesdeloriente.com.co/',                            11, 0),
  ('casa',     'Crédito casa Banco de Bogotá',  '01154498085', 'https://www.avalpaycenter.com/wps/portal/portal-de-pagos/web/pagos-aval', 10, 1);
