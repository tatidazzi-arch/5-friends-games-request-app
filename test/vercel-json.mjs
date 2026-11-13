/**
 * Valida o vercel.json contra o schema da Vercel.
 *
 * A CLI da Vercel aceita "includeFiles" como array no schema, mas o build
 * real exige string — e o erro só aparece no deploy. Este teste pega isso
 * antes.
 *
 * Roda: node test/vercel-json.mjs
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

console.log('\n=== validação do vercel.json ===\n');

const vjPath = path.join(ROOT, 'vercel.json');
if (!fs.existsSync(vjPath)) {
  console.log('  (sem vercel.json neste repo — nada a validar)');
  console.log(`\nRESULTADO: 0 passaram, 0 falharam\n`);
  process.exit(0);
}

const raw = fs.readFileSync(vjPath, 'utf8');
let vj;
try {
  vj = JSON.parse(raw);
  check('vercel.json é JSON válido', true);
} catch (e) {
  check('vercel.json é JSON válido', false, e.message);
  process.exit(1);
}

// --- tipos aceitos pela Vercel ---
for (const key of ['framework', 'buildCommand', 'outputDirectory', 'installCommand']) {
  if (!(key in vj)) continue;
  const v = vj[key];
  const ok = v === null || typeof v === 'string';
  check(`"${key}" é string ou null`, ok, `tipo=${typeof v}`);
}

// --- functions: includeFiles é STRING (o build exige isso!) ---
if (vj.functions) {
  for (const [file, cfg] of Object.entries(vj.functions)) {
    check(`functions["${file}"] é objeto`, typeof cfg === 'object' && cfg !== null);
    if ('includeFiles' in cfg) {
      check(
        `functions["${file}"].includeFiles é string (array quebra o build!)`,
        typeof cfg.includeFiles === 'string',
        `tipo=${typeof cfg.includeFiles} valor=${JSON.stringify(cfg.includeFiles)}`,
      );
    }
    if ('excludeFiles' in cfg) {
      check(
        `functions["${file}"].excludeFiles é string`,
        typeof cfg.excludeFiles === 'string',
        `tipo=${typeof cfg.excludeFiles}`,
      );
    }
    if ('maxDuration' in cfg) {
      check(
        `functions["${file}"].maxDuration é 1..max ou "max"`,
        cfg.maxDuration === 'max' || (Number.isInteger(cfg.maxDuration) && cfg.maxDuration >= 1),
        `valor=${cfg.maxDuration}`,
      );
    }
  }
}

// --- rewrites: source e destination presentes, sem query na source ---
if (vj.rewrites) {
  check('rewrites é array', Array.isArray(vj.rewrites));
  for (const r of vj.rewrites ?? []) {
    check(`rewrite "${r.source}" tem destination`, typeof r.destination === 'string');
    check(`rewrite "${r.source}" não tem query na source`, !r.source.includes('?'));
    check(`rewrite "${r.source}" não usa "has"/"missing" (não funciona em rewrites)`, !r.has && !r.missing);
  }
}

// --- crons: array de objetos com path e schedule ---
if (vj.crons !== undefined) {
  check('crons é array', Array.isArray(vj.crons));
  for (const c of vj.crons ?? []) {
    check('cron tem path e schedule', typeof c.path === 'string' && typeof c.schedule === 'string');
  }
}

// --- chaves desconhecidas causam erro de config na Vercel ---
const CHAVES_VALIDAS = new Set([
  '$schema', 'buildCommand', 'bunVersion', 'cleanUrls', 'crons', 'devCommand',
  'fluid', 'framework', 'functions', 'headers', 'ignoreCommand', 'images',
  'installCommand', 'outputDirectory', 'proxy', 'redirects', 'bulkRedirectsPath',
  'regions', 'functionFailoverRegions', 'rewrites', 'routes', 'skipMiddlewareRequestBody',
  'trailingSlash',
]);
for (const key of Object.keys(vj)) {
  check(`chave "${key}" é válida na Vercel`, CHAVES_VALIDAS.has(key), 'chave desconhecida');
}

// --- a pasta api/ precisa existir para a função ser criada ---
check('pasta api/ existe (senão a Vercel não cria função nenhuma)',
  fs.existsSync(path.join(ROOT, 'api')));

console.log(`\nRESULTADO: ${pass} passaram, ${fail} falharam\n`);
process.exit(fail ? 1 : 0);
