# Portal de acesso — 5 Friends Games

Site de login com **senha mestra do dono**: o dono entra, cria contas
(nome de usuário + senha) para outras pessoas e elas entram com essas credenciais.

Sem dependências externas — só Node (módulos nativos + `node:sqlite`).

```
server.mjs        servidor HTTP + API
lib/db.mjs        banco SQLite (usuários, sessões, tentativas, histórico)
lib/auth.mjs      hash scrypt, sessões em cookie, trava anti-força bruta
lib/http.mjs      JSON, cookies, arquivos estáticos
public/           tela de login + painel do dono (HTML/CSS/JS puro)
data/             banco de dados (criado no 1º start, fora do git)
```

## Rodar

```bash
npm start
# http://localhost:3000
```

Requer **Node 22.5+** (usa o `node:sqlite` nativo). Não precisa de `npm install` —
o projeto não tem dependências.

Variáveis de ambiente (todas opcionais):

| Var | Padrão | O que faz |
|---|---|---|
| `PORT` | `3000` | porta do servidor |
| `HOST` | `0.0.0.0` | interface de rede |
| `DATA_DIR` | `./data` | onde fica o banco |
| `SESSION_DAYS` | `7` | validade da sessão |
| `MAX_LOGIN_FAILS` | `5` | erros de login até bloquear |
| `LOCK_MINUTES` | `10` | tempo de bloqueio |
| `SECURE_COOKIE` | `0` | `1` = cookie só em https (produção) |
| `GAME_DIST` | `./dist` | pasta do build do jogo (opcional) |

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
- **Pedir troca de senha**: o convidado é obrigado a criar uma senha nova no 1º acesso.
- **Desativar**: a conta é bloqueada na hora e as sessões abertas caem.
- **Resetar senha**: gera uma senha nova e derruba as sessões do usuário.
- **Histórico**: quem entrou, quando, e o que o dono fez.

## Segurança

- Senhas nunca são gravadas em texto puro: `scrypt` com sal aleatório por usuário
  e comparação em tempo constante (`timingSafeEqual`).
- A senha do usuário só aparece em texto puro no momento da criação/reset — nunca
  é retornada depois (o servidor só tem o hash).
- Sessão em cookie `HttpOnly` + `SameSite=Lax`, com expiração.
- Trava anti-força bruta por usuário+IP (5 erros → 10 min bloqueado).
- Caminhos de arquivo bloqueados contra *path traversal*.
- O `data/` (com o banco e as senhas) está fora do git.

## Publicar na internet

O portal precisa de **disco persistente** (o banco é um arquivo SQLite), então
não roda como serverless da Vercel. Opções:

- **Servidor próprio / VPS** (recomendado): `npm start` atrás de nginx/Caddy com
  TLS e `SECURE_COOKIE=1`.
- **Railway / Render / Fly.io** com disco montado.
- **Vercel**: funciona se trocar o SQLite por um Postgres/Vercel KV e adaptar
  `lib/db.mjs` (as queries já estão isoladas lá).

Backup do banco: copie o arquivo `data/acesso.db` (é um SQLite comum).
