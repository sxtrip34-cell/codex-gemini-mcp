#!/usr/bin/env node
// Installer for codex-gemini-mcp. Cross-platform (Windows, macOS, Linux); needs Node.js 20+.
//
//   node scripts/install.mjs                 install deps, register both servers in Claude Code, build + install the panel
//   node scripts/install.mjs --antigravity   also add the servers to Antigravity (~/.gemini/config/mcp_config.json)
//   node scripts/install.mjs --no-panel      skip the VS Code / Antigravity / Cursor panel
//   node scripts/install.mjs --no-claude     skip the Claude Code registration
//   node scripts/install.mjs --dry-run       only print what would happen
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const SERVERS = {
  codex: path.join(ROOT, 'packages', 'codex-mcp', 'server.mjs'),
  gemini: path.join(ROOT, 'packages', 'gemini-mcp', 'server.mjs'),
};

const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, ok: (s) => `\x1b[32m${s}\x1b[0m`, warn: (s) => `\x1b[33m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` };
const step = (s) => console.log(`\n${c.bold('›')} ${c.bold(s)}`);
const ok = (s) => console.log(`  ${c.ok('✓')} ${s}`);
const warn = (s) => console.log(`  ${c.warn('!')} ${s}`);
const info = (s) => console.log(`  ${c.dim(s)}`);

function which(cmd) {
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const e of exts) {
      const p = path.join(dir.replace(/^"|"$/g, ''), cmd + e);
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  return null;
}

const quote = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
function run(cmd, cmdArgs, { cwd = ROOT, capture = false } = {}) {
  const shell = IS_WIN && /\.(cmd|bat)$/i.test(cmd);
  const shown = [cmd, ...cmdArgs].map(quote).join(' ');
  if (DRY) { info(`would run: ${shown}`); return { status: 0, stdout: '' }; }
  const r = spawnSync(shell ? quote(cmd) : cmd, shell ? cmdArgs.map(quote) : cmdArgs, {
    cwd, shell, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', windowsHide: true,
  });
  if (r.error) throw r.error;
  return r;
}

function writeJson(file, data) {
  if (DRY) { info(`would write ${file}`); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

// ---------------------------------------------------------------- 1. Node and dependencies

step('Node.js and dependencies');
const major = +process.versions.node.split('.')[0];
if (major < 20) { console.error(`Node.js 20 or newer is required (found ${process.versions.node}).`); process.exit(1); }
ok(`Node.js ${process.versions.node}`);
const npm = which('npm');
if (!npm) { console.error('npm not found on PATH.'); process.exit(1); }
const inst = run(npm, ['install', '--no-fund', '--no-audit']);
if (inst.status) { console.error('npm install failed.'); process.exit(1); }
ok('npm install');

writeJson(path.join(os.homedir(), '.codex-gemini-mcp', 'install.json'), { root: ROOT, installedAt: new Date().toISOString() });
ok(`recorded this clone in ~/.codex-gemini-mcp/install.json`);

// ---------------------------------------------------------------- 2. What is on this machine

step('Checking the tools the servers drive');
if (!DRY) {
  const codex = await import(pathToFileURL(SERVERS.codex).href);
  const { findAgy } = await import(pathToFileURL(path.join(ROOT, 'packages', 'gemini-mcp', 'agy.mjs')).href);
  const { findChrome } = await import(pathToFileURL(path.join(ROOT, 'packages', 'gemini-mcp', 'browser.mjs')).href);
  const codexPath = codex.findCodex();
  const t = codex.toolbox();
  const report = (label, found, hint) => (found ? ok(`${label}: ${found}`) : warn(`${label}: not found — ${hint}`));
  report('Codex CLI', codexPath !== 'codex' || which('codex') ? codexPath : null, 'install the Codex app or `npm i -g @openai/codex`, then sign in (codex login)');
  report('Antigravity CLI (agy, for gemini_ask)', findAgy(), 'install Antigravity and sign in (optional; only gemini_ask needs it)');
  report('Google Chrome (for Gemini images/video/music)', findChrome(), 'install Google Chrome');
  report('ffmpeg (video, previews)', t.ffmpeg, 'install ffmpeg (winget install Gyan.FFmpeg / brew install ffmpeg / apt install ffmpeg)');
  report('Blender (3D)', t.blender, 'install Blender for generate_3d');
} else info('skipped in --dry-run');

// ---------------------------------------------------------------- 3. Claude Code

if (!args.has('--no-claude')) {
  step('Registering the MCP servers in Claude Code (user scope)');
  const claude = which('claude');
  if (!claude) warn('Claude Code CLI not found. Add the servers yourself: claude mcp add --scope user codex -- node <path>/packages/codex-mcp/server.mjs');
  else {
    for (const [name, server] of Object.entries(SERVERS)) {
      const existing = DRY ? { status: 1 } : run(claude, ['mcp', 'get', name], { capture: true });
      if (existing.status === 0) {
        const sameServer = String(existing.stdout).includes(server);
        sameServer ? ok(`${name}: already registered`) : warn(`${name}: a server with this name already exists; left as is. Remove it first (claude mcp remove ${name} -s user) to use this one.`);
        continue;
      }
      const r = run(claude, ['mcp', 'add', '--scope', 'user', name, '--', process.execPath, server]);
      r.status ? warn(`${name}: claude mcp add failed`) : ok(`${name} registered`);
    }
  }
}

// ---------------------------------------------------------------- 4. Antigravity

if (args.has('--antigravity')) {
  step('Adding the MCP servers to Antigravity');
  const file = path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
  let conf = {};
  try { const raw = fs.readFileSync(file, 'utf8').trim(); conf = raw ? JSON.parse(raw) : {}; } catch (e) { if (e.code !== 'ENOENT') { warn(`could not read ${file}: ${e.message}`); conf = null; } }
  if (conf) {
    conf.mcpServers ||= {};
    for (const [name, server] of Object.entries(SERVERS)) {
      if (conf.mcpServers[name]) { ok(`${name}: already in mcp_config.json`); continue; }
      conf.mcpServers[name] = { command: process.execPath, args: [server], env: {} };
      ok(`${name} added`);
    }
    writeJson(file, conf);
    info('In Antigravity: agent panel … → MCP Servers → Manage → Refresh (or restart Antigravity).');
  }
}

// ---------------------------------------------------------------- 5. Panel

if (!args.has('--no-panel')) {
  step('Building and installing the Codex · Gemini panel');
  const vsix = path.join(ROOT, 'dist', 'codex-gemini-panel.vsix');
  if (!DRY) fs.mkdirSync(path.dirname(vsix), { recursive: true });
  const npx = which('npx');
  const built = run(npx, ['-y', '@vscode/vsce@3.9.2', 'package', '--no-dependencies', '-o', vsix], { cwd: path.join(ROOT, 'packages', 'vscode-panel') });
  if (built.status) warn('packaging the panel failed');
  else {
    ok(`packaged ${path.relative(ROOT, vsix)}`);
    const local = process.env.LOCALAPPDATA || '';
    const editors = [
      ['VS Code', which('code')],
      ['Antigravity', which('antigravity-ide') || (IS_WIN ? [path.join(local, 'Programs', 'Antigravity IDE', 'bin', 'antigravity-ide.cmd')].find((p) => fs.existsSync(p)) : null)],
      ['Cursor', which('cursor')],
    ].filter(([, cli]) => cli);
    if (!editors.length) warn(`no editor CLI found; install ${path.relative(ROOT, vsix)} with "Extensions: Install from VSIX…"`);
    for (const [label, cli] of editors) {
      const r = run(cli, ['--install-extension', vsix, '--force'], { capture: true });
      r.status ? warn(`${label}: install failed`) : ok(`${label}: installed (reload the window to see it)`);
    }
  }
}

// ---------------------------------------------------------------- next steps

step('Next steps');
console.log(`  1. Sign in to Codex once if you have not:        ${c.bold('codex login')}  (or open the Codex app)`);
console.log(`  2. Sign in to Gemini once (opens a window):      ${c.bold('npm run gemini:signin')}`);
console.log(`  3. Restart Claude Code, then ask for an image, a video or a 3D model.`);
console.log('');
