// Smoke test: starts server.mjs over stdio, lists tools, and optionally runs one tool call.
// Usage: node test/smoke.mjs                       -> list tools
//        node test/smoke.mjs <tool> '<json args>'  -> call a tool and print the result
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [tool, json] = process.argv.slice(2);

const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(here, '..', 'server.mjs')], stderr: 'inherit' });
const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(transport);

console.log('instructions:', client.getInstructions()?.split('\n')[0]);
const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));

if (tool) {
  const t0 = Date.now();
  const res = await client.callTool({ name: tool, arguments: JSON.parse(json || '{}') }, undefined, {
    timeout: 3_600_000,
    resetTimeoutOnProgress: true,
    onprogress: (p) => console.log(`  progress ${p.progress}: ${p.message}`),
  });
  console.log(`--- ${tool} finished in ${Math.round((Date.now() - t0) / 1000)}s, isError=${!!res.isError}`);
  for (const c of res.content) {
    if (c.type === 'text') console.log(c.text);
    else if (c.type === 'image') {
      const out = path.join(here, '..', 'test-output', `preview-${Date.now()}.${c.mimeType.split('/')[1]}`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(c.data, 'base64'));
      console.log(`[preview image saved: ${out}]`);
    }
  }
}
await client.close();
