/**
 * Autenticação: hash de senha, sessões em cookie e trava anti-força bruta.
 *
 * SENHAS NUNCA SÃO GRAVADAS EM TEXTO PURO.
 * Usamos scrypt (node:crypto) com sal aleatório por usuário:
 *   guardamos "scrypt$<sal>$<hash>" e comparamos com timingSafeEqual.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { nowIso, daysFromNow } from './db.mjs';

const scryptAsync = promisify(scrypt);
const KEYLEN = 64;
const SALT_BYTES = 16;

/** Gera o texto que vai pro banco (scrypt$sal$hash). */
export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scryptAsync(password, salt, KEYLEN);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Confere a senha contra o hash guardado (tempo constante). */
export async function verifyPassword(password, stored) {
  try {
    const [algo, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scryptAsync(password, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Senha aleatória legível para o convite (sem caracteres confusos: 0/O, 1/l). */
export function generatePassword(len = 10) {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export class Auth {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {{sessionDays?: number, maxFails?: number, lockMinutes?: number}} opts
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.sessionDays = opts.sessionDays ?? 7;
    this.maxFails = opts.maxFails ?? 5;
    this.lockMinutes = opts.lockMinutes ?? 10;
  }

  // ---------- sessões ----------

  createSession(userId, ip, userAgent) {
    const token = randomBytes(32).toString('base64url');
    const expires = daysFromNow(this.sessionDays);
    this.db
      .prepare('INSERT INTO sessions (token, user_id, created_at, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?)')
      .run(token, userId, nowIso(), expires, ip ?? null, userAgent ?? null);
    return { token, expires };
  }

  /** Devolve o usuário da sessão (ou null se inválida/expirada/desabilitada). */
  userFromToken(token) {
    if (!token) return null;
    const row = this.db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.is_admin, u.disabled, u.must_change, s.expires_at
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token = ?`,
      )
      .get(token);
    if (!row) return null;
    if (row.expires_at < nowIso()) {
      this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return null;
    }
    if (row.disabled) return null;
    return row;
  }

  destroySession(token) {
    if (!token) return;
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  destroySessionsOf(userId) {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  // ---------- anti-força bruta ----------

  /** Retorna ms restantes de bloqueio (0 se pode tentar). */
  lockRemaining(key) {
    const row = this.db.prepare('SELECT locked_until FROM attempts WHERE key = ?').get(key);
    if (!row || !row.locked_until) return 0;
    const left = new Date(row.locked_until).getTime() - Date.now();
    if (left <= 0) {
      this.db
        .prepare('UPDATE attempts SET locked_until = NULL, failed = 0, updated_at = ? WHERE key = ?')
        .run(nowIso(), key);
      return 0;
    }
    return left;
  }

  registerFailure(key) {
    const row = this.db.prepare('SELECT failed FROM attempts WHERE key = ?').get(key);
    const failed = (row?.failed ?? 0) + 1;
    const lockedUntil =
      failed >= this.maxFails ? new Date(Date.now() + this.lockMinutes * 60_000).toISOString() : null;
    this.db
      .prepare(
        `INSERT INTO attempts (key, failed, locked_until, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET failed = excluded.failed, locked_until = excluded.locked_until, updated_at = excluded.updated_at`,
      )
      .run(key, failed, lockedUntil, nowIso());
    return { failed, lockedUntil };
  }

  resetFailures(key) {
    this.db.prepare('DELETE FROM attempts WHERE key = ?').run(key);
  }
}
