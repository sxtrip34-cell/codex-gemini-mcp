// Gemini · Codex panel webview. The user picks the provider, the model and the power; the extension
// decides whether a message is chat, image, video, music or 3D and reports what it understood.
(() => {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const PROVIDERS = ['gemini', 'codex'];
  const NAME = { gemini: 'Gemini', codex: 'Codex' };
  const state = {
    provider: saved.provider === 'codex' ? 'codex' : 'gemini',
    threads: saved.threads || { gemini: saved.messages || [], codex: [] },
    model: { gemini: saved.model?.gemini || (typeof saved.model === 'string' ? saved.model : 'neon'), codex: saved.model?.codex || '' },
    power: { gemini: saved.power?.gemini ?? '', codex: saved.power?.codex ?? '' },
    config: { gemini: { models: [] }, codex: { models: [], defaultModel: '', defaultPower: '' } },
    status: { gemini: { state: 'checking', text: 'Connecting…' }, codex: { state: 'checking', text: 'Connecting…' } },
    files: [],
    busy: null, // provider that is working
    activity: '',
    output: window.PANEL_OUTPUT || '',
  };
  if (state.model.gemini === 'agy') state.model.gemini = 'flash';
  const save = () => vscode.setState({
    provider: state.provider,
    threads: { gemini: state.threads.gemini.slice(-150), codex: state.threads.codex.slice(-150) },
    model: state.model, power: state.power,
  });

  // ---------------------------------------------------------------- icons

  const GLYPH = {
    gemini: (cls = 'glyph') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="gg" x1="3" y1="21" x2="21" y2="3" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#4F8DF7"/><stop offset=".55" stop-color="#8B7CF6"/><stop offset="1" stop-color="#C98BEA"/></linearGradient></defs><path fill="url(#gg)" d="M12 2c.5 4.9 3.2 8.4 8.7 10-5.5 1.6-8.2 5.1-8.7 10-.5-4.9-3.2-8.4-8.7-10C8.8 10.4 11.5 6.9 12 2z"/></svg>`,
    codex: (cls = 'glyph') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="cg" x1="4" y1="20" x2="20" y2="4" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#36C9A0"/><stop offset="1" stop-color="#5DB8F0"/></linearGradient></defs><path fill="url(#cg)" fill-rule="evenodd" d="M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm0 5.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6z"/></svg>`,
  };
  const ICON = {
    clip: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.2 7.6 8.1 12.7a3.3 3.3 0 0 1-4.7-4.7l5.4-5.4a2.2 2.2 0 0 1 3.1 3.1L6.6 11a1.1 1.1 0 0 1-1.6-1.6l4.8-4.8"/></svg>',
    send: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12.5v-9M4 7.5 8 3.5l4 4"/></svg>',
    stop: '<svg width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" rx="2.5" fill="currentColor"/></svg>',
    bolt: '<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M9.3 1.2 3.4 8.8a.5.5 0 0 0 .4.8h3.3l-.6 4.9c-.1.5.6.8.9.4l5.9-7.6a.5.5 0 0 0-.4-.8H9.6l.6-4.9c.1-.5-.6-.8-.9-.4z"/></svg>',
    chev: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 4 5 6.5 7.5 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    check: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    plus: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    cube: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" opacity=".9" d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7z" /><path fill="var(--bg)" opacity=".35" d="M12 12 3.5 7 12 2.5 20.5 7zM12 12v9.5L20.5 17V7z"/></svg>',
  };
  const TOOL_LABEL = { image: 'Image', video: 'Video', music: 'Music', '3d': '3D model' };
  const IDEAS = {
    gemini: [
      'Explain how this project is structured',
      'Minimal product shot of a ceramic mug on linen, soft window light',
      'Make a vertical video: slow drone shot over misty mountains at sunrise',
      'Make a 30-second calm lo-fi track with soft piano',
    ],
    codex: [
      'Find the bugs in the open project and fix them',
      'Make a low-poly 3D model of a vintage camera as GLB',
      'Transparent PNG icon of a paper plane, soft gradient',
      'Make a 6-second hero loop: slow push-in on a misty forest',
    ],
  };
  const SUBTITLE = {
    gemini: 'Your Google account: chat, Nano Banana images, Veo video, music.',
    codex: 'Codex on this workspace: code, images, videos, 3D models.',
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cap = (s) => (s === 'xhigh' ? 'XHigh' : s ? s[0].toUpperCase() + s.slice(1) : s);

  function md(src) {
    return String(src || '').split('```').map((part, i) => {
      if (i % 2) {
        const nl = part.indexOf('\n');
        const code = nl > -1 ? part.slice(nl + 1) : part;
        return `<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`;
      }
      let h = esc(part)
        .replace(/^#{1,6} (.+)$/gm, '<strong class="h">$1</strong>')
        .replace(/^\s*(?:[-*•]|\d+\.) (.+)$/gm, '<span class="li">$1</span>')
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
        .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, '$1<em>$2</em>')
        .replace(/\[([^\]\n]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="#" data-url="$2">$1</a>')
        .replace(/\[([^\]\n]+)\]\(((?:[A-Za-z]:|\/)[^)\n]+)\)/g, '<a href="#" data-path="$2" data-act="open">$1</a>');
      h = h.replace(/(<\/span>)\n{2,}(?=<span class="li">)/g, '$1\n');
      return h.split(/\n{2,}/).filter((p) => p.trim()).map((p) => `<p>${p
        .replace(/\n/g, '<br>')
        .replace(/<br>(?=<span class="li">|<strong class="h">)/g, '')
        .replace(/(<span class="li">.*?<\/span>|<strong class="h">.*?<\/strong>)<br>/g, '$1')}</p>`).join('');
    }).join('');
  }

  // ---------------------------------------------------------------- layout

  const app = document.getElementById('app');
  app.innerHTML = `
    <header class="top">
      <div class="switch" id="switch" role="tablist">
        <span class="thumb" aria-hidden="true"></span>
        ${PROVIDERS.map((p) => `<button role="tab" data-provider="${p}">${GLYPH[p]()}<span>${NAME[p]}</span></button>`).join('')}
      </div>
      <span class="spacer"></span>
      <button class="status" id="status" data-state="checking"><i></i><span>Connecting…</span></button>
      <button class="ghost" id="new" title="New chat">${ICON.plus}</button>
    </header>
    <main class="log" id="log" aria-live="polite"></main>
    <section class="composer" id="composer">
      <div class="chips" id="chips"></div>
      <textarea id="input" rows="1" spellcheck="false"></textarea>
      <div class="row">
        <button class="ghost" id="attach" title="Attach files">${ICON.clip}</button>
        <button class="pick" id="model" title="Model"></button>
        <button class="pick" id="power" title="Power"></button>
        <span class="spacer"></span>
        <button class="send" id="send" title="Send (Enter)">${ICON.send}</button>
      </div>
    </section>`;

  const $ = (id) => document.getElementById(id);
  const log = $('log'), input = $('input'), sendBtn = $('send'), statusBtn = $('status');
  const modelBtn = $('model'), powerBtn = $('power');
  let busyEl = null, lastUserNode = null, menu = null;

  // ---------------------------------------------------------------- model and power

  function models(p = state.provider) {
    return state.config[p].models || [];
  }
  function currentModel(p = state.provider) {
    const list = models(p);
    const id = state.model[p] || (p === 'codex' ? state.config.codex.defaultModel : '');
    return list.find((m) => m.id === id) || list[0] || null;
  }
  function powerLevels(p = state.provider) {
    return currentModel(p)?.power || [];
  }
  function powerItems(p = state.provider) {
    const def = p === 'codex' && state.config.codex.defaultPower ? ` · ${state.config.codex.defaultPower}` : '';
    return [{ id: '', label: 'Default', desc: p === 'codex' ? `Codex setting${def}` : 'Account setting' },
      ...powerLevels(p).map((l) => ({ id: l, label: cap(l), desc: { low: 'Fastest', medium: 'Balanced', high: 'Thorough', xhigh: 'Very thorough', max: 'Deepest', ultra: 'Longest thinking' }[l] || '' }))];
  }

  function syncControls() {
    const p = state.provider;
    app.dataset.provider = p;
    document.querySelectorAll('#switch button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.provider === p)));
    input.placeholder = p === 'codex' ? 'Ask Codex, or describe an image, video or 3D model…' : 'Ask Gemini, or describe an image, video or track…';
    const m = currentModel();
    modelBtn.innerHTML = `<span>${esc(m ? m.label : '…')}</span>${ICON.chev}`;
    if (state.power[p] && !powerLevels().includes(state.power[p])) state.power[p] = '';
    powerBtn.hidden = !powerLevels().length;
    powerBtn.classList.toggle('set', !!state.power[p]);
    powerBtn.title = `Power: ${state.power[p] ? cap(state.power[p]) : 'Default'}`;
    powerBtn.innerHTML = `${ICON.bolt}<span>${esc(state.power[p] ? cap(state.power[p]) : 'Default')}</span>${ICON.chev}`;
    const st = state.status[p];
    statusBtn.dataset.state = st.state;
    statusBtn.title = st.text;
    statusBtn.querySelector('span').textContent = st.state === 'signin' ? (statusBtn.dataset.asked ? 'Signed in? Check again' : 'Sign in') : st.state === 'ok' ? st.text : st.state === 'error' ? 'Retry' : st.text;
    updateSend();
    save();
  }

  function openMenu(anchor, title, items, value, onPick) {
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'listbox');
    menu.innerHTML = `<div class="menu-title">${esc(title)}</div>` + items.map((it, i) =>
      `<button role="option" data-i="${i}" aria-selected="${it.id === value}"><span class="mi-text"><span>${esc(it.label)}</span>${it.desc ? `<small>${esc(it.desc)}</small>` : ''}</span>${it.id === value ? ICON.check : ''}</button>`).join('');
    app.appendChild(menu); // inside #app so it takes the provider's colours
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
    menu.style.bottom = (innerHeight - r.top + 8) + 'px';
    requestAnimationFrame(() => menu?.classList.add('open'));
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]');
      if (!b) return;
      onPick(items[+b.dataset.i].id);
      closeMenu();
      input.focus();
    });
    (menu.querySelector('[aria-selected="true"]') || menu.querySelector('button'))?.focus();
  }
  function closeMenu() { menu?.remove(); menu = null; }
  document.addEventListener('mousedown', (e) => { if (menu && !menu.contains(e.target) && !e.target.closest('.pick')) closeMenu(); });
  document.addEventListener('keydown', (e) => {
    if (!menu) return;
    const opts = [...menu.querySelectorAll('button[data-i]')];
    const i = opts.indexOf(document.activeElement);
    if (e.key === 'Escape') { closeMenu(); input.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); opts[(i + 1) % opts.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); opts[(i - 1 + opts.length) % opts.length].focus(); }
  });

  modelBtn.addEventListener('click', () => {
    if (menu) return closeMenu();
    const p = state.provider;
    const items = models(p).map((m) => ({ id: m.id, label: m.label, desc: m.desc }));
    if (!items.length) return;
    openMenu(modelBtn, `${NAME[p]} model`, items, currentModel()?.id, (id) => { state.model[p] = id; syncControls(); });
  });
  powerBtn.addEventListener('click', () => {
    if (menu) return closeMenu();
    const p = state.provider;
    openMenu(powerBtn, 'Power', powerItems(p), state.power[p], (id) => { state.power[p] = id; syncControls(); });
  });

  // ---------------------------------------------------------------- composer

  function updateSend() {
    const busyHere = state.busy !== null;
    sendBtn.classList.toggle('stop', busyHere);
    sendBtn.innerHTML = busyHere ? ICON.stop : ICON.send;
    sendBtn.title = busyHere ? 'Stop' : 'Send (Enter)';
    sendBtn.disabled = !busyHere && !input.value.trim();
  }
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }
  const baseName = (f) => f.split(/[\\/]/).pop();
  function renderChips() {
    $('chips').innerHTML = state.files.map((f, i) => `<span class="chip" title="${esc(f)}"><span>${esc(baseName(f))}</span><button data-rm="${i}" title="Remove">×</button></span>`).join('');
  }

  // ---------------------------------------------------------------- messages

  function mediaHtml(f) {
    const actions = `<span class="acts"><button data-act="open" data-path="${esc(f.path)}">Open</button><button data-act="reveal" data-path="${esc(f.path)}">Show</button><button data-act="copy" data-path="${esc(f.path)}">Copy path</button></span>`;
    if (f.kind === 'model') return `<div class="media file-only"><span class="cube">${ICON.cube}</span><span class="name" title="${esc(f.path)}">${esc(f.name)}</span>${actions}</div>`;
    const el = f.kind === 'video' ? `<video src="${esc(f.uri)}" controls preload="metadata" playsinline loop></video>`
      : f.kind === 'audio' ? `<audio src="${esc(f.uri)}" controls preload="metadata"></audio>`
        : `<img src="${esc(f.uri)}" alt="${esc(f.name)}" data-open="${esc(f.path)}">`;
    return `<div class="media">${el}<div class="file"><span class="name" title="${esc(f.path)}">${esc(f.name)}</span>${actions}</div></div>`;
  }

  const tagHtml = (m) => (TOOL_LABEL[m.tool] || m.via
    ? `<span class="tag">${[TOOL_LABEL[m.tool], m.aspect, m.via ? `via ${NAME[m.via]}` : ''].filter(Boolean).map(esc).join(' · ')}</span>` : '');

  function messageNode(m, provider) {
    const div = document.createElement('div');
    if (m.role === 'user') {
      div.className = 'msg user';
      const files = (m.files || []).length ? `<div class="chips">${m.files.map((f) => `<span class="chip" title="${esc(f)}"><span>${esc(baseName(f))}</span></span>`).join('')}</div>` : '';
      div.innerHTML = `${tagHtml(m)}${files}<div class="bubble">${esc(m.text)}</div>`;
    } else {
      div.className = 'msg bot' + (m.error ? ' error' : '');
      const by = m.by || provider;
      div.innerHTML = `<div class="avatar">${GLYPH[by]()}</div><div class="body">${m.text ? `<div class="md">${md(m.text)}</div>` : ''}${(m.files || []).map(mediaHtml).join('')}</div>`;
    }
    return div;
  }

  function emptyNode() {
    const p = state.provider;
    const div = document.createElement('div');
    div.className = 'empty';
    const out = state.output.split(/[\\/]/).slice(-2).join('/');
    div.innerHTML = `${GLYPH[p]('glyph big')}<h2>${NAME[p]}</h2><p>${esc(SUBTITLE[p])}<br>Just write; it works out what to make. Files go to <code>${esc(out)}</code>.</p>
      <div class="ideas">${IDEAS[p].map((text, i) => `<button class="idea" data-idea="${i}">${esc(text)}</button>`).join('')}</div>`;
    return div;
  }

  function renderAll() {
    const p = state.provider;
    log.innerHTML = '';
    lastUserNode = null;
    const thread = state.threads[p];
    if (!thread.length) log.appendChild(emptyNode());
    for (const m of thread) {
      const node = messageNode(m, p);
      if (m.role === 'user') lastUserNode = node;
      log.appendChild(node);
    }
    if (state.busy === p) showBusy(state.activity);
    scrollDown(false);
  }

  function push(provider, m) {
    const thread = state.threads[provider];
    const wasEmpty = !thread.length;
    thread.push(m);
    save();
    if (provider !== state.provider) return;
    if (wasEmpty) log.innerHTML = '';
    const node = messageNode(m, provider);
    if (m.role === 'user') lastUserNode = node;
    if (busyEl && busyEl.parentNode) log.insertBefore(node, busyEl); else log.appendChild(node);
    scrollDown();
  }

  function showBusy(text) {
    if (!busyEl) {
      busyEl = document.createElement('div');
      busyEl.className = 'busy';
      busyEl.innerHTML = '<span class="avatar"></span><span class="activity"></span>';
    }
    busyEl.querySelector('.avatar').innerHTML = GLYPH[state.busy || state.provider]();
    busyEl.querySelector('.activity').textContent = text || 'Working…';
    if (!busyEl.parentNode) log.appendChild(busyEl);
    scrollDown();
  }
  const hideBusy = () => busyEl?.remove();
  const scrollDown = (smooth = true) => requestAnimationFrame(() => log.scrollTo({ top: log.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }));

  // ---------------------------------------------------------------- actions

  function send() {
    if (state.busy !== null) { vscode.postMessage({ type: 'stop' }); return; }
    const text = input.value.trim();
    if (!text) return;
    const p = state.provider;
    push(p, { role: 'user', text, files: state.files.slice() });
    vscode.postMessage({
      type: 'send', provider: p, text, files: state.files,
      model: p === 'codex' ? (state.model.codex || undefined) : state.model.gemini,
      power: powerLevels(p).length ? state.power[p] : '',
    });
    input.value = '';
    state.files = [];
    renderChips();
    autosize();
    updateSend();
  }

  function setProvider(p) {
    if (p === state.provider) return;
    closeMenu();
    state.provider = p;
    syncControls();
    renderAll();
    input.focus();
  }

  $('switch').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-provider]');
    if (b) setProvider(b.dataset.provider);
  });
  $('new').addEventListener('click', () => vscode.postMessage({ type: 'newChat', provider: state.provider }));
  $('attach').addEventListener('click', () => vscode.postMessage({ type: 'attach' }));
  $('chips').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-rm]');
    if (b) { state.files.splice(+b.dataset.rm, 1); renderChips(); }
  });
  sendBtn.addEventListener('click', send);
  input.addEventListener('input', () => { autosize(); updateSend(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  statusBtn.addEventListener('click', () => {
    const s = state.status[state.provider].state;
    if (state.provider === 'gemini' && s === 'signin') vscode.postMessage({ type: statusBtn.dataset.asked ? 'ready' : 'signIn' });
    else if (s === 'error') vscode.postMessage({ type: 'ready' });
  });
  log.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) { e.preventDefault(); vscode.postMessage({ type: act.dataset.act, path: act.dataset.path }); return; }
    const img = e.target.closest('img[data-open]');
    if (img) { vscode.postMessage({ type: 'open', path: img.dataset.open }); return; }
    const a = e.target.closest('a[data-url]');
    if (a) { e.preventDefault(); vscode.postMessage({ type: 'openUrl', url: a.dataset.url }); return; }
    const idea = e.target.closest('[data-idea]');
    if (idea) {
      input.value = IDEAS[state.provider][+idea.dataset.idea];
      autosize();
      updateSend();
      input.focus();
    }
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    const p = m.provider;
    switch (m.type) {
      case 'config':
        state.config[p] = { ...state.config[p], ...m };
        if (m.output) state.output = m.output;
        syncControls();
        if (!state.threads[state.provider].length) renderAll();
        break;
      case 'status':
        state.status[p] = { state: m.state, text: m.text };
        if (p === 'gemini' && m.state === 'signin' && /check again/i.test(m.text)) statusBtn.dataset.asked = '1';
        if (m.state === 'ok') delete statusBtn.dataset.asked;
        syncControls();
        break;
      case 'routed': {
        const last = [...state.threads[p]].reverse().find((x) => x.role === 'user');
        if (!last) break;
        Object.assign(last, { tool: m.tool, aspect: m.aspect, via: m.via });
        save();
        if (p === state.provider && lastUserNode) {
          lastUserNode.querySelector('.tag')?.remove();
          lastUserNode.insertAdjacentHTML('afterbegin', tagHtml(last));
        }
        break;
      }
      case 'busy':
        state.busy = m.busy ? p : null;
        state.activity = m.busy ? m.activity : '';
        if (m.busy && p === state.provider) showBusy(m.activity); else if (!m.busy) hideBusy();
        updateSend();
        break;
      case 'reply': push(p, { role: 'bot', by: m.by, text: m.text, files: m.files || [] }); break;
      case 'error': push(p || state.provider, { role: 'bot', text: m.text, error: true }); break;
      case 'attached':
        state.files.push(...m.files.filter((f) => !state.files.includes(f)));
        renderChips();
        break;
      case 'requestNewChat':
        vscode.postMessage({ type: 'newChat', provider: state.provider });
        break;
      case 'cleared':
        for (const k of p ? [p] : PROVIDERS) state.threads[k] = [];
        save();
        renderAll();
        break;
    }
  });

  syncControls();
  renderAll();
  autosize();
  vscode.postMessage({ type: 'ready' });
})();
