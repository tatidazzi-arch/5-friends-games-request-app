/**
 * Teste do servidor local (node server.mjs) — o mesmo app, backend SQLite.
 *
 * Roda: node test/local-sim.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
function check(nome, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS ${nome}`); }
  else { fail++; console.log(`  FALHOU ${nome} ${extra}`); }
}

const PORT = 3000 + Math.floor(Math.random() * 9000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-local-'));

const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR, SECURE_COOKIE: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d.toString(); });
server.stderr.on('data', (d) => { serverLog += d.toString(); });

/** Espera o servidor responder. */
async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${BASE}/api/state`);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return false;
}

/** Requisição que guarda cookies (como um navegador). */
function makeClient() {
  let cookie = '';
  return async function req(method, url, body) {
    const res = await fetch(`${BASE}${url}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookie) {
      const pair = c.split(';')[0];
      if (pair.startsWith('sid=')) cookie = pair;
    }
    let json = null;
    try { json = await res.json(); } catch { /* não é JSON */ }
    return { status: res.status, json };
  };
}

try {
  console.log('\n=== servidor local (SQLite) ===\n');
  if (!(await waitForServer())) {
    console.log('servidor não subiu:\n' + serverLog);
    process.exit(1);
  }
  check('servidor subiu', true);

  const cli = makeClient();

  let r = await cli('GET', '/api/state');
  check('GET /api/state -> 200', r.status === 200, `status=${r.status}`);
  check('precisa de setup', r.json?.needsSetup === true, JSON.stringify(r.json));

  r = await cli('POST', '/api/setup', { username: 'dono', displayName: 'Miguel Franklin Dazzi', password: 'senha123' });
  check('setup -> 201', r.status === 201, `status=${r.status}`);

  r = await cli('POST', '/api/login', { username: 'dono', password: 'senha123' });
  check('login -> 200', r.status === 200, `status=${r.status}`);
  check('nome do dono', r.json?.user?.displayName === 'Miguel Franklin Dazzi');

  r = await cli('GET', '/api/users');
  check('lista de contas', r.status === 200 && r.json?.users?.length === 1, JSON.stringify(r.json));

  r = await cli('POST', '/api/users', { username: 'joao', displayName: 'Joao' });
  check('cria conta -> 201', r.status === 201, `status=${r.status}`);
  check('senha gerada', r.json?.password?.length === 10);
  const joaoPass = r.json.password;

  // convidado
  const cli2 = makeClient();
  r = await cli2('POST', '/api/login', { username: 'joao', password: joaoPass });
  check('convidado entra', r.status === 200, `status=${r.status}`);
  r = await cli2('GET', '/api/users');
  check('convidado sem acesso às contas', r.status === 403, `status=${r.status}`);

  // dono desativa o convidado
  const users = (await cli('GET', '/api/users')).json.users;
  const joaoId = users.find((u) => u.username === 'joao').id;
  r = await cli('POST', `/api/users/${joaoId}/disable`);
  check('desativa conta', r.status === 200, `status=${r.status}`);
  r = await cli2('GET', '/api/me');
  check('sessão do convidado derrubada', r.status === 401, `status=${r.status}`);
  r = await cli2('POST', '/api/login', { username: 'joao', password: joaoPass });
  check('conta desativada não entra', r.status === 403, `status=${r.status}`);

  // auditoria
  r = await cli('GET', '/api/audit');
  check('auditoria populada', r.status === 200 && r.json?.log?.length >= 4, `len=${r.json?.log?.length}`);

  // páginas
  r = await cli('GET', '/login');
  check('/login -> 200', r.status === 200, `status=${r.status}`);
  r = await cli('GET', '/');
  check('/ -> 200', r.status === 200, `status=${r.status}`);

  console.log(`\nRESULTADO: ${pass} passaram, ${fail} falharam\n`);
} finally {
  server.kill();
  // o banco ainda pode estar aberto: tenta limpar, mas não falha o teste por isso
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* deixa o temp para o SO limpar */
  }
}

process.exit(fail ? 1 : 0);
