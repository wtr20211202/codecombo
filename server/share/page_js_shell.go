package share

// 分享访客页内联 JS 段二：UI 壳与导出（P-20261007-22 纯搬运自 page.go
// 的 pageTmplSrc 模板段，零逻辑改动）——导出图片（webp 探测/编码/预览）
// 与顶栏/主题选择/⋯菜单/全屏/宽屏/buildShell 布局骨架

const pageTmplJsShellSrc = `// 导出格式表：WebP 编码能力因浏览器而异（Safari 不支持 canvas 编码 webp，
// toBlob 会静默回落成 PNG），打开弹层前探测一次，不支持即不提供该选项
const EXPORT_FORMATS = [
  { id: 'png',  mime: 'image/png',  ext: 'png',  label: 'exportFmtPng'  },
  { id: 'jpeg', mime: 'image/jpeg', ext: 'jpg',  label: 'exportFmtJpeg' },
  { id: 'webp', mime: 'image/webp', ext: 'webp', label: 'exportFmtWebp' },
];
let webpEncodable = null; // null = 未探测
function exportFileName(fmt){
  const base = (state.entry && state.entry.name) || (state.share && state.share.name) || 'share';
  let ext = 'png';
  for (const f of EXPORT_FORMATS) if (f.id === fmt) ext = f.ext;
  return base.replace(/\.[^.]*$/, '') + '.' + ext;
}

async function inlineImages(root){
  const imgs = root.querySelectorAll('img');
  for (let i = 0; i < imgs.length; i++) {
    try {
      const blob = await (await fetch(imgs[i].src)).blob();
      imgs[i].src = await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = () => res('');
        fr.readAsDataURL(blob);
      });
    } catch (e) { /* 无法内联的图保留原 src：SVG 图片态不加载外部资源，该处留白 */ }
  }
}

// 按格式编码画布：JPEG 无透明通道，透明像素会被编码成黑块，先铺白底；
// PNG 保持默认参数（无损）；JPEG/WebP 统一 0.92 质量（体积与观感的平衡点）
function encodeCanvas(cv, fmt){
  const f = EXPORT_FORMATS.find(x => x.id === fmt) || EXPORT_FORMATS[0];
  return new Promise((res) => {
    let src = cv;
    if (f.id === 'jpeg') {
      src = document.createElement('canvas');
      src.width = cv.width; src.height = cv.height;
      const ctx = src.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, src.width, src.height);
      ctx.drawImage(cv, 0, 0);
    }
    src.toBlob((blob) => res(blob), f.mime, f.id === 'png' ? undefined : 0.92);
  });
}
function detectWebp(){
  if (webpEncodable !== null) return Promise.resolve(webpEncodable);
  return new Promise((res) => {
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    c.toBlob((b) => { webpEncodable = !!b && b.type === 'image/webp'; res(webpEncodable); }, 'image/webp');
  });
}

async function exportCardImage(btn){
  if (exporting) return;
  exporting = true;
  const old = btn.textContent;
  btn.textContent = t('exporting');
  btn.disabled = true;
  const finish = (fail) => {
    btn.disabled = false; exporting = false;
    btn.textContent = fail ? t('exportFailed') : old;
    if (fail) {
      // 窄屏入口在「⋯」菜单里，点完菜单即收起——失败只剩隐藏按钮文案，
      // 必须补一条 toast 才能让访客知道没出图、可重试
      flashToast(t('exportFailed'));
      setTimeout(() => { btn.textContent = old; }, 1500);
    }
  };
  try {
    const scale = 2;
    const cssText = (document.getElementById('page-css') || {}).textContent || '';
    const cs = getComputedStyle(document.documentElement);
    // 主题变量固化为内容根上的内联属性：foreignObject 内 :root 不匹配内容元素，
    // 页面 CSS 的 :root 变量定义不会生效，必须由祖先内联继承
    const wrap = document.createElement('div');
    const bg = cs.getPropertyValue('--bg').trim();
    wrap.style.setProperty('--bg', bg);
    ['--card','--text','--muted','--border','--accent','--accent2','--hover','--chip','--shadow']
      .forEach(v => wrap.style.setProperty(v, cs.getPropertyValue(v).trim()));
    wrap.style.cssText += 'position:relative;width:' + Math.round($app.getBoundingClientRect().width) + 'px;padding:22px;box-sizing:border-box;' +
      'background:radial-gradient(1100px 420px at 50% -180px, rgba(106,92,255,.14), transparent 70%),' + bg + ';' +
      "font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;" +
      'color:' + cs.getPropertyValue('--text').trim() + ';';
    // 导出头为专用静态标题块，不克隆带操作按钮的页头：主题切换/导出/
    // 复制/下载控件定格进图片既无功能又喧宾夺主（业界导出只留标题 +
    // 元信息自述内容）；图标/标题/元信息与页头同一套样式类
    const entry = state.entry || {};
    const xhead = document.createElement('div');
    xhead.className = 'header';
    const xicon = document.createElement('div');
    xicon.className = 'icon';
    xicon.innerHTML = entry.isDir ? ICONS.folder : (ICONS[entry.kind] || ICONS.file);
    const xmeta = document.createElement('div');
    xmeta.className = 'meta';
    xmeta.appendChild(el('h1', '', entry.name || (state.share && state.share.name) || ''));
    xmeta.appendChild(el('div', 'sub', subEl.textContent));
    xhead.append(xicon, xmeta);
    wrap.appendChild(xhead);
    // 快照/过期状态条随导出图（P-20261005-168 时点声明，P-20261111-5 起合并
    // 为单行紧凑条）：导出是最常见的截图外传途径，导出件缺时点声明同样会
    // 被误当现状（水印随导出图的同款理由；live 永久记录无该节点，零变化）。
    // 导出克隆源 = reader 内容区（原 .card；P-20261020-7 去卡片后同一
    // 语义——标题头自述 + 当前内容，不含顶栏操作控件）。
    const statusBanner = document.getElementById('status-banner');
    if (statusBanner) wrap.appendChild(statusBanner.cloneNode(true));
    // 根层级的面包屑只是"文件分享 › 文件名"的重复（标题头已自述），
    // 仅子目录层级保留以呈现路径上下文
    const readerClone = readerEl.cloneNode(true);
    if (!state.path) {
      const cr = readerClone.querySelector('.crumbs');
      if (cr) cr.remove();
    }
    // 内容区里的常显交互件一并剥离：返回上级/刷新/行内下载复制/过滤输入框
    // 在静态图中没有任何功能；悬停才显的 .pre-copy/.h-anchor 本就不可见
    readerClone.querySelectorAll('.row-acts, .crumb-refresh, .up-btn, .filter-row input')
      .forEach(n => n.remove());
    // 滚动容器展开为全高：导出完整内容长图而非仅可视视口
    readerClone.style.height = 'auto';
    readerClone.style.overflow = 'visible';
    readerClone.querySelectorAll('.scroll, .preview, .md-article').forEach(n => {
      n.style.height = 'auto'; n.style.maxHeight = 'none'; n.style.overflow = 'visible';
    });
    wrap.appendChild(readerClone);
    // 屏外定位只落在 host 容器上（html-to-image 的克隆容器同思路）：
    // wrap 会被原样序列化进 foreignObject，fixed/-99999px 一旦带进去，
    // 栅格化时内容整体落在视口左侧之外，导出的就是一张全空图片。
    // position:relative 供导出图内水印（mountWatermark(wrap)）绝对定位锚定
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-99999px;top:0;';
    host.appendChild(wrap);
    document.body.appendChild(host);
    mountWatermark(wrap);
    await inlineImages(wrap);
    // 页面样式内联进克隆树（须在测量完成后插入，style 元素不影响布局）
    const styleEl = document.createElement('style');
    styleEl.textContent = cssText;
    wrap.insertBefore(styleEl, wrap.firstChild);

    const W = wrap.offsetWidth, H = wrap.offsetHeight;
    // 画布尺寸上限（Chrome 16384）：超长内容按上限截断
    const fitScale = Math.min(1, 16384 / Math.max(W, 1), 16384 / Math.max(H, 1));
    const s = Math.max(1, Math.min(scale, fitScale)) < scale && H * scale > 16384
      ? Math.max(1, 16384 / H) : scale;
    let useH = H;
    if (H * s > 16384) { useH = Math.floor(16384 / s); wrap.style.height = useH + 'px'; wrap.style.overflow = 'hidden'; }
    // XML 非法控制字符清洗（文本预览可能携带二进制残留）
    const xhtml = new XMLSerializer().serializeToString(wrap).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    // SVG 以 1x 自然尺寸构造：foreignObject 内的 CSS 布局视口 = SVG 宽高，
    // 内容恰好充满；drawImage 放大到 s 倍画布时浏览器按目标尺寸重新栅格化
    // 矢量内容（html-to-image 同款手法），得到真正的高清而非 1x 内容缩在
    // 画布一角
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + useH + '">' +
      '<foreignObject width="100%" height="100%">' + xhtml + '</foreignObject></svg>';
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = Math.round(W * s); cv.height = Math.round(useH * s);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      host.remove();
      finish(false);
      openExportPreview(cv);
    };
    img.onerror = () => { host.remove(); finish(true); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  } catch (e) { finish(true); }
}

// ── 导出预览弹层：栅格化结果先在弹层里预览（透明区棋盘格可辨），
// 选定格式、确认体积后另存。画布随弹层关闭释放 ──
let exportMask = null;
function closeExportPreview(){
  if (!exportMask) return;
  if (exportMask._url) URL.revokeObjectURL(exportMask._url);
  exportMask.remove();
  exportMask = null;
}
async function openExportPreview(cv){
  closeExportPreview();
  await detectWebp();
  if (exportMask) return; // 等待期间已有弹层打开：不叠开
  const mask = el('div', 'export-mask');
  const dlg = el('div', 'export-dialog');
  const head = el('div', 'export-head');
  head.appendChild(el('h3', '', t('exportPreview')));
  head.appendChild(el('span', 'dim', cv.width + ' × ' + cv.height + ' px'));
  dlg.appendChild(head);
  const body = el('div', 'export-body');
  const img = document.createElement('img');
  img.alt = t('exportPreview');
  body.appendChild(img);
  dlg.appendChild(body);
  const foot = el('div', 'export-foot');
  const seg = el('div', 'seg');
  const sizeEl = el('span', 'dim', '');
  const sp = el('span', 'sp');
  const cancelBtn = el('button', 'btn-ghost', t('cancel'));
  const saveBtn = el('button', 'btn2', t('download'));
  foot.append(seg, sizeEl, sp, cancelBtn, saveBtn);
  dlg.appendChild(foot);
  mask.appendChild(dlg);
  mask.onclick = (ev) => { if (ev.target === mask) closeExportPreview(); };
  document.body.appendChild(mask);
  exportMask = mask;

  let fmt = 'png';
  const apply = async () => {
    saveBtn.disabled = true;
    const blob = await encodeCanvas(cv, fmt);
    saveBtn.disabled = false;
    if (exportMask !== mask || !blob) return;
    const url = URL.createObjectURL(blob);
    img.src = url;
    if (mask._url) URL.revokeObjectURL(mask._url);
    mask._url = url;
    sizeEl.textContent = fmtSize(blob.size);
  };
  EXPORT_FORMATS.filter(f => f.id !== 'webp' || webpEncodable).forEach((f, i) => {
    const b = el('button', i === 0 ? 'on' : '', t(f.label));
    b.onclick = () => {
      if (fmt === f.id) return;
      fmt = f.id;
      seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      void apply();
    };
    seg.appendChild(b);
  });
  cancelBtn.onclick = closeExportPreview;
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    const blob = await encodeCanvas(cv, fmt);
    saveBtn.disabled = false;
    if (exportMask !== mask || !blob) { if (!blob) flashToast(t('exportFailed')); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = exportFileName(fmt);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    closeExportPreview();
    flashToast(t('exportDone'));
  };
  void apply();
}

// ── 顶栏动作与 reader 骨架（P-20261020-7）──
// 主题选择器在桌面顶栏与「⋯」菜单各有一份（同 THEME_KEY / THEMES 表，
// 任一处改动即时同步另一处）。桌面全量可见，≤700px 由 CSS 把
// .desktop-only 收进菜单（下载常驻一级，菜单项 40px 热区）。
const FS_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
const NEWTAB_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/></svg>';
function makeThemeSelect(cls){
  const sel = el('select', 'theme-select' + (cls ? ' ' + cls : ''));
  sel.title = t('theme');
  sel.setAttribute('aria-label', t('theme'));
  [['auto', t('themeAuto')], ['light', t('themeLight')], ['dark', t('themeDark')],
   ['one-dark', t('themeOneDark')], ['dracula', t('themeDracula')]].forEach(pair => {
    const opt = document.createElement('option');
    opt.value = pair[0]; opt.textContent = pair[1];
    sel.appendChild(opt);
  });
  try { sel.value = localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { sel.value = 'auto'; }
  sel.onchange = () => {
    applyTheme(sel.value);
    try { localStorage.setItem(THEME_KEY, sel.value); } catch (e) { /* ignore */ }
    [themeDesktop, themeMenuSel].forEach(other => {
      if (other && other !== sel && other.value !== sel.value) other.value = sel.value;
    });
  };
  return sel;
}
function iconButton(svg, label){
  const b = el('button', 'icon-btn desktop-only');
  b.type = 'button';
  b.innerHTML = svg;
  b.title = label;
  b.setAttribute('aria-label', label);
  return b;
}
function menuItem(label, fn){
  const b = el('button', 'more-item', label);
  b.type = 'button';
  b.setAttribute('role', 'menuitem');
  b.onclick = () => { closeMore(); fn(); };
  return b;
}
function setMoreOpen(open){
  if (!moreEl) return;
  moreEl.classList.toggle('open', open);
  if (moreBtn) moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function closeMore(){ setMoreOpen(false); }
// 复制链接 = 当前目标的下载直链（文件 → /dl/原名；目录 → /dl/名.zip）；
// 片段没有下载语义，复制页面短链本身
function copyShareLink(){
  // 页面链接语义（P-20261020-11）：携带当前 ?path= 深链；下载直链由
  // dlCopyBtn 单独复制，两者不混用
  copyText(pageUrl()).then(ok => {
    if (!ok) { flashToast(t('copyFailed')); return; }
    flashToast(t('linkCopied'));
    if (!copyBtn) return;
    copyBtn.textContent = t('copied');
    setTimeout(() => { copyBtn.textContent = t('copyLink'); }, 1200);
  });
}
// 新标签打开：PDF/图片/音视频/文本直取 raw（浏览器原生呈现），HTML 走
// /html 端点保留 <base> 相对资源回源；其余（md/docx/csv/片段/目录）开
// 当前阅读页。iframe 全幅后浏览器原生 chrome 仍属浏览器行为
function newTabUrl(){
  const e = state.entry || {};
  if (!e.isDir) {
    if (e.kind === 'html') return withPath('html', state.path);
    if (e.kind === 'pdf' || e.kind === 'image' || e.kind === 'video' ||
        e.kind === 'audio' || e.kind === 'text') return withPath('raw', state.path);
  }
  return location.href;
}
function openInNewTab(){ window.open(newTabUrl(), '_blank', 'noopener'); }
function fsElement(){
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}
function toggleFullscreen(){
  if (fsElement()) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) { try { const p = exit.call(document); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ } }
    return;
  }
  const root = document.documentElement;
  const req = root.requestFullscreen || root.webkitRequestFullscreen;
  if (!req) return;
  try { const p = req.call(root); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ }
}
function syncFullscreen(){
  const on = !!fsElement();
  const label = on ? t('exitFullscreen') : t('fullscreen');
  [fsBtn, fsMenuBtn].forEach(b => {
    if (!b) return;
    if (b === fsMenuBtn) b.textContent = label;
    b.title = label;
    b.setAttribute('aria-label', label);
  });
}
document.addEventListener('fullscreenchange', syncFullscreen);
document.addEventListener('webkitfullscreenchange', syncFullscreen);
// markdown/docx 阅读列全宽切换（桌面顶栏按钮 / 窄屏菜单项同一状态）
function updateWideBtn(kind){
  const on = kind === 'markdown' || kind === 'docx';
  if (wideBtn) wideBtn.style.display = on ? '' : 'none';
  if (wideMenuBtn) wideMenuBtn.style.display = on ? '' : 'none';
}
function syncWide(){
  const label = state.wide ? t('readingWidth') : t('fullWidth');
  [wideBtn, wideMenuBtn].forEach(b => {
    if (!b) return;
    b.textContent = label;
    b.title = label;
    b.setAttribute('aria-pressed', state.wide ? 'true' : 'false');
  });
}
function toggleWide(){
  state.wide = !state.wide;
  syncWide();
  const art = scrollEl.querySelector('.md-article');
  if (art) art.classList.toggle('wide', state.wide);
}

function buildShell(){
  // 服务端预渲染的快照/过期紧凑状态条（P-20261005-168 时点声明，P-20261111-5
  // 起合并为单行）：下面的 replaceChildren 会清掉静态壳，先摘下、header
  // 就位后插回原位（条随 HTML 直出、不依赖本脚本执行成功）；live 永久
  // 记录节点不存在，零变化
  const statusBanner = document.getElementById('status-banner');
  $app.replaceChildren();
  headerEl = el('div', 'header');
  const ic = el('div', 'icon'); ic.innerHTML = ICONS.info;
  headerEl.appendChild(ic);
  const meta = el('div', 'meta');
  meta.appendChild(el('h1', '', t('loading')));
  subEl = el('div', 'sub', '');
  meta.appendChild(subEl);
  headerEl.appendChild(meta);

  const actions = el('div', 'actions');
  // 主题切换器：跟随系统 / 主应用四款主题（选择持久化）
  themeDesktop = makeThemeSelect('desktop-only');
  actions.appendChild(themeDesktop);
  // 复制动作拆分（P-20261020-11）：页面链接（含 ?path= 深链）与下载直链各一
  copyBtn = el('button', 'btn desktop-only', t('copyLink'));
  copyBtn.title = t('copyLink');
  copyBtn.onclick = copyShareLink;
  actions.appendChild(copyBtn);
  dlCopyBtn = el('button', 'btn desktop-only', t('copyDownloadLink'));
  dlCopyBtn.title = t('copyDownloadLink');
  dlCopyBtn.onclick = () => {
    copyText(dlUrl(state.path, state.entry && state.entry.isDir))
      .then(ok => { flashToast(ok ? t('dlLinkCopied') : t('copyFailed')); });
  };
  actions.appendChild(dlCopyBtn);
  // 下载常驻一级动作（窄屏也不收进菜单）
  dlBtn = el('button', 'btn primary', t('download'));
  dlBtn.style.display = 'none';
  dlBtn.onclick = () => { anchorDownload(dlUrl(state.path, state.entry && state.entry.isDir), state.entry && !state.entry.isDir ? (state.entry.name || '') : ''); };
  actions.appendChild(dlBtn);
  // 导出高清图片：SVG foreignObject 栅格化（html-to-image 同源技术，零外部
  // 依赖——分享页 CSP 锁死外部资源，不能引 CDN 库）。内嵌 PDF/HTML/媒体
  // 预览不支持，对应场景按钮禁用
  exportBtn = el('button', 'btn desktop-only export-btn', t('exportImage'));
  exportBtn.title = t('exportTip');
  exportBtn.onclick = () => exportCardImage(exportBtn);
  actions.appendChild(exportBtn);
  wideBtn = el('button', 'btn desktop-only wide-btn', t('fullWidth'));
  wideBtn.style.display = 'none';
  wideBtn.onclick = toggleWide;
  actions.appendChild(wideBtn);
  fsBtn = iconButton(FS_ICON, t('fullscreen'));
  fsBtn.onclick = toggleFullscreen;
  actions.appendChild(fsBtn);
  newTabBtn = iconButton(NEWTAB_ICON, t('newTab'));
  newTabBtn.onclick = openInNewTab;
  actions.appendChild(newTabBtn);

  // 「⋯」菜单：≤700px 收口导出/复制/全宽/主题/全屏/新标签
  moreEl = el('div', 'more');
  moreBtn = el('button', 'more-btn', '⋯');
  moreBtn.type = 'button';
  moreBtn.title = t('moreActions');
  moreBtn.setAttribute('aria-label', t('moreActions'));
  moreBtn.setAttribute('aria-haspopup', 'menu');
  moreBtn.setAttribute('aria-expanded', 'false');
  moreBtn.onclick = (ev) => { ev.stopPropagation(); setMoreOpen(!moreEl.classList.contains('open')); };
  moreEl.appendChild(moreBtn);
  const menu = el('div', 'more-menu');
  menu.setAttribute('role', 'menu');
  copyMenuBtn = menuItem(t('copyPageShort'), copyShareLink);
  exportMenuBtn = menuItem(t('exportImage'), () => exportCardImage(exportMenuBtn));
  wideMenuBtn = menuItem(t('fullWidth'), toggleWide);
  wideMenuBtn.style.display = 'none';
  fsMenuBtn = menuItem(t('fullscreen'), toggleFullscreen);
  newTabMenuBtn = menuItem(t('newTab'), openInNewTab);
  menu.append(copyMenuBtn, exportMenuBtn, wideMenuBtn, el('div', 'more-sep'));
  const themeRow = el('div', 'more-theme');
  themeRow.appendChild(el('span', '', t('theme')));
  themeMenuSel = makeThemeSelect('');
  themeRow.appendChild(themeMenuSel);
  menu.append(themeRow, fsMenuBtn, newTabMenuBtn);
  moreEl.appendChild(menu);
  actions.appendChild(moreEl);

  headerEl.appendChild(actions);
  $app.appendChild(headerEl);
  if (statusBanner) $app.appendChild(statusBanner);

  // reader = 顶栏之下的唯一内容容器（无卡片边框/阴影）；文件根页隐藏
  // 面包屑（标题已自述），目录/子路径保留返回链（refresh 里按 entry 判定）
  readerEl = el('div', 'reader');
  crumbBarEl = crumbs(state.path);
  readerEl.appendChild(crumbBarEl);
  scrollEl = el('div', 'scroll');
  readerEl.appendChild(scrollEl);
  $app.appendChild(readerEl);

  // 全屏 API 缺失（旧 iOS 等）时诚实隐藏入口，不留死按钮
  if (!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen)) {
    fsBtn.style.display = 'none';
    fsMenuBtn.style.display = 'none';
  }
  setMoreOpen(false);
  syncWide();
  syncFullscreen();
}
`
