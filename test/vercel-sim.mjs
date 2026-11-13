/**
 * Teste do modo serverless (como a Vercel chama a função).
 *
 * Simula o req/res da Vercel:
 *  - req.url vem reescrito (/api/index?__path=...)
 *  - req.query já parseado
 *  - req.body já parseado (o runtime da Vercel faz o parse do JSON)
 *
 * Roda: node test/vercel-sim.mjs
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// banco isolado: o teste não pode mexer no data/ de verdade
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-vercel-'));
process.env.DATA_DIR = DATA_DIR;

const { default: handler } = await import('../api/index.mjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
function check(nome, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS ${nome}`); }
  else { fail++; console.log(`  FALHOU ${nome} ${extra}`); }
}

/** Cria um req/res no estilo Vercel (body parseado, query parseado). */
function fakeReq(method, url, body) {
  const u = new URL(url, 'http://localhost');
  const req = {
    method,
    url: u.pathname + u.search,
    headers: { host: 'localhost', 'user-agent': 'teste', 'content-type': 'application/json' },
    query: Object.fromEntries(u.searchParams),
    body: body === undefined ? undefined : body,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      // o body já vem parseado na Vercel: o stream está vazio
    },
  };
  return req;
}

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    writeHead(code, headers = {}) {
      this.statusCode = code;
      for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = v;
    },
    end(data) { if (data) this.body += data.toString(); },
  };
  return res;
}

/** Chama a função como a Vercel faria, devolvendo { status, json, headers }. */
async function call(method, url, body, cookie) {
  const req = fakeReq(method, url, body);
  if (cookie) req.headers.cookie = cookie;
  const res = fakeRes();
  await handler(req, res);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* não é JSON */ }
  return { status: res.statusCode, json, headers: res.headers, body: res.body };
}

/** Cookie de sessão da última resposta (para encadear chamadas). */
function sessionCookie(headers) {
  const sc = headers['set-cookie'];
  if (!sc) return null;
  return String(sc).split(';')[0];
}

console.log('\n=== modo serverless (simulação da Vercel) ===\n');

// 1. state
let r = await call('GET', '/api/index?__path=/api/state');
check('GET /api/state -> 200', r.status === 200, `status=${r.status}`);
check('precisa de setup', r.json?.needsSetup === true, JSON.stringify(r.json));
check('sem jogo neste repo', r.json?.hasGame === false, JSON.stringify(r.json));

// 2. setup
r = await call('POST', '/api/index?__path=/api/setup', {
  username: 'dono', displayName: 'Miguel Franklin Dazzi', password: 'senha123',
});
check('POST /api/setup -> 201', r.status === 201, `status=${r.status} ${r.body}`);

// 3. setup de novo -> 409
r = await call('POST', '/api/index?__path=/api/setup', { username: 'x', password: 'abcdef' });
check('setup repetido -> 409', r.status === 409, `status=${r.status}`);

// 4. login
r = await call('POST', '/api/index?__path=/api/login', { username: 'dono', password: 'senha123' });
check('POST /api/login -> 200', r.status === 200, `status=${r.status} ${r.body}`);
check('nome do dono', r.json?.user?.displayName === 'Miguel Franklin Dazzi', JSON.stringify(r.json));
const cookie = sessionCookie(r.headers);
check('cookie de sessão emitido', !!cookie, JSON.stringify(r.headers));

// 5. rotas autenticadas
r = await call('GET', '/api/index?__path=/api/users', undefined, cookie);
check('GET /api/users (logado) -> 200', r.status === 200, `status=${r.status}`);
check('lista 1 conta', r.json?.users?.length === 1, JSON.stringify(r.json?.users));

r = await call('GET', '/api/index?__path=/api/users');
check('GET /api/users (sem sessão) -> 403', r.status === 403, `status=${r.status}`);

// 6. cria conta
r = await call('POST', '/api/index?__path=/api/users', { username: 'joao', displayName: 'Joao' }, cookie);
check('POST /api/users -> 201', r.status === 201, `status=${r.status} ${r.body}`);
check('senha gerada (10 chars)', r.json?.password?.length === 10, JSON.stringify(r.json));
check('mustChange por padrão', r.json?.user?.mustChange === true, JSON.stringify(r.json?.user));
const joaoPass = r.json.password;

// 7. convidado entra
r = await call('POST', '/api/index?__path=/api/login', { username: 'joao', password: joaoPass });
check('convidado entra -> 200', r.status === 200, `status=${r.status}`);
const joaoCookie = sessionCookie(r.headers);

// 8. convidado não vê contas
r = await call('GET', '/api/index?__path=/api/users', undefined, joaoCookie);
check('convidado -> 403 em /api/users', r.status === 403, `status=${r.status}`);

// 9. convidado não joga antes de trocar a senha
r = await call('GET', '/api/index?__path=/jogo/', undefined, joaoCookie);
check('sem trocar senha -> 403 em /jogo', r.status === 403, `status=${r.status}`);

// 10. troca a senha
r = await call('POST', '/api/index?__path=/api/me/password',
  { currentPassword: joaoPass, newPassword: 'joaonovo123' }, joaoCookie);
check('troca de senha -> 200', r.status === 200, `status=${r.status} ${r.body}`);

r = await call('POST', '/api/index?__path=/api/login', { username: 'joao', password: 'joaonovo123' });
check('login com a senha nova -> 200', r.status === 200, `status=${r.status}`);
const joaoCookie2 = sessionCookie(r.headers);

// 11. jogo agora é servido (sem build -> 404, mas não 401/403)
r = await call('GET', '/api/index?__path=/jogo/', undefined, joaoCookie2);
check('jogo sem build -> 404 (não 401/403)', r.status === 404, `status=${r.status}`);

// 12. páginas HTML
r = await call('GET', '/api/index?__path=/login');
check('/login -> 200', r.status === 200, `status=${r.status}`);
check('/login serve o HTML', r.body.includes('loginForm'), r.body.slice(0, 80));

r = await call('GET', '/api/index?__path=/');
check('/ -> 200', r.status === 200, `status=${r.status}`);

// 13. estáticos (app.js, style.css)
r = await call('GET', '/api/index?__path=/app.js');
check('/app.js -> 200', r.status === 200, `status=${r.status}`);
r = await call('GET', '/api/index?__path=/style.css');
check('/style.css -> 200', r.status === 200, `status=${r.status}`);

// 14. path traversal bloqueado
r = await call('GET', '/api/index?__path=/../../etc/passwd');
check('path traversal bloqueado', r.status === 404 || r.status === 400, `status=${r.status}`);

// 15. cookie tem Secure (Vercel é https)
r = await call('POST', '/api/index?__path=/api/login', { username: 'dono', password: 'senha123' });
check('cookie com Secure', String(r.headers['set-cookie'] || '').includes('Secure'),
  String(r.headers['set-cookie']));

// 16. logout
r = await call('POST', '/api/index?__path=/api/logout', {}, cookie);
check('logout -> 200', r.status === 200, `status=${r.status}`);

console.log(`\nRESULTADO: ${pass} passaram, ${fail} falharam\n`);

// limpeza do banco de teste
try {
  fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
} catch {
  /* o SO limpa depois */
}

process.exit(fail ? 1 : 0);
