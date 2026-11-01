package share

// 访客协作位共享资产（P-20261024-1，guestboard.go 同款单一事实源模式）：
// 终端直播访客页挂载的两个协作位——
//   - 素材上行位（SC.collab）：留言板上方的「粘贴/拖入/点击」三入口 +
//     进度/完成态；上传端点 POST /s/{token}/drop（multipart files+nickname），
//     完成态恢复取 GET /s/{token}/drops。粘贴同 P-20261023-2 哲学（paste
//     事件 clipboardData.files）；手机测试主场景 = 点击「拍照」入口带
//     accept="image/*" capture（paste 在移动端是系统分享菜单形态）。
//   - 直通输入位（SC.directInput）：申请-批准握手 UI（申请 → 等待 → 持权输入）
//     + 持权倒计时；2s 轮询 /direct/state（直通位在场才轮询）。
//
// 渲染纪律与三页同款：零外部依赖、全部用户字符串 textContent 写入、
// 昵称沿用留言板 gb-nick 输入（单一身份源）。v1 只挂终端直播页
//（termpage.go）；文件/回放页后续增量（boot 态字段已预留）。

// collabCSS 协作位样式（termpage 模板以 {{.CollabCSS}} 注入 <style>；
// 变量取各页同源 :root 主题 token）
const collabCSS = `
.cl-root{flex-shrink:0;margin-top:10px;background:var(--card);border:1px solid var(--border);
border-radius:12px;overflow:hidden}
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
@media print{.cl-root{display:none!important}}
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
  const board = wrap.querySelector('.gb-root');
  if (board) wrap.insertBefore(root, board); else {
    const footer = wrap.querySelector('.footer');
    if (footer) wrap.insertBefore(root, footer); else wrap.appendChild(root);
  }
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
    root.appendChild(sec);

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
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => {
      e.preventDefault(); drop.classList.remove('over');
      uploadFiles(e.dataTransfer && e.dataTransfer.files);
    };
    fileInput.onchange = () => { uploadFiles(fileInput.files); fileInput.value = ''; };
    camInput.onchange = () => { uploadFiles(camInput.files); camInput.value = ''; };
    // 粘贴入口（P-20261023-2 同哲学：paste 事件 clipboardData.files）
    document.addEventListener('paste', (e) => {
      const files = e.clipboardData && e.clipboardData.files;
      if (files && files.length) { e.preventDefault(); uploadFiles(files); }
    });

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
          if (xhr.status === 200) {
            row.classList.add('ok'); bar.style.width = '100%'; st.textContent = t('clDone');
            resolve(true);
          } else {
            row.classList.add('err');
            st.textContent = xhr.status === 413 ? t('clQuota') : (xhr.status === 429 ? t('clLimited') : t('clFailed'));
            resolve(false);
          }
        };
        xhr.onerror = () => { row.classList.add('err'); st.textContent = t('clFailed'); resolve(false); };
        xhr.send(fd);
      });
    }
    let busy = false;
    async function uploadFiles(fileList) {
      if (!fileList || !fileList.length || busy) return;
      busy = true;
      const files = Array.from(fileList);
      const note0 = prog.querySelector('.cl-idle');
      if (note0) note0.remove();
      for (const f of files) {
        const row = document.createElement('div'); row.className = 'cl-item';
        row.setAttribute('data-testid', 'cl-item');
        const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = f.name;
        const barBox = document.createElement('span'); barBox.className = 'cl-bar';
        const bar = document.createElement('i'); barBox.appendChild(bar);
        const st = document.createElement('span'); st.className = 'st'; st.textContent = '0%';
        row.append(nm, barBox, st);
        prog.insertBefore(row, prog.firstChild);
        await uploadOne(f, row, bar, st);
      }
      busy = false;
      loadDone();
    }
    // 完成态恢复（刷新/重开不丢「我传过了」）——只列最近几条
    async function loadDone() {
      try {
        const res = await fetch('/s/' + SC.token + '/drops');
        if (!res.ok) return;
        const data = await res.json();
        const drops = (data.drops || []).slice(0, 8);
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
      } catch (e) { /* 完成态恢复失败不影响上传位 */ }
    }
    loadDone();
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
    root.appendChild(sec);

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
    }
    function renderPending() {
      box.replaceChildren();
      badge.style.display = 'none';
      send.disabled = true;
    }
    function renderHeld(mine, nick, remain) {
      if (mine) {
        if (!box.contains(ta)) box.replaceChildren(ta, foot);
        badge.style.display = '';
        badgeTxt.textContent = t('clDirectHeld').replace('{m}', String(Math.max(1, Math.ceil(remain / 60))));
        send.disabled = !ta.value.trim();
      } else {
        box.replaceChildren();
        badge.style.display = '';
        badgeTxt.textContent = t('clDirectOther');
        send.disabled = true;
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
