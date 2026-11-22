package share

// 访客输入位共享资产（P-20261106-8 可写分享，P-20261121-1 统一双授权模式，
// guestboard.go/collabpage.go 同款单一事实源模式）：终端直播访客页挂载的
// 「访客输入」位——WS 上行桥的浏览器侧半边，开放直入与申请批准两模式合一。
// 挂载条件 = 开放直入（SC.writable）或申请通道在场（SC.guestInput，缺省开）
// 任一；全关零挂载（存量语义）。
//
// 双授权模式（连接接入时点定格，hello 帧告知，服务端同款定格语义）：
//   - 开放直入（mode=open）：hello 即开键入——远程协助语义，「你的输入将
//     直达主人的终端」出域横幅常驻；
//   - 申请批准（mode=hold）：接入只看状态——申请（POST /s/{token}/direct/
//     request，唯一访客 HTTP 端点）→ 等待 → 持权；键入资格随持权
//    （direct_state 帧驱动，无持权时 xterm onData 不发帧——服务端另有
//     input_denied 兜底拒收）；收回/过期连接被服务端主动断开
//    （direct_revoked 帧）后回到「可重新申请」，自动重连取回状态面。
//
// 行为契约（与 writable.go 服务端半边对账）：
//   - 输入通道只在 WS hello 后开启（term.options.disableStdin 翻转；hold
//     模式再叠持权门）——页面加载可接入 ≠ 键入已通（还要过口令门/上限门/
//     帧率门/持权门）；
//   - 键入经 onData → BinaryMessage 帧直发（按键帧/粘贴块同一通道，粘贴
//     的危险块审批在服务端 commandrisk 预检，页面只呈现状态）；
//   - 视口反喂 resize（P-20261120-8）：键入资格开通后视口宽度经 TextMessage
//     控制帧反喂主机 PTY（「客户端窗口=终端宽度」，本地乐观先行 + SSE 回声
//     对账 + 主人动作抑制窗 + TmuxExternal 服务端拒绝），断连/失权即停用
//    （画布让渡随键入资格走）；
//   - hold 模式状态对账：约 10s 一发 {"type":"state"} Text 帧（服务端回
//     direct_state 帧并顺带惰性清扫超时持权——免 ticker 设计的对账触发器），
//     授予/收回各迁移点服务端主动推送；
//   - 控制帧驱动状态面：hello/input_throttled/input_denied/paste_review/
//     paste_approved/paste_denied/resize_applied/resize_denied/direct_state/
//     direct_revoked/ended/writable_off（协议面见 writable.go handleTermWS 注）；
//   - 断连即回落只读并进入 5s 状态轮询——主人开启任一授权模式时页面自动
//     重连（「随时开关」的访客侧感知面）。
//
// 渲染纪律与三页同款：零外部依赖、全部用户字符串 textContent 写入。

// writableCSS 可写位样式（termpage 模板以 {{.WritableCSS}} 注入 <style>；
// 变量取各页同源 :root 主题 token。P-20261118-9 评审裁定：合并条新样式落
// 本文件（仅 term 页注入）勿入 termlayout.go——frozen/cast 横幅零触碰。
// P-20261121-1：申请批准路径的「申请输入」按钮复用协作位 cl-btn 胶囊形态，
// 落状态条下的申请槽）
const writableCSS = `
/* 横幅合并（P-20261119-3）：可写状态段并入页首警示横幅（#maskBanner）右段——
   遮蔽/未过滤警示（左段，termpage 静态 DOM）与可写状态（右段，本脚本挂载）
   同槽单条，状态切换只换右段文案与色；原 card 顶独立 wr-strip 条退役
   （两条警示上下堆叠占两行 → 单条）。右段胶囊形态：margin-left:auto 推右，
   on/wait/err 三档状态色沿用旧条分档 */
.wr-strip{display:flex;align-items:center;gap:7px;margin-left:auto;flex-shrink:0;
border-radius:999px;padding:2px 10px;font-size:12px;line-height:1.5;font-weight:600}
.wr-strip.on{background:var(--warn-bg);border:1px solid var(--warn-bd);color:var(--warn-tx)}
.wr-strip.wait{background:var(--chip);border:1px solid var(--border);color:var(--text)}
.wr-strip.err{background:var(--warn-bg);border:1px solid var(--warn-bd);color:#d64545}
.wr-strip .dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:#ff9d2e;
animation:pulse 1.6s ease-in-out infinite}
.wr-strip.wait .dot{background:var(--accent);animation:none}
/* 两段布局红线（「显著不折叠」，P-20261118-9 裁定）：横幅开 flex-wrap，任何
   宽度下右段排不下都落到左段下一行、两段完整文案可见；≤640px 右段恒独占
   一行（评审必改4 窄屏裁定——390px 下左右同排必挤压裁切）；横幅缺席的防御
   回落（挂进 card 顶）沿用旧条纵向间距 */
.banner{flex-wrap:wrap}
.card .wr-strip{margin:8px 10px 0;border-radius:10px;padding:6px 12px}
@media (max-width:640px){
  .banner{row-gap:6px}
  .banner .wr-strip{flex-basis:100%;margin-left:0}
}
@media print{.wr-strip{display:none!important}}
`

// writableJS 可写位脚本（termpage 模板以 {{.WritableJS}} 注入主 script 尾部，
// 在 CollabJS 之后挂载——输入通道是本位的职责，协作位/留言板互不相干）
const writableJS = `
(function mountWritable(){
  if (!SC.writable && !SC.guestInput) return;
  // 访客身份：同一 localStorage 键（sc.share.visitorId）跨模式一致——持权
  // 绑定键与审计/可见性标识键同源，owner 侧徽标/审计的 visitorTail 指认统一
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

  // 状态条（横幅右段，P-20261119-3 横幅合并）：挂在页首警示横幅 #maskBanner
  // 内——左段遮蔽/未过滤警示原样，右段可写状态随协议换文案与色（showStrip/
  // hideStrip 协议驱动面零改动，testid wr-strip/wr-text 保持）。横幅缺席
  // （异常防御）回落 card 顶独立条（writableCSS 有对应间距规则）
  const banner = document.getElementById('maskBanner');
  const card = document.querySelector('.card');
  const strip = document.createElement('span');
  strip.className = 'wr-strip';
  strip.setAttribute('data-testid', 'wr-strip');
  strip.style.display = 'none';
  const dot = document.createElement('i'); dot.className = 'dot';
  const stripTxt = document.createElement('span');
  stripTxt.setAttribute('data-testid', 'wr-text');
  strip.append(dot, stripTxt);
  if (banner) banner.appendChild(strip);
  else if (card) card.insertBefore(strip, card.firstChild);
  function showStrip(state, msg){
    strip.style.display = '';
    strip.className = 'wr-strip ' + (state || '');
    stripTxt.textContent = msg || '';
  }
  function hideStrip(){ strip.style.display = 'none'; }

  // 申请批准路径的申请槽（状态条下的独立按钮行，仅 mode=hold 且无持权时
  // 在场；复用协作位 cl-btn 胶囊形态——浮层 absent 时贴 card 顶，凭挂在
  // strip 同侧的盒内不进列流）
  const reqBox = document.createElement('div');
  reqBox.setAttribute('data-testid', 'wr-request-box');
  reqBox.style.display = 'none';
  const reqBtn = document.createElement('button');
  reqBtn.type = 'button'; reqBtn.className = 'cl-btn';
  reqBtn.setAttribute('data-testid', 'wr-request');
  reqBtn.textContent = t('wrRequest');
  reqBox.appendChild(reqBtn);
  if (banner) banner.appendChild(reqBox);
  else if (card) card.insertBefore(reqBox, card.firstChild);

  let ws = null;          // 上行桥连接（null = 未接入）
  let wsOpen = false;     // hello 已到 = 接线成立（键入资格另看 mode/hold）
  let canType = false;    // 键入资格：open 模式 hello 即 true；hold 模式随持权
  let holdMode = false;   // 申请批准模式（连接定格）
  let stateTimer = 0;     // hold 模式状态对账轮询（10s）
  let remainSec = 0;      // 持权倒计时本地锚（direct_state.remainSeconds）
  let pollTimer = 0;
  let roTip0 = t('readonlyTip');

  // ── 视口反喂 resize 驱动（P-20261120-8，业界 ttyd/VS Code web 终端「客户端
  // 窗口=终端宽度」语义）：键入让渡的画布面——目标栅格 = 视口可用宽高 ÷ 基准
  // 字号格宽（原生 14px 零留白，替代 3× 巨字放大），经 WS 控制面反喂主机 PTY。
  // 只读页不挂本段（无 WS 上行，「只读页不新增 resize 上行」；只读栅格跟随
  // 主机变化仍走 SSE resize 帧 + scFitGrid 保真渲染）。画布让渡随键入资格：
  // hold 模式仅持权在窗口期驱动（失权即停用，服务端无持权 resize 帧兜底忽略）。
  // contention 三闸（评审必改4 定案）：①前端 250ms 防抖（窗口拖拽连续 resize）
  // + |目标−现值|≥2 才发（1 格抖动不发）；②服务端合并窗内主人/其他访客的写入
  // 经 SSE resize 帧回声到达——匹配自源值即回声清账，不匹配即主人侧动作，进
  // 10s 抑制窗跟随主人栅格不回踩（PSReadLine 收到 resize 会重发 banner 污染
  // scrollback，间歇期防抖动）；③TmuxExternal 会话服务端拒绝（resize_denied
  // 帧），驱动停用回落主机保真
  const VP_DEBOUNCE_MS = 250;
  const VP_MIN_DELTA = 2;
  const VP_OWNER_SUPPRESS_MS = 10000;
  const vp = { on: false, cols: 0, rows: 0, timer: 0, suppressUntil: 0 };
  function vpTarget(){
    const box = $('termBox');
    if (!box || !box.clientWidth) return null;
    const cs = getComputedStyle(box);
    const aw = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - SC_TERM_SB;
    const ah = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (!(aw > 0 && ah > 0)) return null;
    const cell = scCellAt(SC_TERM_FONT_SIZE);
    if (!(cell.w > 0 && cell.h > 0)) return null;
    // 钳制域与服务端（writable.go WritableResize 承接）逐字对齐——两端同域则
    // 应用值恒等于目标值，回声恒匹配，不产生钳制差振荡
    const cols = Math.max(20, Math.min(500, Math.floor(aw / cell.w)));
    const rows = Math.max(2, Math.min(300, Math.floor(ah / cell.h)));
    return { cols, rows };
  }
  function vpStopTimer(){
    if (vp.timer) { clearTimeout(vp.timer); vp.timer = 0; }
  }
  function vpSchedule(){
    if (!vp.on) return;
    vpStopTimer();
    vp.timer = setTimeout(vpSend, VP_DEBOUNCE_MS);
  }
  function vpSend(){
    vp.timer = 0;
    if (!vp.on || !canType || !ws || ws.readyState !== 1) return;
    if (Date.now() < vp.suppressUntil) return;
    if (!term.element) { vpSchedule(); return; } // 字体就绪开门竞态：等 term.open 后重试
    const tgt = vpTarget();
    if (!tgt) return;
    if (Math.abs(tgt.cols - vp.cols) < VP_MIN_DELTA && Math.abs(tgt.rows - vp.rows) < VP_MIN_DELTA) return;
    vp.cols = tgt.cols; vp.rows = tgt.rows;
    // 本地乐观先行（评审方案①）：渲染立即按目标栅格铺满视口，服务端应用后
    // SSE resize 帧同值回声对账（≤1s；合并窗/节流只在服务端侧，访客体感即时）
    setHost(tgt.cols, tgt.rows);
    try { ws.send(JSON.stringify({ type: 'resize', cols: tgt.cols, rows: tgt.rows })); } catch (e) {}
  }
  // 回声对账（termpage SSE resize 帧钩子注入，wrHostResize）：自源回声 = 应用
  // 值与我方上报一致，清账即可；不匹配 = 主人侧动作（本机窗口/API 抢回）——
  // 跟随主人栅格渲染（setHost 已由帧处理器执行）并进抑制窗，窗内不回踩
  wrHostResize = function(cols, rows){
    if (!vp.on || !(cols > 0 && rows > 0)) return;
    if (cols === vp.cols && rows === vp.rows) return;
    vp.cols = cols; vp.rows = rows;
    vp.suppressUntil = Date.now() + VP_OWNER_SUPPRESS_MS;
  };
  // 几何 kick（termpage layout() 钩子注入，wrLayoutHook）：窗口拖拽/横幅折行/
  // 页底浮层引起的容器变化重算目标——复用 scObserve 既有观测链，不另挂观察器
  wrLayoutHook = function(){ if (vp.on) vpSchedule(); };

  // 键入通道：onData 一次挂载，内部按 canType 闸——通道只在 hello（open 模式）
  // 或持权（hold 模式）后开启
  term.onData((data) => {
    if (!canType || !ws || ws.readyState !== 1) return;
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
  function setTyping(on){
    canType = on;
    setStdin(on);
    // 画布让渡随键入资格：反喂驱动随 on/off 同步（hold 失权即停用，重连
    // hello 重新开通）
    vp.on = on;
    if (on) {
      vp.suppressUntil = 0;
      vp.cols = (typeof hostCols === 'number' && hostCols > 0) ? hostCols : 0;
      vp.rows = (typeof hostRows === 'number' && hostRows > 0) ? hostRows : 0;
      vpSchedule();
    } else {
      vpStopTimer();
    }
  }

  // hold 模式状态面：direct_state 帧驱动（hello/轮询/迁移点同形）。状态条
  // 与申请槽互斥呈现——none=申请槽在场；pending/held=状态条；他人持权=
  // 状态条（无申请槽，等轮转）
  function applyDirectState(d){
    const st = d.status || 'none';
    if (st === 'held' && d.mine) {
      remainSec = d.remainSeconds || 0;
      reqBox.style.display = 'none';
      setTyping(true);
      showStrip('on', t('wrHeld').replace('{m}', String(Math.max(1, Math.ceil(remainSec / 60)))));
      $('sub').textContent = t('wrSubLive');
      $('roTip').textContent = t('wrTip');
      startStatePoll();
    } else if (st === 'held') {
      reqBox.style.display = 'none';
      setTyping(false);
      showStrip('wait', t('wrOther'));
      $('sub').textContent = t('readonlyTip');
      $('roTip').textContent = roTip0;
      startStatePoll();
    } else if (st === 'pending') {
      reqBox.style.display = 'none';
      setTyping(false);
      showStrip('wait', t('wrWaiting'));
      startStatePoll();
    } else {
      $('roTip').textContent = roTip0;
      reqBox.style.display = holdMode ? '' : 'none';
      setTyping(false);
      hideStrip();
      $('sub').textContent = t('readonlyTip');
      startStatePoll();
    }
  }

  // hold 模式状态对账轮询（约 10s 一发 {"type":"state"}——服务端回
  // direct_state 并顺带惰性清扫超时持权；键入帧本身也续期，轮询是
  // 「无输入期间」的兜底对账）。与 5s 断连轮询（schedulePoll）分表：
  // 本表只在 WS 在场时跑
  function startStatePoll(){
    if (stateTimer || !holdMode) return;
    stateTimer = setInterval(() => {
      if (!ws || ws.readyState !== 1) { stopStatePoll(); return; }
      try { ws.send(JSON.stringify({ type: 'state' })); } catch (e) {}
    }, 10000);
  }
  function stopStatePoll(){
    if (stateTimer) { clearInterval(stateTimer); stateTimer = 0; }
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
          if ((m.mode || 'open') === 'hold') {
            holdMode = true;
            // 申请批准路径：hello 后随帧的 direct_state 定状态面（申请槽/
            // 等待/持权）；键入资格随持权，此处只接线
            startStatePoll();
          } else {
            // 开放直入：hello 即键入资格（远程协助语义——出域警示横幅照常）
            reqBox.style.display = 'none';
            setTyping(true);
            showStrip('on', t('wrOn'));
            $('roTip').textContent = t('wrTip');
            // sub 所有权二分（P-20261119-3）：可写页 sub 由本位独占——键入
            // 通道确实开通（WS hello）才翻可写文案；termpage 的 ES hello 在
            // SC.writable 下不触 sub（到达顺序不定的双通道竞态在所有权边界
            // 消解），teardown 恢复只读文案
            $('sub').textContent = t('wrSubLive');
          }
          break;
        case 'direct_state':
          applyDirectState(m);
          break;
        case 'direct_revoked':
          // 持权收回/过期/关通道：服务端随帧断开本连接（onclose 收场）——
          // 状态条先给出可感知原因（wrRevoked 指明可重新申请；通道关闭是
          // wrClosed 专属文案），申请槽在重连后按对账态重出
          setTyping(false);
          showStrip('err', m.reason === 'channel_closed' ? t('wrClosed') : t('wrRevoked'));
          break;
        case 'resize_applied':
          // 服务端应用回执（500ms 合并窗后）：状态条诚实提示（必改6）+ 对账
          // 基准收敛——SSE resize 帧随后 ≤1s 到达同值，回声门判定自源不进
          // 抑制窗
          if (m.cols > 0 && m.rows > 0) { vp.cols = m.cols; vp.rows = m.rows; }
          if (canType) showStrip('on', t('wrResized'));
          break;
        case 'resize_denied':
          // 外部接管会话（TmuxExternal）服务端禁用访客 resize：驱动停用回落
          // 主机栅格保真（后续 SSE resize 帧照常跟随渲染），不重试
          vp.on = false;
          vpStopTimer();
          if (canType) showStrip('on', t('wrOn'));
          break;
        case 'input_throttled':
          showStrip('wait', t('wrThrottled'));
          break;
        case 'input_denied':
          // hold 模式无持权帧被服务端拒收（前端 canType 闸正常时不可达，
          // 防御对账：回到无持权态）
          applyDirectState({ status: 'none' });
          break;
        case 'paste_review':
          showStrip('wait', t('wrReview'));
          break;
        case 'paste_approved':
          showStrip(canType ? 'on' : 'wait', canType ? t('wrOn') : t('wrWaiting'));
          break;
        case 'paste_denied':
          showStrip('err', t('wrDenied'));
          break;
        case 'ended':
          teardown(false);
          markEnded();
          break;
        case 'writable_off':
          // 开放直入被 owner 关闭：断开回落只读（申请通道若在场，轮询会带
          // 页面重连进 hold 模式申请路径）
          teardown(true);
          break;
      }
    };
    ws.onclose = () => { ws = null; stopStatePoll(); if (wsOpen) teardown(true); };
    ws.onerror = () => {};
  }
  function teardown(byPoll){
    wsOpen = false;
    stopStatePoll();
    // 键入资格与画布反喂随通道关闭停用：上行桥断了就没有键入/resize 上行，
    // 显示栅格回落主机保真跟随（SSE resize 帧照常渲染）；重连 hello 重新接线
    setTyping(false);
    hideStrip();
    reqBox.style.display = 'none';
    $('roTip').textContent = roTip0;
    // sub 同步恢复只读文案（P-20261119-3）：writable_off/断连后输入通道已关，
    // 只读表述重新属实（ended 帧走 teardown(false) 后 markEnded 清 sub，
    // 恢复值随即被清不残留）
    $('sub').textContent = t('readonlyTip');
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    // 断连即回落只读 + 进入状态轮询：主人开启任一授权模式时自动重连
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
        if (d.writable || d.guestInput) { clearInterval(pollTimer); pollTimer = 0; connect(); }
      } catch (e) { /* 网络闪断：下轮再对账 */ }
    }, 5000);
  }

  // 申请输入（hold 模式申请槽）：POST /s/{token}/direct/request 唯一访客
  // HTTP 端点（键入与状态对账走 WS）。404=通道关闭/分享结束专属文案
  //（入口 gating 页载定死，页内 owner 关通道才触达）；429 频控文案不变
  reqBtn.onclick = async () => {
    reqBtn.disabled = true;
    try {
      const res = await fetch('/s/' + SC.token + '/direct/request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId, nickname: nickOf() })
      });
      let data = {};
      try { data = await res.json(); } catch (e) {}
      if (res.ok) {
        reqBox.style.display = 'none';
        showStrip('wait', t('wrWaiting'));
        if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ type: 'state' })); } catch (e) {} }
      } else {
        showStrip('err', res.status === 404 ? t('wrClosed') : (res.status === 429 ? t('clLimited') : t('clFailed')));
        reqBox.style.display = '';
      }
    } catch (e) { showStrip('err', t('clFailed')); reqBox.style.display = ''; }
    reqBtn.disabled = false;
  };

  if (ended) return; // 直播已结束：不挂轮询不接线（markEnded 已收场）
  connect();
})();
`
