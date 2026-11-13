// Diagnóstico rápido do deploy.
// Use: node verificar-deploy.mjs
const url = process.argv[2] || 'https://5-friends-games-request-i15fwn65s-5-fg.vercel.app';

const res = await fetch(`${url}/api/health`, { redirect: 'manual' });

console.log(`\nURL: ${url}/api/health`);
console.log(`Status: ${res.status}`);

if (res.status === 302 || res.status === 301) {
  const loc = res.headers.get('location') || '';
  console.log(`\n🔒 Deployment Protection ATIVO (redirect para ${loc.slice(0, 60)}...)`);
  console.log('   Desligue em: Settings → Deployment Protection → Vercel Authentication → Disabled');
  console.log('   Sem isso os seus amigos não conseguem entrar no site.');
} else {
  const txt = await res.text();
  try {
    const h = JSON.parse(txt);
    console.log('\n' + JSON.stringify(h, null, 2));
    if (h.temPostgresUrl === false) {
      console.log('\n⚠️  POSTGRES_URL NÃO está configurada.');
      console.log('   Crie em: Settings → Environment Variables → POSTGRES_URL');
      console.log('   (a connection string do Postgres/Neon) e redeploy.');
    } else {
      console.log('\n✅ Postgres configurado.');
    }
  } catch {
    console.log('\n' + txt.slice(0, 800));
  }
}
console.log('');
