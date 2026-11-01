package share

// 分享访客页内联 JS 段三：视图渲染与导航（P-20261007-22 纯搬运自 page.go
// 的 pageTmplSrc 模板段，零逻辑改动）——面包屑/目录表格/文件渲染/错误页/
// nav/refresh 主循环与页底访客留言板挂载（{{.BoardJS}} 注入点在段尾）

const pageTmplJsNavSrc = `function crumbs(current){
  const bar = el('div', 'crumbs');
  const parts = current ? current.split('/') : [];
  // 返回上级（业界文件管理器惯例）：非根层级显示 ↑ 按钮
  if (parts.length) {
    const up = el('button', 'up-btn');
    up.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
    up.title = t('backHome');
    up.onclick = () => nav(parts.slice(0, -1).join('/'));
    bar.appendChild(up);
  }
  const rootC = el('button', 'crumb' + (parts.length ? '' : ' cur'));
  rootC.textContent = t('appTitle');
  rootC.onclick = () => nav('');
  bar.appendChild(rootC);
  parts.forEach((p, i) => {
    bar.appendChild(el('span', 'sep', '›'));
    const isCur = i === parts.length - 1;
    const c = el('button', 'crumb' + (isCur ? ' cur' : ''));
    c.textContent = p;
    if (!isCur) c.onclick = () => nav(parts.slice(0, i + 1).join('/'));
    bar.appendChild(c);
  });
  return bar;
}
function setHeader(entry){
  state.entry = entry;
  const ic = headerEl.querySelector('.icon');
  ic.innerHTML = entry.isDir ? ICONS.folder : (ICONS[entry.kind] || ICONS.file);
  headerEl.querySelector('h1').textContent = entry.name || state.share.name;
  const bits = [state.share.projectName].filter(Boolean);
  bits.push(entry.isDir ? t('folder') : (entry.kind === 'snippet' ? t('snippetLabel') : t('file')));
  if (!entry.isDir) bits.push(fmtSize(entry.size));
  if (entry.modTime) bits.push(fmtTime(entry.modTime));
  subEl.textContent = bits.join('  ·  ');
  dlBtn.textContent = entry.isDir ? t('downloadZip') : t('download');
  // 片段无下载语义（内容经页面阅读 / raw 直取）：下载按钮与下载链接复制
  // 钮一并隐藏，只留页面链接（P-20261020-11 的拆分语义）
  const noDownload = entry.kind === 'snippet';
  dlBtn.style.display = noDownload ? 'none' : '';
  if (dlCopyBtn) dlCopyBtn.style.display = noDownload ? 'none' : '';
}
// 目录头摘要（P-20261020-11）：列表接口已有 entries/size，前端汇总——
// 目录条目本身的 size 是文件系统元数据（非递归），只累加文件，避免把
// 目录块大小混进「共 X」；项数仍按全部条目计（文件 + 子目录）
function updateDirSummary(entries){
  let total = 0;
  for (const e of entries) if (!e.isDir) total += e.size || 0;
  const bits = [
    state.share && state.share.projectName,
    t('folder'),
    t('dirSummary').replace('{count}', String(entries.length)).replace('{size}', fmtSize(total)),
  ];
  if (state.entry && state.entry.modTime) bits.push(fmtTime(state.entry.modTime));
  subEl.textContent = bits.filter(Boolean).join('  ·  ');
}

// 大目录提供即时过滤；列头点击排序（名称/大小/修改时间，目录恒在前）。
// 过滤词与排序选择存 dirView：轮询/刷新重渲染后保留，输入焦点不丢内容
let dirView = { key: '', dir: 1, q: '' };
function renderDir(entries){
  updateDirSummary(entries);
  scrollEl.replaceChildren();
  updateExportBtn(null);
  updateWideBtn(null);
  if (!entries.length) {
    scrollEl.appendChild(el('div', 'empty', t('emptyDir')));
    return;
  }
  const tbl = el('table', 'list');
  const thead = el('thead'); const trh = el('tr');
  const inds = {};
  const mkth = (label, key, cls) => {
    const th = el('th', cls + (key ? ' sortable' : ''));
    th.textContent = label;
    if (key) {
      inds[key] = th;
      th.onclick = () => {
        if (dirView.key === key) dirView.dir = -dirView.dir;
        else { dirView.key = key; dirView.dir = 1; }
        apply();
      };
    }
    return th;
  };
  trh.append(mkth(t('colName'), 'name', ''), mkth(t('colSize'), 'size', 'r col-size'),
    mkth(t('colModified'), 'modTime', 'r col-modified'));
  // 行内操作列无表头文案，留空 th 占位让固定列宽/列数与 tbody 对齐
  const actsTh = el('th', 'r acts-col');
  actsTh.setAttribute('aria-hidden', 'true');
  trh.appendChild(actsTh);
  thead.appendChild(trh); tbl.appendChild(thead);
  const tb = el('tbody'); tbl.appendChild(tb);
  let cntEl = null;
  if (entries.length >= 8) {
    const row = el('div', 'filter-row');
    const inp = document.createElement('input');
    inp.placeholder = t('filterPlaceholder');
    inp.value = dirView.q;
    cntEl = el('span', 'cnt', String(entries.length));
    inp.oninput = () => { dirView.q = inp.value; apply(); };
    row.appendChild(inp); row.appendChild(cntEl);
    scrollEl.appendChild(row);
  } else {
    dirView.q = '';
  }
  scrollEl.appendChild(tbl);
  const sortEntries = (list) => {
    if (!dirView.key) return list; // 默认序：后端已目录优先+按名
    const k = dirView.key, d = dirView.dir;
    return list.slice().sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // 目录恒在前
      let r = 0;
      if (k === 'size') r = (a.size || 0) - (b.size || 0);
      else if (k === 'modTime') r = (Date.parse(a.modTime) || 0) - (Date.parse(b.modTime) || 0);
      else {
        const an = (a.name || '').toLowerCase(), bn = (b.name || '').toLowerCase();
        r = an < bn ? -1 : (an > bn ? 1 : 0);
      }
      return r * d;
    });
  };
  function apply(){
    const q = dirView.q.trim().toLowerCase();
    const vis = entries.filter(e => !q || e.name.toLowerCase().includes(q));
    fillTable(tb, sortEntries(vis));
    if (cntEl) cntEl.textContent = String(vis.length);
    Object.keys(inds).forEach(key => {
      const th = inds[key];
      const old = th.querySelector('.sort-ind');
      if (old) old.remove();
      if (dirView.key === key) {
        const ind = document.createElement('span');
        ind.className = 'sort-ind';
        ind.textContent = dirView.dir > 0 ? '▲' : '▼';
        th.appendChild(ind);
      }
    });
  }
  apply();
}
function fillTable(tb, entries){
  tb.replaceChildren();
  for (const e of entries) {
    const tr = el('tr');
    const nm = el('td'); const wrap = el('div', 'cell-name');
    const ic = el('span'); ic.innerHTML = iconOf(e);
    // 窄屏（≤700px）修改时间列隐藏，改在名称下作副行（行宽收口，见 page-css）
    const box = el('div', 'nm-box');
    const nameEl = el('span', 'nm', e.name);
    nameEl.title = e.name; // 固定列宽下长名 ellipsis 收敛，悬浮可见全文
    box.appendChild(nameEl);
    box.appendChild(el('span', 'mtime-m', fmtTime(e.modTime)));
    wrap.append(ic, box);
    nm.appendChild(wrap); tr.appendChild(nm);
    tr.appendChild(el('td', 'r dim col-size', e.isDir ? '' : fmtSize(e.size)));
    tr.appendChild(el('td', 'r dim col-modified', fmtTime(e.modTime)));
    // 行内操作：单个文件/子目录均可直接下载或复制下载链接（目录为 .zip）
    const act = el('td', 'r acts');
    const acts = el('span', 'row-acts');
    const mk = (label, title, fn) => {
      const b = el('button', 'row-act', label);
      b.title = title;
      b.setAttribute('aria-label', title);
      b.onclick = (ev) => { ev.stopPropagation(); fn(); };
      return b;
    };
    acts.append(
      mk('⬇', t('download'), () => { anchorDownload(dlUrl(e.path, e.isDir), e.isDir ? '' : (e.name || '')); }),
      mk('⧉', t('copyDownloadLink'), () => {
        copyText(dlUrl(e.path, e.isDir)).then(ok => { flashToast(ok ? t('dlLinkCopied') : t('copyFailed')); });
      }),
    );
    act.appendChild(acts); tr.appendChild(act);
    tr.onclick = () => nav(e.path);
    tb.appendChild(tr);
  }
}
let toastTimer = null;
function flashToast(msg){
  let box = document.querySelector('.toast');
  if (!box) { box = el('div', 'toast'); document.body.appendChild(box); }
  box.textContent = msg; box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 1600);
}
// 页面内确认弹层（P-20261020-4）：不依赖原生 confirm（样式/可访问性跟页面走），
// 只承载「一段说明 + 取消/确认」——脚本运行风险确认的唯一消费方
function confirmAction(title, body, okText){
  return new Promise((resolve) => {
    const mask = el('div', 'confirm-mask');
    const dlg = el('div', 'confirm-dialog');
    dlg.appendChild(el('h3', '', title));
    dlg.appendChild(el('p', '', body));
    const acts = el('div', 'confirm-acts');
    const cancel = el('button', 'btn-ghost', t('cancel'));
    const ok = el('button', 'btn2', okText);
    const close = (v) => { mask.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (ev) => { if (ev.key === 'Escape') close(false); };
    cancel.onclick = () => close(false);
    ok.onclick = () => close(true);
    mask.onclick = (ev) => { if (ev.target === mask) close(false); };
    document.addEventListener('keydown', onKey);
    acts.append(cancel, ok); dlg.appendChild(acts); mask.appendChild(dlg);
    document.body.appendChild(mask);
    ok.focus();
  });
}

function renderFile(entry){
  scrollEl.replaceChildren();
  const kind = entry.kind;
  updateExportBtn(kind);
  updateWideBtn(kind);
  const pv = el('div', 'preview');

  if (kind === 'markdown' || kind === 'docx' || kind === 'csv' || kind === 'snippet') {
    // 服务端渲染净化片段：页内注入到 .md-article，reader 的 .scroll 是唯一
    // 滚动区（原 .preview 自滚会造成双滚动，锚点滚动/阅读列也不稳）。
    // 注入后跑通用增强管道（表格包裹/代码复制/标题锚点/图片灯箱）——
    // 对未来新片段类型同样自动生效。CSV 全宽横滚（.csv 解除阅读列上限）；
    // md/docx 保留 860px 阅读列，全宽切换只改 .wide 类（state 会话内记忆）
    const art = el('div', 'md-article' + (kind === 'csv' ? ' csv' : '') +
      (state.wide && (kind === 'markdown' || kind === 'docx') ? ' wide' : ''));
    pv.className = 'preview doc';
    pv.appendChild(art);
    // 片段：过期时点提示条（临时性是片段分享的显式语义）
    if (kind === 'snippet' && state.expiresAt) {
      pv.insertBefore(el('div', 'doc-note', t('snippetExpiresAt').replace('{time}', fmtTime(state.expiresAt))), art);
    }
    scrollEl.appendChild(pv);
    fetch(withPath('render', state.path))
      .then(r => {
        if (!r.ok) {
          // 超上限（413）给"仅下载"提示，其余失败给重试提示——
          // 绝不把后端 JSON 原文当 HTML 注入
          const e = new Error('render ' + r.status); e.code = (r.status === 413 ? 'too_large' : 'load'); throw e;
        }
        return r.text();
      })
      .then(html => { art.innerHTML = html; enhanceArticle(art); })
      .catch(e => { art.innerHTML = '<div class="doc-err">' + t(e && e.code === 'too_large' ? 'textTooLarge' : 'errorLoad') + '</div>'; });
    return;
  }
  if (kind === 'pdf' || kind === 'html') {
    // pdf：浏览器原生查看；html：/html 端点注入 <base> 后呈现——相对
    // css/img 子资源经 /f/ 路由回源分享根。脚本默认停用（iframe sandbox
    // 空值 + 响应 CSP sandbox 双层）；访客显式「运行脚本（隔离）」时两层
    // 同步只加 allow-scripts，绝不加 allow-same-origin——脚本页保持不透明
    // 源，读不到主应用 cookie/localStorage，表单/弹窗/顶层导航仍被禁用
    // css/img 子资源经 /f/ 路由回源分享根（脚本被 sandbox+CSP 双层拦死）。
    // 全幅形态：iframe 贴齐 reader（无内衬/圆角），由浏览器自身承接 PDF chrome
    pv.className = 'preview fill';
    const htmlUrl = (allow) => withPath('html', state.path) + (allow ? '&scripts=1' : '');
    const fr = document.createElement('iframe');
    fr.setAttribute('sandbox', '');
    fr.src = (kind === 'html') ? htmlUrl(false) : withPath('raw', state.path);
    pv.appendChild(fr);
    if (kind === 'pdf' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) {
      pv.insertBefore(el('div', 'doc-note', t('mobilePdfHint')), fr);
    }
    if (kind === 'pdf') appendPreviewTools(pv, () => withPath('raw', state.path));
    if (kind === 'html') {
      let scriptsOn = false;
      // 单文件分享的边界就是该 html 文件本身（同目录 css/img 不在分享内），
      // 相对资源必然 404——诚实说明并建议分享所在文件夹（P-20261020-4）
      if (state.share && !state.share.isDir) {
        pv.insertBefore(el('div', 'doc-note sc-html-single-note', t('htmlFileNote')), fr);
      }
      const note = el('div', 'doc-note sc-html-script-note');
      const label = el('span', '', t('htmlScriptOff'));
      const act = el('button', 'note-act', t('htmlScriptRun'));
      const apply = (allow) => {
        scriptsOn = allow;
        fr.setAttribute('sandbox', allow ? 'allow-scripts' : '');
        label.textContent = allow ? t('htmlScriptOn') : t('htmlScriptOff');
        act.textContent = allow ? t('htmlScriptStop') : t('htmlScriptRun');
        fr.src = htmlUrl(allow);
      };
      act.onclick = async () => {
        if (scriptsOn) { apply(false); return; }
        if (await confirmAction(t('htmlScriptConfirmTitle'), t('htmlScriptConfirmBody'), t('htmlScriptConfirmOk'))) {
          apply(true);
        }
      };
      note.append(label, act);
      pv.insertBefore(note, fr);
      appendPreviewTools(pv, () => htmlUrl(scriptsOn));
    }
  } else if (kind === 'image') {
    // 图片/音视频在页面画布居中适配（media 容器撑满 reader 高度）
    pv.className = 'preview media';
    appendPreviewTools(pv, () => withPath('raw', state.path));
    const img = document.createElement('img');
    img.alt = entry.name; img.src = withPath('raw', state.path);
    pv.appendChild(img);
  } else if (kind === 'video' || kind === 'audio') {
    pv.className = 'preview media';
    appendPreviewTools(pv, () => withPath('raw', state.path));
    const m = document.createElement(kind === 'video' ? 'video' : 'audio');
    m.controls = true; m.src = withPath('raw', state.path);
    pv.appendChild(m);
  } else if (kind === 'text') {
    // 纯文本/代码：页面底色 + 单滚动（pre 自身不滚、不铺底色）；工具条 P-11
    pv.className = 'preview text';
    // 文本/代码工具条（P-20261020-11）：复制全文/自动换行/行号——按钮
    // 常显（触屏无 hover），行号与高亮在大文件阈值处降级为纯 pre
    const tools = el('div', 'preview-tools');
    const copyAllBtn = el('button', 'tool-btn', t('copyAll'));
    copyAllBtn.title = t('copyAll');
    copyAllBtn.disabled = true;
    const wrapBtn = el('button', 'tool-btn', t('wrapLines'));
    wrapBtn.title = t('wrapLines');
    const lnBtn = el('button', 'tool-btn', t('lineNumbers'));
    lnBtn.title = t('lineNumbers');
    lnBtn.disabled = true;
    tools.append(copyAllBtn, wrapBtn, lnBtn);
    const body = el('div', 'text-body');
    pv.appendChild(tools);
    pv.appendChild(body);
    scrollEl.appendChild(pv);
    let rawText = '';
    const applyWrap = (v) => {
      textPrefs.wrap = v;
      wrapBtn.classList.toggle('on', v);
      wrapBtn.setAttribute('aria-pressed', v ? 'true' : 'false');
      const tgt = body.querySelector('.text-lines, .text-plain');
      if (tgt) tgt.classList.toggle('with-wrap', v);
    };
    const applyLn = (v) => {
      textPrefs.lines = v;
      lnBtn.classList.toggle('on', v && !lnBtn.disabled);
      lnBtn.setAttribute('aria-pressed', v ? 'true' : 'false');
      const box = body.querySelector('.text-lines');
      if (box) box.classList.toggle('with-ln', v);
    };
    applyWrap(textPrefs.wrap);
    applyLn(textPrefs.lines);
    wrapBtn.onclick = () => applyWrap(!textPrefs.wrap);
    lnBtn.onclick = () => { if (!lnBtn.disabled) applyLn(!textPrefs.lines); };
    copyAllBtn.onclick = () => {
      if (!rawText) return;
      copyText(rawText).then(ok => {
        if (ok) { copyAllBtn.textContent = t('copied'); setTimeout(() => { copyAllBtn.textContent = t('copyAll'); }, 1200); }
        else flashToast(t('copyFailed'));
      });
    };
    fetch(withPath('raw', state.path))
      .then(r => { if (!r.ok) throw new Error('raw ' + r.status); return r.text(); })
      .then(s => {
        rawText = s;
        const r = renderTextBody(body, s, entry.name);
        copyAllBtn.disabled = false;
        lnBtn.disabled = !r.rich;
        lnBtn.classList.toggle('on', r.rich && textPrefs.lines);
        lnBtn.title = r.rich ? t('lineNumbers') : t('largeFilePlain');
        lnBtn.setAttribute('aria-label', lnBtn.title);
        lnBtn.setAttribute('aria-pressed', r.rich && textPrefs.lines ? 'true' : 'false');
        // U+FFFD：非法 UTF-8 字节解码的标志（正文极少有意含它）
        if (s.indexOf('\uFFFD') >= 0) {
          pv.insertBefore(el('div', 'doc-note', t('encodingHint')), body);
        }
      })
      .catch(() => {
        body.replaceChildren(el('div', 'doc-err', t('errorLoad')));
        copyAllBtn.disabled = true;
        lnBtn.disabled = true;
      });
    return;
  } else {
    // 信息卡：不支持内联预览的格式
    const info = el('div', 'info');
    const big = el('div', 'big'); big.innerHTML = BIG(kind === 'info' ? 'info' : kind);
    info.appendChild(big);
    info.appendChild(el('h2', '', entry.name));
    info.appendChild(el('div', 'tip', t('unsupportedTip')));
    const kv = el('div', 'kv');
    const k1 = el('div'); k1.append(t('kindLabel'), el('b', '', (entry.name.split('.').pop() || '').toUpperCase()));
    const k2 = el('div'); k2.append(t('sizeLabel'), el('b', '', fmtSize(entry.size)));
    const k3 = el('div'); k3.append(t('modifiedLabel'), el('b', '', fmtTime(entry.modTime)));
    kv.append(k1, k2, k3);
    info.appendChild(kv);
    info.appendChild(el('br'));
    const dl = el('button', 'btn2', t('download'));
    dl.onclick = () => { anchorDownload(withPath('download', state.path), entry.name || ''); };
    info.appendChild(dl);
    scrollEl.appendChild(info);
    return;
  }
  scrollEl.appendChild(pv);
}

function renderError(code){
  const map = {
    share_not_found: ['errorShareNotFound', 'errorShareNotFoundD'],
    share_consumed: ['consumedHeading', 'consumedDesc'],
    target_gone: ['errorTargetGone', 'errorTargetGoneD'],
    target_missing: ['errorTargetMissing', 'errorTargetMissingD'],
  };
  const pair = map[code] || ['errorLoad', ''];
  scrollEl.replaceChildren();
  const st = el('div', 'status');
  const big = el('div', 'big'); big.innerHTML = BIG('info');
  st.appendChild(big);
  const txt = el('div');
  txt.appendChild(el('h2', '', t(pair[0])));
  if (pair[1]) txt.appendChild(el('p', '', t(pair[1])));
  st.appendChild(txt);
  scrollEl.appendChild(st);
}

async function nav(path){
  state.path = path || '';
  // 浏览器地址随定位更新（深链/刷新/复制当前页都落在同一目标）；受限
  // 环境（file/sandbox/历史被禁用）忽略，不影响页面内导航
  try { history.replaceState(null, '', pageUrl()); } catch (e) { /* ignore */ }
  loading();
  await refresh();
}
// Esc = 关闭导出预览弹层 > 收起「⋯」菜单 > 返回上级（目录浏览时）；根层级不动作
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (exportMask) { closeExportPreview(); return; }
  // 脚本确认弹层自管 Esc（其自己的 keydown 监听只关弹层）——这里先短路，
  // 否则会同时触发「返回上级」导航（目录分享下弹层与页面跳转一起发生）
  if (document.querySelector('.confirm-mask')) return;
  if (moreEl && moreEl.classList.contains('open')) { closeMore(); return; }
  if (state.path) nav(state.path.split('/').slice(0, -1).join('/'));
});
// 「⋯」菜单：点菜单/按钮之外任意处收起
document.addEventListener('click', (e) => {
  if (moreEl && !moreEl.contains(e.target)) closeMore();
});
function loading(){
  scrollEl.replaceChildren();
  scrollEl.scrollTop = 0;
  scrollEl.appendChild(el('div', 'spin'));
}

async function refresh(){
  progress(true);
  const keepScroll = scrollEl.scrollTop; // 轮询/手动刷新不扰动阅读位置
  try {
    const meta = await jfetch(withPath('meta', state.path));
    state.share = meta.share;
    state.expiresAt = meta.expiresAt || '';
    document.title = (meta.entry.name || meta.share.name) + ' · ' + t('appTitle');
    setHeader(meta.entry);
    // 单文件根页（无子路径）不渲染面包屑——文件名已在顶栏自述；目录与
    // 目录内文件保留返回链（P-20261020-7：进入 reader 仅留返回/面包屑条）
    const bar = crumbs(state.path);
    if (!meta.entry.isDir && !state.path) bar.style.display = 'none';
    crumbBarEl.replaceWith(bar);
    crumbBarEl = bar;
    if (meta.entry.isDir) {
      // 刷新按钮贴面包屑右侧：目录内容是实时读取，新增文件点一下即见
      const rb = el('button', 'crumb-refresh');
      rb.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"/></svg>';
      rb.title = t('refresh');
      rb.onclick = () => { void refresh(); };
      bar.appendChild(rb);
      const lst = await jfetch(withPath('list', state.path));
      renderDir(lst.entries);
    } else if (meta.entry.kind === 'text' && meta.entry.size > 20 * 1024 * 1024) {
      // 文本预览上限与服务端 markdown 渲染上限同源（20MB）：再大的文本
      // 浏览器整段读入体验变差，信息卡 + 下载更合适
      meta.entry.kind = 'info';
      renderFile(meta.entry);
      const tip = document.querySelector('.info .tip');
      if (tip) tip.textContent = t('textTooLarge');
    } else {
      renderFile(meta.entry);
    }
    scrollEl.scrollTop = keepScroll;
  } catch (e) {
    if (window.__SC_DEBUG) console.error('refresh fail', e && (e.stack || e.message));
    renderError(e && e.code);
  } finally {
    progress(false);
  }
}

buildShell();
mountWatermark(null);
loading();
refresh();
// 目录视图轻量轮询（20s）：新增/删除文件自动刷出（后端列表实时读目录）。
// 页面不可见、非目录视图、正在输入过滤词时跳过，不打扰操作
setInterval(() => {
  if (document.hidden) return;
  if (!state.entry || !state.entry.isDir) return;
  const inp = scrollEl.querySelector('.filter-row input');
  if (inp && document.activeElement === inp) return;
  void refresh();
}, 20000);

// 访客留言板（P-20261006-13）：页底留言区（三形态访客页同一段脚本，
// 单一事实源 guestboard.go；依赖上方 SC/t 已就绪，故置于主脚本尾）
{{.BoardJS}}
</script>
`
