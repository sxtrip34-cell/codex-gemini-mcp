// Router: which tool a panel message goes to, decided by keywords (no model call).
const test = require('node:test');
const assert = require('node:assert/strict');
const { quickRoute, aspectOf, durationOf, formatOf, detailOf, route } = require('../router.js');

const cases = [
  // chat
  ['Explain the structure of this project', 'chat'],
  ['bu projenin yapısını açıkla', 'chat'],
  ['merhaba nasılsın', 'chat'],
  ['logo nedir?', 'chat'],
  ['write a react component for a video player', 'chat'],
  ['bir şarkı sözü yaz yağmur hakkında', 'chat'],
  ['3D nedir?', 'chat'],
  // image
  ['kırmızı bir elmanın görselini oluştur', 'image'],
  ['Create a 16:9 hero image of a misty forest', 'image'],
  ['bir kafe için minimal logo tasarla', 'image'],
  ['Minimal product shot of a ceramic mug on linen, soft window light', 'image'],
  ['3d render görseli yap: neon şehir', 'image'],
  // video
  ['deniz kenarında yürüyen köpek videosu üret', 'video'],
  ['make a vertical video of rain on a window', 'video'],
  // music
  ['30 saniyelik sakin lo-fi müzik yap', 'music'],
  ['generate a jingle for my coffee brand', 'music'],
  // 3D
  ['low-poly bir sandalye 3D modeli yap', '3d'],
  ['make a 3D model of a vintage camera as glb', '3d'],
  ['blender ile bir kupa modeli oluştur', '3d'],
];

for (const [text, want] of cases) {
  test(`"${text}" -> ${want}`, () => {
    assert.equal(quickRoute(text, [])?.tool, want);
  });
}

test('ambiguous camera-move descriptions are left to the classifier', () => {
  assert.equal(quickRoute('Slow drone shot over misty mountains at sunrise', []), null);
});

test('attachments: edit, animate, ask', () => {
  const img = ['C:/tmp/photo.jpg'];
  assert.equal(quickRoute('arka planı beyaz yap', img).tool, 'image');
  assert.equal(quickRoute('make it look like a watercolor', img).tool, 'image');
  assert.equal(quickRoute('bunu canlandır', img).tool, 'video');
  assert.equal(quickRoute('bu resimde ne var?', img).tool, 'chat');
});

test('aspect ratio from the wording', () => {
  assert.equal(aspectOf('dikey bir story görseli', 'image'), '9:16');
  assert.equal(aspectOf('a 16:9 banner', 'image'), '16:9');
  assert.equal(aspectOf('kare instagram post', 'image'), '1:1');
  assert.equal(aspectOf('a cat', 'image'), null);
});

test('video length, 3D format and detail', () => {
  assert.equal(durationOf('10 saniyelik video'), 10);
  assert.equal(durationOf('make an 8s clip'), 8);
  assert.equal(formatOf('export it as FBX'), 'fbx');
  assert.equal(detailOf('a low-poly chair'), 'low');
  assert.equal(detailOf('gerçekçi bir saat'), 'high');
});

test('route() asks the classifier only for ambiguous messages', async () => {
  let asked = 0;
  const ask = async () => { asked++; return '{"tool":"video","aspect":"9:16"}'; };
  assert.deepEqual(await route('kırmızı bir elmanın görselini oluştur', [], ask), { tool: 'image', aspect: null, via: 'keywords' });
  assert.equal(asked, 0);
  assert.deepEqual(await route('Slow drone shot over misty mountains at sunrise', [], ask), { tool: 'video', aspect: '9:16', via: 'flash' });
  assert.equal(asked, 1);
});
