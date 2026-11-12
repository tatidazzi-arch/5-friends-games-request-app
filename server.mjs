/**
 * Portal de acesso — servidor HTTP (Node puro, sem dependências).
 *
 * COMO FUNCIONA
 *  1. No primeiro acesso, o dono cria a senha mestra (usuário "dono").
 *  2. Logado como dono, ele cria contas para os outros: nome de usuário + senha.
 *  3. Os outros entram em /login com o usuário e a senha que receberam.
 *
 * PAPEL DO DONO:admin = gerencia contas. Papel comum = só entra.
 *
 * Roda com: node server.mjs   (porta padrão 3000, ver PORT)
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, nowIso, daysFromNow, purgeExpiredSessions } from './lib/db.mjs';
import { Auth, hashPassword, verifyPassword, generatePassword } from './lib/auth.mjs';
import {
  sendJson,
  sendError,
  readJson,
  readCookie,
  setSessionCookie,
  clearSessionCookie,
  clientIp,
  isSecure,
  serveStatic,
  serveFileNoCache,
} from './lib/http.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'acesso.db');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const SECURE_COOKIE = process.env.SECURE_COOKIE === '1';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 7);
// Onde fica o jogo (build do Vite). Opcional: se existir, entra pelo mesmo login.
const GAME_DIST = process.env.GAME_DIST || path.join(__dirname, 'dist');
const HAS_GAME = fs.existsSync(path.join(GAME_DIST, 'index.html'));

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = openDb(DB_FILE);
const auth = new Auth(db, {
  sessionDays: SESSION_DAYS,
  maxFails: Number(process.env.MAX_LOGIN_FAILS || 5),
  lockMinutes: Number(process.env.LOCK_MINUTES || 10),
});

const MIN_PW = 6;

// ---------------------------------------------------------------- helpers

function audit(actor, action, detail) {
  db.prepare('INSERT INTO audit (at, actor, action, detail) VALUES (?,?,?,?)').run(
    nowIso(),
    actor ?? null,
    action,
    detail ?? null,
  );
}

function ownerCount() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get();
  return row?.n ?? 0;
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name || u.username,
    isAdmin: !!u.is_admin,
    disabled: !!u.disabled,
    mustChange: !!u.must_change,
    createdAt: u.created_at,
    lastLogin: u.last_login ?? null,
    expiresAt: u.expires_at ?? null,
  };
}

/** Envia o JSON de erro e não deixa a função seguir. */
function fail(res, status, msg) {
  sendError(res, status, msg);
  return null;
}

// ---------------------------------------------------------------- API

async function apiSetup(req, res) {
  if (ownerCount() > 0) return fail(res, 409, 'O dono já foi configurado.');
  const body = await readJson(req);
  const username = String(body.username || 'dono').trim().toLowerCase();
  const displayName = (String(body.displayName || '').trim() || 'Dono').slice(0, 60);
  const password = String(body.password || '');
  if (!/^[a-z0-9._-]{2,32}$/.test(username))
    return fail(res, 400, 'Usuário inválido (use letras minúsculas, números, . _ -).');
  if (password.length < MIN_PW) return fail(res, 400, `A senha do dono precisa de ${MIN_PW}+ caracteres.`);
  const hash = await hashPassword(password);
  // confere de novo: o hash é assíncrono e duas requisições podem chegar juntas
  if (ownerCount() > 0) return fail(res, 409, 'O dono já foi configurado.');
  const info = db
    .prepare(
      'INSERT INTO users (username, display_name, pw_hash, is_admin, created_at) VALUES (?,?,?,1,?)',
    )
    .run(username, displayName, hash, nowIso());
  audit(username, 'setup_dono', `id=${info.lastInsertRowid}`);
  sendJson(res, 201, { ok: true });
}

async function apiLogin(req, res) {
  const body = await readJson(req);
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  const ip = clientIp(req);
  const key = `${username}|${ip}`;

  const locked = auth.lockRemaining(key);
  if (locked > 0) {
    const mins = Math.ceil(locked / 60000);
    return fail(res, 429, `Muitas tentativas erradas. Tente de novo em ${mins} min.`);
  }

  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const ok = row ? await verifyPassword(password, row.pw_hash) : false;

  if (!row || !ok) {
    auth.registerFailure(key);
    audit(username, 'login_falhou', ip);
    return fail(res, 401, 'Usuário ou senha incorretos.');
  }
  if (row.disabled) return fail(res, 403, 'Essa conta está desativada. Fale com o dono.');

  auth.resetFailures(key);
  const { token } = auth.createSession(row.id, ip, req.headers['user-agent'] || '');
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(nowIso(), row.id);
  audit(row.username, 'login_ok', ip);
  setSessionCookie(res, token, SESSION_DAYS * 86400, SECURE_COOKIE || isSecure(req));
  sendJson(res, 200, { ok: true, user: publicUser(row), mustChange: !!row.must_change });
}

function apiLogout(req, res) {
  const token = readCookie(req, 'sid');
  auth.destroySession(token);
  clearSessionCookie(res, SECURE_COOKIE || isSecure(req));
  sendJson(res, 200, { ok: true });
}

function apiMe(req, res, user) {
  if (!user) return fail(res, 401, 'Não logado.');
  sendJson(res, 200, { user: publicUser(user) });
}

async function apiChangeOwnPassword(req, res, user) {
  if (!user) return fail(res, 401, 'Não logado.');
  const body = await readJson(req);
  const current = String(body.currentPassword || '');
  const next = String(body.newPassword || '');
  if (next.length < MIN_PW) return fail(res, 400, `A nova senha precisa de ${MIN_PW}+ caracteres.`);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  if (!row || !(await verifyPassword(current, row.pw_hash)))
    return fail(res, 401, 'Senha atual incorreta.');
  db.prepare('UPDATE users SET pw_hash = ?, must_change = 0 WHERE id = ?').run(await hashPassword(next), user.id);
  audit(user.username, 'trocou_senha_propria');
  sendJson(res, 200, { ok: true });
}

/** Admin: lista de contas. */
function apiListUsers(req, res, user) {
  if (!user?.is_admin) return fail(res, 403, 'Só o dono pode ver as contas.');
  const rows = db
    .prepare(
      `SELECT id, username, display_name, is_admin, disabled, must_change, created_at, last_login, expires_at
         FROM users ORDER BY is_admin DESC, created_at ASC`,
    )
    .all();
  sendJson(res, 200, { users: rows.map(publicUser) });
}

/** Admin: cria uma conta nova (usuário + senha) para mandar pros outros. */
async function apiCreateUser(req, res, user) {
  if (!user?.is_admin) return fail(res, 403, 'Só o dono pode criar contas.');
  const body = await readJson(req);
  const username = String(body.username || '').trim().toLowerCase();
  const displayName = String(body.displayName || '').trim().slice(0, 60);
  const password = String(body.password || '').trim();
  const expiresDays = body.expiresDays ? Math.min(3650, Math.max(1, Number(body.expiresDays))) : null;

  if (!/^[a-z0-9._-]{2,32}$/.test(username))
    return fail(res, 400, 'Usuário inválido (2-32 chars: letras minúsculas, números, . _ -).');
  if (password && password.length < MIN_PW)
    return fail(res, 400, `A senha precisa de ${MIN_PW}+ caracteres.`);
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return fail(res, 409, 'Já existe uma conta com esse usuário.');

  // senha gerada se o dono não digitar nada
  const plain = password || generatePassword(10);
  const isAdmin = body.isAdmin ? 1 : 0;
  const expiresAt = expiresDays ? daysFromNow(expiresDays) : null;
  // por padrão o convidado precisa trocar a senha no 1º acesso (opt-out: mustChange=false)
  const mustChange = body.mustChange === false ? 0 : 1;
  const info = db
    .prepare(
      `INSERT INTO users (username, display_name, pw_hash, is_admin, must_change, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(username, displayName || username, await hashPassword(plain), isAdmin, mustChange, nowIso(), expiresAt);
  audit(user.username, 'criou_usuario', `${username} (id=${info.lastInsertRowid})`);
  sendJson(res, 201, {
    ok: true,
    user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)),
    // a senha em texto só aparece aqui, na hora da criação — nunca é guardada assim
    password: plain,
  });
}

/** Admin: liga/desliga uma conta. */
function apiToggleUser(req, res, user, id) {
  if (!user?.is_admin) return fail(res, 403, 'Só o dono pode editar contas.');
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
  if (!row) return fail(res, 404, 'Conta não encontrada.');
  if (row.is_admin && row.id === user.id) return fail(res, 400, 'Você não pode desativar a si mesmo.');
  const disabled = row.disabled ? 0 : 1;
  db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled, row.id);
  if (disabled) auth.destroySessionsOf(row.id);
  audit(user.username, disabled ? 'desativou_usuario' : 'reativou_usuario', row.username);
  sendJson(res, 200, { ok: true, disabled: !!disabled });
}

/** Admin: reseta a senha de uma conta e devolve a nova (para repassar). */
async function apiResetPassword(req, res, user, id) {
  if (!user?.is_admin) return fail(res, 403, 'Só o dono pode resetar senhas.');
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
  if (!row) return fail(res, 404, 'Conta não encontrada.');
  const body = await readJson(req).catch(() => ({}));
  const plain = String(body.password || '').trim() || generatePassword(10);
  if (plain.length < MIN_PW) return fail(res, 400, `A senha precisa de ${MIN_PW}+ caracteres.`);
  db.prepare('UPDATE users SET pw_hash = ?, must_change = 0 WHERE id = ?').run(await hashPassword(plain), row.id);
  auth.destroySessionsOf(row.id);
  audit(user.username, 'resetou_senha', row.username);
  sendJson(res, 200, { ok: true, password: plain });
}

/** Admin: apaga a conta. */
function apiDeleteUser(req, res, user, id) {
  if (!user?.is_admin) return fail(res, 403, 'Só o dono pode apagar contas.');
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
  if (!row) return fail(res, 404, 'Conta não encontrada.');
  if (row.id === user.id) return fail(res, 400, 'Você não pode apagar a si mesmo.');
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(row.id);
  audit(user.username, 'apagou_usuario', row.username);
  sendJson(res, 200, { ok: true });
}

/** Admin: histórico de ações. */
function apiAudit(req, res, user) {
  if (!user?.is_admin) return fail(res, 403, 'Só o dono pode ver o histórico.');
  const rows = db.prepare('SELECT at, actor, action, detail FROM audit ORDER BY id DESC LIMIT 100').all();
  sendJson(res, 200, { log: rows });
}

// ---------------------------------------------------------------- roteador

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const token = readCookie(req, 'sid');
  const user = auth.userFromToken(token);

  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');

  try {
    // ---------- API ----------
    if (pathname.startsWith('/api/')) {
      const method = req.method ?? 'GET';
      const route = `${method} ${pathname}`;

      switch (route) {
        case 'GET /api/state':
          return sendJson(res, 200, { needsSetup: ownerCount() === 0, hasGame: HAS_GAME, user: publicUser(user) });
        case 'POST /api/setup':
          return await apiSetup(req, res);
        case 'POST /api/login':
          return await apiLogin(req, res);
        case 'POST /api/logout':
          return apiLogout(req, res);
        case 'GET /api/me':
          return apiMe(req, res, user);
        case 'POST /api/me/password':
          return await apiChangeOwnPassword(req, res, user);
        case 'GET /api/users':
          return apiListUsers(req, res, user);
        case 'POST /api/users':
          return await apiCreateUser(req, res, user);
        case 'GET /api/audit':
          return apiAudit(req, res, user);
      }

      // /api/users/:id/...
      const m = pathname.match(/^\/api\/users\/(\d+)(\/[a-z]+)?$/);
      if (m) {
        const id = m[1];
        const action = m[2] ?? '';
        if (method === 'POST' && action === '/disable') return apiToggleUser(req, res, user, id);
        if (method === 'POST' && action === '/enable') return apiToggleUser(req, res, user, id);
        if (method === 'POST' && action === '/password') return await apiResetPassword(req, res, user, id);
        if (method === 'DELETE' && !action) return apiDeleteUser(req, res, user, id);
      }

      return sendError(res, 404, 'Rota não encontrada.');
    }

    // ---------- páginas ----------
    // O jogo (build) só abre para quem está logado.
    if (pathname === '/jogo') {
      // barra no final: os assets do build são relativos ("./assets/...")
      res.writeHead(301, { location: '/jogo/' });
      return res.end();
    }
    if (pathname.startsWith('/jogo/')) {
      if (!user) return sendJson(res, 401, { error: 'Faça login para jogar.' });
      // senha temporária: tem que trocar antes de jogar
      if (user.must_change)
        return sendJson(res, 403, { error: 'Troque sua senha no painel antes de jogar.' });
      if (!HAS_GAME) return sendJson(res, 404, { error: 'Jogo não encontrado (rode npm run build).' });
      const rel = pathname.slice('/jogo'.length) || '/';
      const target = path.join(GAME_DIST, rel === '/' ? 'index.html' : rel);
      if (rel === '/' || rel === '/index.html') {
        if (await serveFileNoCache(res, path.join(GAME_DIST, 'index.html'))) return;
      }
      if (await serveStatic(res, GAME_DIST, rel)) return;
      if (await serveFileNoCache(res, path.join(GAME_DIST, 'index.html'))) return;
      return sendError(res, 404, 'Arquivo não encontrado.');
    }

    // Arquivos do portal (index.html, app.js, style.css)
    if (pathname === '/' || pathname === '/index.html' || pathname === '/login' || pathname === '/login/') {
      if (await serveFileNoCache(res, path.join(PUBLIC_DIR, 'index.html'))) return;
      return sendError(res, 500, 'index.html não encontrado.');
    }
    if (await serveStatic(res, PUBLIC_DIR, pathname)) return;

    return sendError(res, 404, 'Não encontrado.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'erro';
    if (msg === 'json inválido') return sendError(res, 400, 'JSON inválido.');
    console.error('[erro]', err);
    return sendError(res, 500, 'Erro interno.');
  }
});

// limpeza periódica de sessões vencidas
const cleanup = setInterval(() => purgeExpiredSessions(db), 60 * 60 * 1000);
cleanup.unref();

server.listen(PORT, HOST, () => {
  console.log(`\n  🔐 Portal de acesso rodando em http://localhost:${PORT}`);
  console.log(`     banco: ${DB_FILE}`);
  if (!ownerCount()) console.log('     primeiro acesso: o navegador vai pedir para criar a senha do dono.');
  if (HAS_GAME) console.log(`     jogo: /jogo (protegido pelo login)`);
  console.log('');
});
