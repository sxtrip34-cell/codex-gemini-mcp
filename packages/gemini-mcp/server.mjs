#!/usr/bin/env node
// gemini-mcp — Google Gemini on a Google AI Pro account, no API key.
//   gemini_ask    text, code, analysis, web search through the Antigravity CLI (agy)
//   gemini_chat   the Gemini web app's own chat models (Hydrogen / Neon / Karbon)
//   gemini_image  Nano Banana images from the Gemini web app
//   gemini_video  Veo videos from the Gemini web app
//   gemini_music  music from the Gemini web app
//   gemini_status sign-in check, opens the Chrome window
//   gemini_job    wait for / list / cancel jobs
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAgy, listAgyModels, runAgy } from './agy.mjs';
import { CDP_PORT, HEADLESS, PROFILE_DIR, getContext, launchChrome } from './browser.mjs';
import {
  APP_URL, DOWNLOAD_LABEL, NotSignedIn, attachFiles, downloadVia, getModeState, openPage, responseState, selectTool, sendPrompt,
  setMode, setOption, signedInState, waitForMedia, withHl, withUI,
} from './web.mjs';

const VERSION = '1.0.0';
const IS_WIN = process.platform === 'win32';
const DEFAULT_OUT = process.env.GEMINI_MCP_OUTPUT_DIR || path.join(os.homedir(), 'Pictures', 'Gemini');
const WAIT_DEFAULT = Number(process.env.GEMINI_MCP_WAIT_SECONDS || 280);
const log = (...a) => process.stderr.write(`[gemini-mcp] ${a.join(' ')}\n`);

// ---------------------------------------------------------------- helpers

const isFile = (p) => { try { return !!p && fs.statSync(p).isFile(); } catch { return false; } };
const text = (t, extra = []) => ({ content: [{ type: 'text', text: t }, ...extra] });
const fail = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
const short = (s, n = 140) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function normPath(p) {
  if (!p) return p;
  p = String(p).trim().replace(/^["']|["']$/g, '');
  if (IS_WIN) { const m = p.match(/^\/([a-zA-Z])(\/.*)?$/); if (m) p = `${m[1].toUpperCase()}:${(m[2] || '/').replace(/\//g, '\\')}`; }
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}
const outDirOf = (a) => { const d = normPath(a.output_dir || DEFAULT_OUT); fs.mkdirSync(d, { recursive: true }); return d; };
function files(list, label) {
  return (list || []).map((p) => { const abs = normPath(p); if (!isFile(abs)) throw new Error(`${label} not found: ${p}`); return abs; });
}
function baseName(filename, prompt, fallback) {
  if (filename) { const b = path.basename(String(filename)).replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim(); if (b) return b; }
  // Strip accents (ö→o, ş→s, ğ→g; ı has no decomposition) so Turkish prompts give readable names.
  const s = String(prompt || '').toLowerCase().replace(/ı/g, 'i').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 6).join('-').slice(0, 48);
  return s || fallback;
}
const sizeOf = (p) => { try { const b = fs.statSync(p).size; return b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`; } catch { return '?'; } };

function which(cmd) {
  const exts = IS_WIN ? ['.exe', '.cmd', ''] : [''];
  for (const d of (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)) for (const e of exts) { const p = path.join(d, cmd + e); if (isFile(p)) return p; }
  return null;
}
let _ff;
function ffmpeg() {
  if (_ff !== undefined) return _ff;
  _ff = isFile(process.env.FFMPEG_PATH) ? process.env.FFMPEG_PATH : which('ffmpeg');
  if (!_ff && IS_WIN) {
    const pkgs = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const d of fs.readdirSync(pkgs).filter((d) => /ffmpeg/i.test(d))) for (const sub of fs.readdirSync(path.join(pkgs, d))) {
        const p = path.join(pkgs, d, sub, 'bin', 'ffmpeg.exe'); if (isFile(p)) { _ff = p; break; }
      }
    } catch {}
  }
  return (_ff ||= null);
}
function preview(file, at) {
  const ff = ffmpeg();
  if (!ff || !isFile(file)) return null;
  const out = path.join(os.tmpdir(), `gemini-mcp-prev-${crypto.randomUUID()}.jpg`);
  try {
    execFileSync(ff, ['-y', '-loglevel', 'error', ...(at != null ? ['-ss', String(at)] : []), '-i', file, '-frames:v', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease', '-q:v', '4', out], { timeout: 60000, stdio: 'ignore', windowsHide: true });
    const data = fs.readFileSync(out).toString('base64');
    fs.rmSync(out, { force: true });
    return { type: 'image', data, mimeType: 'image/jpeg' };
  } catch { return null; }
}
function probe(file) {
  const ff = ffmpeg();
  const fp = ff && path.join(path.dirname(ff), IS_WIN ? 'ffprobe.exe' : 'ffprobe');
  if (!isFile(fp)) return null;
  try {
    const j = JSON.parse(execFileSync(fp, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8', timeout: 30000, windowsHide: true }));
    const v = (j.streams || []).find((s) => s.codec_type === 'video');
    return { duration: Number(Number(j.format?.duration || 0).toFixed(2)), width: v?.width, height: v?.height, audio: (j.streams || []).some((s) => s.codec_type === 'audio') };
  } catch { return null; }
}

// ---------------------------------------------------------------- jobs

const jobs = new Map();
function startJob(kind, summary, fn) {
  const id = `${kind}-${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  const job = { id, kind, summary: short(summary, 100), status: 'running', startedAt: Date.now(), activity: 'queued', result: null, cancel: null };
  job.promise = Promise.resolve().then(() => fn(job))
    .then((r) => { job.status = job.status === 'cancelled' ? 'cancelled' : r.isError ? 'failed' : 'done'; job.result = r; return r; },
      (e) => { job.status = job.status === 'cancelled' ? 'cancelled' : 'failed'; job.result = fail(e instanceof NotSignedIn ? e.message : `${kind} failed: ${e.message}`); return job.result; })
    .finally(() => { job.endedAt = Date.now(); });
  jobs.set(id, job);
  for (const [k, j] of jobs) if (jobs.size > 100 && j.status !== 'running') jobs.delete(k);
  return job;
}
async function awaitJob(job, waitSec, extra, token) {
  const wait = Math.max(0, Math.min(Number.isFinite(+waitSec) ? +waitSec : WAIT_DEFAULT, 3600));
  let timer, ticker, n = 0;
  if (token !== undefined && extra?.sendNotification) {
    ticker = setInterval(() => extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++n, message: `${job.kind}: ${job.activity}` } }).catch(() => {}), 10000);
  }
  try {
    const r = await Promise.race([job.promise, new Promise((res) => { timer = setTimeout(() => res(null), wait * 1000); })]);
    if (r) return r;
    return text(`Still running (${Math.round((Date.now() - job.startedAt) / 1000)}s so far). job_id: ${job.id}\nLatest activity: ${job.activity}\nIt keeps running in the background. Call gemini_job with this job_id to wait for the result.`);
  } finally { clearTimeout(timer); clearInterval(ticker); }
}

// ---------------------------------------------------------------- web media jobs

/**
 * Shared flow for image / video / music: open a tab (new chat or chat_url), pick the tool, set options,
 * attach files, send, wait, download every result in the new response.
 */
// Some download buttons open a small menu (music: "Video – audio with cover art" / "Audio only – MP3").
async function clickDownload(page, button, pick) {
  await button.click();
  const items = page.locator('[role=menu]:visible [role=menuitem]');
  try { await items.first().waitFor({ timeout: 1500 }); } catch { return; } // started directly
  const texts = (await items.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  const idx = texts.findIndex((t) => pick.test(t));
  await items.nth(idx >= 0 ? idx : 0).click();
}

function mediaJob(kind, a, { tool, options, timeoutSec, fallbackName, pick = /./ }) {
  if (!a.prompt) throw new Error('prompt is required');
  const outDir = outDirOf(a);
  const refs = files(a.reference_images, 'reference image');
  const base = baseName(a.filename, a.prompt, fallbackName);
  return startJob(kind, a.prompt, async (job) => {
    let page;
    job.cancel = () => page?.close().catch(() => {});
    try {
      job.activity = 'opening Gemini';
      const prev = await withUI(async () => {
        page = await openPage(a.chat_url || APP_URL);
        job.activity = `selecting ${tool}`;
        await selectTool(page, tool);
        for (const [which, choice] of options) await setOption(page, which, choice);
        if (refs.length) { job.activity = 'uploading reference files'; await attachFiles(page, refs); }
        job.activity = 'sending prompt';
        return sendPrompt(page, a.prompt);
      });
      job.activity = `waiting for the ${kind}`;
      const t0 = Date.now();
      const chatLink = () => page.url().replace(/[?&]hl=en\b/, '');
      let st, saved;
      try {
        st = await waitForMedia(page, prev, kind, {
          timeoutSec,
          onTick: (s) => { job.activity = `waiting for the ${kind} (${Math.round((Date.now() - t0) / 1000)}s)${s.text ? ': ' + short(s.text, 80) : ''}`; },
        });
        job.activity = 'downloading';
        saved = await withUI(async () => {
          const resp = page.locator('model-response').nth(prev);
          const btns = resp.locator('button[aria-label*="ownload"]').filter({ visible: true }).and(resp.getByRole('button', { name: DOWNLOAD_LABEL[kind] }));
          const n = await btns.count();
          const out = [];
          for (let i = 0; i < n; i++) {
            const dest = path.join(outDir, n > 1 ? `${base}-${i + 1}` : base);
            out.push(await downloadVia(() => clickDownload(page, btns.nth(i), pick), dest));
          }
          return out;
        });
      } catch (e) {
        e.message += `\nchat_url: ${chatLink()}`;
        throw e;
      }
      const chatUrl = chatLink();
      if (!saved.length) return fail(`Gemini made the ${kind} but no download button was found.\nchat: ${chatUrl}`);
      const previews = a.preview === false ? [] : saved.slice(0, 4).map((s) => {
        if (kind === 'video') { const info = probe(s.path); s.info = info; return preview(s.path, info?.duration ? info.duration / 2 : 1); }
        if (kind === 'image') return preview(s.path);
        return null;
      }).filter(Boolean);
      const lines = [`Saved ${saved.length} file(s):`];
      for (const s of saved) lines.push(`- ${s.path} (${sizeOf(s.path)})${s.info ? ` ${s.info.width}x${s.info.height}, ${s.info.duration}s${s.info.audio ? ', with audio' : ''}` : ''}`);
      lines.push(`chat_url: ${chatUrl} (pass to the same tool to refine in this chat)`);
      if (st.text) lines.push(`Gemini: ${short(st.text, 400)}`);
      return text(lines.join('\n'), previews);
    } finally {
      if (page && a.keep_tab !== true) await page.close().catch(() => {});
    }
  });
}

const IMAGE_ASPECTS = ['1:1', '9:16', '3:4', '4:3', '16:9'];

function geminiImage(a) {
  if (a.aspect && !IMAGE_ASPECTS.includes(a.aspect)) throw new Error(`aspect must be one of ${IMAGE_ASPECTS.join(', ')}`);
  return mediaJob('image', a, {
    tool: 'Create image',
    options: [['Aspect ratio', a.aspect], ['Format', a.format === 'gif' ? 'GIF' : a.format === 'image' ? 'Image' : null]],
    timeoutSec: 300,
    fallbackName: 'gemini-image',
  });
}

function geminiVideo(a) {
  const aspect = a.aspect === 'portrait' ? 'Portrait' : a.aspect === 'landscape' ? 'Landscape' : null;
  return mediaJob('video', a, {
    tool: 'Create video',
    options: [['Aspect ratio', aspect], ['Format', a.format === 'gif' ? 'GIF' : a.format === 'video' ? 'Video' : null]],
    timeoutSec: 900,
    fallbackName: 'gemini-video',
  });
}

function geminiMusic(a) {
  return mediaJob('music', a, {
    tool: 'Create music', options: [], timeoutSec: 600, fallbackName: 'gemini-music',
    pick: a.format === 'video' ? /^Video/i : /Audio only|MP3/i,
  });
}

// ---------------------------------------------------------------- web chat

const MEDIA_DOWNLOAD = /image|video|track|audio|music/i;

async function saveChatMedia(page, prev, a, job) {
  job.activity = 'saving generated media';
  const outDir = outDirOf(a);
  const base = baseName(a.filename, a.prompt, 'gemini');
  for (let i = 0; i < 12; i++) { // let the media elements finish loading
    const s = await responseState(page, prev);
    if (s.images + s.videos + s.audios > 0) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return withUI(async () => {
    const resp = page.locator('model-response').nth(prev);
    const btns = resp.locator('button[aria-label*="ownload"]').filter({ visible: true }).and(resp.getByRole('button', { name: MEDIA_DOWNLOAD }));
    const n = await btns.count();
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(await downloadVia(() => clickDownload(page, btns.nth(i), /Audio only|MP3/i), path.join(outDir, n > 1 ? `${base}-${i + 1}` : base)));
    }
    return out;
  });
}

function geminiChat(a) {
  if (!a.prompt) throw new Error('prompt is required');
  const refs = files(a.files, 'file');
  return startJob('chat', a.prompt, async (job) => {
    let page, saved = null;
    job.cancel = () => page?.close().catch(() => {});
    try {
      const prev = await withUI(async () => {
        page = await openPage(a.chat_url || APP_URL);
        if (a.mode || a.thinking) {
          saved = await getModeState(page);
          await setMode(page, { mode: a.mode, thinking: a.thinking });
        }
        if (refs.length) await attachFiles(page, refs);
        return sendPrompt(page, a.prompt);
      });
      const t0 = Date.now();
      let last = '', since = Date.now(), st;
      while (Date.now() - t0 < (a.timeout_seconds || 900) * 1000) {
        await new Promise((r) => setTimeout(r, 2000));
        st = await responseState(page, prev);
        job.activity = `answering (${Math.round((Date.now() - t0) / 1000)}s)`;
        if (!st.exists) continue;
        if (st.text !== last) { last = st.text; since = Date.now(); }
        if (st.done && !st.busy && Date.now() - since > 2500) break;
      }
      const chatUrl = page.url().replace(/[?&]hl=en\b/, '');
      // Gemini sometimes answers a chat prompt with generated media (it makes images on its own).
      const media = st?.downloads?.some((l) => MEDIA_DOWNLOAD.test(l)) ? await saveChatMedia(page, prev, a, job) : [];
      if (media.length) {
        const lines = [`Saved ${media.length} file(s):`, ...media.map((s) => `- ${s.path} (${sizeOf(s.path)})`), `chat_url: ${chatUrl}`];
        if (st.text) lines.push(`Gemini: ${st.text}`);
        return text(lines.join('\n'), media.slice(0, 4).map((s) => (/\.(png|jpe?g|webp)$/i.test(s.path) ? preview(s.path) : null)).filter(Boolean));
      }
      if (!st?.text) return fail(`No answer from Gemini.\nchat_url: ${chatUrl}`);
      return text(`${st.text}\n\nchat_url: ${chatUrl}`);
    } finally {
      // Put the account's default mode back.
      if (page && saved && (saved.mode || saved.thinking)) {
        await withUI(() => setMode(page, saved)).catch((e) => log(`could not restore mode: ${e.message}`));
      }
      if (page && a.keep_tab !== true) await page.close().catch(() => {});
    }
  });
}

// ---------------------------------------------------------------- agy

function geminiAsk(a) {
  if (!a.prompt) throw new Error('prompt is required');
  let cwd = null;
  if (a.cwd) { cwd = normPath(a.cwd); if (!fs.existsSync(cwd)) throw new Error(`cwd not found: ${cwd}`); }
  const access = a.access === 'edit' ? 'edit' : 'read-only';
  if (access === 'edit' && !cwd) throw new Error('access "edit" needs a cwd.');
  return startJob('ask', a.prompt, async (job) => {
    job.activity = 'Gemini (agy) is working';
    const r = await runAgy({
      prompt: a.prompt, cwd, access, model: a.model, effort: a.effort, conversationId: a.conversation_id,
      addDirs: (a.add_dirs || []).map(normPath), timeoutSec: a.timeout_seconds || 900,
      onSpawn: (child) => { job.cancel = () => child.kill(); },
    });
    const lines = [r.response?.trim() || '(empty response)', '', `conversation_id: ${r.conversation_id} (pass back to continue)`];
    if (r.status && r.status !== 'SUCCESS') lines.push(`status: ${r.status}`);
    if (r.denied_actions?.length) lines.push(`denied (read-only): ${r.denied_actions.map((d) => d.display_name || d.action).join(', ')}`);
    if (r.notes) lines.push(`note: ${short(r.notes, 300)}`);
    const res = text(lines.join('\n'));
    if (!r.response?.trim() && r.status !== 'SUCCESS') res.isError = true;
    return res;
  });
}

// ---------------------------------------------------------------- status

async function geminiStatus(a) {
  const lines = [];
  const agy = findAgy();
  lines.push(`agy (text): ${agy || 'NOT FOUND'}`);
  if (agy && a.list_models) {
    const models = await listAgyModels();
    lines.push(`agy models: ${models.map((m) => m.id).join(', ') || '(none)'}`);
  }
  const visible = a.open_window === true;
  lines.push(`Chrome profile: ${PROFILE_DIR} (DevTools port ${CDP_PORT}, ${visible || !HEADLESS ? 'visible window' : 'headless, no window'})`);
  try {
    const st = await withUI(async () => {
      const ctx = await getContext({ headless: visible ? false : HEADLESS });
      let page = ctx.pages().find((p) => p.url().includes('gemini.google.com'));
      if (!page) { page = await ctx.newPage(); await page.goto(APP_URL, { waitUntil: 'domcontentloaded' }); }
      await page.waitForTimeout(3000);
      if (visible) await page.bringToFront().catch(() => {});
      const s = await signedInState(page);
      const plan = await page.evaluate(() => {
        const t = document.body.innerText || '';
        return /\bUltra\b/.test(t) ? 'Ultra' : /\bPro\b/.test(t) ? 'Pro' : null;
      }).catch(() => null);
      return { ...s, plan };
    });
    if (st.signedIn) lines.push(`Gemini web: signed in${st.plan ? ` (${st.plan} plan shown)` : ''}${visible ? '. The window goes back to headless on the next media call.' : ''}`);
    else if (visible) lines.push('Gemini web: NOT signed in. A Chrome window is open on gemini.google.com: sign in there with the Google AI Pro account, then call gemini_status again.');
    else lines.push('Gemini web: NOT signed in. Call gemini_status with open_window=true to open a window for signing in.');
  } catch (e) {
    lines.push(`Gemini web: error ${e.message}`);
  }
  return text(lines.join('\n'));
}

// ---------------------------------------------------------------- gemini_job

async function geminiJob(a, extra, token) {
  if (!a.job_id) {
    if (!jobs.size) return text('No jobs in this server session.');
    return text([...jobs.values()].map((j) => `${j.id}  ${j.status}  ${Math.round(((j.endedAt || Date.now()) - j.startedAt) / 1000)}s  ${j.summary}${j.status === 'running' ? `  — ${j.activity}` : ''}`).join('\n'));
  }
  const job = jobs.get(a.job_id);
  if (!job) return fail(`Unknown job_id ${a.job_id} (jobs live only as long as this MCP server process).`);
  if (a.cancel) { if (job.status === 'running') { job.status = 'cancelled'; await job.cancel?.(); } return text(`Job ${job.id}: ${job.status}`); }
  if (job.status !== 'running') return job.result;
  return awaitJob(job, a.wait_seconds, extra, token);
}

// ---------------------------------------------------------------- schemas

const waitProp = { type: 'integer', minimum: 0, maximum: 3600, description: `Seconds to wait before returning a job_id (default ${WAIT_DEFAULT}). The job keeps running either way.` };
const outProp = { type: 'string', description: `Absolute folder to save into, e.g. the project's assets folder. Default: ${DEFAULT_OUT}` };
const fileProp = { type: 'string', description: 'Base file name without extension (default: from the prompt). Existing files are never overwritten.' };
const refsProp = { type: 'array', items: { type: 'string' }, description: 'Absolute paths of images (or other files) to upload with the prompt: references, or the image to edit/animate.' };
const chatProp = { type: 'string', description: 'chat_url from an earlier result: continue in that chat to refine ("make it warmer").' };
const previewProp = { type: 'boolean', description: 'Return a small preview image (default true).' };

const TOOLS = [
  {
    name: 'gemini_image',
    description: 'Generate or edit an image with Google Gemini (Nano Banana) on the user\'s Google AI Pro account, through the Gemini web app. Saves the full-size file (about 2.8K) to output_dir and returns a preview and a chat_url for refinement. To edit an image, pass it in reference_images and describe the change. Typical time: 15-60 s.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to create or change. Be specific about subject, style, composition, light and any exact text.' },
        output_dir: outProp, filename: fileProp,
        aspect: { type: 'string', enum: IMAGE_ASPECTS, description: 'Aspect ratio (default: Gemini decides).' },
        format: { type: 'string', enum: ['image', 'gif'], description: 'image (default) or an animated GIF.' },
        reference_images: refsProp, chat_url: chatProp, preview: previewProp, wait_seconds: waitProp,
      },
      required: ['prompt'],
    },
  },
  {
    name: 'gemini_video',
    description: 'Generate a real AI video with Google Veo (Gemini "Create video") on the user\'s Google AI Pro account. Text-to-video, or image-to-video when an image is given in reference_images. Returns the MP4 (with Veo audio), a preview frame and a chat_url. The AI Pro plan has a small daily video quota, so use it for final shots, not drafts. Typical time: 1-5 min; often returns a job_id first (poll gemini_job).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Shot description: subject, action, camera move, light, mood, sound.' },
        output_dir: outProp, filename: fileProp,
        aspect: { type: 'string', enum: ['landscape', 'portrait'], description: 'landscape 16:9 (default) or portrait 9:16.' },
        format: { type: 'string', enum: ['video', 'gif'], description: 'video (default) or GIF.' },
        reference_images: refsProp, chat_url: chatProp, preview: previewProp, wait_seconds: waitProp,
      },
      required: ['prompt'],
    },
  },
  {
    name: 'gemini_music',
    description: 'Generate a music track with Gemini "Create music" on the user\'s Google AI Pro account. Saves an MP3 to output_dir (or the MP4 with cover art). Daily limit on AI Pro. Typical time: 1-2 min.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Genre, mood, tempo, instruments, length, vocals or instrumental.' },
        format: { type: 'string', enum: ['mp3', 'video'], description: 'mp3 (default) or video (MP4 with cover art).' },
        output_dir: outProp, filename: fileProp, chat_url: chatProp, wait_seconds: waitProp,
      },
      required: ['prompt'],
    },
  },
  {
    name: 'gemini_ask',
    description: 'Ask Google Gemini through the Antigravity CLI (agy) on the user\'s Google account: questions, code, analysis, web research (it can search the web), second opinions. Read-only by default; access "edit" lets it change files in cwd. Fast (seconds; web research can take minutes). Returns the answer and a conversation_id to continue.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        conversation_id: { type: 'string', description: 'Continue an earlier gemini_ask conversation.' },
        cwd: { type: 'string', description: 'Absolute folder Gemini works in (it can read files there).' },
        add_dirs: { type: 'array', items: { type: 'string' }, description: 'Extra folders it may read.' },
        access: { type: 'string', enum: ['read-only', 'edit'], description: 'read-only (default) or edit (needs cwd).' },
        model: { type: 'string', description: 'agy model id, e.g. gemini-3.8-flash-high (see gemini_status list_models).' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
        timeout_seconds: { type: 'integer' },
        wait_seconds: waitProp,
      },
      required: ['prompt'],
    },
  },
  {
    name: 'gemini_chat',
    description: 'Chat with the Gemini web app\'s own models on the user\'s AI Pro account (mode Hydrogen = everyday, Neon = deeper analysis, auto; Carbon needs the Ultra plan). Use it for the strongest Gemini web model or file analysis in the web app; for quick questions gemini_ask is faster. The account\'s default mode is restored afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        mode: { type: 'string', enum: ['auto', 'hydrogen', 'neon', 'carbon'], description: 'Model mode (default: the account\'s current mode). carbon requires Google AI Ultra.' },
        thinking: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Thinking level (default: the account\'s current level).' },
        files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of files to upload.' },
        output_dir: { type: 'string', description: `Where to save media if Gemini answers with an image, video or music (default ${DEFAULT_OUT}).` },
        chat_url: chatProp, timeout_seconds: { type: 'integer' }, wait_seconds: waitProp,
      },
      required: ['prompt'],
    },
  },
  {
    name: 'gemini_status',
    description: 'Check the setup: agy found, Chrome profile signed in to Gemini, AI Pro plan. Chrome normally runs headless (no window); open_window=true opens a visible window, only needed to sign in again.',
    inputSchema: { type: 'object', properties: { open_window: { type: 'boolean' }, list_models: { type: 'boolean' } } },
  },
  {
    name: 'gemini_job',
    description: 'Wait for, list or cancel Gemini jobs. Without job_id it lists the jobs of this server session.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, wait_seconds: waitProp, cancel: { type: 'boolean' } } },
  },
];

const INSTRUCTIONS = `Google Gemini on the user's Google AI Pro account (no API key).
- gemini_image: Nano Banana images and edits. gemini_video: real Veo text-to-video and image-to-video (small daily quota; use for finals). gemini_music: music tracks.
- gemini_ask: fast questions, code, analysis and web research through the Antigravity CLI. gemini_chat: the Gemini web app's chat models.
Pass output_dir as the project's asset folder. Look at the returned preview before using an asset. Refine in the same chat with chat_url.
Long jobs return a job_id: call gemini_job to wait. If a tool says the profile is not signed in, call gemini_status with open_window=true and ask the user to sign in.`;

// ---------------------------------------------------------------- server

const server = new Server({ name: 'gemini', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name } = req.params;
  const a = req.params.arguments || {};
  const token = req.params._meta?.progressToken;
  try {
    switch (name) {
      case 'gemini_image': return await awaitJob(geminiImage(a), a.wait_seconds, extra, token);
      case 'gemini_video': return await awaitJob(geminiVideo(a), a.wait_seconds, extra, token);
      case 'gemini_music': return await awaitJob(geminiMusic(a), a.wait_seconds, extra, token);
      case 'gemini_ask': return await awaitJob(geminiAsk(a), a.wait_seconds, extra, token);
      case 'gemini_chat': return await awaitJob(geminiChat(a), a.wait_seconds, extra, token);
      case 'gemini_status': return await geminiStatus(a);
      case 'gemini_job': return await geminiJob(a, extra, token);
      default: return fail(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return fail(e.message);
  }
});

export { withHl, launchChrome };

const isMain = import.meta.main ?? (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) {
  const shutdown = () => process.exit(0);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);
  await server.connect(new StdioServerTransport());
  log(`v${VERSION} ready; agy=${findAgy() || 'missing'}; chrome profile=${PROFILE_DIR}; ffmpeg=${ffmpeg() || 'missing'}`);
}
