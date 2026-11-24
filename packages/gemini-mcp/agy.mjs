// Text side: the Antigravity CLI (agy) in print mode. It runs on the Google account signed in to
// Antigravity, so it uses the Google AI Pro quota with no API key.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STATE_DIR } from './browser.mjs';

const isFile = (p) => { try { return !!p && fs.statSync(p).isFile(); } catch { return false; } };

export function findAgy() {
  if (isFile(process.env.AGY_PATH)) return process.env.AGY_PATH;
  const local = path.join(os.homedir(), '.gemini', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');
  if (isFile(local)) return local;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const d of (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const e of exts) { const p = path.join(d, 'agy' + e); if (isFile(p)) return p; }
  }
  return null;
}

/**
 * Run one agy turn.
 * access: 'read-only' (plan mode + sandbox: no commands, no file writes) or 'edit' (may edit files in cwd).
 */
export function runAgy({ prompt, cwd, access = 'read-only', model, effort, conversationId, addDirs = [], timeoutSec = 900, onSpawn }) {
  const agy = findAgy();
  if (!agy) return Promise.reject(new Error('Antigravity CLI (agy) not found. Install Antigravity or set AGY_PATH.'));
  const work = cwd || path.join(STATE_DIR, 'agy-work');
  fs.mkdirSync(work, { recursive: true });
  const args = [`--print=${prompt}`, '--output-format', 'json', '--print-timeout', `${timeoutSec}s`, '--sandbox'];
  if (access === 'read-only') args.push('--mode', 'plan');
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (conversationId) args.push('--conversation', conversationId);
  for (const d of addDirs) args.push('--add-dir', d);

  return new Promise((resolve, reject) => {
    const child = spawn(agy, args, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    onSpawn?.(child);
    let out = '', err = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('error', reject);
    child.on('close', (code) => {
      const start = out.indexOf('{');
      let j = null;
      try { j = JSON.parse(out.slice(start)); } catch {}
      if (!j) return reject(new Error(`agy exited with code ${code} and no JSON result.\n${(err || out).slice(-1500)}`));
      resolve({ ...j, notes: out.slice(0, Math.max(0, start)).trim() || null, code });
    });
  });
}

export async function listAgyModels() {
  const agy = findAgy();
  if (!agy) return [];
  return new Promise((resolve) => {
    const child = spawn(agy, ['models'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
    child.on('close', () => resolve(out.split(/\r?\n/).map((l) => l.split('\t')).filter((p) => p.length === 2).map(([id, name]) => ({ id: id.trim(), name: name.trim() }))));
    child.on('error', () => resolve([]));
  });
}
