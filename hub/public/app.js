// Sign-in and backend selection. Choosing a backend navigates to its real DSH page.
import { ago, h, t } from './lib.js';

const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
const LAST = 'dsh-hub-last';
let installPrompt;

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error ?? 'failed'), { status: response.status });
  return data;
}

const mark = () => h('picture', { class: 'mark' },
  h('source', { srcset: '/icons/favicon-dark.svg', media: '(prefers-color-scheme: dark)' }),
  h('img', { src: '/icons/favicon.svg', alt: '' }));

function loginView() {
  const password = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', 'aria-label': t('password'), placeholder: t('password'), required: true });
  const error = h('div', { class: 'error', role: 'alert' });
  const form = h('form', { class: 'login', onsubmit: async (event) => {
    event.preventDefault();
    error.textContent = '';
    try {
      await api('/api/login', { method: 'POST', body: { password: password.value } });
      void route();
    } catch (failure) {
      error.textContent = failure.status === 429 ? t('rateLimited') : failure.status === 401 ? t('wrongPassword') : t('unreachable');
    }
  } }, h('div', { class: 'login-brand' }, mark(), h('h1', null, 'DeepSeek Harness')), password, error, h('button', { class: 'btn primary', type: 'submit' }, t('login')));
  app.replaceChildren(h('main', { class: 'center' }, form));
  password.focus();
}

function addSheet() {
  const close = () => wrap.remove();
  const name = h('input', { class: 'input', 'aria-label': t('name'), placeholder: t('name') });
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('add') }, h('h2', null, t('add')), name,
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: close }, t('cancel')),
      h('button', { class: 'btn primary', onclick: async () => {
        if (!name.value.trim()) return;
        const { token } = await api('/api/harnesses', { method: 'POST', body: { name: name.value.trim() } });
        const snippet = JSON.stringify({ hubUrl: location.origin, token, harnessName: name.value.trim() }, null, 2);
        sheet.replaceChildren(h('h2', null, t('add')), h('p', { class: 'muted' }, t('tokenOnce')), h('code', { class: 'code' }, snippet), h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: close }, t('done'))));
      } }, t('create'))));
  const wrap = h('div', { class: 'sheet-wrap', onkeydown: (event) => { if (event.key === 'Escape') close(); }, onclick: (event) => { if (event.target === wrap) close(); } }, sheet);
  document.body.append(wrap);
  name.focus();
}

function card(harness) {
  const status = harness.status ?? {};
  const sub = [harness.host, harness.platform].filter(Boolean).join(' · ');
  const facts = harness.online
    ? [t('sessions', status.sessions ?? 0), status.running ? t('running', status.running) : null].filter(Boolean).join(' · ')
    : harness.lastSeen ? t('lastSeen', ago(harness.lastSeen)) : t('neverSeen');
  return h('article', { class: `card${harness.online ? '' : ' offline'}` },
    h('a', { class: 'card-main', href: harness.online ? `/h/${harness.id}/` : undefined, 'aria-disabled': harness.online ? undefined : 'true' },
      h('span', { class: `dot${status.running ? ' busy' : harness.online ? ' on' : ''}` }),
      h('span', { class: 'card-text' }, h('strong', null, harness.name), h('span', { class: 'muted' }, sub || '—'), h('span', { class: 'muted' }, facts))),
    h('button', { class: 'btn ghost danger', onclick: async () => {
      if (confirm(t('removeConfirm', harness.name))) await api(`/api/harnesses/${harness.id}`, { method: 'DELETE' });
    } }, t('remove')));
}

function watchRoster(onRoster, onLink) {
  let socket; let closed = false; let delay = 800; let retry;
  const open = () => {
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/roster`);
    socket.onopen = () => { delay = 800; onLink(true); };
    socket.onmessage = (event) => { const frame = JSON.parse(event.data); if (frame.t === 'roster') onRoster(frame.harnesses); };
    socket.onclose = () => {
      if (closed) return;
      onLink(false);
      retry = setTimeout(open, delay);
      delay = Math.min(delay * 2, 15_000);
    };
  };
  open();
  return () => { closed = true; clearTimeout(retry); socket?.close(); };
}

function installButton() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) return null;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const button = h('button', { class: 'btn ghost', hidden: !ios && !installPrompt, onclick: async () => {
    if (ios) { alert(t('iosInstall')); return; }
    await installPrompt?.prompt();
    installPrompt = undefined;
    button.hidden = true;
  } }, t('install'));
  addEventListener('beforeinstallprompt', () => { button.hidden = false; });
  return button;
}

function pickerView() {
  const hint = h('p', { class: 'muted' });
  const cards = h('div', { class: 'cards' });
  const banner = h('div', { class: 'banner', role: 'status', hidden: true });
  const empty = h('div', { class: 'empty', hidden: true }, h('strong', null, t('emptyTitle')), h('span', { class: 'muted' }, t('emptyBody')));
  app.replaceChildren(h('main', { class: 'picker' },
    h('header', { class: 'topbar' }, mark(), h('span', { class: 'grow' }, 'DeepSeek Harness'), installButton(),
      h('button', { class: 'btn ghost', onclick: async () => { await api('/api/logout', { method: 'POST', body: {} }); void route(); } }, t('logout'))),
    banner,
    h('section', { class: 'picker-inner' },
      h('div', { class: 'picker-head' }, h('div', null, h('h1', null, t('pick')), hint), h('button', { class: 'btn primary', onclick: addSheet }, t('add'))),
      empty, cards)));
  let offlineNotice = params.get('offline');
  let first = true;
  watchRoster((harnesses) => {
    const sorted = [...harnesses].sort((a, b) => Number(b.online) - Number(a.online) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
    if (first) {
      first = false;
      // An installed app resumes where it left off; the backend list is one tap away inside it.
      const last = localStorage.getItem(LAST);
      if (params.get('source') === 'pwa' && sorted.some((row) => row.id === last && row.online)) { location.replace(`/h/${last}/`); return; }
    }
    hint.textContent = t('pickHint', sorted.filter((row) => row.online).length, sorted.length);
    empty.hidden = sorted.length > 0;
    cards.replaceChildren(...sorted.map(card));
    const missing = offlineNotice && sorted.find((row) => row.id === offlineNotice);
    if (missing && !missing.online) { banner.hidden = false; banner.textContent = t('wentOffline', missing.name); } else if (offlineNotice) { banner.hidden = true; offlineNotice = null; }
  }, (connected) => {
    if (offlineNotice) return;
    banner.hidden = connected;
    banner.textContent = t('reconnecting');
  });
}

async function route() {
  try {
    await api('/api/me');
  } catch (error) {
    if (error.status === 401) { loginView(); return; }
    app.replaceChildren(h('main', { class: 'center' }, h('div', { class: 'login' }, mark(), h('p', { class: 'muted' }, t('unreachable')), h('button', { class: 'btn primary', onclick: () => void route() }, t('retry')))));
    return;
  }
  const next = params.get('next');
  if (next && /^\/h\/[\w-]+\/$/.test(next)) { location.replace(next); return; }
  pickerView();
}

addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); installPrompt = event; });
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
void route();
