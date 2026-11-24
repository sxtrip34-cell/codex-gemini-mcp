// Renders the README graphics from docs/src/*.html to docs/assets/*.png with headless Chrome.
//   node docs/src/render.mjs            all graphics
//   node docs/src/render.mjs banner     one graphic
// Needs Google Chrome (playwright-core comes with gemini-mcp's dependencies).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const { chromium } = createRequire(path.join(root, 'packages', 'gemini-mcp', 'package.json'))('playwright-core');
const out = path.join(root, 'docs', 'assets');
fs.mkdirSync(out, { recursive: true });

const only = process.argv[2];
const pages = fs.readdirSync(here).filter((f) => f.endsWith('.html') && (!only || f === `${only}.html`));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--allow-file-access-from-files'] });
for (const file of pages) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(path.join(here, file)).href, { waitUntil: 'load', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}); // web fonts, iframes
  await Promise.race([page.evaluate(() => document.fonts.ready), page.waitForTimeout(8000)]);
  await page.waitForTimeout(500);
  const frame = page.locator('#frame');
  const name = file.replace(/\.html$/, '.png');
  await frame.screenshot({ path: path.join(out, name), omitBackground: true });
  console.log(`docs/assets/${name}`);
  await page.close();
}
await browser.close();
