// Chrome for the Gemini web app, with its own profile and a localhost DevTools port.
// By default it runs headless: no window, no taskbar entry, no focus stealing. A visible window is
// only opened for signing in (gemini_status open_window=true), and the next call goes back to headless.
// Chrome is started as a normal process (no automation flags) and playwright-core attaches over CDP.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

export const STATE_DIR = process.env.GEMINI_MCP_HOME || path.join(os.homedir(), '.gemini-mcp');
export const PROFILE_DIR = path.join(STATE_DIR, 'chrome-profile');
export const CDP_PORT = Number(process.env.GEMINI_MCP_CDP_PORT || 9339);
export const GEMINI_URL = 'https://gemini.google.com/app';
export const HEADLESS = process.env.GEMINI_MCP_HEADLESS !== '0';
const MODE_FILE = path.join(STATE_DIR, 'chrome-mode.json');

const isFile = (p) => { try { return !!p && fs.statSync(p).isFile(); } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
  if (isFile(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
  return candidates.find(isFile) || null;
}

// Headless Chrome announces itself as "HeadlessChrome"; present the normal desktop user agent instead.
function desktopUserAgent(chrome) {
  let major = '157';
  try {
    const v = fs.readdirSync(path.dirname(chrome)).filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d)).sort().pop();
    if (v) major = v.split('.')[0];
  } catch {}
  const platform = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
    : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

async function cdpAlive() {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

const readMode = () => { try { return JSON.parse(fs.readFileSync(MODE_FILE, 'utf8')); } catch { return null; } };

export async function closeChrome() {
  if (!(await cdpAlive())) return;
  try {
    const b = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const s = await b.newBrowserCDPSession();
    await s.send('Browser.close').catch(() => {});
  } catch {}
  for (let i = 0; i < 40 && (await cdpAlive()); i++) await sleep(250);
  await sleep(800); // let Chrome release the profile lock
  _browser = null;
}

/** Make sure our Chrome runs in the wanted mode. Returns true when it (re)started Chrome. */
export async function launchChrome({ headless = HEADLESS, url = GEMINI_URL } = {}) {
  if (await cdpAlive()) {
    const running = readMode() || { headless: false }; // unknown instance: treat as visible
    if (running.headless === headless) return false;
    await closeChrome();
  }
  const chrome = findChrome();
  if (!chrome) throw new Error('Google Chrome not found. Set CHROME_PATH.');
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const args = [
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ];
  if (headless) args.push('--headless=new', `--user-agent=${desktopUserAgent(chrome)}`, '--window-size=1920,1080', '--mute-audio');
  else args.push('--window-size=1280,900');
  args.push(url);
  const child = spawn(chrome, args, { detached: true, stdio: 'ignore', windowsHide: headless });
  child.unref();
  fs.writeFileSync(MODE_FILE, JSON.stringify({ headless, pid: child.pid, started: new Date().toISOString() }));
  for (let i = 0; i < 60; i++) {
    if (await cdpAlive()) return true;
    await sleep(500);
  }
  throw new Error(`Chrome started but its DevTools port ${CDP_PORT} did not open.`);
}

let _browser = null;
export async function getBrowser({ headless = HEADLESS } = {}) {
  const restarted = await launchChrome({ headless });
  if (!restarted && _browser?.isConnected()) return _browser;
  _browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  _browser.on('disconnected', () => { _browser = null; });
  return _browser;
}

export async function getContext(opts) {
  const b = await getBrowser(opts);
  return b.contexts()[0] || (await b.newContext());
}
