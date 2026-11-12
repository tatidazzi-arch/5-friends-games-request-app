/**
 * Utilidades HTTP: JSON, cookies, corpo da requisição e arquivos estáticos.
 * Sem dependências externas (só módulos nativos do Node).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

/** Envia JSON. */
export function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(data);
}

/** Erro JSON no formato padrão. */
export function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

/** Lê o corpo JSON (limite de 64 KB). */
export async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('corpo grande demais');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('json inválido');
  }
}

/** Lê o cookie `name` do cabeçalho Cookie. */
export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

/** Define/limpa um cookie de sessão. */
export function setSessionCookie(res, token, maxAgeSec, secure) {
  const parts = [
    `sid=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('set-cookie', parts.join('; '));
}

export function clearSessionCookie(res, secure) {
  const parts = ['sid=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  res.setHeader('set-cookie', parts.join('; '));
}

/** IP do cliente (respeita proxy). */
export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'desconhecido';
}

/** Se a conexão é https (direto ou via proxy). */
export function isSecure(req) {
  if (req.socket.encrypted) return true;
  const proto = req.headers['x-forwarded-proto'];
  return typeof proto === 'string' && proto.split(',')[0].trim() === 'https';
}

/**
 * Serve um arquivo estático de `root`.
 * Devolve true se atendeu a requisição.
 */
export async function serveStatic(res, root, urlPath) {
  const base = path.resolve(root);
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return false;
  }
  // resolve dentro da raiz: qualquer ".." que fuja é bloqueado
  let file = path.resolve(base, '.' + path.posix.normalize(decoded));
  if (file !== base && !file.startsWith(base + path.sep)) return false;

  try {
    const stat = await fsp.stat(file);
    if (stat.isDirectory()) file = path.join(file, 'index.html');
  } catch {
    return false;
  }

  let data;
  try {
    data = await fsp.readFile(file);
  } catch {
    return false;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': data.length,
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });
  res.end(data);
  return true;
}

/** Serve um arquivo estático sem cache (usado para o index do jogo). */
export async function serveFileNoCache(res, file) {
  let data;
  try {
    data = await fsp.readFile(file);
  } catch {
    return false;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': data.length,
    'cache-control': 'no-store',
  });
  res.end(data);
  return true;
}

export function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
