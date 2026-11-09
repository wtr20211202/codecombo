package share

// 访客可写位共享资产（P-20261106-8，guestboard.go/collabpage.go 同款单一
// 事实源模式）：终端直播访客页挂载的「可写输入」位——WS 上行桥的浏览器侧
// 半边。挂载条件 = 记录 Writable 开（SC.writable），缺省零挂载（存量语义）。
//
// 行为契约（与 writable.go 服务端半边对账）：
//   - 输入通道只在 WS hello 后开启（term.options.disableStdin 翻转）——
//     页面加载即可写 ≠ 键入已通（还要过口令门/上限门/帧率门）；
//   - 键入经 onData → BinaryMessage 帧直发（按键帧/粘贴块同一通道，粘贴
//     的危险块审批在服务端 commandrisk 预检，页面只呈现状态）；
//   - 控制帧驱动状态面：hello/input_throttled/paste_review/paste_approved/
//     paste_denied/ended/writable_off（协议面见 writable.go handleTermWS 注）；
//   - 断连即回落只读并进入 5s 状态轮询——主人重新开启可写时页面自动重连
//     （「随时开关」的访客侧感知面；轮询节奏与直通档 2s 对账同族且更疏）；
//   - 出域警示横幅常驻（「你的输入将直达主人的终端」），可写位在场即不折叠。
//
// 渲染纪律与三页同款：零外部依赖、全部用户字符串 textContent 写入。

// writableCSS 可写位样式（termpage 模板以 {{.WritableCSS}} 注入 <style>；
// 变量取各页同源 :root 主题 token）
const writableCSS = `
.wr-strip{flex-shrink:0;display:flex;align-items:center;gap:8px;margin:8px 10px 0;
border-radius:9px;padding:6px 12px;font-size:12px;line-height:1.5}
.wr-strip.on{background:var(--warn-bg);border:1px solid var(--warn-bd);color:var(--warn-tx)}
.wr-strip.wait{background:var(--chip);border:1px solid var(--border);color:var(--text)}
.wr-strip.err{background:var(--warn-bg);border:1px solid var(--warn-bd);color:#d64545}
.wr-strip .dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:#ff9d2e;
animation:pulse 1.6s ease-in-out infinite}
.wr-strip.wait .dot{background:var(--accent);animation:none}
@media print{.wr-strip{display:none!important}}
`

// writableJS 可写位脚本（termpage 模板以 {{.WritableJS}} 注入主 script 尾部，
// 在 CollabJS 之后挂载——输入通道是本位的职责，协作位/留言板互不相干）
const writableJS = `
(function mountWritable(){
  if (!SC.writable) return;
  // 访客身份：与直通档同一 localStorage 键（sc.share.visitorId）——同浏览器
  // 两档身份一致，owner 侧徽标/审计的 visitorTail 指认统一
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
  function nickOf(){
    const el = document.querySelector('[data-testid="gb-nick"]');
    return el ? el.value : '';
  }

  // 状态条（card 顶部常驻）：on=可写在场 / wait=粘贴待批 / err=被拒/断连
  const card = document.querySelector('.card');
  const strip = document.createElement('div');
  strip.className = 'wr-strip';
  strip.setAttribute('data-testid', 'wr-strip');
  strip.style.display = 'none';
  const dot = document.createElement('i'); dot.className = 'dot';
  const stripTxt = document.createElement('span');
  stripTxt.setAttribute('data-testid', 'wr-text');
  strip.append(dot, stripTxt);
  if (card) card.insertBefore(strip, card.firstChild);
  function showStrip(state, msg){
    strip.style.display = '';
    strip.className = 'wr-strip ' + (state || '');
    stripTxt.textContent = msg || '';
  }
  function hideStrip(){ strip.style.display = 'none'; }

  let ws = null;          // 上行桥连接（null = 未接入）
  let wsOpen = false;     // hello 已到 = 键入通道开启
  let pollTimer = 0;
  let roTip0 = t('readonlyTip');

  // 键入通道：onData 一次挂载，内部按 wsOpen 闸——通道只在 hello 后开启
  term.onData((data) => {
    if (!wsOpen || !ws || ws.readyState !== 1) return;
    try { ws.send(new TextEncoder().encode(data)); } catch (e) {}
  });

  function setStdin(on){
    try {
      term.options.disableStdin = !on;
      // 光标可见性：只读态透明（服务端输出无本地光标语义），可写态点亮——
      // 访客要知道「键入会落在哪」
      term.options.theme = Object.assign({}, term.options.theme,
        on ? { cursor: '#3d7bfd', cursorAccent: '#3d7bfd' } : { cursor: 'transparent' });
    } catch (e) {}
  }
  function connect(){
    if (ws) return;
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    try {
      ws = new WebSocket(proto + location.host + '/s/' + SC.token +
        '/termws?visitorId=' + encodeURIComponent(visitorId) +
        '&nickname=' + encodeURIComponent(nickOf()));
    } catch (e) { ws = null; schedulePoll(); return; }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { /* hello 前不开输入——门禁全过才算接入 */ };
    ws.onmessage = (ev) => {
      let m = {};
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      switch (m.type) {
        case 'hello':
          wsOpen = true;
          setStdin(true);
          showStrip('on', t('wrOn'));
          $('roTip').textContent = t('wrTip');
          break;
        case 'input_throttled':
          showStrip('wait', t('wrThrottled'));
          break;
        case 'paste_review':
          showStrip('wait', t('wrReview'));
          break;
        case 'paste_approved':
          showStrip('on', t('wrOn'));
          break;
        case 'paste_denied':
          showStrip('err', t('wrDenied'));
          break;
        case 'ended':
          teardown(false);
          markEnded();
          break;
        case 'writable_off':
          teardown(true);
          break;
      }
    };
    ws.onclose = () => { ws = null; if (wsOpen) teardown(true); };
    ws.onerror = () => {};
  }
  function teardown(byPoll){
    wsOpen = false;
    setStdin(false);
    hideStrip();
    $('roTip').textContent = roTip0;
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    // 断连即回落只读 + 进入状态轮询：主人重新开启可写时自动重连
    if (byPoll) schedulePoll();
  }
  function schedulePoll(){
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      if (ws || ended) { if (ended && pollTimer) { clearInterval(pollTimer); pollTimer = 0; } return; }
      try {
        const res = await fetch('/s/' + SC.token + '/writable/state');
        if (!res.ok) return;
        const d = await res.json();
        if (d.writable) { clearInterval(pollTimer); pollTimer = 0; connect(); }
      } catch (e) { /* 网络闪断：下轮再对账 */ }
    }, 5000);
  }

  if (ended) return; // 直播已结束：不挂轮询不接线（markEnded 已收场）
  if (SC.writable) connect();
})();
`
