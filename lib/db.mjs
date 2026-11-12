/**
 * Banco de dados do portal de acesso (SQLite nativo do Node, sem dependências).
 *
 * Guarda 3 coisas:
 *  - users     : contas (dono/administradores e convidados)
 *  - sessions  : cookies de quem está logado
 *  - attempts  : tentativas de login erradas (trava anti-força bruta)
 *  - audit     : histórico de ações (criou usuário, trocou senha, entrou...)
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
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
  key         TEXT PRIMARY KEY,
  failed      INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at  TEXT NOT NULL
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

/** Abre/cria o banco e devolve uma instância pronta. */
export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

/** Helpers de data em ISO (tudo em UTC, sem bagunça de fuso). */
export const nowIso = () => new Date().toISOString();

export function daysFromNow(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString();
}

/** Limpa sessões vencidas (chamado de vez em quando). */
export function purgeExpiredSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
}
