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
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/app.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const GAME_DIST = process.env.GAME_DIST || path.join(ROOT, 'dist');
// só usado quando não há POSTGRES_URL (na Vercel o Postgres manda)
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
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

export default async function handler(req, res) {
  const app = await getApp();

  // caminho original (enviado pelo rewrite) ou o que sobrou na URL
  const original = req.query?.__path;
  const pathname = typeof original === 'string' && original ? original : null;

  return app.handler(req, res, pathname);
}

// a Vercel usa a raiz do projeto como cwd em alguns casos
if (!fs.existsSync(PUBLIC_DIR)) {
  console.warn(`[aviso] public/ não encontrado em ${PUBLIC_DIR}`);
}
