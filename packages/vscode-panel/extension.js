// Codex · Gemini panel: one webview in the secondary side bar with a Gemini / Codex switch.
// Each provider is a local MCP server (gemini-mcp, codex-mcp) started on demand and spoken to over stdio.
// The user picks provider, model and power; the router decides chat / image / video / music / 3D.
const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { McpClient, parseResult, kindOf } = require('./mcp-client.js');
const { route, isEdit, durationOf, formatOf, detailOf } = require('./router.js');

const VIEW_ID = 'codexGemini.chat';
const IMG = /\.(png|jpe?g|webp|gif|bmp)$/i;
const INSTALL_FILE = path.join(os.homedir(), '.codex-gemini-mcp', 'install.json');
const SERVERS = {
  gemini: { setting: 'geminiServerPath', rel: ['packages', 'gemini-mcp', 'server.mjs'], jobTool: 'gemini_job' },
  codex: { setting: 'codexServerPath', rel: ['packages', 'codex-mcp', 'server.mjs'], jobTool: 'codex_job' },
};
let extensionRoot = null; // set in activate()
const GEMINI_MODELS = [
  { id: 'neon', label: 'Neon', desc: 'Deeper analysis', power: ['low', 'medium', 'high'] },
  { id: 'hydrogen', label: 'Hydrogen', desc: 'Everyday help', power: [] },
  { id: 'auto', label: 'Auto', desc: 'Adapts to the request', power: [] },
  { id: 'flash', label: 'Flash', desc: 'Fast, reads this workspace', power: ['low', 'medium', 'high'] },
];
// Who can make what. A request the chosen provider cannot make goes to the other one.
const CAN = { gemini: new Set(['chat', 'image', 'video', 'music']), codex: new Set(['chat', 'image', 'video', '3d']) };

const cfg = () => vscode.workspace.getConfiguration('codexGemini');
const workspaceRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;

function outputDir() {
  const set = cfg().get('outputDir');
  if (set) return set;
  const root = workspaceRoot();
  return root ? path.join(root, 'ai-output') : path.join(os.homedir(), 'Pictures', 'AI');
}

// Where a server lives: the setting, the clone the installer recorded, or this repository when the
// extension runs straight from a clone.
function serverCandidates(s) {
  let installed = null;
  try { installed = JSON.parse(fs.readFileSync(INSTALL_FILE, 'utf8')).root; } catch {}
  return [
    cfg().get(s.setting),
    installed && path.join(installed, ...s.rel),
    extensionRoot && path.join(extensionRoot, '..', '..', ...s.rel),
  ].filter(Boolean);
}

function clientOptions(name, s) {
  const candidates = serverCandidates(s);
  const found = candidates.find((p) => fs.existsSync(p));
  return { name, serverPath: found || candidates[0] || s.rel.join('/'), fallbackPath: found, nodePath: cfg().get('nodePath') || undefined };
}

class PanelView {
  constructor(context, log) {
    this.context = context;
    this.log = log;
    this.view = null;
    this.busy = false;
    this.job = null;
    this.stopped = false;
    this.clients = {};
    for (const [name, s] of Object.entries(SERVERS)) {
      this.clients[name] = new McpClient({ ...clientOptions(name, s), log: (l) => log(`[${name}] ${l}`) });
    }
    const saved = context.workspaceState.get('codexGemini.sessions', {});
    this.sessions = { gemini: saved.gemini || {}, codex: saved.codex || {} };
  }

  saveSessions() { this.context.workspaceState.update('codexGemini.sessions', this.sessions); }

  reconfigure() {
    for (const [name, s] of Object.entries(SERVERS)) {
      this.clients[name].dispose();
      Object.assign(this.clients[name].opts, clientOptions(name, s));
    }
  }

  dispose() { for (const c of Object.values(this.clients)) c.dispose(); }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        vscode.Uri.file(os.homedir()),
        vscode.Uri.file(outputDir()),
        ...(vscode.workspace.workspaceFolders || []).map((f) => f.uri),
      ],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => this.post({ type: 'error', provider: m.provider, text: e.message })));
  }

  post(m) { this.view?.webview.postMessage(m); }

  async onMessage(m) {
    switch (m.type) {
      case 'ready': return this.checkStatus();
      case 'send': return this.send(m);
      case 'stop': return this.stop();
      case 'newChat': return this.newChat(m.provider);
      case 'signIn': return this.signIn();
      case 'attach': {
        const uris = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach', defaultUri: vscode.Uri.file(workspaceRoot() || os.homedir()) });
        if (uris?.length) this.post({ type: 'attached', files: uris.map((u) => u.fsPath) });
        return;
      }
      case 'open': return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(m.path));
      case 'reveal': return vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(m.path));
      case 'copy':
        await vscode.env.clipboard.writeText(m.path);
        vscode.window.setStatusBarMessage('$(check) Path copied', 2000);
        return;
      case 'openUrl':
        if (/^https:\/\//.test(m.url)) return vscode.env.openExternal(vscode.Uri.parse(m.url));
        return;
    }
  }

  // ---------------------------------------------------------------- status and models

  async checkStatus() {
    this.post({ type: 'config', provider: 'gemini', models: GEMINI_MODELS, output: outputDir() });
    this.post({ type: 'status', provider: 'gemini', state: 'checking', text: 'Connecting…' });
    this.post({ type: 'status', provider: 'codex', state: 'checking', text: 'Connecting…' });
    await Promise.all([this.geminiStatus(), this.codexStatus()]);
  }

  async geminiStatus() {
    try {
      const r = parseResult(await this.clients.gemini.callTool('gemini_status', {}));
      const line = r.text.split('\n').find((l) => l.startsWith('Gemini web:')) || r.text;
      const ok = /signed in/.test(line) && !/NOT signed in/.test(line);
      const plan = (/\((\w+) plan shown\)/.exec(line) || [])[1];
      this.post({ type: 'status', provider: 'gemini', state: ok ? 'ok' : 'signin', text: ok ? `${plan || 'Google'} · signed in` : 'Not signed in' });
    } catch (e) {
      this.log(`[gemini] status failed: ${e.message}`);
      this.post({ type: 'status', provider: 'gemini', state: 'error', text: e.message });
    }
  }

  async codexStatus() {
    try {
      const t = parseResult(await this.clients.codex.callTool('codex_status', {})).text;
      const get = (k) => (new RegExp(`^${k}: (.*)$`, 'm').exec(t) || [])[1] || '';
      let models = [];
      try { models = JSON.parse(get('models') || '[]'); } catch {}
      const defaultModel = get('default_model');
      const defaultEffort = get('default_effort');
      this.post({
        type: 'config', provider: 'codex',
        models: models.map((m) => ({ id: m.id, label: m.name, desc: m.id === defaultModel ? 'Default' : '', power: m.efforts })),
        defaultModel, defaultPower: defaultEffort,
      });
      const ok = /logged in/i.test(get('login'));
      this.post({ type: 'status', provider: 'codex', state: ok ? 'ok' : 'error', text: ok ? 'ChatGPT · signed in' : get('login') || 'Codex not signed in' });
    } catch (e) {
      this.log(`[codex] status failed: ${e.message}`);
      this.post({ type: 'status', provider: 'codex', state: 'error', text: e.message });
    }
  }

  async signIn() {
    this.post({ type: 'status', provider: 'gemini', state: 'checking', text: 'Opening sign-in window…' });
    try {
      await this.clients.gemini.callTool('gemini_status', { open_window: true });
      vscode.window.showInformationMessage('Sign in to Gemini in the Chrome window that opened, then click the status in the panel to check again.');
      this.post({ type: 'status', provider: 'gemini', state: 'signin', text: 'Sign in in the window, then check again' });
    } catch (e) {
      this.log(`[gemini] status failed: ${e.message}`);
      this.post({ type: 'status', provider: 'gemini', state: 'error', text: e.message });
    }
  }

  newChat(provider) {
    if (this.busy) return;
    const which = provider ? [provider] : Object.keys(this.sessions);
    for (const p of which) this.sessions[p] = {};
    this.saveSessions();
    this.post({ type: 'cleared', provider });
  }

  async stop() {
    this.stopped = true;
    if (this.job) await this.clients[this.job.provider].callTool(SERVERS[this.job.provider].jobTool, { job_id: this.job.id, cancel: true }).catch(() => {});
  }

  // ---------------------------------------------------------------- calls

  geminiCall({ text, tool, aspect, model, power, files }) {
    const out = outputDir();
    const s = this.sessions.gemini;
    const chat_url = s.chatUrl || undefined;
    if (tool === 'image') return ['gemini_image', { prompt: text, output_dir: out, reference_images: files, aspect: aspect || undefined, chat_url }];
    if (tool === 'video') return ['gemini_video', { prompt: text, output_dir: out, reference_images: files.filter((f) => IMG.test(f)), aspect: aspect === '9:16' ? 'portrait' : aspect === '16:9' ? 'landscape' : undefined, chat_url }];
    if (tool === 'music') return ['gemini_music', { prompt: text, output_dir: out, chat_url }];
    if (model === 'flash') {
      const prompt = files.length ? `${text}\n\nFiles: ${files.join(', ')}` : text;
      return ['gemini_ask', {
        prompt, cwd: workspaceRoot() || undefined, add_dirs: [...new Set(files.map((f) => path.dirname(f)))],
        conversation_id: s.conversationId || undefined, model: `gemini-3.8-flash-${power || 'high'}`,
      }];
    }
    return ['gemini_chat', { prompt: text, mode: model || undefined, thinking: model === 'neon' && power ? power : undefined, files, chat_url, output_dir: out }];
  }

  codexCall({ text, tool, aspect, model, power, files }) {
    const out = outputDir();
    const images = files.filter((f) => IMG.test(f));
    const others = files.filter((f) => !IMG.test(f));
    const opts = { model: model || undefined, reasoning_effort: power || undefined };
    if (tool === 'image') {
      const editing = images.length === 1 && isEdit(text);
      const ASPECT = { '16:9': 'wide', '9:16': 'tall', '1:1': 'square', '4:3': '4:3 landscape', '3:4': '3:4 portrait' };
      return ['generate_image', { prompt: text, output_dir: out, aspect: ASPECT[aspect], edit_image: editing ? images[0] : undefined, reference_images: editing ? [] : images, ...opts }];
    }
    if (tool === 'video') {
      return ['generate_video', { prompt: text, output_dir: out, aspect: aspect === '9:16' ? 'portrait' : aspect === '1:1' ? 'square' : 'landscape', duration_seconds: durationOf(text), reference_images: images, ...opts }];
    }
    if (tool === '3d') {
      return ['generate_3d', { prompt: text, output_dir: out, format: formatOf(text), detail: detailOf(text), reference_images: images, ...opts }];
    }
    const prompt = others.length ? `${text}\n\nFiles: ${others.join(', ')}` : text;
    const sid = this.sessions.codex.sessionId;
    if (sid) return ['codex_reply', { session_id: sid, prompt, images }];
    return ['codex', { prompt, cwd: workspaceRoot() || os.homedir(), sandbox: 'workspace-write', images, ...opts }];
  }

  /** Fast classifier for ambiguous messages (Gemini Flash through agy). */
  async askFlash(prompt) {
    return parseResult(await this.clients.gemini.callTool('gemini_ask', { prompt, model: 'gemini-3.8-flash-low', wait_seconds: 120 })).body;
  }

  async send(msg) {
    const provider = msg.provider === 'codex' ? 'codex' : 'gemini';
    if (this.busy || !msg.text?.trim()) return;
    this.busy = true;
    this.stopped = false;
    const busy = (activity) => this.post({ type: 'busy', provider, busy: true, activity });
    busy('Understanding the request…');
    try {
      const files = msg.files || [];
      const routed = await route(msg.text, files, (p) => this.askFlash(p));
      const executor = CAN[provider].has(routed.tool) ? provider : provider === 'gemini' ? 'codex' : 'gemini';
      this.log(`route: ${routed.tool}${routed.aspect ? ' ' + routed.aspect : ''} (${routed.via}) -> ${executor}`);
      this.post({ type: 'routed', provider, tool: routed.tool, aspect: routed.aspect || null, via: executor !== provider ? executor : null });
      if (this.stopped) return this.post({ type: 'reply', provider, text: '_Stopped._', files: [] });
      const what = { chat: 'Thinking…', image: 'Creating an image…', video: 'Creating a video…', music: 'Creating music…', '3d': 'Building a 3D model…' }[routed.tool];
      busy(executor !== provider ? `${what.replace('…', '')} with ${executor === 'codex' ? 'Codex' : 'Gemini'}…` : what);

      // The chosen model and power belong to the chosen provider; a hand-off uses the other side's defaults.
      const call = { text: msg.text, tool: routed.tool, aspect: routed.aspect, files, model: executor === provider ? msg.model : undefined, power: executor === provider ? msg.power : undefined };
      const [name, args] = executor === 'codex' ? this.codexCall(call) : this.geminiCall(call);
      if (args.output_dir) fs.mkdirSync(args.output_dir, { recursive: true });

      const client = this.clients[executor];
      const onProgress = (s) => busy(s.replace(/^[\w-]+: /, ''));
      let r = parseResult(await client.callTool(name, { ...args, wait_seconds: 0 }));
      while (r.jobId) {
        this.job = { provider: executor, id: r.jobId };
        r = parseResult(await client.callTool(SERVERS[executor].jobTool, { job_id: r.jobId, wait_seconds: 3000 }, onProgress));
      }

      const s = this.sessions[executor];
      if (r.chatUrl) s.chatUrl = r.chatUrl;
      if (r.conversationId) s.conversationId = r.conversationId;
      if (executor === 'codex' && routed.tool === 'chat' && r.sessionId) s.sessionId = r.sessionId;
      this.saveSessions();

      if (this.stopped) return this.post({ type: 'reply', provider, text: '_Stopped._', files: [] });
      if (r.isError) return this.post({ type: 'error', provider, text: r.body || r.text });
      const filesOut = r.files.filter((p) => fs.existsSync(p)).map((p) => ({
        path: p, name: path.basename(p), kind: kindOf(p),
        uri: this.view.webview.asWebviewUri(vscode.Uri.file(p)).toString(),
      }));
      this.post({ type: 'reply', provider, by: executor, text: r.body, files: filesOut });
    } catch (e) {
      this.post({ type: 'error', provider, text: e.message });
    } finally {
      this.busy = false;
      this.job = null;
      this.post({ type: 'busy', provider, busy: false });
    }
  }

  html(webview) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const media = (f) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `media-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${media('panel.css')}">
<title>Codex · Gemini</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}">window.PANEL_OUTPUT = ${JSON.stringify(outputDir())};</script>
<script nonce="${nonce}" src="${media('panel.js')}"></script>
</body>
</html>`;
  }
}

function activate(context) {
  const channel = vscode.window.createOutputChannel('Codex · Gemini');
  const log = (s) => channel.appendLine(s);
  extensionRoot = context.extensionPath;
  const view = new PanelView(context, log);

  context.subscriptions.push(
    channel,
    { dispose: () => view.dispose() },
    vscode.window.registerWebviewViewProvider(VIEW_ID, view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('codexGemini.open', () => vscode.commands.executeCommand(`${VIEW_ID}.focus`)),
    vscode.commands.registerCommand('codexGemini.newChat', () => view.post({ type: 'requestNewChat' })),
    vscode.commands.registerCommand('codexGemini.signIn', () => view.signIn()),
    vscode.commands.registerCommand('codexGemini.openOutput', () => {
      const dir = outputDir();
      fs.mkdirSync(dir, { recursive: true });
      return vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codexGemini')) view.reconfigure();
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
