// Records docs/assets/demo.gif: the real panel (panel-frame.html) driven through a short session.
//   node docs/src/demo.mjs     (needs Google Chrome and ffmpeg on PATH)
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const { chromium } = createRequire(path.join(root, 'packages', 'gemini-mcp', 'package.json'))('playwright-core');
const frames = fs.mkdtempSync(path.join(os.tmpdir(), 'cgm-demo-'));
const out = path.join(root, 'docs', 'assets', 'demo.gif');
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 400, height: 660 }, deviceScaleFactor: 1.5 });
await page.goto(pathToFileURL(path.join(here, 'panel-frame.html')).href + '?scene=gemini', { waitUntil: 'load' });
await page.waitForTimeout(800);

let n = 0;
const snap = async (hold = 1) => {
  const buf = await page.screenshot();
  for (let i = 0; i < hold; i++) fs.writeFileSync(path.join(frames, `f${String(n++).padStart(4, '0')}.png`), buf);
};
const say = (m) => page.evaluate((m) => window.postMessage(m, '*'), m);
const media = (f) => new URL(`media/${f}`, pathToFileURL(path.join(here, 'x')).href).href;
async function type(text) {
  await page.click('#input');
  for (let i = 0; i < text.length; i += 2) {
    await page.keyboard.type(text.slice(i, i + 2));
    await snap();
  }
}
async function busy(provider, activity, frames) {
  await say({ type: 'busy', provider, busy: true, activity });
  for (let i = 0; i < frames; i++) { await page.waitForTimeout(90); await snap(); }
}

await snap(12);
await type('dikey story görseli yap: origami turna');
await snap(3);
await page.keyboard.press('Enter');
await busy('gemini', 'Understanding the request…', 4);
await say({ type: 'routed', provider: 'gemini', tool: 'image', aspect: '9:16' });
await busy('gemini', 'Creating an image…', 6);
await busy('gemini', 'waiting for the image (21s)', 6);
await say({ type: 'busy', provider: 'gemini', busy: false });
await say({ type: 'reply', provider: 'gemini', by: 'gemini', text: '', files: [{ path: 'my-app/ai-output/origami-turna.jpg', name: 'origami-turna.jpg', kind: 'image', uri: media('crane.jpg') }] });
await page.waitForTimeout(400);
await snap(20);

await page.click('#switch button[data-provider="codex"]');
for (let i = 0; i < 4; i++) { await page.waitForTimeout(80); await snap(); }
await snap(6);
await type('a low-poly vintage camera as GLB');
await snap(3);
await page.keyboard.press('Enter');
await busy('codex', 'Understanding the request…', 3);
await say({ type: 'routed', provider: 'codex', tool: '3d', aspect: null });
await busy('codex', 'Building a 3D model…', 6);
await busy('codex', 'running: blender -b --python build.py (1m 40s)', 8);
await say({ type: 'busy', provider: 'codex', busy: false });
await say({ type: 'reply', provider: 'codex', by: 'codex', text: 'Stylised film camera, **7,430 triangles**, 0.18 × 0.10 × 0.09 m, textures embedded.', files: [
  { path: 'my-app/ai-output/vintage-camera_preview.png', name: 'vintage-camera_preview.png', kind: 'image', uri: media('camera-3d.jpg') },
  { path: 'my-app/ai-output/vintage-camera.glb', name: 'vintage-camera.glb', kind: 'model', uri: '' },
] });
await page.waitForTimeout(500);
await snap(26);
await browser.close();

execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-framerate', '10', '-i', path.join(frames, 'f%04d.png'),
  '-vf', 'scale=420:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle', out]);
fs.rmSync(frames, { recursive: true, force: true });
console.log(`docs/assets/demo.gif (${n} frames, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
