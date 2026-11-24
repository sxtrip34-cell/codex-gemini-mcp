// Decides what a panel message is for: chat, image, video or music (and the aspect ratio).
// Clear cases are decided instantly by keywords (Turkish, English, Russian, Georgian);
// only ambiguous ones are classified by Gemini Flash through agy.

const VIDEO = /(video|vidyo|klip|\bclip|animasyon|animation|\banimate|canland[ıi]r|hareketlendir|\bveo\b|\bfilm\b|reels|tiktok|shorts|drone|dolly|timelapse|time-lapse|slow[- ]?motion|a[ğg][ıi]r [çc]ekim|видео|ролик|ვიდეო)/i;
const MUSIC = /(m[üu]zik|[şs]ark[ıi]|beste|melodi|\bbeat\b|jingle|music|\bsong\b|soundtrack|instrumental|enstr[üu]mantal|lo-?fi|музык|песн|მუსიკ|სიმღერ)/i;
const IMAGE = /(g[öo]rsel|resim|foto[ğg]raf|\bfoto\b|ill[üu]strasyon|[çc]izim|\blogo|poster|afi[şs]|banner|\bikon|\bicon|wallpaper|duvar ka[ğg][ıi]d|\bimage|picture|\bphoto|illustration|drawing|sticker|thumbnail|mockup|product shot|[üu]r[üu]n [çc]ekimi|portrait photo|render|изображени|картинк|фото|логотип|სურათ|ფოტო|ლოგო)/i;
const GEN = /(\byap\b|yap[ıi]n|yapar m[ıi]s[ıi]n|olu[şs]tur|[üu]ret|[çc]iz\b|[çc]izer|tasarla|haz[ıi]rla|canland[ıi]r|\bcreate|\bmake\b|generate|\bdraw|\bdesign|\brender|\bproduce|\bpaint|\banimate|сделай|создай|нарисуй|сгенерируй|შექმენი|დახატე|გააკეთე)/i;
const TEXT_VERB = /(\byaz\b|yaz[ıi]n|\bwrite\b|lyrics|s[öo]z[üu]|senaryo|script|prompt|[öo]zetle|summari[sz]e|[çc]evir|translate|[öo]ner|suggest|fikir|idea|analiz|analy[sz]e|review|incele|напиши|დაწერე)/i;
const CODE = /(\bcode\b|\bkod|function|fonksiyon|component|komponent|\bcss\b|\bhtml\b|react|\bapi\b|python|javascript|typescript|\bbug\b|player|oynat[ıi]c[ıi]|\brepo\b|endpoint|\bsql\b)/i;
const QUESTION = /(\?\s*$|\bnedir\b|\bnas[ıi]l\b|\bneden\b|\bniye\b|ne demek|a[çc][ıi]kla|anlat|\bexplain\b|\bwhat\b|\bwhy\b|\bhow\b|\bwhich\b|почему|как |что |რა |როგორ|რატომ)/i;
const EDIT = /(de[ğg]i[şs]tir|d[üu]zenle|kald[ıi]r|\bsil\b|ekle\b|arka ?plan|renklendir|b[üu]y[üu]t|netle[şs]tir|\bedit\b|change|replace|remove|\badd\b|make it|turn it|background|retouch|upscale|recolou?r|restyle|измени|убери|შეცვალე)/i;
const IMG_FILE = /\.(png|jpe?g|webp|gif|bmp|heic)$/i;
const THREE_D = /(\b3d\b|3 ?boyut|[üu][çc] boyut|\bglb\b|\bgltf\b|\bfbx\b|\bstl\b|usdz|blender|low[- ]?poly|\bmesh\b|трехмерн|3д|სამგანზომილ)/i;
const THREE_D_OBJECT = /(model|asset|\bglb\b|\bgltf\b|\bfbx\b|\bobj\b|\bstl\b|usdz|mesh|blender|low[- ]?poly|nesne|obje|object|prop|karakter|character|модел|მოდელ)/i;

const isThreeD = (t) => THREE_D.test(t) && THREE_D_OBJECT.test(t);
const isEdit = (t) => EDIT.test(t);

/** Seconds asked for in the text ("10 saniye", "8s", "15 seconds"). */
function durationOf(text) {
  const m = /(\d{1,3})\s*(?:sn\b|saniye|s\b|sec|second|сек|წამ)/i.exec(text);
  return m ? Math.min(120, Math.max(2, +m[1])) : undefined;
}
const formatOf = (text) => ((/\b(glb|gltf|fbx|obj|stl|usdz)\b/i.exec(text) || [])[1] || '').toLowerCase() || undefined;
const detailOf = (text) => (/low[- ]?poly|d[üu][şs][üu]k poligon|basit|simple/i.test(text) ? 'low'
  : /high[- ]?poly|detayl[ıi]|detailed|ger[çc]ek[çc]i|realistic|y[üu]ksek detay/i.test(text) ? 'high' : undefined);

function aspectOf(text, tool) {
  const t = text.toLowerCase();
  if (/9\s*[:x×/]\s*16|dikey|portrait|vertical|stor(y|ies)|reels|tiktok|shorts|telefon ekran|phone screen|вертикал/.test(t)) return '9:16';
  if (/16\s*[:x×/]\s*9|yatay|landscape|horizontal|widescreen|youtube|banner|hero|masa[üu]st[üu]|desktop|горизонт/.test(t)) return '16:9';
  if (tool === 'image') {
    if (/1\s*[:x×/]\s*1|\bkare\b|square|instagram post|avatar|profil foto|profile pic|\blogo|\bicon|\bikon/.test(t)) return '1:1';
    if (/4\s*[:x×/]\s*3/.test(t)) return '4:3';
    if (/3\s*[:x×/]\s*4/.test(t)) return '3:4';
  }
  return null;
}

/** Instant decision, or null when the message is ambiguous. */
function quickRoute(text, files = []) {
  const t = text.trim();
  const hasImage = files.some((f) => IMG_FILE.test(f));
  const media = isThreeD(t) ? '3d' : VIDEO.test(t) ? 'video' : MUSIC.test(t) ? 'music' : IMAGE.test(t) ? 'image' : null;
  const gen = GEN.test(t), textVerb = TEXT_VERB.test(t), code = CODE.test(t), question = QUESTION.test(t);

  if (hasImage && /(canland[ıi]r|hareketlendir|\banimate|bring (it )?to life|оживи)/i.test(t)) return { tool: 'video', aspect: aspectOf(t, 'video') };
  if (!media) {
    if (hasImage && EDIT.test(t) && !question && !textVerb) return { tool: 'image', aspect: aspectOf(t, 'image') };
    return { tool: 'chat' };
  }
  if (code) return { tool: 'chat' };
  if (gen && !textVerb && !question) return { tool: media, aspect: aspectOf(t, media) };
  if ((question || textVerb) && !gen) return { tool: 'chat' };
  // A plain visual description ("minimal product shot of a mug, soft light") is an image request.
  // Video and music cost daily quota, so their ambiguous cases still go to the classifier.
  if (media === 'image' && !question && !textVerb) return { tool: 'image', aspect: aspectOf(t, 'image') };
  return null; // e.g. "slow drone shot over misty mountains", "a song about rain, write it"
}

const ROUTER_PROMPT = (text, files) => `You route one message in a Gemini side panel. Decide what the user wants:
- "chat": an answer, explanation, text, code, analysis, lyrics or a prompt written as text
- "image": a picture generated or an attached image edited
- "video": a video clip generated (or an attached image animated)
- "music": a music track generated
- "3d": a 3D model or asset generated (GLB/FBX/OBJ, Blender)
A message that only describes a scene (subject, light, composition, style) without asking anything is a request to generate it:
"video" if it describes motion or a camera move (drone shot, dolly, pan, time-lapse, something moving), otherwise "image".
Also give the aspect ratio if the message implies one ("16:9", "9:16", "1:1", "4:3", "3:4"), else null.
Attached files: ${files.length ? files.map((f) => f.split(/[\\/]/).pop()).join(', ') : 'none'}.
Reply with only JSON, like {"tool":"image","aspect":null}.

Message:
"""
${text}
"""`;

/** @param {(prompt: string) => Promise<string>} ask runs a fast model and returns its text */
async function route(text, files, ask) {
  const quick = quickRoute(text, files);
  if (quick) return { ...quick, via: 'keywords' };
  try {
    const out = await ask(ROUTER_PROMPT(text, files));
    const j = JSON.parse((/\{[\s\S]*?\}/.exec(out) || ['{}'])[0]);
    const tool = ['chat', 'image', 'video', 'music', '3d'].includes(j.tool) ? j.tool : 'chat';
    const aspect = ['16:9', '9:16', '1:1', '4:3', '3:4'].includes(j.aspect) ? j.aspect : aspectOf(text, tool);
    return { tool, aspect, via: 'flash' };
  } catch {
    return { tool: 'chat', via: 'fallback' };
  }
}

module.exports = { route, quickRoute, aspectOf, isEdit, durationOf, formatOf, detailOf };
