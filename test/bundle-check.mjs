/**
 * Verifica se a função da Vercel tem tudo que ela precisa no bundle.
 *
 * A Vercel empacota a função em api/index.js + os arquivos em includeFiles.
 * Se faltar algum import (lib/, public/), o deploy quebra em produção.
 *
 * Roda: node test/bundle-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
function check(nome, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS ${nome}`); }
  else { fail++; console.log(`  FALHOU ${nome} ${extra}`); }
}

console.log('\n=== conferência do bundle da função ===\n');

// 1. api/index.js existe
const apiFile = path.join(ROOT, 'api', 'index.js');
check('api/index.js existe', fs.existsSync(apiFile));
check('exporta handler default', /export\s+default/.test(fs.readFileSync(apiFile, 'utf8')));

// 2. todo import relativo existe
const src = fs.readFileSync(apiFile, 'utf8');
const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
for (const imp of imports) {
  if (!imp.startsWith('.')) continue;
  const target = path.resolve(path.dirname(apiFile), imp);
  check(`import existe: ${imp}`, fs.existsSync(target), target);
}

// 3. imports dentro de lib/ (a Vercel rastreia dependências automaticamente)
for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) {
  const full = path.join(ROOT, 'lib', f);
  const code = fs.readFileSync(full, 'utf8');
  for (const m of code.matchAll(/from\s+'(\.[^']+)'/g)) {
    const target = path.resolve(path.dirname(full), m[1]);
    check(`lib/${f} -> ${m[1]} existe`, fs.existsSync(target), target);
  }
}

// 4. public/ precisa estar no includeFiles do vercel.json
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const fn = vercel.functions?.['api/index.js'] ?? {};
check('vercel.json tem functions api/index.js', !!fn);
check('includeFiles inclui public/**',
  Array.isArray(fn.includeFiles) && fn.includeFiles.some((p) => p.includes('public')),
  JSON.stringify(fn.includeFiles));

// 5. os rewrites carregam o caminho original
const rewrites = vercel.rewrites ?? [];
const allHavePath = rewrites.every((r) => r.destination.includes('__path='));
check('todos os rewrites passam __path', allHavePath, JSON.stringify(rewrites));
check('rewrite da API existe', rewrites.some((r) => r.source === '/api/(.*)'));
check('rewrite do /login existe', rewrites.some((r) => r.source === '/login'));

// 6. outputDirectory aponta para public/
check('outputDirectory = public', vercel.outputDirectory === 'public', vercel.outputDirectory);

// 7. package.json tem o pg (Postgres na Vercel)
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check('pg nas dependências', !!pkg.dependencies?.pg, JSON.stringify(pkg.dependencies));
check('script de start', pkg.scripts?.start === 'node server.mjs', pkg.scripts?.start);
check('script de teste', !!pkg.scripts?.test, pkg.scripts?.test);

// 8. o .gitignore protege o data/
const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
check('.gitignore ignora data/', /^\s*data\//m.test(gi));

// 9. nenhum arquivo com senha no bundle
const suspicious = [];
for (const f of ['public/app.js', 'public/index.html', 'public/style.css']) {
  const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
  if (/cowcow|scrypt\$[A-Za-z0-9+/=]{10,}/.test(code)) suspicious.push(f);
}
check('sem senha hardcoded no frontend', suspicious.length === 0, suspicious.join(', '));

console.log(`\nRESULTADO: ${pass} passaram, ${fail} falharam\n`);
process.exit(fail ? 1 : 0);
