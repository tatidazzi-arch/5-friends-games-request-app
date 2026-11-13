/**
 * Teste do adapter Postgres sem precisar de um servidor Postgres.
 *
 * Usa um pool falso que simula o comportamento do Postgres (RETURNING id,
 * ON CONFLICT, tipos) e roda o app inteiro por cima dele. Assim validamos:
 *  - conversão dos placeholders "?" -> "$1, $2..." (inclusive dentro de texto)
 *  - INSERT ganha "RETURNING id"; ON CONFLICT não ganha
 *  - o app funciona igual no SQLite e no Postgres
 *
 * Roda: node test/pg-adapter.mjs
 */
import assert from 'node:assert';
import { toPgPlaceholders, createPgStore } from '../lib/db.mjs';
import { Auth, hashPassword, verifyPassword, generatePassword } from '../lib/auth.mjs';

let pass = 0;
let fail = 0;
function check(nome, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS ${nome}`); }
  else { fail++; console.log(`  FALHOU ${nome} ${extra}`); }
}

console.log('\n=== adapter Postgres (pool simulado) ===\n');

// ---- 1. conversão de placeholders ----
check('sem placeholder', toPgPlaceholders('SELECT 1') === 'SELECT 1');
check('1 placeholder', toPgPlaceholders('SELECT * FROM t WHERE a = ?') === 'SELECT * FROM t WHERE a = $1');
check('3 placeholders', toPgPlaceholders('INSERT INTO t (a,b,c) VALUES (?,?,?)') ===
  'INSERT INTO t (a,b,c) VALUES ($1,$2,$3)');
check('múltiplos com AND', toPgPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?') ===
  'SELECT * FROM t WHERE a = $1 AND b = $2');
check('"?" dentro de texto fica intacto',
  toPgPlaceholders("SELECT * FROM t WHERE nome = 'ok? sim' AND a = ?") ===
  "SELECT * FROM t WHERE nome = 'ok? sim' AND a = $1");
check("'' (escape de aspa) não confunde",
  toPgPlaceholders("SELECT * FROM t WHERE n = 'a''b' AND a = ?") ===
  "SELECT * FROM t WHERE n = 'a''b' AND a = $1");
check('numeração coerente',
  toPgPlaceholders('UPDATE t SET a = ?, b = ?, c = ? WHERE id = ?') ===
  'UPDATE t SET a = $1, b = $2, c = $3 WHERE id = $4');

// ---- 2. pool falso que simula o Postgres ----
const log = [];
let nextId = 1;
// estado mínimo da tabela "attempts" (o suficiente p/ testar a trava)
const attempts = new Map();

const fakePool = {
  async query(sql, params = []) {
    log.push({ sql, params });

    // simula o Postgres: "RETURNING id" numa tabela sem coluna id = erro
    if (/RETURNING\s+id/i.test(sql)) {
      const t = (sql.match(/INSERT\s+INTO\s+([a-z_]+)/i) || [])[1]?.toLowerCase();
      if (t === 'sessions' || t === 'attempts') {
        const err = new Error(`column "id" does not exist`);
        err.code = '42703';
        throw err;
      }
    }

    // --- attempts ---
    if (/INSERT INTO attempts/i.test(sql)) {
      const [key, failed, lockedUntil] = params;
      attempts.set(key, { failed, locked_until: lockedUntil });
      return { rowCount: 1, rows: [] };
    }
    if (/SELECT locked_until FROM attempts/i.test(sql)) {
      const row = attempts.get(params[0]);
      return { rowCount: 1, rows: row ? [row] : [] };
    }
    if (/SELECT failed FROM attempts/i.test(sql)) {
      const row = attempts.get(params[0]);
      return { rowCount: 1, rows: row ? [row] : [] };
    }
    if (/UPDATE attempts SET locked_until = NULL/i.test(sql)) {
      const row = attempts.get(params[1]);
      if (row) attempts.set(params[1], { failed: 0, locked_until: null });
      return { rowCount: 1, rows: [] };
    }
    if (/DELETE FROM attempts/i.test(sql)) {
      attempts.delete(params[0]);
      return { rowCount: 1, rows: [] };
    }

    // --- users / sessions / audit ---
    if (/^\s*INSERT\s+INTO\s+users/i.test(sql)) {
      const id = nextId++;
      return { rowCount: 1, rows: [{ id }] };
    }
    if (/^\s*INSERT\s+INTO\s+(sessions|attempts|audit)/i.test(sql)) {
      return { rowCount: 1, rows: [] };
    }
    if (/COUNT\(\*\)/i.test(sql)) {
      return { rowCount: 1, rows: [{ n: nextId > 1 ? 1 : 0 }] };
    }
    if (/^\s*SELECT/i.test(sql)) {
      return { rowCount: 0, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  },
  async end() {},
};

const store = createPgStore(fakePool);
check('store é postgres', store.kind === 'postgres');

// INSERT comum ganha RETURNING id
log.length = 0;
const res1 = await store
  .prepare('INSERT INTO users (username, display_name, pw_hash, is_admin, created_at) VALUES (?,?,?,1,?)')
  .run('dono', 'Miguel Franklin Dazzi', 'hash', '2026-01-01T00:00:00.000Z');
check('INSERT de users tem RETURNING id', log[0].sql.includes('RETURNING id'), log[0].sql);
check('lastInsertRowid vem do RETURNING', res1.lastInsertRowid === 1, String(res1.lastInsertRowid));
check('changes = rowCount', res1.changes === 1, String(res1.changes));
check('params na ordem original', JSON.stringify(log[0].params) ===
  JSON.stringify(['dono', 'Miguel Franklin Dazzi', 'hash', '2026-01-01T00:00:00.000Z']));

// ON CONFLICT NÃO pode ter RETURNING id (tabela attempts não tem id)
log.length = 0;
await store
  .prepare(
    `INSERT INTO attempts (key, failed, locked_until, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET failed = excluded.failed`,
  )
  .run('dono|ip', 1, null, '2026-01-01T00:00:00.000Z');
check('INSERT ON CONFLICT sem RETURNING', !log[0].sql.includes('RETURNING'), log[0].sql);
check('ON CONFLICT com placeholders certos', log[0].sql.includes('$1') && log[0].sql.includes('$4'),
  log[0].sql);

// UPDATE/DELETE/SELECT não ganham RETURNING
log.length = 0;
await store.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(1, 3);
check('UPDATE sem RETURNING', !log[0].sql.includes('RETURNING'), log[0].sql);
check('UPDATE com $1/$2', log[0].sql.includes('$1') && log[0].sql.includes('$2'), log[0].sql);

// --- BUG QUE CAUSAVA 500 EM TODO LOGIN NO POSTGRES ---
// A tabela "sessions" tem "token" como PK: NÃO tem coluna "id".
// Se o INSERT ganhasse "RETURNING id", o Postgres responderia
// "column id does not exist" e o login quebraria na Vercel.
log.length = 0;
await store
  .prepare('INSERT INTO sessions (token, user_id, created_at, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?)')
  .run('tok', 1, '2026-01-01', '2026-01-08', '1.1.1.1', 'ua');
check('INSERT em sessions NÃO tem RETURNING (sessions não tem id)',
  !log[0].sql.includes('RETURNING'), log[0].sql);
check('INSERT em sessions tem 6 placeholders', /VALUES \(\$1,\$2,\$3,\$4,\$5,\$6\)/.test(log[0].sql), log[0].sql);

// a tabela "audit" tem id: pode usar RETURNING
log.length = 0;
await store.prepare('INSERT INTO audit (at, actor, action, detail) VALUES (?,?,?,?)')
  .run('2026-01-01', 'dono', 'login_ok', 'ip');
check('INSERT em audit tem RETURNING id', log[0].sql.includes('RETURNING id'), log[0].sql);

log.length = 0;
await store.prepare('SELECT * FROM users WHERE username = ?').get('dono');
check('SELECT com $1', log[0].sql.includes('$1'), log[0].sql);
check('get devolve undefined sem linhas', (await store.prepare('SELECT 1 WHERE false').get()) === undefined);

// ---- 3. o app inteiro por cima do Postgres simulado ----
console.log('');
console.log('  (app completo por cima do store Postgres)');

/**
 * Simula a Vercel: Postgres configurado, sessão criada e login feito.
 * É o caminho que estava quebrado (RETURNING id em sessions).
 */
{
  const sessions = new Map();
  const users = new Map([['dono', { id: 1, username: 'dono', pw_hash: 'x', disabled: 0 }]]);

  const simPool = {
    async query(sql, params = []) {
      if (/RETURNING\s+id/i.test(sql)) {
        const t = (sql.match(/INSERT\s+INTO\s+([a-z_]+)/i) || [])[1]?.toLowerCase();
        if (t !== 'users' && t !== 'audit') {
          const e = new Error(`column "id" does not exist`);
          e.code = '42703';
          throw e;
        }
      }
      if (/INSERT INTO sessions/i.test(sql)) {
        sessions.set(params[0], { user_id: params[1], expires_at: params[3] });
        return { rowCount: 1, rows: [] };
      }
      if (/FROM\s+sessions\s+s\s+JOIN/i.test(sql)) {
        const s = sessions.get(params[0]);
        if (!s) return { rowCount: 0, rows: [] };
        const u = users.get('dono');
        return { rowCount: 1, rows: [{ ...u, expires_at: s.expires_at }] };
      }
      if (/SELECT \* FROM users WHERE username/i.test(sql)) {
        const u = users.get(params[0]);
        return { rowCount: 1, rows: u ? [u] : [] };
      }
      if (/COUNT\(\*\)/i.test(sql)) return { rowCount: 1, rows: [{ n: 1 }] };
      if (/^\s*SELECT/i.test(sql)) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    },
    async end() {},
  };

  const simStore = createPgStore(simPool);
  const simAuth = new Auth(simStore, { sessionDays: 7, maxFails: 5, lockMinutes: 10 });

  // login cria sessão (era aqui que estourava o erro do RETURNING id)
  let erro = null;
  let token = null;
  try {
    const s = await simAuth.createSession(1, '1.1.1.1', 'ua');
    token = s.token;
  } catch (e) {
    erro = e;
  }
  check('criar sessão no Postgres não estoura', erro === null, erro?.message);
  check('sessão tem token', typeof token === 'string' && token.length > 20);

  // e o token recupera o usuário
  const achado = await simAuth.userFromToken(token);
  check('token recupera o usuário', achado?.username === 'dono', JSON.stringify(achado));
}

console.log('');

// monkey-patch: openDb precisa devolver o store falso.
// como o app importa openDb direto, testamos as funções que mais importam.
const auth = new Auth(store, { sessionDays: 7, maxFails: 5, lockMinutes: 10 });
const hash = await hashPassword('senha123');
check('hash no formato scrypt$sal$hash', hash.startsWith('scrypt$') && hash.split('$').length === 3, hash.slice(0, 20));
check('senha confere', await verifyPassword('senha123', hash));
check('senha errada não confere', !(await verifyPassword('errada', hash)));
check('hash diferente a cada vez', (await hashPassword('senha123')) !== hash);
check('senha gerada tem 10 chars', generatePassword(10).length === 10);
check('senha gerada sem 0/O/1/l', !/[0O1l]/.test(generatePassword(200)), generatePassword(200));

// lock de força bruta
let locked = 0;
for (let i = 0; i < 5; i++) await auth.registerFailure('u|ip');
locked = await auth.lockRemaining('u|ip');
check('5 erros -> bloqueado', locked > 0, String(locked));
await auth.resetFailures('u|ip');
check('reset libera o bloqueio', (await auth.lockRemaining('u|ip')) === 0);

console.log(`\nRESULTADO: ${pass} passaram, ${fail} falharam\n`);
process.exit(fail ? 1 : 0);
