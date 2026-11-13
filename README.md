# Portal de acesso — 5 Friends Games

Site de login com **senha mestra do dono**: o dono entra, cria contas
(nome de usuário + senha) para outras pessoas e elas entram com essas credenciais.

Roda na **Vercel** (com Postgres) ou localmente (com SQLite, sem dependências).

```
server.mjs        servidor HTTP local (node server.mjs)
api/index.js      função serverless da Vercel
lib/app.mjs       núcleo do app: rotas + regras de acesso (compartilhado)
lib/db.mjs        banco: SQLite (local) ou Postgres (Vercel) — mesma API
lib/auth.mjs      hash scrypt, sessões em cookie, trava anti-força bruta
lib/http.mjs      JSON, cookies, arquivos estáticos
public/           tela de login + painel do dono (HTML/CSS/JS puro)
test/             testes automatizados (local, serverless, Postgres e bundle)
data/             banco SQLite local (criado no 1º start, fora do git)
```

## Rodar localmente

```bash
npm install       # instala o "pg" (só é usado se houver POSTGRES_URL)
npm start
# http://localhost:3000
```

Sem `POSTGRES_URL` o app usa **SQLite** (arquivo em `data/acesso.db`) e não
precisa de nenhum servidor de banco.

| Var | Padrão | O que faz |
|---|---|---|
| `PORT` | `3000` | porta do servidor |
| `HOST` | `0.0.0.0` | interface de rede |
| `DATA_DIR` | `./data` | onde fica o banco SQLite |
| `POSTGRES_URL` | — | se definir, usa Postgres em vez de SQLite |
| `DATABASE_URL` | — | alias do POSTGRES_URL |
| `SESSION_DAYS` | `7` | validade da sessão |
| `MAX_LOGIN_FAILS` | `5` | erros de login até bloquear |
| `LOCK_MINUTES` | `10` | tempo de bloqueio |
| `SECURE_COOKIE` | `0` | `1` = cookie só em https |
| `GAME_DIST` | `./dist` | pasta do build do jogo (opcional) |

## Publicar na Vercel

### 1. Banco de dados

A Vercel é serverless: não tem disco fixo, então o SQLite **não funciona lá**.
Crie um Postgres (a Vercel tem o **Vercel Postgres**/Neon integrado):

- Dashboard da Vercel → **Storage** → **Create Database** → Neon/Postgres
- Copie a connection string (`postgres://...`)

### 2. Variáveis de ambiente

No projeto na Vercel → **Settings** → **Environment Variables**:

| Nome | Valor |
|---|---|
| `POSTGRES_URL` | a connection string do Postgres |
| `SESSION_DAYS` | `7` (opcional) |

> **A `POSTGRES_URL` é obrigatória na Vercel.** Sem ela o app até abre, mas usa um
> banco temporário em `/tmp`: as contas somem sempre que a função reinicia
> (a Vercel reinicia funções o tempo todo). A tela mostra um aviso amarelo
> quando isso acontece.

### 2b. Conferindo se está tudo certo

Depois do deploy, abra:

```
https://SEU-PROJETO.vercel.app/api/health
```

A resposta mostra o backend em uso, se a `POSTGRES_URL` foi lida e a versão do
Node. Se der `503`, o campo `detalhe` diz exatamente o que falhou.

### 2c. Se aparecer "500 FUNCTION_INVOCATION_FAILED"

Quase sempre é a `POSTGRES_URL` (ausente, com senha errada ou banco dormindo).
Veja a seção **Troubleshooting** abaixo. |

### 3. Deploy

```bash
npm install -g vercel
vercel link          # conecta ao projeto
vercel deploy --prod
```

O `vercel.json` já está pronto: a função em `api/index.js` atende a API, a
tela de login e o jogo protegido, e o `public/` é servido como estático.

### Como o roteamento funciona

A Vercel reescreve a URL antes de chamar a função, então o `req.url` não é
confiável. Por isso o `vercel.json` manda o caminho original em `?__path=`
e a função usa esse valor:

```json
{ "source": "/api/(.*)", "destination": "/api/index?__path=/api/$1" }
```

### Testar o deploy antes de subir

```bash
vercel dev           # sobe localmente com o mesmo roteamento da Vercel
```

## Troubleshooting

### "500 FUNCTION_INVOCATION_FAILED"

A função não conseguiu iniciar. Descubra o motivo em `/api/health` (ela responde
mesmo quando o banco falha) ou nos **logs** do deploy na Vercel.

Causas, da mais comum para a menos:

| Sintoma | Causa | Solução |
|---|---|---|
| `temPostgresUrl: false` | faltou a variável de ambiente | crie `POSTGRES_URL` em Settings → Environment Variables e redeploy |
| `column "id" does not exist` | banco com schema antigo | já corrigido nesta versão; redeploy |
| `password authentication failed` | senha da URL errada | recrie a connection string no painel do banco |
| `ECONNREFUSED` / `timeout` | banco dormendo ou inacessível | "wake" no painel (Neon/Vercel Postgres) e redeploy |
| `pg não está instalado` | dependência faltando | `npm install` e redeploy (a Vercel instala sozinha pelo `package.json`) |

### A tela pede login e não entra

Duas causas diferentes:

1. **"This page is unavailable"** → a função quebrou. Veja acima.
2. **Página de login da Vercel** → o projeto tem **Deployment Protection**
   ligado. Desligue em **Settings → Deployment Protection → Vercel
   Authentication** (ou coloque em "Only Preview"). Sem isso, quem não estiver
   logado na Vercel não consegue acessar o site — inclusive os seus amigos.

### As contas somem do nada

Sinal de que está rodando com o banco temporário (sem `POSTGRES_URL`).
Configure o Postgres — a tela de login mostra um aviso amarelo nesse caso.

### O deploy não(build) falha

Confira se o `package.json` tem `"type": "module"` e se `api/index.js` está
na raiz. O `vercel.json` não deve ter `buildCommand` (não há build).

1. **Primeiro acesso**: o navegador mostra "crie a conta do dono" (seu nome,
   usuário `dono`, senha 6+ caracteres). Isso só acontece uma vez — o banco
   guarda que já foi feito.
2. **Dono faz login** e cai no painel **Contas de acesso**.
3. **Cria a conta**: digita o usuário (ex.: `joao`), opcionalmente o nome, a senha
   (ou deixa em branco para o sistema gerar uma) e a validade em dias.
4. **Manda pros outros**: o painel mostra a senha em texto **uma única vez**, com
   botões de copiar a credencial ou copiar a mensagem pronta pro WhatsApp.
5. **Os outros entram** em `/login` com o usuário + senha que receberam.
6. No painel o dono pode **desativar**, **resetar senha**, **apagar** contas e ver
   o **histórico** de acessos.

## Recursos

- **Senha mestra**: só o dono cria/gerencia contas. Convidados não veem as contas
  alheias (a API responde 403).
- **Senha gerada**: deixe o campo vazio e o sistema cria uma senha legível (sem 0/O, 1/l).
- **Validade**: a conta expira sozinha depois de N dias.
- **Pedir troca de senha**: por padrão o convidado é obrigado a criar uma senha
  nova no 1º acesso (dá para desligar na criação da conta).
- **Desativar**: a conta é bloqueada na hora e as sessões abertas caem.
- **Resetar senha**: gera uma senha nova e derruba as sessões do usuário.
- **Histórico**: quem entrou, quando, e o que o dono fez.

## Segurança

- Senhas nunca são gravadas em texto puro: `scrypt` com sal aleatório por usuário
  e comparação em tempo constante (`timingSafeEqual`).
- A senha do usuário só aparece em texto puro no momento da criação/reset — nunca
  é retornada depois (o servidor só tem o hash).
- Sessão em cookie `HttpOnly` + `SameSite=Lax` (+ `Secure` no deploy), com expiração.
- Trava anti-força bruta por usuário+IP (5 erros → 10 min bloqueado).
- Caminhos de arquivo bloqueados contra *path traversal*.
- O `data/` (com o banco e as senhas) está fora do git.

## Testes

```bash
npm test
```

- `test/local-sim.mjs` — servidor local com SQLite (fluxo completo do dono e convidado)
- `test/vercel-sim.mjs` — função serverless simulada (body parseado, URL reescrita, cookie Secure)
- `test/pg-adapter.mjs` — adapter Postgres (conversão de SQL, `RETURNING id`, `ON CONFLICT`)
- `test/vercel-env.mjs` — disco read-only (fallback pro /tmp), Postgres fora do ar, `/api/health`
- `test/bundle-check.mjs` — confere se o bundle da função tem tudo que ela importa

## Publicar fora da Vercel

O app também roda em qualquer Node com disco (VPS, Railway, Render, Fly.io):

```bash
npm start
```

Backup do banco local: copie `data/acesso.db`. No Postgres, use `pg_dump`.
