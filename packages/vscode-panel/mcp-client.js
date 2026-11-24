// Minimal MCP client over stdio (newline-delimited JSON-RPC) for the local gemini MCP server.
// No dependencies, so the extension does not need to bundle the MCP SDK.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function findNode() {
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const e of exts) {
      const p = path.join(dir, 'node' + e);
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  const fallback = 'C:\\Program Files\\nodejs\\node.exe';
  return fs.existsSync(fallback) ? fallback : 'node';
}

class McpClient {
  /** @param {{serverPath: string, nodePath?: string, log?: (s: string) => void}} opts */
  constructor(opts) {
    this.opts = opts;
    this.log = opts.log || (() => {});
    this.proc = null;
    this.ready = null;
    this.pending = new Map();
    this.progress = new Map();
    this.nextId = 1;
  }

  start() {
    if (this.ready) return this.ready;
    // The configured path wins; if it does not exist, fall back to the built-in one.
    const serverPath = [this.opts.serverPath, this.opts.fallbackPath].find((p) => p && fs.existsSync(p));
    if (!serverPath) {
      const msg = `${this.opts.name || 'MCP'} server not found (${this.opts.serverPath || this.opts.fallbackPath}). Run the installer in scripts/, or set the server path in the Codex · Gemini settings.`;
      this.log(msg);
      return Promise.reject(new Error(msg));
    }
    const node = this.opts.nodePath || findNode();
    this.proc = spawn(node, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: process.env });
    let buf = '';
    this.proc.stdout.setEncoding('utf8').on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.onMessage(line);
      }
    });
    this.proc.stderr.setEncoding('utf8').on('data', (d) => this.log(String(d).trimEnd()));
    this.proc.on('error', (e) => this.log(`server error: ${e.message}`));
    this.proc.on('exit', (code) => {
      this.log(`gemini MCP server exited (${code})`);
      for (const p of this.pending.values()) p.reject(new Error('The Gemini server stopped.'));
      this.pending.clear();
      this.progress.clear();
      this.proc = null;
      this.ready = null;
    });
    this.ready = this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'gemini-panel', version: '1.0.0' },
    }).then((r) => { this.notify('notifications/initialized', {}); return r; });
    this.ready.catch(() => { this.ready = null; });
    return this.ready;
  }

  onMessage(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && (m.result !== undefined || m.error)) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      this.progress.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message || 'MCP error'));
      else p.resolve(m.result);
    } else if (m.method === 'notifications/progress') {
      this.progress.get(m.params?.progressToken)?.(m.params?.message || '');
    } else if (m.id !== undefined && m.method) {
      this.write({ jsonrpc: '2.0', id: m.id, result: {} }); // e.g. ping
    }
  }

  write(obj) { if (this.proc) this.proc.stdin.write(JSON.stringify(obj) + '\n'); }
  notify(method, params) { this.write({ jsonrpc: '2.0', method, params }); }

  request(method, params, onProgress) {
    const id = this.nextId++;
    if (onProgress) { params = { ...params, _meta: { progressToken: id } }; this.progress.set(id, onProgress); }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async callTool(name, args, onProgress) {
    await this.start();
    return this.request('tools/call', { name, arguments: args }, onProgress);
  }

  dispose() {
    try { this.proc?.kill(); } catch {}
    this.proc = null;
    this.ready = null;
  }
}

// ---------------------------------------------------------------- result helpers

// Result text of both servers (gemini-mcp and codex-mcp): file lines, ids, and the model's own words.
const EXT = '(?:png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|m4a|ogg|glb|gltf|fbx|obj|stl|usdz)';
const FILE_LINE = new RegExp(`^(?:- |Video: |3D asset: |preview: )(.+?\\.${EXT})(?: \\([\\d.]+ (?:MB|KB)\\))?\\s*$`, 'gim');
const META = /^(chat_url|conversation_id|session_id|status|note|denied \(read-only\)|exit code|work folder|blend|ffprobe|preview|Video|3D asset|errors|Saved \d+ file|Generated \d+ image|generated images|New image|Updated|Codex said)\b/i;

function resultText(res) {
  return (res?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

function parseResult(res) {
  const text = resultText(res);
  const field = (name) => (new RegExp(`^${name}: (\\S+)`, 'm').exec(text) || [])[1] || null;
  const files = [...new Set([...text.matchAll(FILE_LINE)].map((m) => m[1].trim()))];
  const said = /^(?:Gemini|Codex): ([\s\S]*)$/m.exec(text);
  const isMeta = (l) => META.test(l) || (FILE_LINE.lastIndex = 0, FILE_LINE.test(l));
  // "Codex: …" is followed by bookkeeping lines (session_id, errors) in codex_reply results.
  const body = said
    ? said[1].split('\n').filter((l) => !/^(session_id|chat_url|conversation_id|exit code|work folder|ffprobe|Updated): /.test(l)).join('\n').trim()
    : text.split('\n').filter((l) => !isMeta(l)).join('\n').trim();
  FILE_LINE.lastIndex = 0;
  return {
    isError: !!res?.isError,
    text,
    body,
    files,
    chatUrl: field('chat_url'),
    conversationId: field('conversation_id'),
    sessionId: field('session_id'),
    jobId: /^Still running/m.test(text) ? ((/job_id: (\S+)/.exec(text) || [])[1] || null) : null,
  };
}

const kindOf = (p) => (/\.(mp4|webm|mov)$/i.test(p) ? 'video'
  : /\.(mp3|wav|m4a|ogg)$/i.test(p) ? 'audio'
    : /\.(glb|gltf|fbx|obj|stl|usdz)$/i.test(p) ? 'model' : 'image');

module.exports = { McpClient, findNode, parseResult, resultText, kindOf };
