// Runs before the DSH client on every harness page. DSH stays unmodified: this only
// separates per-backend storage and adds phone behaviour around its stable layout hooks.
(() => {
  const hub = window.__DSH_HUB__;
  if (!hub) return;
  const root = document.documentElement;
  // Keep in step with mobile.css. Screen height, not window height: the keyboard shrinks the latter.
  const COMPACT = '(max-width: 767px), (max-device-height: 500px) and (pointer: coarse)';
  const compact = matchMedia(COMPACT);
  const zh = String(navigator.language).toLowerCase().startsWith('zh');
  const text = { switch: zh ? '切换后端' : 'Switch backend', menu: zh ? '打开侧栏' : 'Open sidebar', close: zh ? '关闭' : 'Close' };

  localStorage.setItem('dsh-hub-last', hub.id); // Read by the picker to resume this backend.
  isolateStorage(`hub:${hub.id}:`);
  if ('serviceWorker' in navigator) addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined));

  /** All backends share this origin; without a prefix one backend's session ids reach another. */
  function isolateStorage(prefix) {
    const store = window.localStorage;
    const proto = Storage.prototype;
    const raw = { getItem: proto.getItem, setItem: proto.setItem, removeItem: proto.removeItem, key: proto.key, clear: proto.clear };
    const lengthOf = Object.getOwnPropertyDescriptor(proto, 'length').get;
    const own = () => {
      const keys = [];
      for (let at = 0; at < lengthOf.call(store); at += 1) {
        const key = raw.key.call(store, at);
        if (key.startsWith(prefix)) keys.push(key.slice(prefix.length));
      }
      return keys;
    };
    proto.getItem = function getItem(key) { return raw.getItem.call(this, this === store ? prefix + key : key); };
    proto.setItem = function setItem(key, value) {
      raw.setItem.call(this, this === store ? prefix + key : key, value);
      if (this === store && key === 'dsh.sessions.current') queueMicrotask(closeDrawer);
    };
    proto.removeItem = function removeItem(key) { raw.removeItem.call(this, this === store ? prefix + key : key); };
    proto.key = function key(index) { return this === store ? own()[index] ?? null : raw.key.call(this, index); };
    proto.clear = function clear() {
      if (this !== store) { raw.clear.call(this); return; }
      for (const key of own()) raw.removeItem.call(store, prefix + key);
    };
    Object.defineProperty(proto, 'length', { configurable: true, get() { return this === store ? own().length : lengthOf.call(this); } });
  }

  /** Soft keyboards shrink only the visual viewport on iOS; the page must follow it. */
  const HOME_BAR_CLEARANCE = 6;
  function trackViewport() {
    const view = window.visualViewport;
    if (!view) return;
    let full = 0;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom)';
    document.body.append(probe);
    const portrait = matchMedia('(orientation: portrait)');
    /*
     * An iOS home-screen app can report a window shorter than the screen by the status-bar height.
     * That bottom strip cannot be drawn on: content placed there is covered by the system with a
     * white bar, so the layout must not extend into it. The strip already clears the home
     * indicator, so only the part of the inset it does not cover is padded.
     */
    const bottomPad = () => {
      const inset = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
      if (!inset) return 0;
      const long = Math.max(screen.width, screen.height);
      const short = Math.min(screen.width, screen.height);
      const reserved = Math.max(0, (portrait.matches ? long : short) - window.innerHeight);
      // The home indicator is a thin bar ~8px above the edge; the composer's own padding already
      // clears it, so the full inset (34px) would only add dead space. Keep just a small margin.
      return Math.min(HOME_BAR_CLEARANCE, Math.max(0, Math.round(inset - reserved)));
    };
    const apply = () => {
      full = Math.max(full, view.height);
      root.style.setProperty('--hub-vh', `${Math.round(view.height)}px`);
      root.style.setProperty('--hub-pad-bottom', `${bottomPad()}px`);
      root.toggleAttribute('data-hub-keyboard', view.height < full * 0.78);
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };
    view.addEventListener('resize', apply);
    view.addEventListener('scroll', apply);
    addEventListener('resize', apply);
    addEventListener('orientationchange', () => { full = 0; setTimeout(apply, 300); });
    // A home-screen app settles its window size a moment after the first paint.
    for (const delay of [400, 1500]) setTimeout(apply, delay);
    apply();
  }

  const frame = () => document.querySelector('div:has(> [class*="_sidebarCol"])');
  const drawerOpen = () => { const node = frame(); return Boolean(node) && !node.hasAttribute('data-sidebar-collapsed'); };
  const toggleDrawer = () => document.querySelector('[class*="_sidebarCol"] [class*="_toggle"]')?.click();
  function closeDrawer() { if (compact.matches && drawerOpen()) toggleDrawer(); }
  function openDrawer() { if (compact.matches && !drawerOpen()) toggleDrawer(); }

  const icon = (body) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

  function element(tag, id, html, label) {
    const node = document.createElement(tag);
    node.id = id;
    node.innerHTML = html;
    if (tag === 'button') node.type = 'button';
    if (label) { node.setAttribute('aria-label', label); node.title = label; }
    return node;
  }

  const menu = element('button', 'hub-menu', icon('<path d="M4 7h16M4 12h16M4 17h10"/>'), text.menu);
  const scrim = element('div', 'hub-scrim', '');
  const switcher = element('button', 'hub-switch', `${icon('<path d="M4 8h13l-3-3M20 16H7l3 3"/>')}<span></span>`, text.switch);
  switcher.lastElementChild.textContent = text.switch;
  menu.addEventListener('click', openDrawer);
  scrim.addEventListener('click', closeDrawer);
  switcher.addEventListener('click', () => { location.href = '/?pick=1'; });

  function installGestures() {
    let start;
    addEventListener('touchstart', (event) => {
      if (!compact.matches || event.touches.length !== 1) { start = undefined; return; }
      const touch = event.touches[0];
      const open = drawerOpen();
      const inDrawer = open && Boolean(event.target.closest?.('[class*="_sidebarCol"]'));
      start = touch.clientX < 28 && !open ? { x: touch.clientX, y: touch.clientY, kind: 'open' } : inDrawer ? { x: touch.clientX, y: touch.clientY, kind: 'close' } : undefined;
    }, { passive: true });
    addEventListener('touchend', (event) => {
      if (!start) return;
      const touch = event.changedTouches[0];
      const dx = touch.clientX - start.x;
      const dy = Math.abs(touch.clientY - start.y);
      if (dy < 60 && start.kind === 'open' && dx > 56) openDrawer();
      if (dy < 60 && start.kind === 'close' && dx < -56) closeDrawer();
      start = undefined;
    }, { passive: true });
  }

  /**
   * Plugins hide row actions behind `:hover` too, and no list of class names can cover
   * them. Rules that only reveal something are repeated without the hover for touch.
   */
  function installTouchReveals() {
    if (!matchMedia('(hover: none)').matches) return;
    const sheet = document.createElement('style');
    document.head.append(sheet);
    const SKIP = /chevron|glyph|icon|disclosure|tip/i;
    const copy = (rule, out) => {
      if (rule.cssRules && !rule.selectorText) { for (const child of rule.cssRules) copy(child, out); return; }
      if (!rule.selectorText?.includes(':hover')) return;
      const body = rule.style;
      if (body.opacity !== '1' && body.visibility !== 'visible') return;
      for (const part of rule.selectorText.split(/,(?![^(]*\))/)) {
        if (!/:hover[^\s]*\s+\S/.test(part) || part.includes(':has(') || SKIP.test(part)) continue;
        out.push(`${part.replaceAll(':hover', '')}{${body.opacity === '1' ? 'opacity:1!important;' : ''}${body.visibility === 'visible' ? 'visibility:visible!important;' : ''}}`);
      }
    };
    const rebuild = () => {
      const out = [];
      for (const source of document.styleSheets) {
        if (source.ownerNode === sheet) continue;
        try { for (const rule of source.cssRules) copy(rule, out); } catch { /* Cross-origin sheets cannot be read. */ }
      }
      sheet.textContent = [...new Set(out)].join('\n');
    };
    let timer;
    new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(rebuild, 400); }).observe(document.head, { childList: true, subtree: true });
    rebuild();
  }

  /** Phone keyboards lack the keys a shell needs; these feed xterm's own key handling. */
  function installTerminalKeys() {
    const KEYS = [['Esc', 'Escape', 27], ['Tab', 'Tab', 9], ['←', 'ArrowLeft', 37], ['↓', 'ArrowDown', 40], ['↑', 'ArrowUp', 38], ['→', 'ArrowRight', 39], ['^C', 'c', 67, true], ['^D', 'd', 68, true], ['^L', 'l', 76, true]];
    const bar = element('div', 'hub-keys', '');
    let target;
    for (const [label, key, keyCode, ctrlKey] of KEYS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      // Keeping focus in the terminal keeps the keyboard open between presses.
      button.addEventListener('pointerdown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        target?.focus();
        target?.dispatchEvent(new KeyboardEvent('keydown', { key, keyCode, which: keyCode, ctrlKey: Boolean(ctrlKey), bubbles: true, cancelable: true }));
      });
      bar.append(button);
    }
    document.body.append(bar);
    const show = (node) => { target = node; root.toggleAttribute('data-hub-terminal', Boolean(node)); };
    document.addEventListener('focusin', (event) => { if (event.target.classList?.contains('xterm-helper-textarea')) show(event.target); });
    document.addEventListener('focusout', (event) => {
      if (event.target !== target) return;
      setTimeout(() => { if (document.activeElement !== target) show(undefined); }, 200);
    });
  }

  /**
   * DSH keeps the draft focused when a composer button is pressed, which on a desktop is
   * right and on a touch screen raises the keyboard for buttons that need none. No event is
   * stopped here, because DSH's menus choose on mousedown and a file dialog must open from
   * inside the same gesture. Instead the editor is told not to bring up a keyboard before
   * DSH focuses it, and gets that back when the user taps it.
   */
  function installComposerFocus() {
    const CONTROL = 'button, a, select, [role="button"], [role="switch"], [role="checkbox"]';
    // Menus choose things; what they choose may need typing, so they are left alone.
    const MENU = '[role="listbox"], [role="option"], [role="menu"], [role="menuitem"], [data-trigger-menu], [data-composer-overlay]';
    const EDITOR = '[contenteditable="true"]';
    const editorOf = (node) => node.closest('[data-composer-card]')?.querySelector(EDITOR) ?? null;
    let kick = null; // An editor that was quiet and is being tapped: it needs a fresh focus to show a keyboard.
    document.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'touch' || !(event.target instanceof Element)) return;
      const target = event.target;
      const typing = target.closest(EDITOR);
      if (typing) {
        if (typing.inputMode === 'none') { typing.inputMode = ''; kick = document.activeElement === typing ? typing : null; }
        return;
      }
      if (!target.closest(CONTROL) || target.closest(MENU)) return;
      const editor = editorOf(target);
      // With the editor already focused the keyboard is the user's; touching its mode would hide it.
      if (editor && document.activeElement !== editor) editor.inputMode = 'none';
    }, true);
    document.addEventListener('pointerup', (event) => {
      const editor = kick;
      kick = null;
      if (!editor || event.pointerType !== 'touch' || !editor.isConnected) return;
      // Tapping a field that is already focused does not raise a keyboard on every phone.
      if (document.activeElement === editor) { editor.blur(); editor.focus({ preventScroll: true }); }
    }, true);
    document.addEventListener('focusout', (event) => {
      if (event.target instanceof Element && event.target.matches(EDITOR) && event.target.inputMode === 'none') event.target.inputMode = '';
    }, true);
  }

  /**
   * Keeps the last editor events for the diagnostics panel, and backs up Backspace on touch
   * screens: the editor deletes through `beforeinput`, so a key press that produced none (some
   * mobile keyboards next to a non-editable chip) is replayed as the deletion it stands for.
   */
  const editorLog = [];
  function installEditorEvents() {
    const EDITOR = '[contenteditable="true"]';
    const coarse = matchMedia('(pointer: coarse)');
    let inputs = 0;
    const note = (event, extra = '') => {
      editorLog.push({ event, extra, at: Date.now() });
      if (editorLog.length > 14) editorLog.shift();
    };
    for (const type of ['keydown', 'beforeinput', 'input', 'compositionstart', 'compositionend']) {
      document.addEventListener(type, (event) => {
        const editor = event.target instanceof Element ? event.target.closest(EDITOR) : null;
        if (!editor) return;
        if (type === 'beforeinput') inputs += 1;
        note(event);
        /*
         * DSH deletes a command chip in two steps: the first Backspace selects it, the second removes
         * it. The editor drops the selection on the next keydown unless that same keydown also
         * performed the deletion. A soft keyboard deletes through `beforeinput` only, so the
         * keydown always wins first and the second press just selects the chip again. Hiding
         * that keydown leaves the deletion to `beforeinput`, which knows about the selection.
         */
        if (type === 'keydown' && (event.key === 'Backspace' || event.key === 'Delete') && editor.hasAttribute('data-composer-chip-selected') && coarse.matches) {
          event.stopImmediatePropagation();
        }
        if (type !== 'keydown' || event.key !== 'Backspace' || event.isComposing || !coarse.matches) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const seen = inputs;
        setTimeout(() => {
          if (seen !== inputs || !editor.isConnected || document.activeElement !== editor) return;
          note({ type: 'replayed Backspace', defaultPrevented: false });
          editor.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true, composed: true }));
        }, 120);
      }, true);
    }
  }

  /**
   * Layout diagnostics for devices that cannot be inspected: long-press the menu button for a
   * panel of viewport, safe-area and bottom-gap measurements, with two marker strips showing
   * where the layout viewport and the shell's own height end.
   */
  function installDebug() {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.append(probe);
    const px = (value) => String(Math.round(value * 10) / 10);
    const box = (node) => { if (!node) return '-'; const r = node.getBoundingClientRect(); return `y ${px(r.top)}..${px(r.bottom)} (h ${px(r.height)})`; };
    let panel; let strips; let timer;
    function lowest() {
      let best = { bottom: 0, label: '-' };
      for (const node of document.querySelectorAll('#root *')) {
        if (node.closest('[class*="_sidebarCol"]')) continue;
        const r = node.getBoundingClientRect();
        if (r.width < 4 || r.height < 4 || r.bottom > innerHeight + 1 || r.bottom <= best.bottom) continue;
        if (getComputedStyle(node).visibility === 'hidden') continue;
        best = { bottom: r.bottom, label: `${node.tagName.toLowerCase()}.${String(node.className).split(' ')[0]}` };
      }
      return best;
    }
    /** What paints in the status-bar band at the top, which no layout of ours should use. */
    function topReport() {
      const name = (node) => `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}.${String(node.getAttribute('class') ?? '').split(' ')[0]}`;
      const found = [];
      for (const node of document.querySelectorAll('body *')) {
        if (node.closest('#hub-debug')) continue;
        const r = node.getBoundingClientRect();
        if (r.width < 6 || r.height < 6 || r.top > 46 || r.bottom < 0 || r.right < 0 || r.left > innerWidth) continue;
        const style = getComputedStyle(node);
        if (style.visibility === 'hidden' || style.display === 'none' || style.position === 'static') continue;
        found.push(`  ${name(node)} ${style.position} x ${px(r.left)}..${px(r.right)} y ${px(r.top)}..${px(r.bottom)}`);
        if (found.length >= 6) break;
      }
      const hit = document.elementsFromPoint(30, 28).slice(0, 4).map(name).join(' < ');
      return [`top band (y<47) positioned: ${found.length || 'none'}`, ...found, `at (30,28): ${hit}`].join('\n');
    }
    function editorReport() {
      const editor = document.querySelector('[data-composer-card] [contenteditable]');
      const now = Date.now();
      const lines = editorLog.slice(-8).map(({ event, extra, at }) => {
        const detail = event.type === 'keydown' ? event.key : event.inputType ?? '';
        const blocked = event.type === 'beforeinput' ? (event.defaultPrevented ? ' prevented' : '') : '';
        return `  -${((now - at) / 1000).toFixed(1)}s ${event.type} ${detail}${blocked}${extra}`;
      });
      return [
        `editor   focused ${document.activeElement === editor}  inputMode ${editor?.inputMode || '-'}  chipSelected ${Boolean(editor?.hasAttribute('data-composer-chip-selected'))}  chips ${editor?.querySelectorAll('[data-composer-command],[data-composer-chip]').length ?? 0}`,
        ...(lines.length ? lines : ['  (no editor events yet)']),
      ].join('\n');
    }
    function report() {
      const view = window.visualViewport;
      const style = getComputedStyle(probe);
      const low = lowest();
      return [
        `window   ${innerWidth}x${innerHeight}  outer ${outerWidth}x${outerHeight}`,
        `screen   ${screen.width}x${screen.height}  avail ${screen.availWidth}x${screen.availHeight}  dpr ${devicePixelRatio}`,
        `docEl    client ${root.clientWidth}x${root.clientHeight}`,
        `visual   ${view ? `${px(view.width)}x${px(view.height)} top ${px(view.offsetTop)} scale ${px(view.scale)}` : 'n/a'}`,
        `--hub-vh ${root.style.getPropertyValue('--hub-vh') || '-'}   keyboard ${root.hasAttribute('data-hub-keyboard')}   pad ${root.style.getPropertyValue('--hub-pad-bottom') || '-'}`,
        `safe     t ${style.paddingTop}  r ${style.paddingRight}  b ${style.paddingBottom}  l ${style.paddingLeft}`,
        `mode     standalone ${navigator.standalone === true || matchMedia('(display-mode: standalone)').matches}  compact ${compact.matches}`,
        `body     ${box(document.body)}`,
        `#root    ${box(document.getElementById('root'))}`,
        `frame    ${box(frame())}`,
        `center   ${box(document.querySelector('[class*="_centerCol"]'))}`,
        `composer ${box(document.querySelector('[data-composer-card]'))}`,
        `lowest   ${px(low.bottom)}  ${low.label}`,
        `gap      lowest -> window bottom ${px(innerHeight - low.bottom)}   -> screen bottom ${px(screen.height - low.bottom)}`,
        'magenta strip = layout viewport bottom, cyan = shell height',
        topReport(),
        editorReport(),
      ].join('\n');
    }
    function close() {
      clearInterval(timer);
      panel?.remove(); strips?.remove();
      panel = undefined; strips = undefined;
    }
    function open() {
      close();
      panel = document.createElement('pre');
      panel.id = 'hub-debug';
      panel.style.cssText = 'position:fixed;z-index:2147483000;left:4px;right:4px;top:calc(env(safe-area-inset-top) + 52px);margin:0;padding:8px;border-radius:8px;background:rgb(0 0 0 / .86);color:#7CFC9A;font:10.5px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-all';
      strips = document.createElement('div');
      strips.innerHTML = '<i style="position:fixed;z-index:2147483000;left:0;right:0;bottom:0;height:5px;background:#f0f"></i><i style="position:fixed;z-index:2147483000;left:0;right:0;top:calc(var(--hub-vh, 100vh) - 5px);height:5px;background:#0ff"></i>';
      const refresh = () => { panel.textContent = `${report()}\n(tap to close)`; };
      const openedAt = Date.now();
      // The click that follows the lift of the long press must not close the panel it just opened.
      panel.addEventListener('click', () => { if (Date.now() - openedAt > 700) close(); });
      document.body.append(panel, strips);
      refresh();
      timer = setInterval(refresh, 1000);
    }
    let held; let long = false;
    // Some browsers cancel the pointer when a long press starts a context menu, so only the lift ends it.
    menu.addEventListener('pointerdown', () => { long = false; clearTimeout(held); held = setTimeout(() => { long = true; open(); }, 500); });
    menu.addEventListener('pointerup', () => clearTimeout(held));
    menu.addEventListener('contextmenu', (event) => event.preventDefault());
    menu.addEventListener('click', (event) => { if (long) { event.stopImmediatePropagation(); long = false; } }, true);
  }

  /** Navigation inside the drawer must reveal the page it selected. */
  function installDrawerNavigation() {
    document.addEventListener('click', (event) => {
      if (!compact.matches || !drawerOpen()) return;
      const target = event.target.closest?.('[class*="_panelRow"], [class*="_newSession"]');
      if (target && target.getAttribute('aria-haspopup') === null) setTimeout(closeDrawer, 0);
    });
  }

  let currentPage;
  function sync() {
    const node = frame();
    root.toggleAttribute('data-hub-drawer', compact.matches && Boolean(node) && drawerOpen());
    root.toggleAttribute('data-hub-right', Boolean(node) && !node.hasAttribute('data-rightbar-collapsed'));
    // A menu in the drawer can replace the main page without touching the session.
    const page = document.querySelector('[class*="_centerCol"] > * > *');
    if (page !== currentPage) { const changed = Boolean(currentPage); currentPage = page; if (changed) closeDrawer(); }
    const foot = document.querySelector('[class*="_sidebarCol"] [class*="_footArea"]');
    if (foot && switcher.parentElement !== foot) foot.prepend(switcher);
  }

  function mount() {
    document.body.append(menu, scrim);
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; sync(); });
    };
    new MutationObserver(schedule).observe(document.getElementById('root') ?? document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-sidebar-collapsed', 'data-rightbar-collapsed'] });
    compact.addEventListener('change', schedule);
    installGestures();
    installDrawerNavigation();
    installTouchReveals();
    installComposerFocus();
    installEditorEvents();
    installDebug();
    if (matchMedia('(pointer: coarse)').matches) installTerminalKeys();
    trackViewport();
    sync();
  }

  if (document.body) mount(); else addEventListener('DOMContentLoaded', mount, { once: true });
})();
