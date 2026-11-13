/* Portal de acesso — lógica da tela (login, painel do dono, conta do usuário). */
'use strict';

const $ = (id) => document.getElementById(id);
const state = { user: null, hasGame: false };

// ---------------------------------------------------------------- utils

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* resposta sem JSON */
  }
  if (!res.ok) throw new Error(data.error || `erro ${res.status}`);
  return data;
}

function showError(el, msg, ok = false) {
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('ok', ok);
  el.hidden = false;
  if (ok) setTimeout(() => { el.hidden = true; }, 4000);
}

function hideError(el) {
  if (el) el.hidden = true;
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Rótulos de ação pro histórico. */
const ACTION_LABEL = {
  setup_dono: 'criou a conta do dono',
  login_ok: 'entrou',
  login_falhou: 'errou a senha',
  criou_usuario: 'criou a conta',
  desativou_usuario: 'desativou a conta',
  reativou_usuario: 'reativou a conta',
  resetou_senha: 'resetou a senha',
  apagou_usuario: 'apagou a conta',
  trocou_senha_propria: 'trocou a própria senha',
};

// ---------------------------------------------------------------- boot

async function boot() {
  try {
    const s = await api('/api/state');
    state.hasGame = s.hasGame;
    if (s.ephemeral) {
      // Vercel sem POSTGRES_URL: os dados somem a cada reinício da função
      $('warnBanner').hidden = false;
      $('warnText').textContent =
        'Este deploy está usando um banco temporário: as contas somem quando o servidor reinicia. ' +
        'Configure a variável de ambiente POSTGRES_URL na Vercel para guardar tudo de verdade.';
    }
    if (s.needsSetup) {
      $('setupBox').hidden = false;
      $('loginSub').textContent = 'Configure o acesso do dono para começar';
      $('loginForm').hidden = true;
    }
    if (s.user) showPanel(s.user);
  } catch (err) {
    // banco fora do ar / função quebrada: mostra o motivo em vez de tela em branco
    $('warnBanner').hidden = false;
    $('warnBanner').style.background = 'rgba(255,92,92,.14)';
    $('warnBanner').style.borderColor = 'rgba(255,92,92,.45)';
    $('warnText').textContent = `O portal não está funcionando: ${err.message}`;
  }
  wire();
}

function wire() {
  // mostrar/ocultar senha
  for (const btn of document.querySelectorAll('[data-toggle]')) {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.toggle);
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  }

  $('loginForm').addEventListener('submit', onLogin);
  $('setupForm').addEventListener('submit', onSetup);
  $('createForm').addEventListener('submit', onCreateUser);
  $('passForm').addEventListener('submit', onChangePassword);
  $('logoutBtn').addEventListener('click', onLogout);
  $('genPass').addEventListener('click', () => { $('newPass').value = randomPass(); });
}

// ---------------------------------------------------------------- login

async function onLogin(ev) {
  ev.preventDefault();
  hideError($('loginError'));
  const btn = $('loginBtn');
  btn.disabled = true;
  btn.textContent = 'ENTRANDO...';
  try {
    const r = await api('/api/login', {
      method: 'POST',
      body: { username: $('loginUser').value, password: $('loginPass').value },
    });
    $('loginPass').value = '';
    showPanel(r.user);
    toast(`Bem-vindo, ${r.user.displayName}!`);
  } catch (err) {
    showError($('loginError'), err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'ENTRAR';
  }
}

async function onSetup(ev) {
  ev.preventDefault();
  hideError($('setupError'));
  try {
    await api('/api/setup', {
      method: 'POST',
      body: {
        username: $('setupUser').value,
        password: $('setupPass').value,
        displayName: $('setupName').value,
      },
    });
    toast('Conta do dono criada! Faça login.');
    $('setupBox').hidden = true;
    $('loginForm').hidden = false;
    $('loginSub').textContent = 'Entre com sua conta';
    $('loginUser').value = $('setupUser').value;
    $('loginPass').focus();
  } catch (err) {
    showError($('setupError'), err.message);
  }
}

async function onLogout() {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* ignora */ }
  location.reload();
}

// ---------------------------------------------------------------- painel

function showPanel(user) {
  state.user = user;
  $('viewLogin').hidden = true;
  $('viewPanel').hidden = false;
  $('whoami').textContent = `${user.displayName} (${user.username})`;
  // esconde os dois painéis antes de mostrar o certo (troca de usuário na mesma aba)
  $('adminPanel').hidden = true;
  $('userPanel').hidden = true;
  $('gameLink').hidden = !state.hasGame;

  if (user.isAdmin) {
    $('adminPanel').hidden = false;
    loadUsers();
    loadAudit();
  } else {
    $('userPanel').hidden = false;
    $('userName').textContent = user.displayName;
    $('userInfo').innerHTML = `
      <div>Usuário: <b>${esc(user.username)}</b></div>
      <div>Conta criada em: ${fmtDate(user.createdAt)}</div>
      ${user.expiresAt ? `<div>Acesso válido até: <b>${fmtDate(user.expiresAt)}</b></div>` : '<div>Acesso sem prazo de validade</div>'}
    `;
  }

  // senha temporária: o convidado precisa trocar antes de continuar
  if (user.mustChange) {
    $('gameLink').hidden = true;
    $('passPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    showError($('passError'), 'Defina uma nova senha para continuar.');
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- dono: contas

async function loadUsers() {
  try {
    const { users } = await api('/api/users');
    const tb = $('usersTable').querySelector('tbody');
    tb.innerHTML = '';
    for (const u of users) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><b>${esc(u.username)}</b>${u.isAdmin ? ' <span class="tag admin">dono</span>' : ''}</td>
        <td>${esc(u.displayName)}</td>
        <td>${fmtDate(u.createdAt)}</td>
        <td>${fmtDate(u.lastLogin)}</td>
        <td>${u.disabled ? '<span class="tag off">desativada</span>' : '<span class="tag on">ativa</span>'}</td>
        <td class="actions"></td>
      `;
      const actions = tr.querySelector('td.actions');

      const reset = document.createElement('button');
      reset.className = 'btn ghost small';
      reset.style.marginTop = '0';
      reset.textContent = 'Nova senha';
      reset.onclick = () => resetPassword(u);
      actions.appendChild(reset);

      const toggle = document.createElement('button');
      toggle.className = 'btn ghost small';
      toggle.style.marginTop = '0';
      toggle.textContent = u.disabled ? 'Ativar' : 'Desativar';
      toggle.onclick = () => toggleUser(u);
      actions.appendChild(toggle);

      if (u.id !== state.user.id) {
        const del = document.createElement('button');
        del.className = 'btn danger';
        del.textContent = 'Apagar';
        del.onclick = () => deleteUser(u);
        actions.appendChild(del);
      }
      tb.appendChild(tr);
    }
  } catch (err) {
    toast(err.message);
  }
}

function randomPass() {
  const a = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => a[b % a.length]).join('');
}

async function onCreateUser(ev) {
  ev.preventDefault();
  hideError($('createError'));
  const btn = ev.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const body = {
      username: $('newUser').value,
      displayName: $('newName').value,
      password: $('newPass').value,
      isAdmin: $('newAdmin').checked,
      mustChange: $('newMustChange').checked,
    };
    if ($('newDays').value) body.expiresDays = Number($('newDays').value);
    const r = await api('/api/users', { method: 'POST', body });
    $('createForm').reset();
    $('newMustChange').checked = true;
    showCreated(r.user, r.password);
    loadUsers();
    loadAudit();
  } catch (err) {
    showError($('createError'), err.message);
  } finally {
    btn.disabled = false;
  }
}

/** Mostra a senha em texto (única vez) + botão de copiar. */
function showCreated(user, password) {
  const box = $('createdList');
  const div = document.createElement('div');
  div.className = 'cred';
  div.innerHTML = `
    <span>✅ Conta <b>${esc(user.username)}</b> criada. Senha: <b class="sp">${esc(password)}</b></span>
  `;
  const copy = document.createElement('button');
  copy.className = 'btn ghost small';
  copy.style.marginTop = '0';
  copy.textContent = 'Copiar';
  copy.onclick = () => copyText(`Usuário: ${user.username}\nSenha: ${password}\nLink: ${location.origin}/login`);
  div.appendChild(copy);

  const share = document.createElement('button');
  share.className = 'btn ghost small';
  share.style.marginTop = '0';
  share.textContent = 'Copiar msg. p/ WhatsApp';
  share.onclick = () => copyText(
    `🔐 *Acesso liberado!*\n\nUsuário: \`${user.username}\`\nSenha: \`${password}\`\n\n${location.origin}/login`,
  );
  div.appendChild(share);

  box.prepend(div);
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copiado!');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('Copiado!');
  }
}

async function toggleUser(u) {
  try {
    await api(`/api/users/${u.id}/${u.disabled ? 'enable' : 'disable'}`, { method: 'POST' });
    toast(u.disabled ? 'Conta ativada' : 'Conta desativada');
    loadUsers();
  } catch (err) {
    toast(err.message);
  }
}

async function resetPassword(u) {
  const nova = prompt(`Nova senha para ${u.username} (vazio = gerar):`);
  if (nova === null) return;
  try {
    const r = await api(`/api/users/${u.id}/password`, { method: 'POST', body: { password: nova } });
    showCreated(u, r.password);
    toast('Senha resetada!');
    loadUsers();
  } catch (err) {
    toast(err.message);
  }
}

async function deleteUser(u) {
  if (!confirm(`Apagar a conta "${u.username}"? Não dá para desfazer.`)) return;
  try {
    await api(`/api/users/${u.id}`, { method: 'DELETE' });
    toast('Conta apagada');
    loadUsers();
  } catch (err) {
    toast(err.message);
  }
}

async function loadAudit() {
  try {
    const { log } = await api('/api/audit');
    $('auditList').innerHTML = log
      .map((l) => `<li><b>${fmtDate(l.at)}</b> — ${esc(l.actor || '—')} ${esc(ACTION_LABEL[l.action] || l.action)} ${esc(l.detail ? `(${l.detail})` : '')}</li>`)
      .join('') || '<li>sem registros</li>';
  } catch { /* ignora */ }
}

// ---------------------------------------------------------------- trocar senha

async function onChangePassword(ev) {
  ev.preventDefault();
  hideError($('passError'));
  const p1 = $('newPass2').value;
  const p2 = $('newPass2b').value;
  if (p1 !== p2) return showError($('passError'), 'As senhas novas não batem.');
  if (p1.length < 6) return showError($('passError'), 'A nova senha precisa de 6+ caracteres.');
  try {
    await api('/api/me/password', {
      method: 'POST',
      body: { currentPassword: $('curPass').value, newPassword: p1 },
    });
    ev.target.reset();
    if (state.user) state.user.mustChange = false;
    if (state.hasGame) $('gameLink').hidden = false;
    showError($('passError'), 'Senha alterada!', true);
  } catch (err) {
    showError($('passError'), err.message);
  }
}

boot();
