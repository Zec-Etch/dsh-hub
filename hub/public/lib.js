// DOM helper and translations for the sign-in and backend pages.
export function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child !== undefined && child !== null && child !== false) node.append(child);
  return node;
}

const STRINGS = {
  zh: {
    login: '登录', password: '访问密码', wrongPassword: '密码不正确', rateLimited: '尝试次数过多，请稍后再试', logout: '退出登录',
    pick: '选择后端', pickHint: (o, t) => `${o} 台在线，共 ${t} 台`, add: '接入新后端', remove: '移除', install: '安装应用',
    sessions: (n) => `${n} 个会话`, running: (n) => `${n} 个运行中`, lastSeen: (s) => `最后在线 ${s}`, neverSeen: '尚未连接', offlineNow: '离线',
    emptyTitle: '还没有接入的后端', emptyBody: '点「接入新后端」生成令牌，写入该 DSH 的配置后，它会主动连上来。',
    name: '名称', create: '生成令牌', tokenOnce: '令牌只显示这一次。把下面内容存成该 DSH 的 $DSH_HOME/dsh-hub-agent.json，几秒内会自动连上：', done: '完成', cancel: '取消',
    removeConfirm: (n) => `移除「${n}」？它的令牌会立即失效。`, reconnecting: '连接中断，正在重连…', wentOffline: (n) => `「${n}」已离线，恢复后可再次进入`, unreachable: '无法连接到服务器，请检查网络',
    iosInstall: '在 Safari 中点“分享”，再选“添加到主屏幕”即可安装', retry: '重试',
  },
  en: {
    login: 'Sign in', password: 'Access password', wrongPassword: 'Incorrect password', rateLimited: 'Too many attempts, try again later', logout: 'Sign out',
    pick: 'Choose a backend', pickHint: (o, t) => `${o} online of ${t}`, add: 'Connect backend', remove: 'Remove', install: 'Install app',
    sessions: (n) => `${n} sessions`, running: (n) => `${n} running`, lastSeen: (s) => `Last seen ${s}`, neverSeen: 'Never connected', offlineNow: 'Offline',
    emptyTitle: 'No backend connected yet', emptyBody: 'Create a token with "Connect backend" and add it to that DSH; it dials in by itself.',
    name: 'Name', create: 'Create token', tokenOnce: 'This token is shown once. Save this as $DSH_HOME/dsh-hub-agent.json on that DSH; it connects within seconds:', done: 'Done', cancel: 'Cancel',
    removeConfirm: (n) => `Remove "${n}"? Its token stops working immediately.`, reconnecting: 'Connection lost, reconnecting…', wentOffline: (n) => `"${n}" is offline; open it again once it returns`, unreachable: 'Cannot reach the server; check your network',
    iosInstall: 'In Safari, tap Share, then Add to Home Screen', retry: 'Retry',
  },
};
const lang = String(navigator.language ?? 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en';
document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
export const t = (key, ...args) => { const value = STRINGS[lang][key]; return typeof value === 'function' ? value(...args) : value; };

const relative = new Intl.RelativeTimeFormat(lang, { numeric: 'auto', style: 'narrow' });
export function ago(time) {
  if (!time) return '—';
  const seconds = Math.round((time - Date.now()) / 1000);
  if (Math.abs(seconds) < 60) return relative.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour');
  return relative.format(Math.round(hours / 24), 'day');
}
