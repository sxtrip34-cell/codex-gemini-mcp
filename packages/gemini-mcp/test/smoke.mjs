// Smoke test over stdio.
//   node test/smoke.mjs                        list tools
//   node test/smoke.mjs <tool> '<json args>'   call one tool, save image previews to test-output/
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [tool, json] = process.argv.slice(2);
const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server.mjs')], stderr: 'inherit' }));
const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));
if (tool) {
  const t0 = Date.now();
  const res = await client.callTool({ name: tool, arguments: JSON.parse(json || '{}') }, undefined, { timeout: 3_600_000, resetTimeoutOnProgress: true });
  console.log(`--- ${tool}: ${Math.round((Date.now() - t0) / 1000)}s, isError=${!!res.isError}`);
  for (const c of res.content) {
    if (c.type === 'text') console.log(c.text);
    else if (c.type === 'image') {
      const out = path.join(root, 'test-output', `preview-${Date.now()}.jpg`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(c.data, 'base64'));
      console.log(`[preview saved: ${out}]`);
    }
  }
}
await client.close();
