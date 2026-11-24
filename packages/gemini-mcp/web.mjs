// Media side: drives gemini.google.com (English UI) in the dedicated Chrome profile.
// Each job works in its own tab. Clicks and typing are serialised through one UI lock;
// the long wait for a generation runs outside the lock, so jobs can overlap.
import fs from 'node:fs';
import path from 'node:path';
import { getBrowser, getContext, STATE_DIR } from './browser.mjs';

export const APP_URL = 'https://gemini.google.com/app?hl=en';
const DL_DIR = path.join(STATE_DIR, 'downloads');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- UI lock

// In-process chain plus a lock directory, because Claude Code and Antigravity each run their own
// server process against the same Chrome (and browser-wide download events).
const LOCK_DIR = path.join(STATE_DIR, 'ui.lock');
async function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(LOCK_DIR); return; } catch {}
    try { if (Date.now() - fs.statSync(LOCK_DIR).mtimeMs > 120000) fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch {}
    await sleep(250);
  }
}
const releaseLock = () => { try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch {} };
process.on('exit', releaseLock);

let chain = Promise.resolve();
export function withUI(fn) {
  const run = chain.then(async () => {
    await acquireLock();
    try { return await fn(); } finally { releaseLock(); }
  });
  chain = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------- pages

export function withHl(url) {
  const u = new URL(url);
  u.searchParams.set('hl', 'en');
  return u.toString();
}

export async function openPage(url = APP_URL) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  await page.goto(withHl(url), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await ensureReady(page);
  return page;
}

export async function signedInState(page) {
  return page.evaluate(() => {
    const signIn = [...document.querySelectorAll('a, button')].some((e) => /^sign in$/i.test((e.innerText || '').trim()) && e.getBoundingClientRect().width > 0);
    const editor = !!document.querySelector('.ql-editor[contenteditable=true]');
    return { signedIn: !signIn && editor, editor, url: location.href };
  });
}

async function ensureReady(page) {
  if (/accounts\.google\.com/.test(page.url())) throw new NotSignedIn();
  try {
    await page.locator('.ql-editor[contenteditable=true]').first().waitFor({ timeout: 30000 });
  } catch {
    const st = await signedInState(page).catch(() => ({}));
    if (!st.signedIn) throw new NotSignedIn();
    throw new Error('Gemini page did not load its prompt box.');
  }
  const st = await signedInState(page);
  if (!st.signedIn) throw new NotSignedIn();
  await dismissDialogs(page);
}

export class NotSignedIn extends Error {
  constructor() { super('The Gemini Chrome profile is not signed in. Call gemini_status with open_window=true and sign in with the Google AI Pro account.'); }
}

// First-run intros, promos and "what's new" bubbles.
export async function dismissDialogs(page) {
  for (let i = 0; i < 4; i++) {
    const clicked = await page.evaluate(() => {
      const ok = /^(Try it|Got it|Not now|No thanks|Dismiss|Close|OK|Continue|Skip|Maybe later)$/i;
      const roots = [...document.querySelectorAll('mat-dialog-container, [role=dialog], [role=alertdialog], .cdk-overlay-pane')];
      for (const r of roots) {
        const b = [...r.querySelectorAll('button')].find((x) => ok.test((x.innerText || x.getAttribute('aria-label') || '').trim()) && x.getBoundingClientRect().width > 0);
        if (b) { b.click(); return true; }
      }
      const bubble = [...document.querySelectorAll('button')].find((x) => /^(Not now|No thanks)$/i.test((x.innerText || '').trim()) && x.getBoundingClientRect().width > 0);
      if (bubble) { bubble.click(); return true; }
      return false;
    });
    if (!clicked) return;
    await sleep(600);
  }
}

// ---------------------------------------------------------------- composer

async function openToolsMenu(page) {
  const btn = page.getByRole('button', { name: /Upload & tools/i }).first();
  await btn.waitFor({ timeout: 15000 });
  for (let attempt = 0; attempt < 3; attempt++) {
    await btn.click();
    // Wait for this menu's own first item; other (hidden) role=menu elements exist on the page.
    try { await page.getByRole('menuitem', { name: /^Upload files/i }).first().waitFor({ timeout: 4000 }); await sleep(400); return; } catch {
      await page.keyboard.press('Escape');
      await sleep(600);
      await dismissDialogs(page);
    }
  }
  throw new Error('The Upload & tools menu did not open.');
}

const TOOL_CHIP = { 'Create image': /Deselect Images?/i, 'Create video': /Deselect Videos?/i, 'Create music': /Deselect Music/i };

export async function selectTool(page, tool) {
  const chip = TOOL_CHIP[tool];
  if (chip && (await page.getByRole('button', { name: chip }).count())) return;
  await openToolsMenu(page);
  let item = page.getByRole('menuitemcheckbox', { name: new RegExp(`^${tool}$`, 'i') });
  try { await item.first().waitFor({ timeout: 2000 }); } catch {}
  if (!(await item.count())) {
    const more = page.getByRole('menuitem', { name: /More tools/i });
    if (await more.count()) { await more.first().click(); await sleep(600); }
    item = page.getByRole('menuitemcheckbox', { name: new RegExp(`^${tool}$`, 'i') });
  }
  if (!(await item.count())) { await page.keyboard.press('Escape'); throw new Error(`Gemini tool "${tool}" not found in the Upload & tools menu.`); }
  await item.first().click();
  await sleep(1000);
  await dismissDialogs(page);
  if (chip) {
    try { await page.getByRole('button', { name: chip }).first().waitFor({ timeout: 8000 }); } catch {
      await dismissDialogs(page);
      if (!(await page.getByRole('button', { name: chip }).count())) throw new Error(`Could not switch on "${tool}".`);
    }
  }
}

// Option menus under the prompt box (Aspect ratio, Format). Matched by aria-label or text.
export async function setOption(page, which, choice) {
  if (!choice) return;
  const btn = page.locator('button.mat-mdc-menu-trigger.mdc-button--outlined').filter({ hasText: which })
    .or(page.locator(`button.mat-mdc-menu-trigger.mdc-button--outlined[aria-label^="${which}"]`));
  if (!(await btn.count())) throw new Error(`Option "${which}" not found.`);
  await btn.first().click();
  await sleep(700);
  const opts = page.getByRole('menuitemradio');
  const texts = (await opts.allInnerTexts()).map((s) => s.replace(/\s+/g, ' ').trim());
  const idx = texts.findIndex((t) => t.toLowerCase().includes(String(choice).toLowerCase()));
  if (idx < 0) { await page.keyboard.press('Escape'); throw new Error(`"${choice}" is not a ${which} option. Options: ${texts.join(', ')}`); }
  await opts.nth(idx).click();
  await sleep(500);
}

// Mode picker: models (Auto / Hydrogen / Neon / Carbon) and thinking level (Low / Medium / High).
// The choice is sticky for the account, so callers read it first and restore it afterwards.
const MODE_ITEMS = '[role=menuitemradio]:visible';
const THINKING = ['Low', 'Medium', 'High'];

async function openModeMenu(page) {
  const trigger = page.locator('[data-test-id="bard-mode-menu-button"]').first();
  try { await trigger.waitFor({ timeout: 15000 }); } catch { throw new Error('Mode picker not found.'); }
  // aria-expanded can stay "true" after a submenu pick, so only trust it on the first attempt.
  for (let attempt = 0; attempt < 4; attempt++) {
    const expanded = (await trigger.getAttribute('aria-expanded')) === 'true';
    if (!expanded || attempt > 0) await trigger.click();
    try { await page.locator(MODE_ITEMS).first().waitFor({ timeout: 2500 }); break; } catch {
      await page.keyboard.press('Escape');
      await sleep(500);
    }
  }
  await sleep(300);
  const items = page.locator(MODE_ITEMS);
  const meta = await items.evaluateAll((es) => es.map((e) => ({ text: (e.innerText || '').replace(/\s+/g, ' ').trim(), checked: e.getAttribute('aria-checked') === 'true' })));
  return { items, meta };
}

async function closeMenus(page) {
  for (let i = 0; i < 3 && (await page.locator('.cdk-overlay-container [role=menu]:visible').count()); i++) {
    await page.keyboard.press('Escape');
    await sleep(350);
  }
}

const isThinking = (t) => THINKING.some((w) => t.startsWith(w + ' ') || t === w);

// "Thinking level" is a submenu of the mode picker. Returns null when the current mode has none.
async function openThinkingMenu(page) {
  await openModeMenu(page);
  const trig = page.locator('[role=menuitem]:visible').filter({ hasText: 'Thinking level' });
  if (!(await trig.count())) return null;
  // textContent includes icon ligatures (e.g. a check mark), so match the words without anchoring.
  const radios = () => page.locator(MODE_ITEMS).filter({ hasText: /\b(Low|Medium|High)\b/ });
  await trig.first().hover();
  try { await radios().first().waitFor({ timeout: 2500 }); } catch {
    await trig.first().click();
    try { await radios().first().waitFor({ timeout: 2500 }); } catch { return null; }
  }
  const items = radios();
  const meta = await items.evaluateAll((es) => es.map((e) => ({ text: (e.innerText || '').replace(/\s+/g, ' ').trim(), checked: e.getAttribute('aria-checked') === 'true' })));
  return { items, meta };
}

export async function getModeState(page) {
  const { meta } = await openModeMenu(page);
  const modeItem = meta.find((m) => m.checked && !isThinking(m.text));
  const th = await openThinkingMenu(page);
  await closeMenus(page);
  return { mode: modeItem?.text.split(' ').pop() || null, thinking: th?.meta.find((m) => m.checked)?.text.split(' ')[0] || null };
}

export async function setMode(page, { mode, thinking } = {}) {
  if (mode) {
    const want = mode.toLowerCase() === 'karbon' ? 'carbon' : mode.toLowerCase();
    const { items, meta } = await openModeMenu(page);
    const idx = meta.findIndex((m) => !isThinking(m.text) && (m.text.toLowerCase().split(' ').pop() === want || m.text.toLowerCase().startsWith(want)));
    if (idx < 0) { await closeMenus(page); throw new Error(`Mode "${mode}" not found. Modes: ${meta.map((m) => m.text).join(' | ')}`); }
    if (!meta[idx].checked) {
      await items.nth(idx).click();
      await sleep(1200);
      const upsell = await page.evaluate(() => /\bUpgrade\b/.test(document.querySelector('.cdk-overlay-container')?.innerText || ''));
      if (upsell) { await dismissDialogs(page); await closeMenus(page); throw new Error(`Mode "${mode}" is not included in this Google AI plan (Gemini offered an upgrade).`); }
    }
    await closeMenus(page);
  }
  if (thinking) {
    const want = thinking[0].toUpperCase() + thinking.slice(1).toLowerCase();
    const th = await openThinkingMenu(page);
    const idx = th ? th.meta.findIndex((m) => m.text.startsWith(want)) : -1;
    if (idx < 0) { await closeMenus(page); throw new Error('Thinking level is not available for the selected mode.'); }
    if (!th.meta[idx].checked) { await th.items.nth(idx).click(); await sleep(600); }
    await closeMenus(page);
  }
}

export async function attachFiles(page, files) {
  if (!files?.length) return;
  const before = await page.locator('uploader-file-preview, .file-preview-container img, [data-test-id*=file-preview]').count();
  await openToolsMenu(page);
  const chooser = page.waitForEvent('filechooser', { timeout: 15000 });
  await page.getByRole('menuitem', { name: /^Upload files/i }).first().click();
  const fc = await chooser;
  await fc.setFiles(files);
  // Wait until previews appear and finish uploading.
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const st = await page.evaluate(() => ({
      previews: document.querySelectorAll('uploader-file-preview, .file-preview-container img, [data-test-id*=file-preview]').length,
      loading: !!document.querySelector('uploader-file-preview mat-progress-spinner, uploader-file-preview .loading, [role=progressbar]'),
    }));
    if (st.previews >= before + files.length && !st.loading) return;
  }
}

export async function sendPrompt(page, prompt) {
  const input = page.locator('.ql-editor[contenteditable=true]').first();
  await input.click();
  await input.fill(prompt);
  await sleep(400);
  const send = page.getByRole('button', { name: /^Send message$/i });
  for (let i = 0; i < 30 && !(await send.isEnabled().catch(() => false)); i++) await sleep(500);
  const count = await page.locator('model-response').count();
  await send.first().click();
  return count; // number of responses before this turn
}

// ---------------------------------------------------------------- reading results

export async function responseState(page, prevCount) {
  return page.evaluate((prev) => {
    const all = [...document.querySelectorAll('model-response')];
    const resp = all.length > prev ? all[all.length - 1] : null;
    const busy = !!document.querySelector('button[aria-label="Stop response"]');
    if (!resp) return { exists: false, busy };
    const labels = [...resp.querySelectorAll('button')].map((b) => (b.getAttribute('aria-label') || '').trim()).filter(Boolean);
    const content = resp.querySelector('message-content') || resp;
    return {
      exists: true,
      busy,
      done: labels.some((l) => /^(Good response|Bad response)$/i.test(l)),
      images: [...resp.querySelectorAll('img')].filter((i) => i.naturalWidth >= 256).length,
      videos: resp.querySelectorAll('video').length,
      audios: resp.querySelectorAll('audio').length,
      downloads: labels.filter((l) => /download/i.test(l)),
      labels,
      text: (content.innerText || '').replace(/^Gemini said\s*/i, '').trim(),
    };
  }, prevCount);
}

// Which download buttons belong to the media (a text answer can carry its own download buttons).
export const DOWNLOAD_LABEL = { image: /image/i, video: /video|download$/i, music: /track|audio|music/i };

/** Wait until the new response has media of the wanted kind with a download button, or ends without it. */
export async function waitForMedia(page, prevCount, kind, { timeoutSec = 900, onTick } = {}) {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastText = '', textSince = Date.now();
  while (Date.now() < deadline) {
    await sleep(2500);
    const st = await responseState(page, prevCount);
    onTick?.(st);
    if (!st.exists) continue;
    const dl = st.downloads.filter((l) => DOWNLOAD_LABEL[kind].test(l));
    const has = kind === 'image' ? st.images > 0 : kind === 'video' ? st.videos > 0 : st.audios + st.videos > 0;
    if (has && dl.length && !st.busy) return st;
    if (st.text !== lastText) { lastText = st.text; textSince = Date.now(); }
    // Finished as plain text (refusal, quota message, question back): stable text, action bar, nothing generating.
    const generating = /generating|creating|being made|in progress|few minutes|hang tight/i.test(st.text);
    if (st.done && !st.busy && !has && !generating && Date.now() - textSince > 12000) {
      const e = new Error(`Gemini answered without a ${kind}:\n${st.text || '(empty response)'}`);
      e.geminiText = st.text;
      throw e;
    }
  }
  throw new Error(`Timed out after ${timeoutSec}s waiting for the ${kind}.`);
}

export async function lastResponseText(page) {
  const st = await responseState(page, 0);
  return st.text;
}

// ---------------------------------------------------------------- downloads

let dl = null; // { session, pendingBegin, waiters, finished }

async function downloads() {
  if (dl) return dl;
  fs.mkdirSync(DL_DIR, { recursive: true });
  const browser = await getBrowser();
  const session = await browser.newBrowserCDPSession();
  await session.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: DL_DIR, eventsEnabled: true });
  const state = { session, pendingBegin: null, waiters: new Map(), finished: new Map() };
  session.on('Browser.downloadWillBegin', (e) => { const p = state.pendingBegin; state.pendingBegin = null; p?.(e); });
  session.on('Browser.downloadProgress', (e) => {
    if (e.state === 'inProgress') return;
    const w = state.waiters.get(e.guid);
    if (w) { state.waiters.delete(e.guid); w(e); } else state.finished.set(e.guid, e);
  });
  browser.once('disconnected', () => { dl = null; });
  dl = state;
  return dl;
}

/** Click something that starts a browser download and move the file to dest (extension taken from Gemini's file name). Call inside withUI. */
export async function downloadVia(click, destNoExt, { timeoutSec = 180 } = {}) {
  const d = await downloads();
  const begin = new Promise((res, rej) => {
    d.pendingBegin = res;
    setTimeout(() => { if (d.pendingBegin === res) { d.pendingBegin = null; rej(new Error('Download did not start.')); } }, 30000);
  });
  await click();
  const info = await begin;
  const prog = d.finished.get(info.guid) || await new Promise((res, rej) => {
    d.waiters.set(info.guid, res);
    setTimeout(() => { if (d.waiters.delete(info.guid)) rej(new Error('Download timed out.')); }, timeoutSec * 1000);
  });
  d.finished.delete(info.guid);
  if (prog.state !== 'completed') throw new Error(`Download ${prog.state}.`);
  const ext = path.extname(info.suggestedFilename || '') || '';
  let dest = destNoExt + ext.toLowerCase(), n = 2;
  while (fs.existsSync(dest)) dest = `${destNoExt}-v${n++}${ext.toLowerCase()}`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(DL_DIR, info.guid), dest);
  fs.rmSync(path.join(DL_DIR, info.guid), { force: true });
  return { path: dest, name: info.suggestedFilename, bytes: prog.receivedBytes };
}
