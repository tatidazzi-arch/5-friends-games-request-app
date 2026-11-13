/**
 * Portal de acesso — servidor HTTP local (Node puro, sem dependências).
 *
 * COMO FUNCIONA
 *  1. No primeiro acesso, o dono cria a senha mestra (usuário "dono").
 *  2. Logado como dono, ele cria contas para os outros: nome de usuário + senha.
 *  3. Os outros entram em /login com o usuário e a senha que receberam.
 *
 * PAPEL DO DONO (admin) = gerencia contas. Papel comum = só entra.
 *
 * Roda com: node server.mjs   (porta padrão 3000, ver PORT)
 *
 * Este arquivo só sobe o HTTP: as regras de acesso estão em lib/app.mjs,
 * que é o mesmo código usado pela função serverless da Vercel (api/index.js).
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './lib/app.mjs';
import { backendKind } from './lib/db.mjs';

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

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = await createApp({
  publicDir: PUBLIC_DIR,
  gameDist: GAME_DIST,
  dbFile: DB_FILE,
  secureCookie: SECURE_COOKIE,
  sessionDays: SESSION_DAYS,
});

const server = http.createServer((req, res) => {
  app.handler(req, res).catch((err) => {
    console.error('[erro]', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: 'Erro interno.' }));
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\n  🔐 Portal de acesso rodando em http://localhost:${PORT}`);
  console.log(`     banco: ${backendKind(process.env.POSTGRES_URL || process.env.DATABASE_URL)}`);
  console.log(`     arquivo: ${DB_FILE}`);
  if (!app.hasGame) console.log('     (sem build do jogo: rode npm run build para habilitar /jogo)');
  console.log('');
});
