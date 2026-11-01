package share

// 分享访客页内联 JS 段一：内容渲染原语（P-20261007-22 纯搬运自 page.go
// 的 pageTmplSrc 模板段，零逻辑改动）——取数/主题/剪贴板/下载链接/
// enhanceArticle 管线/高亮/表格拖拽/灯箱/水印等与具体视图无关的原语

const pageTmplJsCoreSrc = `const SC = {{.Boot}};
const $app = document.getElementById('app');
const t = k => (SC.dict[k] || k);
const withPath = (ep, p) => '/s/' + SC.token + '/' + ep + '?path=' + encodeURIComponent(p || '');
// 深链（P-20261020-11）：markdown 内相对链接重写为 /s/{token}?path=...，
// 页面入口读取该 query 恢复目录/文件定位——否则「复制页面链接」在子目录
// 视图下只能回到根，页面内相对链接也会丢定位
let initialPath = '';
try { initialPath = new URLSearchParams(location.search).get('path') || ''; } catch (e) { initialPath = ''; }
let state = { path: initialPath, share: null, expiresAt: '', wide: false };

// ── 主题切换（与主应用 themes/ 同款调色板；选择持久化，auto 跟随系统） ──
const THEME_KEY = 'sc.share.theme';
const THEMES = ['auto', 'light', 'dark', 'one-dark', 'dracula'];
function applyTheme(name){
  if (!THEMES.includes(name)) name = 'auto';
  document.documentElement.dataset.theme = name;
}
(function initTheme(){
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* 无存储环境走默认 */ }
  applyTheme(saved || 'auto');
})();

// 顶部加载进度条（替代原地转圈的等待观感）
const topbar = document.createElement('div');
topbar.className = 'topbar'; document.body.appendChild(topbar);
function progress(on){
  topbar.style.opacity = '1';
  topbar.style.width = on ? '70%' : '100%';
  if (!on) setTimeout(() => { topbar.style.width = '0'; topbar.style.opacity = '0'; }, 220);
}
// 剪贴板：局域网 http 访问不是安全上下文，navigator.clipboard 可能为
// undefined——与主应用 utils/clipboard.ts 同款取舍，降级 execCommand
function copyText(s){
  const fallback = () => {
    let ta = null;
    try {
      ta = document.createElement('textarea');
      ta.value = s;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.opacity = '0'; ta.style.pointerEvents = 'none';
      document.body.appendChild(ta);
      ta.select();
      return document.execCommand('copy');
    } catch (e) { return false; }
    finally { if (ta && ta.parentNode) ta.remove(); }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(s).then(() => true).catch(fallback);
  }
  return Promise.resolve(fallback());
}
// 自描述下载链接：URL 以原文件名结尾（/s/{t}/dl/docs/a.txt），
// 下载工具可直接取名；目录以 .zip 结尾（后缀即所见格式），服务端
// 剥后缀定位目录打包；根目录打包链接为 /dl/
function dlUrl(p, isDir){
  if (!p) return location.origin + '/s/' + SC.token + '/dl/';
  const enc = '/' + p.split('/').map(encodeURIComponent).join('/') + (isDir ? '.zip' : '');
  return location.origin + '/s/' + SC.token + '/dl' + enc;
}
// 页面链接（与下载直链区分，P-20261020-11）：携带当前访客路径，复制给
// 他人打开即落在同一目录/文件——服务端只把 ?path= 当定位参数校验，不会
// 因链接分享多出取数面
function pageUrl(){
  const base = location.origin + '/s/' + SC.token;
  return state.path ? base + '?path=' + encodeURIComponent(state.path) : base;
}
// 新标签打开（HTML/PDF/媒体，P-20261020-11）：锚点 click 与下载同构，
// rel=noopener 切断 opener；服务端 /html 的 CSP sandbox 与 /raw 的
// nosniff/类型头保持不变，新标签不是放宽脚本的旁路
function openInNewTab(url){
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
// 内嵌预览（HTML/PDF/媒体）右上角工具条：新标签打开与页内 reader 互补，
// 工具条先于内容插入，打印样式统一隐藏
function appendPreviewTools(pv, urlFactory){
  const tools = el('div', 'preview-tools');
  const b = el('button', 'tool-btn', t('openNewTab'));
  b.title = t('openNewTab');
  b.onclick = () => openInNewTab(urlFactory());
  tools.appendChild(b);
  pv.classList.add('has-tools');
  pv.appendChild(tools);
  return tools;
}
// 锚点点击下载（不发生页面导航）：location.href 触发的是「导航转下载」，
// 下载由导航请求转换而来，部分浏览器在该状态下下载弹窗不响应鼠标；
// 同源 + download 属性的锚点点击与主系统内下载（blob + a[download]）同构，
// 浏览器下载弹窗行为一致。服务端 Content-Disposition 文件名优先，download
// 属性仅兜底取名
function anchorDownload(url, name){
  const a = document.createElement('a');
  a.href = url;
  if (name) a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
// ── 通用内容增强管道：对注入片段统一加表格横滚、代码复制、标题锚点、
// 图片灯箱。新预览类型接入后自动获得，无需逐类实现 ──
function enhanceArticle(root){
  root.querySelectorAll('table').forEach(tb => {
    if (tb.parentElement && tb.parentElement.classList.contains('tbl-wrap')) return;
    const w = document.createElement('div'); w.className = 'tbl-wrap';
    tb.parentNode.insertBefore(w, tb); w.appendChild(tb);
    // 列宽保护与拖拽（P-20261010-1）：md/docx/csv 等内容表统一获得
    enableTableColResize(tb);
  });
  root.querySelectorAll('pre').forEach(pre => {
    if (pre.parentElement && pre.parentElement.classList.contains('pre-wrap')) return;
    const w = document.createElement('div'); w.className = 'pre-wrap';
    pre.parentNode.insertBefore(w, pre); w.appendChild(pre);
    const b = document.createElement('button'); b.className = 'pre-copy'; b.textContent = t('copy');
    b.onclick = () => {
      copyText(pre.innerText).then(ok => {
        if (ok) { b.textContent = t('copied'); setTimeout(() => { b.textContent = t('copy'); }, 1200); }
        else flashToast(t('copyFailed'));
      });
    };
    w.appendChild(b);
  });
  root.querySelectorAll('a[href^="#"]').forEach(a => {
    // 文内目录跳转：拦截点击按 id 平滑滚动（滚动区是 .scroll 容器而非窗口，
    // 且服务端 AutoHeadingID 与目录 href 可能存在大小写/URL 编码差异——
    // 精确 id 未命中时按标题文本兜底匹配）
    a.onclick = (ev) => {
      ev.preventDefault();
      let raw = '';
      try { raw = decodeURIComponent((a.getAttribute('href') || '').slice(1)); } catch (e) { raw = (a.getAttribute('href') || '').slice(1); }
      let target = document.getElementById(raw);
      if (!target) {
        const name = raw.trim().toLowerCase();
        root.querySelectorAll('h1,h2,h3,h4').forEach(h => {
          if (target) return;
          const txt = (h.textContent || '').replace(/#\s*$/, '').trim().toLowerCase();
          if (name && txt === name) target = h;
        });
      }
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  });
  root.querySelectorAll('h1,h2,h3,h4').forEach((h, i) => {
    if (!h.id) h.id = 'sec-' + (i + 1) + '-' + (h.textContent || '').trim().slice(0, 24).replace(/\s+/g, '-');
    const a = document.createElement('a');
    a.className = 'h-anchor'; a.href = '#' + h.id; a.textContent = '#';
    a.onclick = (ev) => { ev.preventDefault(); h.scrollIntoView({ behavior: 'smooth' }); };
    h.appendChild(a);
  });
  // 代码块轻量高亮：仅识别语言标注的块（注释/字符串/数字/关键字四类）
  root.querySelectorAll('pre code').forEach(code => highlightCode(code));
  // 长文档大纲（≥3 个标题）：可折叠面板，点击平滑滚动
  buildOutline(root);
  // CSV 截断提示文案（服务端只落 data-rows，双语在页面字典）
  root.querySelectorAll('.sc-csv-trunc').forEach(p => {
    const n = p.getAttribute('data-rows') || '0';
    p.textContent = t('csvTruncated').replace('{n}', n);
  });
  root.querySelectorAll('img').forEach(img => {
    img.style.cursor = 'zoom-in';
    img.onclick = () => openLightbox(img.src);
  });
}
// ── 轻量代码高亮：仅处理带语言标注的代码块。单遍正则扫描（注释/字符串
// 优先消费，关键字与数字次之），原文取自 textContent、输出逐段转义——
// 不引入任何注入面。未识别语言直接跳过（错误高亮比没有更糟）。
// 文本预览（P-20261020-11）复用同一分词器：highlightSegments 返回结构化
// 片段，行渲染与代码块共享语言表/别名/优先级，避免两套高亮漂移 ──
function highlightSpec(className){
  const m = /language-([\w#+-]+)/.exec(className || '');
  if (!m) return null;
  const ALIAS = { ts:'js', tsx:'js', jsx:'js', mjs:'js', cjs:'js', h:'c', cpp:'c', hpp:'c',
    cs:'js', java:'js', kt:'js', rs:'rust', php:'js', swift:'js',
    python:'py', bash:'sh', shell:'sh', zsh:'sh', yaml:'sh',
    yml:'conf', toml:'conf', ini:'conf', conf:'conf', properties:'conf' };
  const lang = ALIAS[m[1].toLowerCase()] || m[1].toLowerCase();
  const KWS = {
    js: 'function|var|let|const|class|extends|new|import|export|from|async|await|if|else|for|while|do|switch|case|default|break|continue|return|try|catch|finally|throw|typeof|instanceof|delete|of|in|null|undefined|true|false|this',
    go: 'func|var|const|type|struct|interface|map|chan|go|defer|if|else|for|range|switch|case|default|break|continue|return|package|import|nil|true|false',
    py: 'def|class|if|elif|else|for|while|return|import|from|as|with|try|except|finally|raise|lambda|pass|break|continue|and|or|not|in|is|global|None|True|False|self',
    sh: 'if|then|elif|else|fi|for|while|do|done|case|esac|function|in|export|local|return|echo|set',
    c: 'int|char|void|long|unsigned|struct|typedef|const|static|if|else|for|while|do|switch|case|default|break|continue|return|sizeof|include|define|NULL|true|false',
    rust: 'fn|let|mut|const|struct|enum|impl|trait|pub|use|mod|match|if|else|for|while|loop|return|Some|None|Ok|Err|true|false',
    sql: 'SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|DROP|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|HAVING|LIMIT|AND|OR|NOT|NULL|AS|DISTINCT'
  };
  let spec = null;
  if (lang === 'js') spec = { line: '//', block: true, kw: KWS.js };
  else if (lang === 'go') spec = { line: '//', block: true, kw: KWS.go };
  else if (lang === 'py') spec = { line: '#', triple: true, kw: KWS.py };
  else if (lang === 'sh') spec = { line: '#', kw: KWS.sh };
  else if (lang === 'conf') spec = { line: '#', kw: '' };
  else if (lang === 'c') spec = { line: '//', block: true, kw: KWS.c };
  else if (lang === 'rust') spec = { line: '//', block: true, kw: KWS.rust };
  else if (lang === 'sql') spec = { line: '--', kw: KWS.sql };
  else if (lang === 'json') spec = { line: '', kw: '' };
  if (!spec) return null;
  const parts = [];
  if (spec.block) parts.push('/\\*[\\s\\S]*?\\*/');
  if (spec.line) parts.push(spec.line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^\\n]*');
  if (spec.triple) parts.push('"""[\\s\\S]*?"""');
  parts.push('"(?:\\\\.|[^"\\\\\\n])*"');
  parts.push("'(?:\\\\.|[^'\\\\\\n])*'");
  if (spec.kw) parts.push('\\b(?:' + spec.kw + ')\\b');
  parts.push('\\b0[xX][0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?\\b');
  let re;
  try { re = new RegExp(parts.join('|'), 'g'); } catch (e) { return null; }
  return { re, kwRe: spec.kw ? new RegExp('^(?:' + spec.kw + ')$') : null, spec };
}
function escHtml(s){
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// 返回 [{text, cls}]；无语言规格返回 null（调用方回落纯文本）
function highlightSegments(src, className){
  const hs = highlightSpec(className);
  if (!hs) return null;
  const { re, kwRe, spec } = hs;
  const out = [];
  let last = 0, mm;
  re.lastIndex = 0;
  while ((mm = re.exec(src))) {
    const s = mm[0];
    if (mm.index > last) out.push({ text: src.slice(last, mm.index), cls: '' });
    let cls = 'tok-n';
    if (spec.block && s.slice(0, 2) === '/*') cls = 'tok-c';
    else if (spec.line && s.slice(0, spec.line.length) === spec.line) cls = 'tok-c';
    else if (s[0] === '"' || s[0] === "'") cls = 'tok-s';
    else if (kwRe && kwRe.test(s)) cls = 'tok-k';
    out.push({ text: s, cls });
    last = mm.index + s.length;
    if (s.length === 0) re.lastIndex++;
  }
  if (last < src.length) out.push({ text: src.slice(last), cls: '' });
  return out;
}
function highlightCode(code){
  if (code.dataset.hl) return;
  code.dataset.hl = '1';
  const segs = highlightSegments(code.textContent, code.className);
  if (!segs) return;
  code.innerHTML = segs.map(s => s.cls
    ? '<span class="' + s.cls + '">' + escHtml(s.text) + '</span>'
    : escHtml(s.text)).join('');
}
// ── 文本预览（P-20261020-11）：行号/换行/复制全文 ──
// 会话内记忆开关（切换文件后保持用户偏好）。行号/高亮受双重阈值约束：
// 行级 DOM 数量（3000 行）与整文高亮正则开销（512KB）；超限降级为单个
// pre（复制/换行仍可用），避免 20MB 文本把访客页卡死。
const textPrefs = { wrap: false, lines: true };
const TEXT_LINE_MAX = 3000;
const TEXT_BYTES_MAX = 512 * 1024;
const EXT_LANG = {
  js:'js', mjs:'js', cjs:'js', ts:'js', tsx:'js', jsx:'js',
  go:'go', py:'py', sh:'sh', bash:'sh', zsh:'sh',
  yaml:'sh', yml:'conf', toml:'conf', ini:'conf', conf:'conf', properties:'conf',
  c:'c', h:'c', cpp:'c', hpp:'c', rs:'rust', sql:'sql', json:'json'
};
function codeLangClass(name){
  const base = (name || '').toLowerCase();
  const m = /\.([a-z0-9]+)$/.exec(base);
  const lang = EXT_LANG[m ? m[1] : base];
  return lang ? 'language-' + lang : '';
}
// 把整文分词结果按 \n 切成逻辑行（跨行 token 会拆到各自行——行号与换行
// 对齐优先，单行内仍保留 token 着色）
function segmentsToLines(segs){
  const lines = [[]];
  for (const seg of segs) {
    const parts = seg.text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([]);
      if (parts[i]) lines[lines.length - 1].push({ text: parts[i], cls: seg.cls });
    }
  }
  return lines;
}
function renderTextBody(body, text, name){
  body.replaceChildren();
  // 显示层统一 CRLF/CR 为 LF（复制仍用原文）：行级渲染若把 \r 留在行尾，
  // CSS 会把它再当一次段内换行，Windows 文本会逐行多出空行
  const display = text.replace(/\r\n?/g, '\n');
  const lineCount = display.split('\n').length;
  const rich = text.length <= TEXT_BYTES_MAX && lineCount <= TEXT_LINE_MAX;
  if (!rich) {
    body.appendChild(el('pre', 'text-plain' + (textPrefs.wrap ? ' with-wrap' : ''), display));
    return { rich: false };
  }
  const segs = highlightSegments(display, codeLangClass(name)) || [{ text: display, cls: '' }];
  const box = el('div', 'text-lines'
    + (textPrefs.lines ? ' with-ln' : '')
    + (textPrefs.wrap ? ' with-wrap' : ''));
  segmentsToLines(segs).forEach((lineSegs, i) => {
    const row = el('div', 'tl');
    row.appendChild(el('span', 'tl-n', String(i + 1)));
    const c = el('span', 'tl-c');
    if (lineSegs.some(s => s.cls)) {
      c.innerHTML = lineSegs.map(s => s.cls
        ? '<span class="' + s.cls + '">' + escHtml(s.text) + '</span>'
        : escHtml(s.text)).join('');
    } else {
      c.textContent = lineSegs.map(s => s.text).join('');
    }
    row.appendChild(c);
    box.appendChild(row);
  });
  body.appendChild(box);
  return { rich: true };
}
// 长文档大纲：标题数达到阈值时在文首插入可折叠面板
function buildOutline(root){
  const heads = Array.prototype.slice.call(root.querySelectorAll('h1,h2,h3,h4'));
  if (heads.length < 3) return;
  const det = document.createElement('details');
  det.className = 'md-outline';
  const sum = document.createElement('summary');
  sum.textContent = t('outline');
  det.appendChild(sum);
  const nav = document.createElement('nav');
  heads.forEach(h => {
    if (!h.id) return;
    const a = document.createElement('a');
    a.href = '#' + h.id;
    a.textContent = (h.textContent || '').replace(/#\s*$/, '').trim();
    a.className = 'ol-' + h.tagName.toLowerCase();
    a.onclick = (ev) => { ev.preventDefault(); h.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    nav.appendChild(a);
  });
  det.appendChild(nav);
  root.insertBefore(det, root.firstChild);
}
// ── md 表格列宽拖拽（P-20261010-1）：th 右缘手柄，拖动即把该表切到
// table-layout:fixed 并按拖前实宽写 col 显式宽（拖动起点=原布局，表不跳变），
// 此后该表按用户值分配、未拖的表维持自动布局。双击手柄该列回自动——表上已
// 无任何显式宽则整表回自动布局。宽度只落 DOM 不持久化：会话内记忆，刷新/
// 内容重渲染即回自动布局（访客页轻形态，主站编辑器预览的 mdTableResize.ts
// 是同形态独立实现，交互语义保持一致）。窄屏(<700px)与触屏拖拽交互不成立，
// 手柄隐藏 + pointerdown 双守卫，回落纯自动布局 ──
function tableColIndex(th){
  return Array.prototype.indexOf.call(th.parentElement.children, th);
}
function applyTableFixed(tb){
  // 把当前自动布局各列实宽固化为 col 显式宽再切 fixed（md 表无合并单元格，
  // 按首行列数建 col；0 宽（隐藏/测量前）不写，该列留在 fixed 的均分空间里）
  const cg = document.createElement('colgroup');
  Array.prototype.forEach.call(tb.rows[0].cells, (c) => {
    const colEl = document.createElement('col');
    const wpx = Math.round(c.getBoundingClientRect().width);
    if (wpx > 0) colEl.style.width = wpx + 'px';
    cg.appendChild(colEl);
  });
  tb.insertBefore(cg, tb.firstChild);
  tb.classList.add('sc-cols-fixed');
  requestAnimationFrame(() => syncClipTitles(tb));
}
function restoreTableAuto(tb){
  const cg = tb.querySelector('colgroup');
  if (cg) cg.remove();
  tb.classList.remove('sc-cols-fixed');
  tb.querySelectorAll('th,td').forEach(c => { c.removeAttribute('title'); });
}
// ellipsis 截断的单元格补 title 悬浮全文（只落实际截断的单元格；切 fixed/
// 拖完/回自动后各同步一次。自动布局 + anywhere 兜底下无横向截断 → 全清）
function syncClipTitles(tb){
  tb.querySelectorAll('th,td').forEach(c => {
    c.removeAttribute('title');
    if (c.scrollWidth > c.clientWidth + 1) c.title = c.textContent;
  });
}
function enableTableColResize(tb){
  if (tb.dataset.colResize) return;
  tb.dataset.colResize = '1';
  const canDrag = () => window.matchMedia('(min-width: 700px)').matches;
  tb.querySelectorAll('th').forEach(th => {
    const h = document.createElement('span');
    h.className = 'col-handle';
    h.setAttribute('aria-hidden', 'true');
    // 拖拽态：fixed 切换惰性到首个 pointermove——纯点击/双击手柄不改变布局
    //（否则双击「恢复自动」会先把没拖过的表切成 fixed，语义自相矛盾）
    let dragIdx = -1, startX = 0, startW = 0, minW = 0, col = null;
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.pointerType && e.pointerType !== 'mouse')) return;
      if (!canDrag()) return;
      const idx = tableColIndex(th);
      if (idx < 0 || !tb.rows.length) return;
      dragIdx = idx;
      startX = e.clientX;
      startW = th.getBoundingClientRect().width;
      // 拖不出比短列下限更窄的列（与 CSS min-width:calc(4em+26px) 同源——
      // border-box 下补回单元格 padding/边框壳，内容区才是 4em）
      minW = 4 * (parseFloat(getComputedStyle(tb).fontSize) || 14) + 26;
      try { h.setPointerCapture(e.pointerId); } catch (err) { /* 指针已失效等时序忽略 */ }
      h.classList.add('dragging');
      e.preventDefault(); // 拖拽不触发表格文本选中
    });
    h.addEventListener('pointermove', (e) => {
      if (dragIdx < 0) return;
      if (!tb.classList.contains('sc-cols-fixed')) applyTableFixed(tb);
      if (!col) col = tb.querySelectorAll('colgroup col')[dragIdx];
      if (!col) return;
      col.style.width = Math.max(minW, startW + e.clientX - startX) + 'px';
    });
    const endDrag = () => {
      if (dragIdx < 0) return;
      dragIdx = -1; col = null;
      h.classList.remove('dragging');
      syncClipTitles(tb);
    };
    h.addEventListener('pointerup', endDrag);
    h.addEventListener('pointercancel', endDrag);
    h.addEventListener('dblclick', () => {
      if (dragIdx >= 0) return;
      const cols = tb.querySelectorAll('colgroup col');
      const c = cols[tableColIndex(th)];
      if (c) c.style.width = '';
      const pinned = Array.prototype.some.call(cols, (x) => x.style.width);
      if (!pinned) restoreTableAuto(tb);
      else syncClipTitles(tb);
    });
    th.appendChild(h);
  });
}
// 窄屏回落：宽屏拖出的 fixed 表在窗口变窄(<700px)时整体回自动布局。监听挂
// matchMedia 单例而非逐表——内容重渲染替换 DOM 会留悬挂引用；重置只碰
// 仍在文档内的表
const wideMQ = window.matchMedia('(min-width: 700px)');
if (wideMQ.addEventListener) wideMQ.addEventListener('change', (e) => {
  if (e.matches) return;
  document.querySelectorAll('table.sc-cols-fixed').forEach(restoreTableAuto);
});
function openLightbox(src){
  const lb = document.createElement('div'); lb.className = 'lightbox';
  const img = document.createElement('img'); img.src = src;
  lb.appendChild(img);
  lb.onclick = () => lb.remove();
  document.addEventListener('keydown', function esc(e){
    if (e.key === 'Escape') { lb.remove(); document.removeEventListener('keydown', esc); }
  });
  document.body.appendChild(lb);
}

// ── 溯源水印（P-20261005-193）：对角双标低透明（4%），单角被裁剪另一角
// 仍可归因；不做全屏平铺。文本由服务端按记录下发（SC.wm，空 = 未开水印
// 不出层），经 textContent 写入与全页用户字符串同一防注入纪律。host 传
// DOM 时渲染为导出画布内的绝对定位形态——「导出图片」产出的外传件同样
// 带归因标（导出正是最常见的截图途径，水印缺席等于功能自拆） ──
function mountWatermark(host){
  if (!SC.wm) return;
  const box = document.createElement('div');
  box.className = 'sc-wm' + (host ? ' sc-wm-abs' : '');
  ['wm-a', 'wm-b'].forEach(k => {
    const s = document.createElement('span');
    s.className = k;
    s.textContent = SC.wm;
    box.appendChild(s);
  });
  (host || document.body).appendChild(box);
}

const ICONS = {
  folder: '<svg width="20" height="20" viewBox="0 0 24 24" fill="#5b8def"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>',
  file: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8a94ab" stroke-width="1.8"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/><path d="M14 3v5h5"/></svg>',
  pdf: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#e05252" stroke-width="1.8"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/><path d="M14 3v5h5"/></svg>',
  image: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3fa96f" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M3 17l5-4 4 3 4-3 5 4"/></svg>',
  markdown: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f7cff" stroke-width="1.8"><rect x="2.5" y="5.5" width="19" height="13" rx="2"/><path d="M6 15v-6l2.5 3L11 9v6M16.5 9v4M14.5 11.5l2 2 2-2"/></svg>',
  docx: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2b6fd4" stroke-width="1.8"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/><path d="M14 3v5h5"/><path d="M8.5 12l1.2 5 2.3-4 2.3 4 1.2-5" stroke-linejoin="round"/></svg>',
  html: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#e0803d" stroke-width="1.8"><path d="M9 8l-4 4 4 4M15 8l4 4-4 4M13 6l-2 12"/></svg>',
  text: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#7d8aa5" stroke-width="1.8"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
  snippet: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8a63d2" stroke-width="1.8"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/><path d="M14 3v5h5M10 12l-2 2.5L10 17M14 12l2 2.5L14 17"/></svg>',
  video: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#b06fd4" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9.5v5l4.5-2.5z" fill="#b06fd4"/></svg>',
  audio: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#d4976f" stroke-width="1.8"><path d="M9 18V6l10-2v11"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="15" r="2.5"/></svg>',
  info: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8a94ab" stroke-width="1.8"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/><path d="M14 3v5h5"/></svg>'
};
function iconOf(e){
  if (e.isDir) return ICONS.folder;
  const k = e.kind;
  if (k && ICONS[k]) return ICONS[k];
  return ICONS.info;
}
const BIG = k => iconOf({isDir:false, kind:k}).replace('width="20" height="20"','width="38" height="38"');

async function jfetch(url){
  const r = await fetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw { status: r.status, code: body.error || ('http_' + r.status) };
  return body;
}

function el(tag, cls, text){
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function fmtSize(n){
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  const u = ['KB','MB','GB','TB']; let v = n, i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + u[i];
}
function fmtTime(iso){
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat(SC.lang === 'zh' ? 'zh-CN' : 'en-US',
      { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  } catch { return iso; }
}

// 固定骨架：header（细顶栏 + 动作）/ reader(crumbs+scroll) 只建一次，
// 刷新只填充内容区。页脚已去掉（P-20261020-7 统一无卡片阅读器）——
// 留言区脚本以 wrap 为锚兜底追加，见 guestboard.go 的 footer 判空分支
let headerEl, subEl, dlBtn, dlCopyBtn, readerEl, crumbBarEl, scrollEl, exportBtn, copyBtn, wideBtn;
let themeDesktop, exportMenuBtn, copyMenuBtn, wideMenuBtn, moreEl, moreBtn, fsBtn, fsMenuBtn,
    newTabBtn, newTabMenuBtn, themeMenuSel;
let exporting = false;
// ===== 导出高清图片：SVG foreignObject 栅格化（html-to-image 同源技术） =====
// 分享页零外部依赖（CSP 锁死资源来源），不能引 CDN 库，故内联实现核心管线：
// 构建静态标题头 + 克隆 reader 内容区 → 内联页面样式（主题变量按当前计算值固化
// 为内联属性）与图片（fetch 转 data URL）→ 序列化进 foreignObject → 画到
// 2 倍画布 → 弹出导出预览（棋盘格透明底可辨），选定 PNG/JPEG/WebP 后另存。
// 导出头不放任何交互控件（业界图片导出惯例：标题自述 + 纯内容）。
// 滚动容器展开为全高导出"长图"；超长内容按 16384px 画布上限截断。
// 屏外定位只落在 host 容器上——wrap 本体会被原样序列化进 foreignObject，
// 定位样式一旦带进去，栅格化时内容整体偏出视口，导出的就是一张全空图。
// 内嵌 PDF/HTML（sandbox iframe）与媒体无法栅格化，对应预览时按钮禁用
function updateExportBtn(kind){
  const off = kind === 'pdf' || kind === 'html' || kind === 'video' || kind === 'audio';
  [exportBtn, exportMenuBtn].forEach(b => {
    if (!b) return;
    b.disabled = off;
    b.title = off ? t('exportUnsupported') : t('exportTip');
  });
}

`
