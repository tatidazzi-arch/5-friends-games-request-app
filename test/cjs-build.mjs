/**
 * Reproduz o BUILD da Vercel: empacota a função em CommonJS e executa.
 *
 * POR QUE ISSO EXISTE:
 * a Vercel compila arquivos .js para CommonJS. Em CommonJS não existe
 * import.meta.url — usar isso no topo do arquivo quebra a função no boot
 * com FUNCTION_INVOCATION_FAILED, sem log nenhum. Foi exatamente o que
 * aconteceu com api/index.js.
 *
 * Este teste empacota a função do jeito que a Vercel faz (CJS) e executa,
 * garantindo que ela carrega e responde.
 *
 * Roda: node test/cjs-build.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
function check(nome, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS ${nome}`); }
  else { fail++; console.log(`  FALHOU ${nome} ${extra}`); }
}

console.log('\n=== build no estilo Vercel (CommonJS) ===\n');

// 0. a função tem que ser .mjs (a Vercel converte .js para CJS)
const apiMjs = path.join(ROOT, 'api', 'index.mjs');
const apiJs = path.join(ROOT, 'api', 'index.js');
check('a função é api/index.mjs (ESM nativo, sem conversão p/ CJS)',
  fs.existsSync(apiMjs) && !fs.existsSync(apiJs),
  `mjs=${fs.existsSync(apiMjs)} js=${fs.existsSync(apiJs)}`);

// 0b. nenhum arquivo da função USA import.meta no código (quebra em CJS)
//     (comentários mencionando a palavra estão ok)
if (fs.existsSync(apiMjs)) {
  const codigo = fs
    .readFileSync(apiMjs, 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
  check('api/index.mjs não usa import.meta.url no código',
    !codigo.includes('import.meta.url'), 'import.meta.url quebra em CJS');
}

// 1. empacota em CJS, como a Vercel faz com .js
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-cjs-'));
const outFile = path.join(tmp, 'bundle.cjs');
let bundled = false;
try {
  // o esbuild fica em node_modules/.bin se estiver instalado; senão usa npx
  const esbuildBin = path.join(ROOT, 'node_modules', '.bin', 'esbuild.cmd');
  const useLocal = fs.existsSync(esbuildBin);
  execFileSync(
    useLocal ? esbuildBin : 'npx',
    useLocal
      ? ['api/index.mjs', '--bundle', '--platform=node', '--format=cjs',
         `--outfile=${outFile}`, '--external:pg', '--external:node:sqlite']
      : ['--yes', 'esbuild@latest', 'api/index.mjs', '--bundle', '--platform=node', '--format=cjs',
         `--outfile=${outFile}`, '--external:pg', '--external:node:sqlite'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000, shell: !useLocal },
  );
  bundled = fs.existsSync(outFile);
} catch (err) {
  console.log('  (esbuild indisponível: pulando o teste de execução)');
  console.log('  ' + String(err.stderr ?? err.message).split('\n')[0]);
}
check('empacotou em CommonJS', bundled);
if (!bundled) {
  console.log(`\nRESULTADO: ${pass} passaram, ${fail} falharam\n`);
  process.exit(fail ? 1 : 0);
}

// 2. executa o bundle CJS e chama o handler
const runner = path.join(tmp, 'run.cjs');
fs.writeFileSync(
  runner,
  `
const path = require('path');
const fs = require('fs');
const bundle = path.join(__dirname, 'bundle.cjs');

function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    writeHead(c, h = {}) { this.statusCode = c; for (const [k, v] of Object.entries(h)) this.headers[k.toLowerCase()] = v; },
    end(d) { if (d) this.body += d.toString(); },
  };
}

(async () => {
  let handler;
  try {
    const mod = require(bundle);
    handler = mod.default || mod;
    if (typeof handler !== 'function') throw new Error('bundle não exporta função');
  } catch (e) {
    console.log('CARREGOU_ERRO: ' + e.message);
    process.exit(2);
  }
  console.log('CARREGOU_OK');

  const res = fakeRes();
  const req = {
    method: 'GET',
    url: '/api/index?__path=/api/health',
    headers: { host: 'x' },
    query: { __path: '/api/health' },
    socket: { remoteAddress: '1.1.1.1' },
    async *[Symbol.asyncIterator]() {},
  };
  try {
    await handler(req, res);
  } catch (e) {
    console.log('HANDLER_ERRO: ' + e.message);
    process.exit(3);
  }
  console.log('STATUS: ' + res.statusCode);
  console.log('BODY: ' + res.body.slice(0, 300));
})();
`,
);

process.env.DATA_DIR = path.join(tmp, 'data');
let out = '';
let code = 0;
try {
  out = execFileSync(process.execPath, [runner], { encoding: 'utf8', timeout: 120_000, stdio: 'pipe' });
} catch (err) {
  out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  code = err.status ?? 1;
}

console.log('  --- saída do bundle CJS ---');
for (const line of out.split('\n').slice(0, 8)) console.log('  ' + line);

check('o bundle CJS carrega sem erro', out.includes('CARREGOU_OK'), out.slice(0, 300));
check('o handler responde', out.includes('STATUS: 200'), out.slice(0, 300));
check('/api/health devolve JSON', out.includes('"ok":true'), out.slice(0, 300));

try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* ok */ }

console.log(`\nRESULTADO: ${pass} passaram, ${fail} falharam\n`);
process.exit(fail ? 1 : 0);
