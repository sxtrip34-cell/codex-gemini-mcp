#!/usr/bin/env node
// codex-mcp — MCP bridge to the local OpenAI Codex CLI (desktop-app build or npm build).
// Tools: generate_image, generate_video, generate_3d, codex, codex_reply, codex_job.
// Every generation runs as a background job; a call waits up to wait_seconds, then hands back a job_id.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.0';
const IS_WIN = process.platform === 'win32';
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const STATE_DIR = process.env.CODEX_MCP_HOME || path.join(os.homedir(), '.codex-mcp');
const DEFAULT_OUT = process.env.CODEX_MCP_OUTPUT_DIR || path.join(os.homedir(), 'Pictures', 'Codex');
const WAIT_DEFAULT = Number(process.env.CODEX_MCP_WAIT_SECONDS || 280);
const IMAGE_EFFORT = process.env.CODEX_MCP_IMAGE_EFFORT || 'medium';
// Sandbox for video/3D jobs: Codex may write only in its work folder and the output folder
// (Blender and ffmpeg run fine inside it). Set to "danger-full-access" if a tool gets blocked.
const BUILD_SANDBOX = process.env.CODEX_MCP_BUILD_SANDBOX || 'workspace-write';

const log = (...a) => process.stderr.write(`[codex-mcp] ${a.join(' ')}\n`);

// ---------------------------------------------------------------- binaries

const isFile = (p) => { try { return !!p && fs.statSync(p).isFile(); } catch { return false; } };
const verOf = (s) => (s.match(/\d+(?:\.\d+)+|\d+/) || ['0'])[0].split('.').map(Number);
const byVerDesc = (a, b) => {
  const x = verOf(a), y = verOf(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (y[i] || 0) - (x[i] || 0); if (d) return d; }
  return 0;
};

// Own PATH lookup: MCP clients may start the server with a trimmed environment (no PATHEXT),
// which makes where.exe find nothing.
function which(cmd) {
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).map((d) => d.replace(/^"|"$/g, '')).filter(Boolean);
  for (const d of dirs) for (const e of exts) { const p = path.join(d, cmd + e); if (isFile(p)) return p; }
  return null;
}

function findFfmpeg() {
  if (isFile(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  const onPath = which('ffmpeg');
  if (onPath || !IS_WIN) return onPath;
  const pkgs = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const d of fs.readdirSync(pkgs).filter((d) => /ffmpeg/i.test(d))) {
      for (const sub of fs.readdirSync(path.join(pkgs, d)).sort(byVerDesc)) {
        const p = path.join(pkgs, d, sub, 'bin', 'ffmpeg.exe');
        if (isFile(p)) return p;
      }
    }
  } catch {}
  for (const p of ['C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe']) if (isFile(p)) return p;
  return null;
}

function findCodex() {
  if (isFile(process.env.CODEX_PATH)) return process.env.CODEX_PATH;
  // The desktop app writes the path of its bundled CLI into config.toml and rewrites it on every update.
  try {
    const toml = fs.readFileSync(path.join(CODEX_HOME, 'config.toml'), 'utf8');
    const m = toml.match(/CODEX_CLI_PATH\s*=\s*(?:'([^']+)'|"((?:[^"\\]|\\.)*)")/);
    const p = m && (m[1] || m[2].replace(/\\\\/g, '\\'));
    if (isFile(p)) return p;
  } catch {}
  if (IS_WIN) {
    const base = 'C:\\Program Files\\WindowsApps';
    try {
      for (const d of fs.readdirSync(base).filter((d) => /^OpenAI\.Codex_/.test(d)).sort(byVerDesc)) {
        const p = path.join(base, d, 'app', 'resources', 'codex.exe');
        if (isFile(p)) return p;
      }
    } catch {}
    try {
      const loc = execFileSync('powershell.exe', ['-NoProfile', '-Command',
        '(Get-AppxPackage OpenAI.Codex | Sort-Object {[version]$_.Version} -Descending | Select-Object -First 1).InstallLocation'],
        { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const p = loc && path.join(loc, 'app', 'resources', 'codex.exe');
      if (isFile(p)) return p;
    } catch {}
  }
  return which('codex') || 'codex';
}

let _tools;
function toolbox() {
  if (_tools) return _tools;
  let blender = isFile(process.env.BLENDER_PATH) ? process.env.BLENDER_PATH : null;
  if (!blender && IS_WIN) {
    const base = 'C:\\Program Files\\Blender Foundation';
    try {
      for (const d of fs.readdirSync(base).sort(byVerDesc)) {
        const p = path.join(base, d, 'blender.exe');
        if (isFile(p)) { blender = p; break; }
      }
    } catch {}
  }
  blender = blender || which('blender');
  const ffmpeg = findFfmpeg();
  let ffprobe = ffmpeg && path.join(path.dirname(ffmpeg), IS_WIN ? 'ffprobe.exe' : 'ffprobe');
  if (!isFile(ffprobe)) ffprobe = which('ffprobe');
  const python = which('python') || which('python3');
  _tools = { blender, ffmpeg, ffprobe, node: process.execPath, python };
  return _tools;
}

// ---------------------------------------------------------------- helpers

const text = (t, extra = []) => ({ content: [{ type: 'text', text: t }, ...extra] });
const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
const short = (s, n = 160) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function normPath(p) {
  if (!p) return p;
  p = String(p).trim().replace(/^["']|["']$/g, '');
  if (IS_WIN) {
    const m = p.match(/^\/([a-zA-Z])(\/.*)?$/); // Git-Bash style /c/Users/...
    if (m) p = `${m[1].toUpperCase()}:${(m[2] || '/').replace(/\//g, '\\')}`;
  }
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

function existingFiles(list, label) {
  return (list || []).map((p) => {
    const abs = normPath(p);
    if (!isFile(abs)) throw new Error(`${label} not found: ${p}`);
    return abs;
  });
}

function baseName(filename, prompt, fallback) {
  if (filename) {
    const b = path.basename(String(filename)).replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim();
    if (b) return b;
  }
  // Strip accents (ö→o, ş→s, ğ→g; ı has no decomposition) so Turkish prompts give readable names.
  const s = String(prompt || '').toLowerCase().replace(/ı/g, 'i').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 6).join('-').slice(0, 48);
  return s || fallback;
}

function uniquePath(dir, base, ext) {
  let p = path.join(dir, base + ext), n = 2;
  while (fs.existsSync(p)) p = path.join(dir, `${base}-v${n++}${ext}`);
  return p;
}

const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
const sizeOf = (p) => { try { const b = fs.statSync(p).size; return b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`; } catch { return '?'; } };

function listNewFiles(dir, sinceMs, exts, depth = 2) {
  const out = [];
  const walk = (d, lvl) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (lvl < depth && !e.name.startsWith('.') && e.name !== 'node_modules') walk(p, lvl + 1); }
      else if ((!exts || exts.test(e.name)) && mtime(p) >= sinceMs - 2000) out.push(p);
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => mtime(b) - mtime(a));
}

function collectGenerated(threadId, sinceMs) {
  if (!threadId) return [];
  const dir = path.join(CODEX_HOME, 'generated_images', threadId);
  return listNewFiles(dir, sinceMs, /\.(png|jpe?g|webp|gif)$/i, 0).reverse();
}

function preview(file, { at, alpha } = {}) {
  const { ffmpeg } = toolbox();
  if (!ffmpeg || !isFile(file)) { log(`preview skipped: ${!ffmpeg ? 'ffmpeg not found' : `no file ${file}`}`); return null; }
  const ext = alpha ? 'png' : 'jpg';
  const out = path.join(os.tmpdir(), `codex-mcp-prev-${crypto.randomUUID()}.${ext}`);
  const args = ['-y', '-loglevel', 'error'];
  if (at != null) args.push('-ss', String(at));
  args.push('-i', file, '-frames:v', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease');
  if (!alpha) args.push('-q:v', '4');
  args.push(out);
  try {
    execFileSync(ffmpeg, args, { timeout: 60000, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    const data = fs.readFileSync(out).toString('base64');
    fs.rmSync(out, { force: true });
    return { type: 'image', data, mimeType: alpha ? 'image/png' : 'image/jpeg' };
  } catch (e) {
    log(`preview failed for ${file}: ${short(e.stderr?.toString() || e.message, 300)}`);
    return null;
  }
}

function probe(file) {
  const { ffprobe } = toolbox();
  if (!ffprobe) return null;
  try {
    const j = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { encoding: 'utf8', timeout: 30000, windowsHide: true }));
    const v = (j.streams || []).find((s) => s.codec_type === 'video');
    return {
      duration: Number(Number(j.format?.duration || 0).toFixed(2)),
      width: v?.width, height: v?.height, fps: v?.avg_frame_rate || v?.r_frame_rate, codec: v?.codec_name,
      audio: (j.streams || []).some((s) => s.codec_type === 'audio'),
    };
  } catch { return null; }
}

// ---------------------------------------------------------------- sessions (for codex_reply)

const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');
let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch {}
function rememberSession(id, info) {
  if (!id) return;
  sessions[id] = { ...sessions[id], ...info, updated: new Date().toISOString() };
  const ids = Object.keys(sessions).sort((a, b) => (sessions[b].updated > sessions[a].updated ? 1 : -1));
  for (const old of ids.slice(200)) delete sessions[old];
  try { ensureDir(STATE_DIR); fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2)); } catch {}
}

// ---------------------------------------------------------------- running codex

// Codex's shell commands need a normal Windows environment even when the MCP client trimmed ours.
function childEnv() {
  const env = { ...process.env, CODEX_HOME };
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const extra = [toolbox().ffmpeg, toolbox().blender].filter(Boolean).map((p) => path.dirname(p));
  env[pathKey] = [...extra, env[pathKey] || ''].join(path.delimiter);
  if (IS_WIN) {
    const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
    env.SystemRoot ??= root;
    env.windir ??= root;
    env.ComSpec ??= path.join(root, 'System32', 'cmd.exe');
    env.PATHEXT ??= '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL';
    env.USERPROFILE ??= os.homedir();
    env.TEMP ??= os.tmpdir();
    env.TMP ??= env.TEMP;
  }
  return env;
}

function runCodex({ prompt, cwd, sandbox = 'read-only', images = [], addDirs = [], resume, effort, model, job }) {
  const codex = findCodex();
  const args = ['exec'];
  if (resume) args.push('resume');
  args.push('--json', '--skip-git-repo-check');
  if (sandbox === 'danger-full-access') args.push('--dangerously-bypass-approvals-and-sandbox');
  else if (resume) args.push('-c', `sandbox_mode="${sandbox}"`);
  else args.push('-s', sandbox);
  if (!resume && cwd) args.push('-C', cwd);
  if (!resume) for (const d of addDirs) args.push('--add-dir', d);
  for (const img of images) args.push(`--image=${img}`);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  if (model) args.push('-m', model);
  if (resume) args.push(resume);
  args.push('-'); // prompt via stdin: no quoting or length limits

  const state = { threadId: resume || null, messages: [], commands: 0, errors: [], usage: null, stderr: '' };
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(codex, args, { cwd: cwd || os.homedir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: childEnv() });
    } catch (e) {
      resolve({ code: -1, ...state, errors: [`could not start Codex (${codex}): ${e.message}`] });
      return;
    }
    if (job) { job.child = child; job.activity = 'starting Codex'; }
    const activity = (s) => { if (job) job.activity = short(s); };

    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        const it = ev.item || {};
        if (ev.type === 'thread.started') { state.threadId = ev.thread_id; if (job) job.threadId = ev.thread_id; }
        else if (ev.type === 'item.started' && it.type === 'command_execution') activity(`running: ${it.command}`);
        else if (ev.type === 'item.completed') {
          if (it.type === 'agent_message') { state.messages.push(it.text); activity(it.text); }
          else if (it.type === 'command_execution') state.commands++;
          else if (it.type === 'error') { if (!/Under-development features/i.test(it.message || '')) state.errors.push(it.message); }
          else if (it.type) activity(it.type.replace(/_/g, ' '));
        } else if (ev.type === 'turn.completed') state.usage = ev.usage;
        else if (ev.type === 'turn.failed') state.errors.push(ev.error?.message || JSON.stringify(ev.error));
        else if (ev.type === 'error') state.errors.push(ev.message || JSON.stringify(ev));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { state.stderr = (state.stderr + d).slice(-6000); });
    child.on('error', (e) => state.errors.push(`Codex process error: ${e.message}`));
    child.on('close', (code) => {
      for (const l of state.stderr.split(/\r?\n/)) if (/\bERROR\b/.test(l)) state.errors.push(short(l.replace(/^\S+\s+ERROR\s+/, ''), 400));
      state.errors = [...new Set(state.errors)];
      if (job) job.child = null;
      resolve({ code, ...state });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt, 'utf8');
  });
}

function report(r) {
  const parts = [`exit code: ${r.code}`];
  if (r.threadId) parts.push(`session_id: ${r.threadId}`);
  if (r.errors.length) parts.push(`errors:\n- ${r.errors.slice(-5).join('\n- ')}`);
  if (r.messages.length) parts.push(`Codex said:\n${r.messages.slice(-3).join('\n')}`);
  else if (r.stderr) parts.push(`stderr tail:\n${r.stderr.slice(-1200)}`);
  return parts.join('\n');
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); return; } catch {} }
  try { child.kill('SIGTERM'); } catch {}
}

// ---------------------------------------------------------------- jobs

const jobs = new Map();

function startJob(kind, summary, fn) {
  const id = `${kind}-${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  const job = { id, kind, summary: short(summary, 120), status: 'running', startedAt: Date.now(), activity: 'queued', result: null, child: null, threadId: null };
  job.promise = Promise.resolve()
    .then(() => fn(job))
    .then((r) => { job.status = job.status === 'cancelled' ? 'cancelled' : r.isError ? 'failed' : 'done'; job.result = r; return r; },
      (e) => { job.status = 'failed'; job.result = fail(`${kind} job failed: ${e.message}`); return job.result; })
    .finally(() => { job.endedAt = Date.now(); });
  jobs.set(id, job);
  for (const [k, j] of jobs) if (jobs.size > 100 && j.status !== 'running') jobs.delete(k);
  return job;
}

async function awaitJob(job, waitSec, extra, progressToken) {
  const wait = Math.max(0, Math.min(Number.isFinite(+waitSec) ? +waitSec : WAIT_DEFAULT, 3600));
  let timer, ticker, n = 0;
  if (progressToken !== undefined && extra?.sendNotification) {
    ticker = setInterval(() => {
      extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: ++n, message: `${job.kind}: ${job.activity}` } }).catch(() => {});
    }, 10000);
  }
  try {
    const r = await Promise.race([job.promise, new Promise((res) => { timer = setTimeout(() => res(null), wait * 1000); })]);
    if (r) return r;
    const secs = Math.round((Date.now() - job.startedAt) / 1000);
    return text(`Still running (${secs}s so far). job_id: ${job.id}\nLatest activity: ${job.activity}\n` +
      'It keeps running in the background. Call codex_job with this job_id to wait for the result.');
  } finally { clearTimeout(timer); clearInterval(ticker); }
}

// ---------------------------------------------------------------- tool: generate_image

const ASPECTS = {
  square: '1:1 square (1024x1024)',
  landscape: '3:2 landscape (1536x1024)',
  portrait: '2:3 portrait (1024x1536)',
  wide: '16:9 widescreen landscape',
  tall: '9:16 vertical (phone screen)',
};

function imagePrompt(a, n, hasEdit, refCount) {
  const L = [
    'You are the image-generation backend for another AI agent. Work non-interactively.',
    'Use your built-in image_gen tool directly. Do not read skill files, do not run shell commands, do not write code, and do not copy or move files: the caller collects the generated files itself.',
    n > 1 ? `Generate exactly ${n} images: distinct variants of the same brief, one image_gen call each.` : 'Generate exactly 1 image.',
  ];
  if (a.aspect) L.push(`Aspect / size: ${ASPECTS[a.aspect] || a.aspect}.`);
  if (a.transparent) L.push('Background: genuinely transparent (alpha channel), clean cut-out edges, no backdrop.');
  let idx = 1;
  if (hasEdit) { L.push('Attached image 1 is the EDIT TARGET: apply only the requested change and keep everything else unchanged.'); idx = 2; }
  if (refCount) {
    const nums = Array.from({ length: refCount }, (_, i) => idx + i).join(', ');
    L.push(`Attached image(s) ${nums}: reference(s) for subject, style or composition. Use them as guidance, not as something to copy.`);
  }
  L.push('Follow the brief faithfully. If it is generic, add only tasteful detail that clearly improves the image. No added text, logos or watermarks unless the brief asks; render any requested text exactly.');
  L.push('', 'Brief:', '"""', a.prompt, '"""', '', 'When done, reply with one short line per image describing it.');
  return L.join('\n');
}

function generateImage(a) {
  if (!a.prompt) throw new Error('prompt is required');
  const outDir = ensureDir(normPath(a.output_dir || DEFAULT_OUT));
  const n = Math.max(1, Math.min(Number(a.count) || 1, 8));
  const edit = a.edit_image ? existingFiles([a.edit_image], 'edit_image') : [];
  const refs = existingFiles(a.reference_images, 'reference image');
  const base = baseName(a.filename, a.prompt, 'image');
  return startJob('image', a.prompt, async (job) => {
    const t0 = Date.now();
    const r = await runCodex({ prompt: imagePrompt(a, n, edit.length > 0, refs.length), cwd: outDir, sandbox: 'read-only', images: [...edit, ...refs], effort: a.reasoning_effort || IMAGE_EFFORT, model: a.model, job });
    const gen = collectGenerated(r.threadId, t0);
    if (!gen.length) return fail(`Codex finished without producing an image.\n${report(r)}`);
    const saved = gen.map((src, i) => {
      const dst = uniquePath(outDir, gen.length > 1 ? `${base}-${i + 1}` : base, path.extname(src).toLowerCase());
      fs.copyFileSync(src, dst);
      return dst;
    });
    rememberSession(r.threadId, { kind: 'image', outDir, base, cwd: outDir, sandbox: 'read-only' });
    const previews = a.preview === false ? [] : saved.slice(0, 4).map((p) => preview(p, { alpha: !!a.transparent })).filter(Boolean);
    return text([
      `Generated ${saved.length} image(s):`,
      ...saved.map((p) => `- ${p} (${sizeOf(p)})`),
      `session_id: ${r.threadId} (pass to codex_reply to refine these images)`,
      r.messages.length ? `Codex: ${r.messages[r.messages.length - 1]}` : '',
    ].filter(Boolean).join('\n'), previews);
  });
}

// ---------------------------------------------------------------- tool: generate_video

const VIDEO_SIZES = { landscape: [1920, 1080, '16:9'], portrait: [1080, 1920, '9:16'], square: [1080, 1080, '1:1'], vertical: [1080, 1920, '9:16'], wide: [1920, 1080, '16:9'] };

// Asset jobs run inside the user's normal Codex profile, whose AGENTS.md may carry project rules
// (git, repos, publishing). These lines keep a generation job to its deliverable.
const ASSET_RULES = [
  'This is a one-off asset job, not a software project: do not run git, do not create repositories, do not push, upload or publish anything. Ignore repository or deployment workflow rules from AGENTS.md for this job.',
  'Stay inside the brief: no brand names, logos, labels, watermarks or other text unless the brief asks for them.',
];

function toolLines() {
  const t = toolbox();
  return [
    `- your built-in image_gen tool. Its files land in ${path.join(CODEX_HOME, 'generated_images')}\\<this session id>\\ — copy the ones you use into the work folder.`,
    `- ffmpeg: ${t.ffmpeg || 'NOT FOUND'}   ffprobe: ${t.ffprobe || 'NOT FOUND'}`,
    `- Blender (headless, run scripts with -b --python): ${t.blender || 'NOT FOUND'}`,
    `- Node.js: ${t.node}   Python: ${t.python || 'NOT FOUND'}`,
  ];
}

function generateVideo(a) {
  if (!a.prompt) throw new Error('prompt is required');
  const outDir = ensureDir(normPath(a.output_dir || DEFAULT_OUT));
  const base = baseName(a.filename, a.prompt, 'video');
  const final = uniquePath(outDir, base, '.mp4');
  const [W, H, ratio] = VIDEO_SIZES[a.aspect] || VIDEO_SIZES.landscape;
  const dur = Math.max(2, Math.min(Number(a.duration_seconds) || 8, 120));
  const fps = Math.max(12, Math.min(Number(a.fps) || 30, 60));
  const refs = existingFiles(a.reference_images, 'reference image');
  return startJob('video', a.prompt, async (job) => {
    const work = ensureDir(path.join(STATE_DIR, 'work', job.id));
    const prompt = [
      'You are the video-production backend for another AI agent. Work non-interactively and finish the job end to end.',
      `Deliverable: ONE finished video file at exactly: ${final}`,
      '', 'Brief:', '"""', a.prompt, '"""', '',
      `Spec: about ${dur} s, ${W}x${H} (${ratio}), ${fps} fps, H.264 MP4, yuv420p, +faststart, ${a.audio ? 'with a fitting audio bed synthesised locally (ffmpeg filters), no copyrighted music' : 'silent (no audio track)'}.`,
      refs.length ? `Attached image(s): references for subject, style or look. Match them.` : '',
      'Toolbox on this machine:', ...toolLines(),
      `Work folder (cwd): ${work}. Keep every intermediate file there.`,
      'Pick the technique that gives the most convincing motion for this brief, for example:',
      '- image_gen keyframes or plates animated with slow camera moves, layered parallax (cut-out foreground/background layers), light sweeps and matched transitions in ffmpeg — upscale stills at least 2x before zoompan so motion is smooth;',
      '- a Blender scene (modelled, or image planes for 2.5D parallax) with an animated camera, rendered with Eevee to frames and encoded with ffmpeg;',
      '- code-rendered motion graphics (frames drawn with Node or Python, encoded with ffmpeg).',
      'No static slideshow, no jitter, no black or empty frames.',
      ...ASSET_RULES,
      'Before finishing: run ffprobe on the result (duration, resolution, fps) and look at 3 extracted frames with view_image; fix obvious problems once.',
      'Final reply: the file path, the technique used, and 2-3 sentences describing the video.',
    ].filter((l) => l !== '').join('\n');
    const t0 = Date.now();
    const r = await runCodex({ prompt, cwd: work, sandbox: BUILD_SANDBOX, images: refs, addDirs: [outDir], model: a.model, effort: a.reasoning_effort, job });
    let out = isFile(final) ? final : listNewFiles(outDir, t0, /\.(mp4|mov|webm)$/i, 0)[0] || listNewFiles(work, t0, /\.(mp4|mov|webm)$/i)[0];
    if (!out) return fail(`Codex finished without producing a video.\n${report(r)}\nwork folder: ${work}`);
    if (path.dirname(out) !== outDir) { fs.copyFileSync(out, final); out = final; }
    rememberSession(r.threadId, { kind: 'video', outDir, base, cwd: work, sandbox: BUILD_SANDBOX, deliverable: out });
    const info = probe(out);
    const frame = a.preview === false ? null : preview(out, { at: info?.duration ? info.duration / 2 : 1 });
    return text([
      `Video: ${out} (${sizeOf(out)})`,
      info ? `ffprobe: ${info.width}x${info.height}, ${info.duration}s, ${info.fps} fps, ${info.codec}${info.audio ? ', with audio' : ', silent'}` : '',
      `work folder: ${work}`,
      `session_id: ${r.threadId} (pass to codex_reply to revise this video)`,
      r.messages.length ? `Codex: ${r.messages[r.messages.length - 1]}` : '',
    ].filter(Boolean).join('\n'), frame ? [frame] : []);
  });
}

// ---------------------------------------------------------------- tool: generate_3d

const DETAIL = { low: 'low-poly, about 2k-8k triangles', medium: 'mid-poly, about 15k-50k triangles', high: 'high detail, about 80k-250k triangles' };
const FORMATS = { glb: 'glTF binary (.glb), embedded textures', gltf: 'glTF separate (.gltf + .bin + textures)', fbx: 'FBX (.fbx)', obj: 'Wavefront OBJ (.obj + .mtl)', stl: 'STL (.stl, single mesh, for 3D printing)', usdz: 'USDZ (.usdz)' };

function generate3d(a) {
  if (!a.prompt) throw new Error('prompt is required');
  const outDir = ensureDir(normPath(a.output_dir || DEFAULT_OUT));
  const fmt = FORMATS[a.format] ? a.format : 'glb';
  const base = baseName(a.filename, a.prompt, 'model');
  const asset = uniquePath(outDir, base, `.${fmt}`);
  const stem = path.basename(asset, `.${fmt}`);
  const prev = path.join(outDir, `${stem}_preview.png`);
  const refs = existingFiles(a.reference_images, 'reference image');
  return startJob('3d', a.prompt, async (job) => {
    const work = ensureDir(path.join(STATE_DIR, 'work', job.id));
    const blend = path.join(work, `${stem}.blend`);
    const prompt = [
      'You are the 3D-asset production backend for another AI agent. Work non-interactively and finish the job end to end.',
      '', 'Brief:', '"""', a.prompt, '"""', '',
      'Deliverables:',
      `- ${asset} — ${FORMATS[fmt]}; Y-up for glTF, real-world scale in metres, origin at the base centre, transforms applied, clean normals, named objects and materials`,
      `- ${prev} — 1024x1024 preview render (three-point lighting, neutral studio backdrop, 3/4 view)`,
      `- ${blend} — the Blender source file`,
      `Detail level: ${DETAIL[a.detail] || DETAIL.medium}.${a.animated ? ' Add a simple looping animation (exported with the asset).' : ''}`,
      refs.length ? 'Attached image(s): references for shape, proportions and materials. Match them.' : '',
      'Toolbox on this machine:', ...toolLines(),
      `Work folder (cwd): ${work}. Keep scripts and intermediates there.`,
      'Method: model it with a Blender Python (bpy) script run headless. Use real modelling (modifiers such as subdivision, bevel, solidify, boolean, array, curves, displacement), not a pile of primitives, and proper PBR materials (Principled BSDF).',
      a.textures === false ? 'Use procedural or flat materials only; no image textures.' : 'Where textures clearly help (labels, organic surfaces, fabric, wood, terrain), create them with image_gen, copy them into the work folder, and use them in the materials (they must end up embedded or exported next to the asset).',
      ...ASSET_RULES,
      'Validate before finishing: re-import the exported file in a fresh Blender process and print object count, triangle count and bounding-box size; render the preview; look at it with view_image and fix obvious problems (floating parts, wrong scale, missing materials, black render) once.',
      'Final reply: the file paths, triangle count, dimensions in metres, and one sentence describing the model.',
    ].filter((l) => l !== '').join('\n');
    const t0 = Date.now();
    const r = await runCodex({ prompt, cwd: work, sandbox: BUILD_SANDBOX, images: refs, addDirs: [outDir], model: a.model, effort: a.reasoning_effort, job });
    const extRe = new RegExp(`\\.${fmt}$`, 'i');
    let out = isFile(asset) ? asset : listNewFiles(outDir, t0, extRe, 0)[0] || listNewFiles(work, t0, extRe)[0];
    if (!out) return fail(`Codex finished without producing a ${fmt} file.\n${report(r)}\nwork folder: ${work}`);
    if (path.dirname(out) !== outDir) { fs.copyFileSync(out, asset); out = asset; }
    const pv = isFile(prev) ? prev : listNewFiles(outDir, t0, /preview.*\.(png|jpe?g)$/i, 0)[0] || listNewFiles(work, t0, /\.(png|jpe?g)$/i)[0];
    rememberSession(r.threadId, { kind: '3d', outDir, base: stem, cwd: work, sandbox: BUILD_SANDBOX, deliverable: out });
    const img = pv && a.preview !== false ? preview(pv) : null;
    return text([
      `3D asset: ${out} (${sizeOf(out)})`,
      pv ? `preview: ${pv}` : 'preview: not produced',
      isFile(blend) ? `blend: ${blend}` : '',
      `work folder: ${work}`,
      `session_id: ${r.threadId} (pass to codex_reply to revise this model)`,
      r.messages.length ? `Codex: ${r.messages[r.messages.length - 1]}` : '',
    ].filter(Boolean).join('\n'), img ? [img] : []);
  });
}

// ---------------------------------------------------------------- tool: codex (general task)

function codexTask(a) {
  if (!a.prompt) throw new Error('prompt is required');
  const cwd = normPath(a.cwd || process.cwd());
  if (!fs.existsSync(cwd)) throw new Error(`cwd not found: ${cwd}`);
  const sandbox = a.sandbox === 'workspace-write' ? 'workspace-write' : 'read-only';
  const images = existingFiles(a.images, 'image');
  return startJob('codex', a.prompt, async (job) => {
    const t0 = Date.now();
    const r = await runCodex({ prompt: a.prompt, cwd, sandbox, images, effort: a.reasoning_effort, model: a.model, job });
    rememberSession(r.threadId, { kind: 'codex', cwd, sandbox, outDir: cwd });
    const gen = collectGenerated(r.threadId, t0);
    const body = [
      r.messages.length ? r.messages[r.messages.length - 1] : '(Codex returned no message)',
      '',
      `session_id: ${r.threadId} (pass to codex_reply to continue)`,
      gen.length ? `generated images (in Codex's store):\n${gen.map((p) => `- ${p}`).join('\n')}` : '',
      r.errors.length || r.code ? report(r) : '',
    ].filter(Boolean).join('\n');
    const res = text(body, gen.slice(0, 2).map((p) => preview(p)).filter(Boolean));
    if (r.code && !r.messages.length) res.isError = true;
    return res;
  });
}

// ---------------------------------------------------------------- tool: codex_reply

function codexReply(a) {
  if (!a.session_id || !a.prompt) throw new Error('session_id and prompt are required');
  const s = sessions[a.session_id] || {};
  const outDir = ensureDir(normPath(a.output_dir || s.outDir || DEFAULT_OUT));
  const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : outDir;
  const images = existingFiles(a.images, 'image');
  return startJob(s.kind ? `${s.kind}-reply` : 'reply', a.prompt, async (job) => {
    const t0 = Date.now();
    let prompt = a.prompt;
    if (s.kind === 'image') prompt += '\n\n(Use the built-in image_gen tool directly. Do not run commands or copy files; the caller collects the images.)';
    if ((s.kind === 'video' || s.kind === '3d') && s.deliverable) prompt += `\n\n(Overwrite the deliverable at ${s.deliverable} with the revised version and re-validate it.)`;
    const r = await runCodex({ prompt, cwd, sandbox: s.sandbox || 'read-only', images, resume: a.session_id, effort: s.kind === 'image' ? IMAGE_EFFORT : undefined, job });
    rememberSession(a.session_id, { ...s, outDir });
    const lines = [r.messages.length ? `Codex: ${r.messages[r.messages.length - 1]}` : '(no message)'];
    const extras = [];
    const gen = collectGenerated(a.session_id, t0);
    if (s.kind === 'image' && gen.length) {
      const saved = gen.map((src) => { const dst = uniquePath(outDir, s.base || 'image', path.extname(src).toLowerCase()); fs.copyFileSync(src, dst); return dst; });
      lines.push('New image(s):', ...saved.map((p) => `- ${p}`));
      extras.push(...saved.slice(0, 4).map((p) => preview(p)).filter(Boolean));
    } else if (gen.length) lines.push('Generated images:', ...gen.map((p) => `- ${p}`));
    if (s.deliverable && mtime(s.deliverable) >= t0) {
      lines.push(`Updated: ${s.deliverable} (${sizeOf(s.deliverable)})`);
      const isVid = /\.(mp4|mov|webm)$/i.test(s.deliverable);
      const info = isVid ? probe(s.deliverable) : null;
      if (info) lines.push(`ffprobe: ${info.width}x${info.height}, ${info.duration}s`);
      const pv = isVid ? preview(s.deliverable, { at: info?.duration ? info.duration / 2 : 1 })
        : preview(listNewFiles(outDir, t0, /preview.*\.(png|jpe?g)$/i, 0)[0] || '');
      if (pv) extras.push(pv);
    }
    if (r.errors.length || r.code) lines.push(report(r));
    lines.push(`session_id: ${a.session_id}`);
    const res = text(lines.join('\n'), extras);
    if (r.code && !r.messages.length) res.isError = true;
    return res;
  });
}

// ---------------------------------------------------------------- tool: codex_job

// ---------------------------------------------------------------- tool: codex_status

function codexStatus() {
  const codex = findCodex();
  const run = (args) => {
    const r = spawnSync(codex, args, { encoding: 'utf8', timeout: 20000, windowsHide: true });
    return `${r.stdout || ''}${r.stderr || ''}`.trim() || (r.error ? r.error.message : '');
  };
  const version = run(['--version']).split(/\r?\n/)[0];
  const login = run(['login', 'status']).split(/\r?\n/).find((l) => /log/i.test(l)) || 'unknown';
  let models = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CODEX_HOME, 'models_cache.json'), 'utf8'));
    const arr = Array.isArray(j) ? j : j.models || Object.values(j).find(Array.isArray) || [];
    models = arr.filter((m) => m.visibility !== 'hide').map((m) => ({
      id: m.slug, name: m.display_name || m.slug,
      efforts: (m.supported_reasoning_levels || []).map((x) => x.effort || x),
    }));
  } catch {}
  let defaultModel = null, defaultEffort = null;
  try {
    const t = fs.readFileSync(path.join(CODEX_HOME, 'config.toml'), 'utf8');
    defaultModel = (/^model\s*=\s*"([^"]+)"/m.exec(t) || [])[1] || null;
    defaultEffort = (/^model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(t) || [])[1] || null;
  } catch {}
  return text([
    `codex: ${codex}`,
    `version: ${version}`,
    `login: ${login.replace(/[\w.+-]+@[\w.-]+/g, '<email>')}`,
    `default_model: ${defaultModel}`,
    `default_effort: ${defaultEffort}`,
    `models: ${JSON.stringify(models)}`,
  ].join('\n'));
}

async function codexJob(a, extra, token) {
  if (!a.job_id) {
    if (!jobs.size) return text('No jobs in this server session.');
    return text([...jobs.values()].map((j) => `${j.id}  ${j.status}  ${Math.round(((j.endedAt || Date.now()) - j.startedAt) / 1000)}s  ${j.summary}${j.status === 'running' ? `  — ${j.activity}` : ''}`).join('\n'));
  }
  const job = jobs.get(a.job_id);
  if (!job) return fail(`Unknown job_id ${a.job_id} (jobs live only as long as this MCP server process).`);
  if (a.cancel) {
    if (job.status === 'running') { job.status = 'cancelled'; killTree(job.child); }
    return text(`Job ${job.id}: ${job.status}`);
  }
  if (job.status !== 'running') return job.result;
  return awaitJob(job, a.wait_seconds, extra, token);
}

// ---------------------------------------------------------------- schemas

const effortProp = { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], description: 'Optional reasoning effort override (default: the Codex config).' };
const waitProp = { type: 'integer', minimum: 0, maximum: 3600, description: `Seconds to wait for the result before returning a job_id (default ${WAIT_DEFAULT}). The job keeps running either way.` };
const outProp = { type: 'string', description: `Absolute folder to save into, e.g. the project's assets folder. Default: ${DEFAULT_OUT}` };
const fileProp = { type: 'string', description: 'Base file name without extension (default: derived from the prompt). Existing files are never overwritten; a -v2 suffix is added.' };
const refsProp = { type: 'array', items: { type: 'string' }, description: 'Absolute paths of reference images (style, subject, composition).' };
const previewProp = { type: 'boolean', description: 'Return a small preview image in the result (default true).' };

const TOOLS = [
  {
    name: 'generate_image',
    description: 'Generate or edit a bitmap image with OpenAI Codex\'s built-in image model (photos, illustrations, product shots, textures, sprites, UI mockups, transparent cut-outs). Saves the PNG(s) to output_dir and returns the paths, a preview and a session_id for refinement via codex_reply. Typical time: 20-90 s per image.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to create (or, with edit_image, what to change). Be specific about subject, style, composition, lighting and any exact text.' },
        output_dir: outProp,
        filename: fileProp,
        count: { type: 'integer', minimum: 1, maximum: 8, description: 'Number of variants (default 1).' },
        aspect: { type: 'string', description: 'square | landscape (3:2) | portrait (2:3) | wide (16:9) | tall (9:16), or free text such as "4:5".' },
        transparent: { type: 'boolean', description: 'Transparent background (alpha).' },
        edit_image: { type: 'string', description: 'Absolute path of an existing image to edit instead of generating from scratch.' },
        reference_images: refsProp,
        model: { type: 'string', description: 'Optional Codex model override.' },
        reasoning_effort: effortProp,
        preview: previewProp,
        wait_seconds: waitProp,
      },
      required: ['prompt'],
    },
  },
  {
    name: 'generate_video',
    description: 'Produce a short MP4 video with OpenAI Codex. Codex has no text-to-video model, so it builds the clip itself: image_gen keyframes and plates animated with camera moves and parallax in ffmpeg, Blender camera animation, or code-rendered motion graphics. Good for hero loops, b-roll, product turntables, animated backgrounds and motion graphics, not for realistic people acting. Typical time: 3-15 min; usually returns a job_id first (poll codex_job).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The video brief: subject, look, motion, pacing, mood, any text.' },
        output_dir: outProp,
        filename: fileProp,
        duration_seconds: { type: 'number', minimum: 2, maximum: 120, description: 'Target length (default 8).' },
        aspect: { type: 'string', enum: ['landscape', 'portrait', 'square'], description: 'landscape 1920x1080 (default), portrait 1080x1920, square 1080x1080.' },
        fps: { type: 'integer', minimum: 12, maximum: 60, description: 'Frames per second (default 30).' },
        audio: { type: 'boolean', description: 'Add a locally synthesised ambient audio bed (default false, silent).' },
        reference_images: refsProp,
        model: { type: 'string', description: 'Optional Codex model override.' },
        reasoning_effort: effortProp,
        preview: previewProp,
        wait_seconds: waitProp,
      },
      required: ['prompt'],
    },
  },
  {
    name: 'generate_3d',
    description: 'Create a 3D model with OpenAI Codex driving Blender headless: models with bpy, adds PBR materials (and image_gen textures when useful), exports GLB/glTF/FBX/OBJ/STL/USDZ, renders a preview PNG and validates the export. Good for props, products, stylised objects, simple characters and environments for web (three.js) or games. Typical time: 3-15 min; usually returns a job_id first (poll codex_job).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to model: object, style (realistic, stylised, low-poly), proportions, materials, intended use.' },
        output_dir: outProp,
        filename: fileProp,
        format: { type: 'string', enum: Object.keys(FORMATS), description: 'Export format (default glb).' },
        detail: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Polygon budget (default medium).' },
        textures: { type: 'boolean', description: 'Allow image_gen textures (default true).' },
        animated: { type: 'boolean', description: 'Add a simple looping animation (default false).' },
        reference_images: refsProp,
        model: { type: 'string', description: 'Optional Codex model override.' },
        reasoning_effort: effortProp,
        preview: previewProp,
        wait_seconds: waitProp,
      },
      required: ['prompt'],
    },
  },
  {
    name: 'codex',
    description: 'Hand any task to the OpenAI Codex agent on this PC (questions, code, research in a folder, second opinion). Read-only by default; set sandbox to workspace-write to let it edit files in cwd. Returns Codex\'s final answer and a session_id for codex_reply.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task for Codex.' },
        cwd: { type: 'string', description: 'Absolute working folder (default: the MCP server\'s working directory).' },
        sandbox: { type: 'string', enum: ['read-only', 'workspace-write'], description: 'read-only (default) or workspace-write (may edit files inside cwd).' },
        images: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of images to attach.' },
        model: { type: 'string', description: 'Optional Codex model override.' },
        reasoning_effort: effortProp,
        wait_seconds: waitProp,
      },
      required: ['prompt'],
    },
  },
  {
    name: 'codex_reply',
    description: 'Continue an earlier Codex session (from generate_image, generate_video, generate_3d or codex) with a follow-up, e.g. "make it warmer", "slow the camera down", "fewer polygons". Image sessions save new versions next to the old ones; video and 3D sessions overwrite their deliverable.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'session_id returned by an earlier call.' },
        prompt: { type: 'string', description: 'The follow-up instruction.' },
        output_dir: { type: 'string', description: 'Optional new folder for image results (default: the original folder).' },
        images: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of extra images to attach.' },
        wait_seconds: waitProp,
      },
      required: ['session_id', 'prompt'],
    },
  },
  {
    name: 'codex_status',
    description: 'Show the Codex CLI in use, its version, the login state, the models this account can use (with their reasoning levels) and the default model and effort.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'codex_job',
    description: 'Check, wait for, or cancel a running Codex job. Without job_id it lists all jobs of this server session.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        wait_seconds: waitProp,
        cancel: { type: 'boolean', description: 'Stop the job.' },
      },
    },
  },
];

const INSTRUCTIONS = `Bridge to the OpenAI Codex agent installed on this PC.
Whenever a task needs a generated bitmap image (photo, illustration, texture, sprite, mockup, transparent cut-out), a short video clip, or a 3D model, use generate_image, generate_video or generate_3d. Do not hand-draw placeholders or stock fills.
Pass output_dir as the project's asset folder so files land where they are used. Look at the returned preview before using an asset; refine with codex_reply and the returned session_id.
Video and 3D jobs take minutes. When a call returns a job_id, call codex_job with it to wait for the result.
Use the codex tool to hand Codex any other task or to get a second opinion.`;

// ---------------------------------------------------------------- server

const server = new Server({ name: 'codex', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name } = req.params;
  const a = req.params.arguments || {};
  const token = req.params._meta?.progressToken;
  try {
    switch (name) {
      case 'generate_image': return await awaitJob(generateImage(a), a.wait_seconds, extra, token);
      case 'generate_video': return await awaitJob(generateVideo(a), a.wait_seconds, extra, token);
      case 'generate_3d': return await awaitJob(generate3d(a), a.wait_seconds, extra, token);
      case 'codex': return await awaitJob(codexTask(a), a.wait_seconds, extra, token);
      case 'codex_reply': return await awaitJob(codexReply(a), a.wait_seconds, extra, token);
      case 'codex_job': return await codexJob(a, extra, token);
      case 'codex_status': return codexStatus();
      default: return fail(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return fail(e.message);
  }
});

function shutdown() {
  for (const j of jobs.values()) if (j.child) killTree(j.child);
  process.exit(0);
}
export { findCodex, toolbox, preview, probe, normPath, baseName, imagePrompt };

const isMain = import.meta.main ?? (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) {
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);
  await server.connect(new StdioServerTransport());
  const t = toolbox();
  log(`v${VERSION} ready; codex=${findCodex()}; ffmpeg=${t.ffmpeg || 'missing'}; blender=${t.blender || 'missing'}`);
}
