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
// o build da Vercel exige includeFiles como STRING (array quebra o deploy)
check('includeFiles inclui public/**',
  typeof fn.includeFiles === 'string' && fn.includeFiles.includes('public'),
  JSON.stringify(fn.includeFiles));

// 5. os rewrites carregam o caminho original
const rewrites = vercel.rewrites ?? [];
const allHavePath = rewrites.every((r) => r.destination.includes('__path='));
check('todos os rewrites passam __path', allHavePath, JSON.stringify(rewrites));
check('rewrite da API existe', rewrites.some((r) => r.source === '/api/(.*)'));
check('rewrite do /login existe', rewrites.some((r) => r.source === '/login'));

// 6. outputDirectory: não usamos (a função serve o public/ via includeFiles).
//    "public" como outputDirectory conflita com a pasta api/ na Vercel.
check('outputDirectory não é usado (a função serve o public/)',
  vercel.outputDirectory === undefined, String(vercel.outputDirectory));

// 7. package.json tem o pg (Postgres na Vercel)
// no repo do jogo o package.json é o do jogo (sem pg) — o teste do bundle
// do portal roda no repo standalone, onde o package.json é o do portal.
const pkgPath = path.join(ROOT, 'package.json');
const temPkg = fs.existsSync(pkgPath);
const pkg = temPkg ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')) : {};
if (temPkg) {
  check('pg nas dependências', !!pkg.dependencies?.pg, JSON.stringify(pkg.dependencies));
  check('script de start', pkg.scripts?.start === 'node server.mjs', pkg.scripts?.start);
  check('script de teste', !!pkg.scripts?.test, pkg.scripts?.test);

  // 7b. NÃO pode ter "main": a Vercel usa esse campo como entrypoint da função.
  //     Se apontar pra server.mjs (servidor HTTP), o build passa mas toda
  //     requisição dá 500 — foi exatamente o bug do primeiro deploy.
  check('package.json NÃO declara "main"',
    pkg.main === undefined, `main=${pkg.main}`);
  check('package.json declara "type": "module"', pkg.type === 'module', pkg.type);
  // "engines" NÃO pode ser fixado: se divergir da versão em Project Settings,
  // a Vercel falha o build ("incompatible with the version configured in
  // Project Settings"). Sem engines, ela usa a do projeto.
  check('package.json NÃO fixa "engines"',
    pkg.engines === undefined, JSON.stringify(pkg.engines));
}

// 8. o .gitignore protege o data/
const giPath = path.join(ROOT, '.gitignore');
if (fs.existsSync(giPath)) {
  const gi = fs.readFileSync(giPath, 'utf8');
  check('.gitignore ignora data/', /^\s*data\//m.test(gi));
} else {
  console.log('  (sem .gitignore local: o repo do jogo protege o data/ na raiz)');
}

// 9. nenhum arquivo com senha no bundle
const suspicious = [];
for (const f of ['public/app.js', 'public/index.html', 'public/style.css']) {
  const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
  if (/cowcow|scrypt\$[A-Za-z0-9+/=]{10,}/.test(code)) suspicious.push(f);
}
check('sem senha hardcoded no frontend', suspicious.length === 0, suspicious.join(', '));

// 10. a função da Vercel precisa EXPORTA um handler
//     (se a Vercel rodar server.mjs como função, não há handler e dá 500)
const apiSrc = fs.readFileSync(apiFile, 'utf8');
check('api/index.js exporta handler default',
  /export\s+default\s+(async\s+)?function/.test(apiSrc) || /export\s+default\s+\w+/.test(apiSrc));

// 11. server.mjs NÃO pode exportar handler (é o servidor local)
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
check('server.mjs não exporta handler (evita confusão de entrypoint)',
  !/export\s+default\s+(async\s+)?function\s+handler/.test(serverSrc));
check('server.mjs abre servidor HTTP', serverSrc.includes('server.listen'));

// 12. simula o build da Vercel: qual arquivo vira a função?
//     A Vercel usa api/index.js se a pasta api/ existir.
const temApi = fs.existsSync(path.join(ROOT, 'api', 'index.js'));
check('pasta api/ existe (a Vercel cria a função a partir dela)', temApi);
if (temPkg) {
  check('a função não depende de "main" do package.json', pkg.main === undefined);
}

console.log(`\nRESULTADO: ${pass} passaram, ${fail} falharam\n`);
process.exit(fail ? 1 : 0);
