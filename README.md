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
test/             testes automatizados (local, serverless e adapter Postgres)
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

## Como se usa

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

## Publicar fora da Vercel

O app também roda em qualquer Node com disco (VPS, Railway, Render, Fly.io):

```bash
npm start
```

Backup do banco local: copie `data/acesso.db`. No Postgres, use `pg_dump`.
