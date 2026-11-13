/**
 * Banco de dados do portal de acesso.
 *
 * DOIS BACKENDS, MESMA API:
 *  - SQLite (node:sqlite, sem dependências) -> desenvolvimento local e VPS
 *  - Postgres (pg)                            -> Vercel (serverless não tem disco)
 *
 * O store é escolhido pela URL: se existir POSTGRES_URL/DATABASE_URL usa
 * Postgres, senão usa o arquivo SQLite. A API exposta é a mesma nos dois:
 *
 *   await store.exec(sql)
 *   await store.prepare(sql).run(...params)   -> { changes, lastInsertRowid }
 *   await store.prepare(sql).get(...params)   -> linha | undefined
 *   await store.prepare(sql).all(...params)   -> linhas[]
 *
 * Guarda 4 coisas:
 *  - users     : contas (dono/administradores e convidados)
 *  - sessions  : cookies de quem está logado
 *  - attempts  : tentativas de login erradas (trava anti-força bruta)
 *  - audit     : histórico de ações (criou usuário, trocou senha, entrou...)
 */
import fs from 'node:fs';
import path from 'node:path';

/** Helpers de data em ISO (tudo em UTC, sem bagunça de fuso). */
export const nowIso = () => new Date().toISOString();

export function daysFromNow(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString();
}

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT    NOT NULL DEFAULT '',
  pw_hash      TEXT    NOT NULL,
  is_admin     INTEGER NOT NULL DEFAULT 0,
  disabled     INTEGER NOT NULL DEFAULT 0,
  must_change  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL,
  last_login   TEXT,
  expires_at   TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL,
  ip         TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS attempts (
  key          TEXT PRIMARY KEY,
  failed       INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,
  actor  TEXT,
  action TEXT NOT NULL,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);
`;

// Mesma estrutura no Postgres. `username` vira UNIQUE sobre LOWER(username)
// para ter o mesmo comportamento do COLLATE NOCASE do SQLite.
const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id           SERIAL   PRIMARY KEY,
  username     TEXT     NOT NULL,
  display_name TEXT     NOT NULL DEFAULT '',
  pw_hash      TEXT     NOT NULL,
  is_admin     INTEGER  NOT NULL DEFAULT 0,
  disabled     INTEGER  NOT NULL DEFAULT 0,
  must_change  INTEGER  NOT NULL DEFAULT 0,
  created_at   TEXT     NOT NULL,
  last_login   TEXT,
  expires_at   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (LOWER(username));

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL,
  ip         TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS attempts (
  key          TEXT PRIMARY KEY,
  failed       INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id     SERIAL  PRIMARY KEY,
  at     TEXT    NOT NULL,
  actor  TEXT,
  action TEXT    NOT NULL,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);
`;

/**
 * Converte os placeholders "?" (SQLite) para "$1, $2..." (Postgres),
 * ignorando "?" dentro de texto entre aspas.
 */
export function toPgPlaceholders(sql) {
  let out = '';
  let n = 0;
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      // '' é escape de aspa dentro do literal
      if (inStr && sql[i + 1] === "'") { out += "''"; i++; continue; }
      inStr = !inStr;
      out += c;
      continue;
    }
    if (c === '?' && !inStr) { n++; out += `$${n}`; continue; }
    out += c;
  }
  return out;
}

/**
 * Store em arquivo SQLite (local / VPS).
 *
 * O `node:sqlite` é importado sob demanda: no Node 22 ele existe mas exige
 * flag, e na Vercel (Postgres) nunca é carregado.
 */
async function openSqlite(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SQLITE_SCHEMA);
  return {
    kind: 'sqlite',
    exec: async (sql) => { db.exec(sql); },
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        run: async (...params) => stmt.run(...params),
        get: async (...params) => stmt.get(...params),
        all: async (...params) => stmt.all(...params),
      };
    },
    close: async () => db.close(),
  };
}

/**
 * Store Postgres a partir de um pool já pronto.
 * Separado da criação do pool para poder ser testado sem servidor.
 * @param {{query: Function, end?: Function}} pool
 */
export function createPgStore(pool) {
  return {
    kind: 'postgres',
    exec: async (sql) => { await pool.query(sql); },
    prepare(sql) {
      const converted = toPgPlaceholders(sql);
      // INSERT precisa devolver o id gerado (no SQLite vem do lastInsertRowid)
      const isInsert = /^\s*INSERT\s+INTO\s+/i.test(converted) && !/\bON\s+CONFLICT\b/i.test(converted);
      const finalSql = isInsert ? `${converted} RETURNING id` : converted;
      return {
        run: async (...params) => {
          const res = await pool.query(finalSql, params);
          return { changes: res.rowCount ?? 0, lastInsertRowid: res.rows?.[0]?.id ?? 0 };
        },
        get: async (...params) => (await pool.query(finalSql, params)).rows[0],
        all: async (...params) => (await pool.query(finalSql, params)).rows,
      };
    },
    close: async () => { await pool.end?.(); },
  };
}

/** Store Postgres (Vercel). */
async function openPostgres(url) {
  let pg;
  try {
    pg = await import('pg');
  } catch {
    throw new Error(
      'POSTGRES_URL definido mas o pacote "pg" não está instalado. Rode: npm install',
    );
  }
  const { Pool } = pg.default ?? pg;
  const ssl = sslFor(url);
  const pool = new Pool({
    connectionString: url,
    max: 5,
    ...(ssl ? { ssl } : {}),
  });
  const client = await pool.connect();
  try {
    await client.query(PG_SCHEMA);
  } finally {
    client.release();
  }
  return createPgStore(pool);
}

/**
 * SSL do Postgres.
 * Se a URL já traz sslmode= (padrão na Vercel/Neon), o próprio `pg` resolve
 * e não devemos sobrescrever. Só forzamos quando a URL não diz nada.
 */
function sslFor(url) {
  if (/sslmode=/i.test(url)) return null; // deixa o pg resolver
  if (/localhost|127\.0\.0\.1/i.test(url)) return null;
  return { rejectUnauthorized: false };
}

/**
 * Abre o banco. Sem URL -> SQLite em `file`; com URL -> Postgres.
 * @param {{url?: string, file: string}} opts
 */
export async function openDb(opts) {
  const url = opts.url || process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (url) return openPostgres(url);
  return openSqlite(opts.file);
}

/** Nome do backend em uso ('sqlite' ou 'postgres') — útil no log de boot. */
export function backendKind(url) {
  return url ? 'postgres' : 'sqlite';
}

/** Limpa sessões vencidas (chamado de vez em quando). */
export async function purgeExpiredSessions(db) {
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
}
