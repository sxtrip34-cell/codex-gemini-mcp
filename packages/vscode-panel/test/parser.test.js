// Result parsing for both servers' text output.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseResult, kindOf } = require('../mcp-client.js');

const res = (text, isError = false) => parseResult({ content: [{ type: 'text', text }], isError });

test('gemini image result', () => {
  const r = res('Saved 1 file(s):\n- /out/mug.jpg (2.4 MB)\nchat_url: https://gemini.google.com/app/abc (pass to the same tool to refine in this chat)\nGemini: Here you go');
  assert.deepEqual(r.files, ['/out/mug.jpg']);
  assert.equal(r.body, 'Here you go');
  assert.equal(r.chatUrl, 'https://gemini.google.com/app/abc');
});

test('gemini chat result', () => {
  const r = res('Ankara\n\nchat_url: https://gemini.google.com/app/def');
  assert.equal(r.body, 'Ankara');
  assert.deepEqual(r.files, []);
});

test('codex video and 3D results', () => {
  const v = res('Video: /out/forest.mp4 (4.8 MB)\nffprobe: 1920x1080, 6s\nwork folder: /w\nsession_id: 01a3 (pass to codex_reply to revise this video)\nCodex: I animated a forest plate.');
  assert.deepEqual(v.files, ['/out/forest.mp4']);
  assert.equal(v.body, 'I animated a forest plate.');
  assert.equal(v.sessionId, '01a3');
  const m = res('3D asset: /out/cam.glb (1.6 MB)\npreview: /out/cam_preview.png\nblend: /w/cam.blend\nsession_id: 01a4\nCodex: The camera.');
  assert.deepEqual(m.files, ['/out/cam.glb', '/out/cam_preview.png']);
  assert.equal(kindOf(m.files[0]), 'model');
  assert.equal(kindOf(m.files[1]), 'image');
});

test('codex chat and reply results drop bookkeeping lines', () => {
  assert.equal(res('The project has three folders.\n\nsession_id: 01a5 (pass to codex_reply to continue)').body, 'The project has three folders.');
  assert.equal(res('Codex: 400\nsession_id: 01a2').body, '400');
});

test('running jobs expose their job_id', () => {
  const r = res('Still running (0s so far). job_id: 3d-abc123\nLatest activity: queued');
  assert.equal(r.jobId, '3d-abc123');
});

test('kindOf', () => {
  assert.equal(kindOf('a.mp4'), 'video');
  assert.equal(kindOf('a.mp3'), 'audio');
  assert.equal(kindOf('a.png'), 'image');
  assert.equal(kindOf('a.usdz'), 'model');
});
