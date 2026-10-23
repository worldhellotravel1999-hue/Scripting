// Only UUID-based local filenames reach CSS; text is never interpreted as HTML.
export function fontTextHTML(options: {
  filename: string
  format: "truetype" | "opentype"
  size: number
  editable: boolean
  /** 静态文本是否允许系统选择；编辑态始终允许。 */
  selectable?: boolean
  flat: boolean
  text: string
  /** 额外行距（pt）：折算进行高，与原生 Text.lineSpacing 对齐。 */
  lineSpacing?: number
  gradientColors?: [string, string]
  /** 深色模式的宿主背景；缺省沿用 flat 的页面色（#000 / #1c1c1e）。 */
  darkBackground?: string
}): string {
  if (!/^[0-9a-f-]+\.(ttf|otf)$/i.test(options.filename)) throw new Error("Invalid font filename")
  const size = options.size === 15 ? 15 : 17
  const darkBackground = /^#[0-9a-f]{3,8}$/i.test(options.darkBackground || "")
    ? options.darkBackground!
    : options.flat ? "#000" : "#1c1c1e"
  const lineHeight = (1.45 + (options.lineSpacing ?? 0) / size).toFixed(3)
  const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")
  const source = json(`url("${options.filename}") format("${options.format}")`)
  const gradient = options.gradientColors
    ? `background:linear-gradient(110deg,${options.gradientColors[0]},${options.gradientColors[1]});-webkit-background-clip:text;-webkit-text-fill-color:transparent;`
    : ""
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src 'self' file:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'">
<style>
:root { color-scheme:light dark; }
html,body { margin:0; padding:0; overflow:hidden; background:#fff; color:#000; }
@media(prefers-color-scheme:dark) { html,body { background:${darkBackground}; color:#fff; } }
#text { display:block; width:100%; box-sizing:border-box; margin:0; padding:0; border:0; outline:0; background:transparent; color:inherit; ${gradient} font:${size}px/${lineHeight} -apple-system,sans-serif; white-space:pre-wrap; overflow-wrap:anywhere; -webkit-text-size-adjust:100%; -webkit-user-select:text; user-select:text; opacity:0; }
textarea#text { resize:none; min-height:100px; max-height:230px; overflow-y:auto; border-radius:0; }
textarea::placeholder { color:#aaa; }
</style></head><body>${options.editable ? '<textarea id="text" dir="auto" aria-label="原文" enterkeyhint="send"></textarea>' : '<div id="text" dir="auto"></div>'}
<script>
const el = document.getElementById('text');
const editable = ${options.editable};
let editVersion = 0;
let lastHeight = -1;
window.fontState = 'loading';
function post(value) {
  try {
    const bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.fontText;
    if (bridge) Promise.resolve(bridge.postMessage(value)).catch(() => {});
  } catch (_) {}
}
function measure() {
  // 只读页面初始为空（文本由原生 syncText 注入）。空元素先报 2px 会让
  // 卡片从初始高度收缩一下再展开；等有文本再测量。
  if (!editable && !el.textContent) return
  if (editable) {
    el.style.height='0px';
    const height = Math.min(230,Math.max(100,el.scrollHeight))+'px';
    el.style.height=height;
  }
  const height = Math.ceil(el.getBoundingClientRect().height)+2;
  if (height !== lastHeight) { lastHeight=height; post({type:'height',value:height}); }
}
let measureTimer = 0
function scheduleMeasure() {
  // 不用 rAF：离屏的 WKWebView 可能暂停 rAF，回调不执行会把 pending 永远卡住。
  if (measureTimer) clearTimeout(measureTimer)
  measureTimer = setTimeout(() => { measureTimer = 0; measure() }, 30)
}
function reveal() { el.style.opacity='1' }
window.setSelectable = function(value) {
  if (editable) return
  el.style.webkitUserSelect = value ? 'text' : 'none'
  el.style.userSelect = value ? 'text' : 'none'
}
window.setSelectable(${options.editable || options.selectable !== false})
window.setText = function(text, expectedVersion) {
  if (editable) {
    if (el.composing || expectedVersion !== editVersion) return;
    if(el.value !== text) el.value=text;
  } else if(el.textContent !== text) el.textContent=text;
  scheduleMeasure();
};
window.setText(${json(options.text)}, 0);
if(editable) {
  el.addEventListener('input', () => {
    scheduleMeasure();
    if (!el.composing) post({type:'input',value:el.value,version:++editVersion});
  });
  el.addEventListener('compositionstart', () => { el.composing=true; });
  el.addEventListener('compositionend', () => { el.composing=false; post({type:'input',value:el.value,version:++editVersion}); scheduleMeasure(); });
  el.addEventListener('keydown', event => {
    if(event.key==='Enter' && !event.isComposing && !el.composing) { event.preventDefault(); post({type:'submit'}); }
  });
}
// Do not observe the root viewport: changing the native frame must not cause
// an endless height -> frame -> ResizeObserver -> height bridge feedback loop.
if (!editable && typeof ResizeObserver === 'function') new ResizeObserver(scheduleMeasure).observe(el);
window.addEventListener('resize', scheduleMeasure);
post({type:'domReady'});
// 字体解码完成前先不显示系统字体，避免每块文字先闪一下再重排；
// 2.5s 仍未完成则先显示系统字体，避免一直空白。
const revealTimer = setTimeout(() => { if (window.fontState === 'loading') reveal(); }, 2500);
try {
  const face = new FontFace('LingoText', ${source});
  document.fonts.add(face);
  face.load().then(() => {
    clearTimeout(revealTimer);
    el.style.fontFamily='LingoText,-apple-system,sans-serif';
    window.fontState='ready';
    reveal();
    measure();
    requestAnimationFrame(measure);
    post({type:'ready'});
  }, () => { clearTimeout(revealTimer); window.fontState='error'; reveal(); post({type:'error'}); });
} catch (_) { clearTimeout(revealTimer); window.fontState='error'; reveal(); post({type:'error'}); }
measure();
</script></body></html>`
}
