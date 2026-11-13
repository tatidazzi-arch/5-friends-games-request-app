/**
 * Função serverless da Vercel (Node.js runtime).
 *
 * A Vercel chama esta função para TUDO que não for arquivo estático em
 * `public/`. Como o portal é uma SPA (a mesma index.html serve / e /login),
 * a função entrega:
 *   - a API (/api/*)
 *   - a tela de login (/, /login)
 *   - o jogo protegido (/jogo/*), se houver build
 *
 * As regras de acesso estão em lib/app.mjs — o mesmo código do servidor local.
 *
 * SOBRE O CAMINHO: a Vercel reescreve a URL antes de chamar a função, então
 * `req.url` pode não ser o caminho original. Por isso o vercel.json manda o
 * caminho de origem em `?__path=` e a gente usa esse valor.
 */
import path from 'node:path';
import fs from 'node:fs';
import { createApp } from '../lib/app.mjs';

// ATENÇÃO: este arquivo é .mjs de propósito.
// A Vercel compila arquivos .js para CommonJS, e em CommonJS não existe
// import.meta.url — usar isso no topo do arquivo quebra a função no boot
// (FUNCTION_INVOCATION_FAILED, sem log). Com .mjs a Vercel mantém o ESM.
//
// Nem por isso usamos import.meta aqui: process.cwd() é mais simples e
// funciona igual nos dois formatos de bundle.

/**
 * Acha a pasta public/ onde o arquivo estiver.
 *
 * No deploy a Vercel empacota a função e o layout muda (o index.html pode
 * ficar ao lado do bundle). Por isso testamos vários lugares em vez de
 * assumir um caminho fixo — se nenhum existir, a função ainda funciona:
 * a camada estática da Vercel serve o index.html em "/".
 */
function resolvePublicDir() {
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, 'public'), // cwd da Vercel (o bundle roda aqui)
    path.join(cwd, '..', 'public'),
    path.join(cwd, '..', '..', 'public'),
    path.join(cwd, 'api', 'public'),
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
    } catch {
      /* ignora */
    }
  }
  return candidates[0];
}

const PUBLIC_DIR = resolvePublicDir();
const GAME_DIST = process.env.GAME_DIST || path.join(process.cwd(), 'dist');
// só usado quando não há POSTGRES_URL (na Vercel o Postgres manda)
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'acesso.db');

// A app é criada uma vez e reaproveitada entre requisições (cold start).
let appPromise = null;
function getApp() {
  if (!appPromise) {
    appPromise = createApp({
      publicDir: PUBLIC_DIR,
      gameDist: GAME_DIST,
      dbFile: DB_FILE,
      // na Vercel o tráfego é https: o cookie sempre vai com Secure
      secureCookie: true,
      sessionDays: Number(process.env.SESSION_DAYS || 7),
    });
  }
  return appPromise;
}

/**
 * Diagnóstico: mostra o que a função está usando (backend, env, etc).
 * Ajuda a descobrir por que o deploy está dando 500 sem precisar dos logs.
 */
function diagnose(req, res) {
  const hasPg = !!(process.env.POSTGRES_URL || process.env.DATABASE_URL);
  const body = {
    ok: true,
    node: process.version,
    temPostgresUrl: hasPg,
    backend: hasPg ? 'postgres' : 'sqlite',
    aviso: hasPg
      ? null
      : 'POSTGRES_URL não está definido: os dados NÃO serão salvos de verdade ' +
        '(a Vercel não tem disco fixo). Configure a variável de ambiente.',
    env: {
      VERCEL: process.env.VERCEL ?? null,
      VERCEL_ENV: process.env.VERCEL_ENV ?? null,
      NODE_ENV: process.env.NODE_ENV ?? null,
      SESSION_DAYS: process.env.SESSION_DAYS ?? null,
    },
    path: req.query?.__path ?? req.url,
  };
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  const original = req.query?.__path;
  const pathname = typeof original === 'string' && original ? original : null;

  // diagnóstico: não precisa de banco, então responde mesmo se o banco falhar
  if (pathname === '/api/health' || pathname === '/api/diagnostico') {
    return diagnose(req, res);
  }

  try {
    const app = await getApp();
    return await app.handler(req, res, pathname);
  } catch (err) {
    // erro na inicialização (banco indisponível, etc): responde com o motivo
    // em vez de deixar a Vercel mostrar um 500 genérico sem informação
    console.error('[falha ao iniciar]', err);
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      error: 'O portal não conseguiu iniciar.',
      detalhe: msg,
      dica: process.env.POSTGRES_URL || process.env.DATABASE_URL
        ? 'Verifique a variável POSTGRES_URL e se o banco está acessível.'
        : 'Configure a variável de ambiente POSTGRES_URL (Postgres) no projeto da Vercel.',
    }));
  }
}
