/**
 * Simula o ambiente real da Vercel para pegar erros de boot:
 *
 *  - disco read-only (EACCES/EROFS) sem POSTGRES_URL
 *  - Postgres com falha de conexão
 *  - node:sqlite indisponível
 *
 * É o cenário que gerou o 500 FUNCTION_INVOCATION_FAILED no deploy.
 *
 * Roda: node test/vercel-env.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let fail = 0;
function check(nome, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS ${nome}`); }
  else { fail++; console.log(`  FALHOU ${nome} ${extra}`); }
}

console.log('\n=== ambiente da Vercel (disco read-only) ===\n');

// --- 1. disco read-only: o openDb precisa cair para o /tmp em vez de estourar ---
const { openDb } = await import('../lib/db.mjs');

// aponta para um caminho que não pode ser criado (raiz do sistema no Windows)
const readOnlyPath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'acesso-readonly', 'acesso.db');
const db = await openDb({ file: readOnlyPath, url: '' });
check('abriu o banco mesmo em disco read-only', !!db);
check('sinalizou que é temporário', db.ephemeral === true, `kind=${db.kind}`);

// o banco precisa funcionar de verdade
const info = await db.prepare('INSERT INTO users (username, display_name, pw_hash, is_admin, created_at) VALUES (?,?,?,1,?)')
  .run('dono', 'Miguel Franklin Dazzi', 'hash', new Date().toISOString());
check('INSERT funciona', info.lastInsertRowid > 0, JSON.stringify(info));
const row = await db.prepare('SELECT * FROM users WHERE username = ?').get('dono');
check('SELECT funciona', row?.username === 'dono', JSON.stringify(row));

// sessão: a tabela que NÃO tem coluna id (o bug do RETURNING id)
const sess = await db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?)')
  .run('tok123', 1, new Date().toISOString(), new Date(Date.now() + 86400000).toISOString(), '1.1.1.1', 'ua');
check('INSERT em sessions funciona (sem coluna id)', sess.changes === 1, JSON.stringify(sess));

await db.close();

// --- 2. com POSTGRES_URL definido mas o pacote pg ausente -> erro claro ---
console.log('');
console.log('  (postgres sem conexão)');
const temPg = fs.existsSync(path.join(process.cwd(), 'node_modules', 'pg'));
if (temPg) {
  // o pacote existe: a URL é inválida, tem que dar erro com mensagem útil
  try {
    await openDb({ file: readOnlyPath, url: 'postgres://usuario:senha@127.0.0.1:1/banco_invalido' });
    check('URL inválida dá erro', false, 'não deu erro');
  } catch (err) {
    check('URL inválida dá erro com mensagem clara',
      /Postgres|POSTGRES_URL|conectar/i.test(err.message), err.message);
  }
} else {
  // sem o pacote pg: a mensagem tem que explicar o que fazer
  try {
    await openDb({ file: readOnlyPath, url: 'postgres://u:s@h/d' });
    check('sem pg dá erro', false, 'não deu erro');
  } catch (err) {
    check('sem pg dá erro explicando o pacote', /pg.*não está instalado|npm install/i.test(err.message), err.message);
  }
}

// --- 3. a função da Vercel responde no /api/health mesmo sem banco ---
console.log('');
console.log('  (endpoint de diagnóstico)');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-health-'));
process.env.DATA_DIR = DATA_DIR;
const { default: handler } = await import('../api/index.mjs');

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    writeHead(code, h = {}) { this.statusCode = code; for (const [k, v] of Object.entries(h)) this.headers[k.toLowerCase()] = v; },
    end(d) { if (d) this.body += d.toString(); },
  };
}

const req = {
  method: 'GET',
  url: '/api/index?__path=/api/health',
  headers: { host: 'x' },
  query: { __path: '/api/health' },
  socket: { remoteAddress: '1.1.1.1' },
  async *[Symbol.asyncIterator]() {},
};
const res = fakeRes();
await handler(req, res);
const health = JSON.parse(res.body);
check('/api/health responde 200', res.statusCode === 200, `status=${res.statusCode}`);
check('/api/health diz se tem POSTGRES_URL', typeof health.temPostgresUrl === 'boolean', JSON.stringify(health));
check('/api/health diz o backend', !!health.backend, JSON.stringify(health));

try { fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* ok */ }

console.log(`\nRESULTADO: ${pass} passaram, ${fail} falharam\n`);
process.exit(fail ? 1 : 0);
