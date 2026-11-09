package share

// 访客协作位共享资产（P-20261024-1，guestboard.go 同款单一事实源模式）：
// 终端直播访客页挂载的两个协作位——
//   - 素材上行位（SC.collab）：「粘贴/拖入/点击」三入口 + 文字素材框 + 进度/
//     完成态；上传端点 POST /s/{token}/drop（multipart files+nickname），完成态
//     恢复取 GET /s/{token}/drops。手机测试主场景 = 点击「拍照」入口带
//     accept="image/*" capture（paste 在移动端是系统分享菜单形态）。
//   - 直通输入位（SC.directInput）：申请-批准握手 UI（申请 → 等待 → 持权输入）
//     + 持权倒计时；2s 轮询 /direct/state（直通位在场才轮询）。
//
// 折叠条 + 浮层（P-20261107-4）：协作位收起为常驻一行的协作条（标题 + 状态摘要
// + 展开钮），展开内容以浮层向上覆于终端卡片之上——素材清单/进度行/文字素材框
// 再长也不进列流（此前 .cl-root 在列流内随进度行撑高，挤压上方终端区，「此消彼
// 长」）。缺省收起；折叠态靠摘要给反馈（上传进度/已收份数/待批），失败与持权才
// 自动展开（需要访客看见的状态才打扰）。与留言板浮层互斥（同锚位不叠）。
//
// 粘贴链路（P-20261023-2 同哲学，P-20261107-4 实勘修复两类失败形态）：
//   ①访客点过终端区再 Ctrl+V——xterm 的 paste 处理器 stopPropagation，document
//     冒泡监听收不到（最常见的「贴图没反应」）→ 改捕获相监听；
//   ②剪贴板只有 HTML <img>（items 全是 kind=string，.files 为空——网页/办公/IM
//     软件复制图片的常见形态）→ items(kind=file) 兜底 + text/html 内联 data:image
//     解码成文件；外链图片跨域读不到字节，诚实提示改用「复制图片」。
//   可编辑目标（输入框/可写终端）里剪贴板带文字时文字粘贴优先不劫持；只读页面
//   上的纯文字粘贴送进文字素材框待访客确认（不直接上传）。
// 文字素材：访客输入/粘贴的文字由页面成 .txt 文件后走同一 /drop 上行链——白名单/
// 配额/频控/审计/通知/消费语义全复用，零新端点；与直通输入（PTY 键入通道）、
// 留言板（board 消息）三者语义各自独立。
//
// 渲染纪律与三页同款：零外部依赖、全部用户字符串 textContent 写入、
// 昵称沿用留言板 gb-nick 输入（单一身份源）。v1 只挂终端直播页
//（termpage.go）；文件/回放页后续增量（boot 态字段已预留）。

// collabCSS 协作位样式（termpage 模板以 {{.CollabCSS}} 注入 <style>；
// 变量取各页同源 :root 主题 token）
const collabCSS = `
.cl-root{position:relative;flex-shrink:0;margin-top:10px;background:var(--card);border:1px solid var(--border);
border-radius:12px}
.cl-head{display:flex;align-items:center;gap:8px;width:100%;border:none;background:transparent;
color:var(--text);padding:9px 14px;font-size:12.5px;font-weight:600;cursor:pointer;text-align:left;border-radius:12px}
.cl-head:hover{background:var(--hover)}
.cl-head .cl-sum{min-width:0;color:var(--muted);font-weight:400;font-size:11.5px;
overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.cl-head .cl-sum.err{color:#d64545}
.cl-head .cl-arrow{margin-left:auto;flex-shrink:0;color:var(--muted);transition:transform .15s}
.cl-root.open .cl-arrow{transform:rotate(180deg)}
.cl-panel{display:none;position:absolute;left:0;right:0;bottom:calc(100% + 6px);z-index:30;
max-height:min(62vh,560px);overflow:auto;background:var(--card);border:1px solid var(--border);
border-radius:12px;box-shadow:var(--shadow)}
.cl-root.open .cl-panel{display:block}
.cl-sec{padding:10px 14px}
.cl-sec+.cl-sec{border-top:1px solid var(--border)}
.cl-title{font-size:12.5px;font-weight:600;color:var(--text);margin:0 0 8px;
display:flex;align-items:center;gap:8px}
.cl-title .cl-hint{color:var(--muted);font-weight:400;font-size:11.5px}
.cl-drop{border:1.5px dashed var(--border);border-radius:10px;padding:12px 10px;
text-align:center;color:var(--muted);font-size:12px;cursor:pointer;
transition:border-color .15s,background .15s}
.cl-drop:hover,.cl-drop.over{border-color:var(--accent);background:var(--hover)}
.cl-acts{display:flex;gap:8px;justify-content:center;margin-top:8px;flex-wrap:wrap}
.cl-btn{border:1px solid var(--border);background:var(--hover);color:var(--text);
border-radius:999px;padding:5px 14px;font-size:12px;cursor:pointer}
.cl-btn:hover{border-color:var(--accent)}
.cl-btn.primary{border:none;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff}
.cl-btn:disabled{opacity:.55;cursor:default}
.cl-prog{margin-top:8px;display:flex;flex-direction:column;gap:6px}
.cl-item{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text)}
.cl-item .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cl-item .st{flex-shrink:0;color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.cl-item.ok .st{color:#2e9e5b}
.cl-item.err .st{color:#d64545}
.cl-bar{flex:1;height:4px;border-radius:2px;background:var(--hover);overflow:hidden;min-width:60px}
.cl-bar>i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--accent),var(--accent2));
transition:width .15s}
.cl-note{font-size:11.5px;color:var(--muted);margin-top:8px}
.cl-dinput{display:flex;flex-direction:column;gap:7px}
.cl-dinput textarea{border:1px solid var(--border);border-radius:8px;background:var(--hover);
color:var(--text);padding:7px 10px;font-size:12.5px;outline:none;font-family:inherit;resize:vertical;min-height:52px}
.cl-dinput textarea:focus{border-color:var(--accent)}
.cl-dfoot{display:flex;align-items:center;gap:8px}
.cl-dfoot .cnt{color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.cl-dfoot .send{margin-left:auto;border:none;background:linear-gradient(135deg,var(--accent),var(--accent2));
color:#fff;padding:5px 16px;border-radius:999px;font-size:12px;cursor:pointer}
.cl-dfoot .send:disabled{opacity:.6;cursor:default}
.cl-badge{display:inline-flex;align-items:center;gap:6px;background:var(--chip);
border:1px solid var(--border);border-radius:999px;padding:2px 10px;font-size:11px;color:var(--text)}
.cl-badge .dot{width:7px;height:7px;border-radius:50%;background:#ff5b5b;animation:pulse 1.6s ease-in-out infinite}
.cl-status{font-size:11.5px;color:var(--muted);min-height:1em;margin-top:4px}
.cl-status.err{color:#d64545}
.cl-drag-mask{display:none;position:absolute;inset:0;z-index:25;align-items:center;justify-content:center;
border:2px dashed var(--accent);border-radius:14px;background:var(--card);
background:color-mix(in srgb,var(--card) 82%,transparent);color:var(--text);font-size:13px;font-weight:600;pointer-events:none}
body.cl-dragging .cl-drag-mask{display:flex}
@media print{.cl-root,.cl-drag-mask{display:none!important}}
`

// collabJS 协作位脚本（termpage 模板以 {{.CollabJS}} 注入主 script 尾部，
// 在 guestBoardJS 之前挂载——插入位「留言板上方」按 gb-root 存在与否决定
// 锚点）。全部用户字符串 textContent 写入；取数只在直通位在场时轮询
const collabJS = `
(function mountCollab(){
  const wantUpload = !!SC.collab;
  const wantDirect = !!SC.directInput;
  if (!wantUpload && !wantDirect) return;
  const wrap = document.querySelector('.wrap');
  if (!wrap) return;
  const root = document.createElement('section');
  root.className = 'cl-root';
  root.setAttribute('data-testid', 'cl-root');
  // 协作条（常驻一行）：标题 + 状态摘要 + 展开钮；展开内容浮于终端区之上
  const head = document.createElement('button');
  head.type = 'button'; head.className = 'cl-head';
  head.setAttribute('data-testid', 'cl-toggle');
  head.setAttribute('aria-expanded', 'false');
  const headTtl = document.createElement('span');
  headTtl.textContent = wantUpload ? t('clUpTitle') : t('clDirectTitle');
  const sum = document.createElement('span'); sum.className = 'cl-sum';
  sum.setAttribute('data-testid', 'cl-summary');
  const arrow = document.createElement('span'); arrow.className = 'cl-arrow'; arrow.textContent = '▴';
  head.append(headTtl, sum, arrow);
  const panel = document.createElement('div'); panel.className = 'cl-panel';
  panel.setAttribute('data-testid', 'cl-panel');
  root.append(head, panel);
  const board = wrap.querySelector('.gb-root');
  if (board) wrap.insertBefore(root, board); else {
    const footer = wrap.querySelector('.footer');
    if (footer) wrap.insertBefore(root, footer); else wrap.appendChild(root);
  }
  function setOpen(on){
    root.classList.toggle('open', on);
    head.setAttribute('aria-expanded', on ? 'true' : 'false');
    // 与留言板浮层互斥（同锚位向上展开，叠放即互相遮挡）
    if (on) { const gb = document.querySelector('.gb-root.open'); if (gb) gb.classList.remove('open'); }
  }
  head.onclick = () => setOpen(!root.classList.contains('open'));
  document.addEventListener('click', (e) => {
    if (e.target && e.target.closest && e.target.closest('.gb-head')) setOpen(false);
  });
  // Esc 收起：只认浮层内的焦点（不抢终端/可写输入里的 Esc）
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { setOpen(false); head.focus(); }
  });
  // 折叠态摘要：上传进度/已收份数 · 直通态；默认显示用途说明
  const sumState = { up: '', direct: '', err: false };
  function renderSum(){
    const parts = [sumState.up, sumState.direct].filter(Boolean);
    sum.textContent = parts.length ? parts.join(' · ') : (wantUpload ? t('clUpHint') : t('clDirectHint'));
    sum.classList.toggle('err', !!sumState.err);
  }
  renderSum();
  // 昵称沿用留言板输入（gb-nick），无需本地状态——身份单一事实源在留言板
  function nickOf(){
    const el = document.querySelector('[data-testid="gb-nick"]');
    return el ? el.value : '';
  }
  function setStatus(box, msg, kind){
    if (!box) return;
    box.textContent = msg || '';
    box.className = 'cl-status' + (kind ? ' ' + kind : '');
  }
  function stamp(){
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  // ── 素材上行位 ──
  if (wantUpload) {
    const sec = document.createElement('div'); sec.className = 'cl-sec';
    const title = document.createElement('p'); title.className = 'cl-title';
    const ttl = document.createElement('span'); ttl.textContent = t('clUpTitle');
    const hint = document.createElement('span'); hint.className = 'cl-hint'; hint.textContent = t('clUpHint');
    title.append(ttl, hint);
    const drop = document.createElement('div'); drop.className = 'cl-drop';
    drop.setAttribute('data-testid', 'cl-drop');
    drop.textContent = t('clDropHint');
    const acts = document.createElement('div'); acts.className = 'cl-acts';
    const pick = document.createElement('button'); pick.type = 'button'; pick.className = 'cl-btn';
    pick.setAttribute('data-testid', 'cl-pick');
    pick.textContent = t('clPickFiles');
    const cam = document.createElement('button'); cam.type = 'button'; cam.className = 'cl-btn';
    cam.setAttribute('data-testid', 'cl-camera');
    cam.textContent = t('clCamera');
    acts.append(pick, cam);
    const prog = document.createElement('div'); prog.className = 'cl-prog';
    prog.setAttribute('data-testid', 'cl-prog');
    const note = document.createElement('p'); note.className = 'cl-note'; note.textContent = t('clUpNote');
    const status = document.createElement('div'); status.className = 'cl-status'; status.setAttribute('data-testid', 'cl-status');
    sec.append(title, drop, acts, prog, note, status);

    // 文字素材框：文字成 .txt 文件后走同一 /drop 上行链（零新端点）
    const TEXT_MAX = 100000;
    const tsec = document.createElement('div'); tsec.className = 'cl-sec';
    const ttitle = document.createElement('p'); ttitle.className = 'cl-title';
    const tttl = document.createElement('span'); tttl.textContent = t('clTextTitle');
    const thint = document.createElement('span'); thint.className = 'cl-hint'; thint.textContent = t('clTextHint');
    ttitle.append(tttl, thint);
    const tbox = document.createElement('div'); tbox.className = 'cl-dinput';
    const tta = document.createElement('textarea');
    tta.placeholder = t('clTextPh');
    tta.setAttribute('data-testid', 'cl-text');
    const tfoot = document.createElement('div'); tfoot.className = 'cl-dfoot';
    const tcnt = document.createElement('span'); tcnt.className = 'cnt'; tcnt.textContent = '0/' + TEXT_MAX;
    const tsend = document.createElement('button'); tsend.type = 'button'; tsend.className = 'send';
    tsend.setAttribute('data-testid', 'cl-text-send');
    tsend.textContent = t('clTextSend'); tsend.disabled = true;
    tfoot.append(tcnt, tsend);
    tbox.append(tta, tfoot);
    const tstatus = document.createElement('div'); tstatus.className = 'cl-status'; tstatus.setAttribute('data-testid', 'cl-text-status');
    tsec.append(ttitle, tbox, tstatus);
    panel.append(sec, tsec);

    const fileInput = document.createElement('input');
    fileInput.type = 'file'; fileInput.multiple = true; fileInput.style.display = 'none';
    fileInput.accept = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.md,.txt,.log,.csv,.tsv,.json,.xml,.yaml,.yml,.ini,.conf,.zip,.7z,.tar,.gz,.tgz';
    const camInput = document.createElement('input');
    camInput.type = 'file'; camInput.accept = 'image/*'; camInput.capture = 'environment';
    camInput.style.display = 'none';
    document.body.append(fileInput, camInput);

    drop.onclick = () => fileInput.click();
    pick.onclick = () => fileInput.click();
    cam.onclick = () => camInput.click();
    // 拖放区只做悬停视觉；投放由下方整页监听统一收口（防同一次投放双上传）
    drop.ondragover = () => drop.classList.add('over');
    drop.ondragleave = () => drop.classList.remove('over');
    fileInput.onchange = () => { uploadFiles(fileInput.files); fileInput.value = ''; };
    camInput.onchange = () => { uploadFiles(camInput.files); camInput.value = ''; };

    // 整页拖入（折叠态同样可投）：带文件的拖拽进入页面即在终端卡片上铺投放提示
    const mask = document.createElement('div'); mask.className = 'cl-drag-mask';
    mask.setAttribute('data-testid', 'cl-drag-mask');
    mask.textContent = t('clDragHint');
    const card = document.querySelector('.card');
    if (card) card.appendChild(mask);
    let dragDepth = 0;
    const hasFiles = (e) => {
      const ty = e.dataTransfer && e.dataTransfer.types;
      return !!ty && Array.from(ty).indexOf('Files') >= 0;
    };
    const endDrag = () => { dragDepth = 0; document.body.classList.remove('cl-dragging'); drop.classList.remove('over'); };
    document.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      dragDepth++;
      document.body.classList.add('cl-dragging');
    });
    document.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) endDrag();
    });
    document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    document.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      endDrag();
      uploadFiles(e.dataTransfer.files);
    });

    // ── 粘贴（捕获相：终端获焦时 xterm 的 paste 处理器会 stopPropagation，冒泡
    // 监听收不到——见文件头注失败形态①）──
    function pasteFiles(dt){
      const out = Array.from(dt.files || []);
      if (out.length) return out;
      // 失败形态②兜底：部分浏览器/来源 .files 为空而 items 里有 kind=file
      for (const it of Array.from(dt.items || [])) {
        if (it.kind === 'file') { const f = it.getAsFile(); if (f) out.push(f); }
      }
      return out;
    }
    // text/html 里的 <img>：内联 data:image 解码成文件；外链只能提示（跨域读不到字节）
    function htmlImage(html){
      if (!html || html.indexOf('<img') < 0) return {};
      const m = /<img[^>]+src\s*=\s*["']([^"']+)["']/i.exec(html);
      if (!m) return {};
      const src = m[1];
      const d = /^data:(image\/(png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(src);
      if (d) {
        try {
          const bin = atob(d[3].replace(/\s+/g, ''));
          const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          const sub = d[2].toLowerCase();
          const ext = sub === 'jpeg' ? 'jpg' : sub;
          const type = 'image/' + (ext === 'jpg' ? 'jpeg' : ext);
          return { file: new File([u8], t('clImgFile') + '-' + stamp() + '.' + ext, { type: type }) };
        } catch (e) { return {}; }
      }
      return { remote: /^(https?:|file:|blob:)/i.test(src) };
    }
    // 可编辑目标：输入框/可编辑区，以及「可写」状态的终端（键入目标）；只读终端不算
    function editableTarget(el){
      if (!el || !el.closest) return false;
      if (el.closest('.xterm')) return !term.options.disableStdin;
      const tag = (el.tagName || '').toLowerCase();
      return tag === 'textarea' || tag === 'input' || !!el.isContentEditable;
    }
    document.addEventListener('paste', (e) => {
      const dt = e.clipboardData;
      if (!dt) return;
      const editable = editableTarget(e.target);
      const text = dt.getData('text/plain') || '';
      // 可编辑目标且剪贴板带文字：文字粘贴优先（办公软件复制常同时附一张渲染图）
      if (editable && text.trim()) return;
      let files = pasteFiles(dt);
      let remote = false;
      if (!files.length) {
        const img = htmlImage(dt.getData('text/html') || '');
        if (img.file) files = [img.file];
        remote = !!img.remote;
      }
      if (files.length) {
        e.preventDefault(); e.stopPropagation();
        uploadFiles(files);
        return;
      }
      if (remote && !text.trim()) {
        e.preventDefault(); e.stopPropagation();
        setStatus(status, t('clPasteRemoteImg'), 'err');
        setOpen(true);
        return;
      }
      // 只读页面上的纯文字：送进文字素材框待访客确认（不直接上传）
      if (!editable && text.trim()) {
        e.preventDefault(); e.stopPropagation();
        tta.value = text;
        syncText();
        setOpen(true);
        tta.focus();
      }
    }, true);

    // XHR 上传（fetch 无上传进度——进度条是提案硬需求）
    function uploadOne(file, row, bar, st) {
      return new Promise((resolve) => {
        const fd = new FormData();
        fd.append('files', file, file.name);
        fd.append('nickname', nickOf());
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/s/' + SC.token + '/drop');
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            bar.style.width = pct + '%'; st.textContent = pct + '%';
          }
        };
        xhr.onload = () => {
          let ok = xhr.status === 200;
          if (ok) {
            // 白名单外/超限在 200 响应内以 kind=rejected 占位（服务端逐文件结算）
            try {
              const d = JSON.parse(xhr.responseText || '{}');
              const a = (d.added || [])[0];
              if (a && a.kind === 'rejected') ok = false;
            } catch (err) { /* 解析失败按成功态呈现（落盘已由 200 担保） */ }
          }
          if (ok) {
            row.classList.add('ok'); bar.style.width = '100%'; st.textContent = t('clDone');
          } else {
            row.classList.add('err');
            st.textContent = xhr.status === 413 ? t('clQuota') : (xhr.status === 429 ? t('clLimited') : t('clFailed'));
          }
          resolve(ok);
        };
        xhr.onerror = () => { row.classList.add('err'); st.textContent = t('clFailed'); resolve(false); };
        xhr.send(fd);
      });
    }
    // 批次串行（上一批未完时新粘贴/投放排队，不再静默丢弃）
    let chain = Promise.resolve(true);
    function uploadFiles(fileList) {
      const files = Array.from(fileList || []);
      if (!files.length) return Promise.resolve(false);
      chain = chain.then(() => runBatch(files), () => runBatch(files));
      return chain;
    }
    async function runBatch(files) {
      let allOk = true;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        sumState.up = t('clUploading').replace('{i}', String(i + 1)).replace('{n}', String(files.length));
        sumState.err = false;
        renderSum();
        const row = document.createElement('div'); row.className = 'cl-item';
        row.setAttribute('data-testid', 'cl-item');
        const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = f.name;
        const barBox = document.createElement('span'); barBox.className = 'cl-bar';
        const bar = document.createElement('i'); barBox.appendChild(bar);
        const st = document.createElement('span'); st.className = 'st'; st.textContent = '0%';
        row.append(nm, barBox, st);
        prog.insertBefore(row, prog.firstChild);
        if (!(await uploadOne(f, row, bar, st))) allOk = false;
      }
      await loadDone();
      if (!allOk) {
        // 失败需要访客看见逐文件原因：自动展开（成功只更新摘要不打扰）
        sumState.up = t('clSomeFailed'); sumState.err = true; renderSum();
        setOpen(true);
      }
      return allOk;
    }
    // 完成态恢复（刷新/重开不丢「我传过了」）——只列最近几条；摘要显示已收份数
    async function loadDone() {
      try {
        const res = await fetch('/s/' + SC.token + '/drops');
        if (!res.ok) return;
        const data = await res.json();
        const all = data.drops || [];
        const drops = all.slice(0, 8);
        prog.querySelectorAll('.cl-item.done-item').forEach((el) => el.remove());
        for (const d of drops) {
          const row = document.createElement('div'); row.className = 'cl-item ok done-item';
          row.setAttribute('data-testid', 'cl-done-item');
          const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = d.name;
          const st = document.createElement('span'); st.className = 'st';
          st.textContent = (d.consumedAt ? t('clUsed') : t('clReceived'));
          row.append(nm, st);
          prog.appendChild(row);
        }
        sumState.up = all.length ? t('clReceivedN').replace('{n}', String(all.length)) : '';
        sumState.err = false;
        renderSum();
      } catch (e) { /* 完成态恢复失败不影响上传位 */ }
    }
    loadDone();

    // 文字素材：计数/上限/提交（成功即清空；失败保留原文可重试）
    function textLen(){ return tta.value.length; }
    function syncText(){
      const n = textLen();
      tcnt.textContent = n + '/' + TEXT_MAX;
      const over = n > TEXT_MAX;
      tsend.disabled = over || !tta.value.trim();
      setStatus(tstatus, over ? t('clTextTooLong').replace('{n}', String(TEXT_MAX)) : '', over ? 'err' : '');
    }
    tta.oninput = syncText;
    tsend.onclick = async () => {
      if (tsend.disabled) return;
      const text = tta.value;
      tsend.disabled = true;
      const file = new File([text], t('clTextFile') + '-' + stamp() + '.txt', { type: 'text/plain' });
      const ok = await uploadFiles([file]);
      if (ok) tta.value = '';
      syncText();
      setStatus(tstatus, ok ? t('clDone') : t('clFailed'), ok ? '' : 'err');
    };
  }

  // ── 直通输入位 ──
  if (wantDirect) {
    const sec = document.createElement('div'); sec.className = 'cl-sec';
    const title = document.createElement('p'); title.className = 'cl-title';
    const ttl = document.createElement('span'); ttl.textContent = t('clDirectTitle');
    const hint = document.createElement('span'); hint.className = 'cl-hint'; hint.textContent = t('clDirectHint');
    title.append(ttl, hint);
    const status = document.createElement('div'); status.className = 'cl-status'; status.setAttribute('data-testid', 'cl-direct-status');
    const box = document.createElement('div'); box.className = 'cl-dinput';
    const ta = document.createElement('textarea');
    ta.maxLength = 4096; ta.placeholder = t('clDirectPh');
    ta.setAttribute('data-testid', 'cl-direct-text');
    const foot = document.createElement('div'); foot.className = 'cl-dfoot';
    const cnt = document.createElement('span'); cnt.className = 'cnt'; cnt.textContent = '0/4096';
    const send = document.createElement('button'); send.type = 'button'; send.className = 'send';
    send.setAttribute('data-testid', 'cl-direct-send');
    send.textContent = t('clDirectSend'); send.disabled = true;
    foot.append(cnt, send);
    box.append(ta, foot);
    const badge = document.createElement('span'); badge.className = 'cl-badge'; badge.style.display = 'none';
    const dot = document.createElement('i'); dot.className = 'dot';
    const badgeTxt = document.createElement('span'); badgeTxt.setAttribute('data-testid', 'cl-direct-badge');
    badge.append(dot, badgeTxt);
    sec.append(title, badge, status, box);
    panel.appendChild(sec);

    // 访客身份：首访生成随机 visitor id（localStorage 持久——SSE 断线重连
    // 凭它恢复持权；与昵称绑定关系仅本地语义，服务端只认 id）
    const VID_KEY = 'sc.share.visitorId';
    let visitorId = '';
    try {
      visitorId = localStorage.getItem(VID_KEY) || '';
      if (!visitorId) {
        visitorId = (crypto.randomUUID ? crypto.randomUUID() :
          'v-' + Date.now().toString(36) + Math.random().toString(36).slice(2));
        localStorage.setItem(VID_KEY, visitorId);
      }
    } catch (e) { visitorId = 'v-' + Date.now().toString(36) + Math.random().toString(36).slice(2); }

    let phase = 'none'; // none | pending | held
    let heldMine = false; // 本访客持权（首次进入时自动展开浮层，访客要看见输入框）
    function setDirectSum(text){ sumState.direct = text; renderSum(); }
    ta.oninput = () => {
      cnt.textContent = [...ta.value].length + '/4096';
      send.disabled = !phase || phase !== 'held' || ![...ta.value.trim()].length;
    };
    // 多行粘贴警示（提案：粘贴长度上限 4KB 与多行粘贴警示）
    ta.addEventListener('paste', (e) => {
      const text = e.clipboardData ? e.clipboardData.getData('text') : '';
      if (text && text.split(/\r\n|\r|\n/).length > 1) {
        if (!window.confirm(t('clDirectMultiline'))) { e.preventDefault(); return; }
      }
      if (new Blob([text]).size > 4096) {
        e.preventDefault();
        setStatus(status, t('clDirectTooLong'), 'err');
      }
    });
    async function post(path, body) {
      const res = await fetch('/s/' + SC.token + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      });
      let data = {};
      try { data = await res.json(); } catch (err) {}
      return { ok: res.ok, status: res.status, data };
    }
    send.onclick = async () => {
      const text = ta.value;
      if (!text.trim() || phase !== 'held') return;
      send.disabled = true;
      try {
        const r = await post('/direct/input', { visitorId, text });
        if (r.ok) {
          ta.value = ''; cnt.textContent = '0/4096';
          setStatus(status, t('clDirectSent'), '');
        } else if (r.status === 403) {
          phase = 'none'; renderNone(); setStatus(status, t('clDirectRevoked'), 'err');
        } else if (r.status === 410) {
          setStatus(status, t('clDirectGone'), 'err');
        } else {
          setStatus(status, t('clFailed'), 'err');
        }
      } catch (e) { setStatus(status, t('clFailed'), 'err'); }
      send.disabled = phase !== 'held' || !ta.value.trim();
    };
    const requestBtn = document.createElement('button');
    requestBtn.type = 'button'; requestBtn.className = 'cl-btn primary';
    requestBtn.setAttribute('data-testid', 'cl-direct-request');
    requestBtn.textContent = t('clDirectRequest');
    requestBtn.onclick = async () => {
      requestBtn.disabled = true;
      try {
        const r = await post('/direct/request', { visitorId, nickname: nickOf() });
        if (r.ok) { phase = 'pending'; setStatus(status, t('clDirectWaiting'), ''); }
        else setStatus(status, r.status === 429 ? t('clLimited') : t('clFailed'), 'err');
      } catch (e) { setStatus(status, t('clFailed'), 'err'); }
      requestBtn.disabled = false;
      poll();
    };
    function renderNone() {
      box.replaceChildren(requestBtn);
      badge.style.display = 'none';
      send.disabled = true;
      heldMine = false;
      setDirectSum('');
    }
    function renderPending() {
      box.replaceChildren();
      badge.style.display = 'none';
      send.disabled = true;
      heldMine = false;
      setDirectSum(t('clDirectPending'));
    }
    function renderHeld(mine, nick, remain) {
      if (mine) {
        if (!box.contains(ta)) box.replaceChildren(ta, foot);
        badge.style.display = '';
        badgeTxt.textContent = t('clDirectHeld').replace('{m}', String(Math.max(1, Math.ceil(remain / 60))));
        send.disabled = !ta.value.trim();
        if (!heldMine) { heldMine = true; setOpen(true); }
        setDirectSum(badgeTxt.textContent);
      } else {
        box.replaceChildren();
        badge.style.display = '';
        badgeTxt.textContent = t('clDirectOther');
        send.disabled = true;
        heldMine = false;
        setDirectSum(t('clDirectOther'));
      }
    }
    renderNone();
    async function poll() {
      try {
        const res = await fetch('/s/' + SC.token + '/direct/state?visitorId=' + encodeURIComponent(visitorId));
        if (!res.ok) { phase = 'none'; renderNone(); return; }
        const d = await res.json();
        if (d.status === 'held') {
          phase = 'held';
          renderHeld(!!d.mine, d.nick || '', d.remainSeconds || 0);
        } else if (d.status === 'pending') {
          phase = 'pending';
          renderPending();
          setStatus(status, t('clDirectWaiting'), '');
        } else {
          if (phase === 'held') setStatus(status, t('clDirectRevoked'), 'err');
          phase = 'none';
          renderNone();
        }
      } catch (e) { /* 网络闪断：保持当前态，下轮再对账 */ }
    }
    poll();
    setInterval(poll, 2000);
  }
})();
`
