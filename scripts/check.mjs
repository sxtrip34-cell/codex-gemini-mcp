// Syntax-checks every JavaScript file in the repository (node --check), without running anything.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(m?js|cjs)$/.test(e.name)) files.push(p);
  }
};
walk(root);
let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.error(`✗ ${path.relative(root, f)}\n${e.stderr}`);
  }
}
console.log(`${files.length - failed}/${files.length} files pass node --check`);
process.exit(failed ? 1 : 0);
