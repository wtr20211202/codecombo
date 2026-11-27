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
//   - 聚焦态 Ctrl/Cmd+V（P-20261123-3）：可写位 custom key handler 放行浏览器
//     原生粘贴——文件/图片走上传链，纯文本走 xterm 原生 paste → onData → WS
//     （审批语义随之生效）。Ctrl+V 不再向主机发字面 ^V（终端内程序快捷键让位）；
//     只读双关页不挂 handler，保持 xterm 原行为；
//   - 视口反喂 resize（P-20261120-8，P-20261122-16 状态机治理）：键入资格开通后
//     视口宽度经 TextMessage 控制帧反喂主机 PTY（「客户端窗口=终端宽度」：
//     目标从**视口**算、双态确认（applied / SSE 同值回声才算改格，2s 未确认
//     回滚退避）、主人动作进抑制窗+棘轮、主人附着时服务端拒绝 owner_active、
//     窄屏（<80 列）不反喂），断连/失权即停用（画布让渡随键入资格走）；
//   - hold 模式状态对账：约 10s 一发 {"type":"state"} Text 帧（服务端回
//     direct_state 帧并顺带惰性清扫超时持权——免 ticker 设计的对账触发器），
//     授予/收回各迁移点服务端主动推送；
//   - 控制帧驱动状态面：hello/input_throttled/input_denied/paste_review/
//     paste_approved/paste_denied/resize_applied/resize_denied/direct_state/
//     direct_revoked/ended/writable_off（协议面见 writable.go handleTermWS 注）；
//   - 断连即回落只读并进入状态探测重连——主人开启任一授权模式时页面自动
//     接入（「随时开关」的访客侧感知面）。
//   - 生命周期（P-20261122-19）：任何 WS 断开（含 hello 前的握手失败与
//     denied 断开）都进入统一退避 1s→2s→5s→10s 封顶；每轮重连前先探
//     GET /writable/state（WS close 拿不到 HTTP 状态，升级 404/503 通常落到
//     1006）：404/410/401 停止（401 口令失效 → 回口令页）、200 且开关开启
//     即接入、200 双关继续 5s 等待。双关页不早退，探测到主人开启后惰性挂载
//     （window.__scMountWritable，不 reload 丢 scrollback）；探测/退避共用
//     一个 state 定时器（禁双跑）；
//   - 收回/关闭原因用独立 notice 元素呈现 ≥6s（#maskBanner 内 wr-notice）：
//     状态条 wr-strip 是协议驱动面，会被 teardown 与重连后的 direct_state
//     none 分支清掉——原因必须活过重连。
//   - 粘贴闸前可见化（P-20261123-1）：hold 未持权/未连线时粘贴不再静默——
//     诊断前置记账（gate/targetKind/holdMode/directStatus）+ 按原因给提示
//    （connecting/wrWaiting/wrOther/puNeedHold，同原因 10s 限频；collab 开
//     只记诊断不弹提示），申请槽在场时 reqBox 1.2s 高亮；输入框目标带文件
//     提示先聚焦终端（puFocusTerm）。**只可见化**：不 preventDefault、
//     不自动发起申请，键入/粘贴丢弃语义不变。
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
/* 独立原因公告（P-20261122-19 ③）：收回/关闭/上限等原因活过重连——与
   wr-strip 同为横幅右段胶囊，但生命周期不受协议状态面（hideStrip/none
   分支）支配，6.5s 自灭。窄屏独占行同 wr-strip 裁定 */
.wr-notice{display:flex;align-items:center;gap:7px;margin-left:auto;flex-shrink:0;
border-radius:999px;padding:2px 10px;font-size:12px;line-height:1.5;font-weight:600;
background:var(--warn-bg);border:1px solid var(--warn-bd);color:#d64545}
.card .wr-notice{margin:8px 10px 0;border-radius:10px;padding:6px 12px}
@media (max-width:640px){
  .banner .wr-notice{flex-basis:100%;margin-left:0}
}
@media print{.wr-notice{display:none!important}}
/* 申请槽粘贴引导高亮（P-20261123-1 ③）：闸前粘贴而无持权且对账状态=none
   时，把注意力指到「申请输入」入口——1.2s 一次性扩散环（不自动发起申请、
   不拦缺省动作）；prefers-reduced-motion 下退化为静态描边（无障碍偏好） */
.wr-req-flash{animation:wrReqFlash 1.2s ease-out 1;border-radius:999px}
@keyframes wrReqFlash{
  0%{box-shadow:0 0 0 0 rgba(61,123,253,.6)}
  100%{box-shadow:0 0 0 10px rgba(61,123,253,0)}
}
@media (prefers-reduced-motion:reduce){
  .wr-req-flash{animation:none;box-shadow:0 0 0 2px var(--accent)}
}
/* 卡片动作排 + 搜索条 + 瞬时提示（P-20261122-1 必改4/6/2 的访客侧 UI）：
   动作排挂卡片顶 in-flow 首行（上传钮/复制钮/搜索开关，cl-btn 胶囊复用）——
   不用 absolute 叠盖终端：claude code 等 TUI 全屏占满画布，顶右角落就是真实
   输出区，浮层会遮字（访客页终端内容不可让位）；搜索条挂卡片底部（card 是
   纵向 flex，追加行不挤压终端区——终端区 flex:1 吸收）；pu-tip 是底部居中
   瞬提示（2.4s 自灭——访客页无 toast 体系，进度/结果的最小反馈面）。
   P-20261122-18：动作排开 flex-wrap（三枚按钮在 390 窄屏允许换行而非被
   flex 压缩裁切，树头按钮组同一热区取态）*/
.wr-actions{flex-shrink:0;display:flex;flex-wrap:wrap;row-gap:6px;gap:6px;
justify-content:flex-end;padding:8px 10px 0}
.wr-actions .cl-btn{position:static;margin:0}
.wr-search{display:none;flex-shrink:0;gap:6px;align-items:center;
padding:6px 10px;border-top:1px solid var(--border);background:var(--card)}
.wr-search.open{display:flex}
.wr-search input{flex:1;min-width:0;border:1px solid var(--border);border-radius:8px;
background:transparent;color:var(--text);padding:4px 9px;font-size:12.5px}
.wr-search input:focus{outline:none;border-color:var(--accent)}
.wr-search-count{font-size:12px;color:var(--muted);min-width:64px;text-align:center;
white-space:nowrap;font-variant-numeric:tabular-nums}
.pu-tip{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:80;
background:var(--card);border:1px solid var(--border);border-radius:10px;
padding:6px 14px;font-size:12.5px;color:var(--text);box-shadow:var(--shadow);
max-width:86vw;text-align:center}
@media (max-width:640px){
  .wr-actions{padding:6px 8px 0}
}
@media print{.wr-actions,.wr-search,.pu-tip{display:none!important}}
`

// writableJS 可写位脚本（termpage 模板以 {{.WritableJS}} 注入主 script 尾部，
// 在 CollabJS 之后挂载——输入通道是本位的职责，协作位/留言板互不相干）
const writableJS = `
(function writableLifecycle(){
  // ── 生命周期外壳（P-20261122-19）─────────────────────────────────────
  // 与挂载解耦：双关只读页也进入（轻量 state 探测，主人开启后惰性挂载），
  // 已挂载页的断连重连也走同一探测入口。schedulePoll 与退避共用**一个**
  // state 定时器（pollTimer）——双跑会让「停止条件判定」与「重连」各跑
  // 一条链，出现暂停页仍在连、或退避档位互相覆盖。
  const IDLE_POLL_MS = 5000;                          // 双关/无连接等待
  const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000]; // 断连退避（封顶 10s）
  let pollTimer = 0;        // 唯一 state 探测定时器（等待与退避共用）
  let pollStopped = false;  // 终态（分享撤销/过期、口令失效、直播结束）不再重连
  let backoffStep = 0;      // 退避档位（hello 成功后复位）
  let mounted = false;      // 可写位 UI 是否已挂载（惰性挂载幂等闸）
  let reconnectFn = null;    // 首次挂载时的 connect 闭包——重连必须复用同一激活域
  // 上行桥连接（null = 未接入）：外壳的 state 探测要看它判「已在连接」，
  // 挂载内 connect/onclose 读写同一变量——不得在挂载函数内再声明（内层
  // 遮蔽会让外壳永远看到 null，探测与连接双跑）
  let ws = null;

  // 独立原因公告（P-20261122-19 ③）：收回/过期/通道关闭/被写上限的原因
  // 必须活过重连——wr-strip 是协议驱动面（teardown hideStrip + 重连后的
  // direct_state none 分支都会清掉它），故用独立元素。6.5s 自灭（≥6s：
  // 至少跨过一轮 5s 重连/对账）。元素按需懒建——双关页在停止条件触发时
  // 也要能播报（此时可写位尚未挂载）
  let noticeEl = null, noticeTxt = null, noticeTimer = 0;
  const NOTICE_MS = 6500;
  function ensureNotice(){
    if (noticeEl) return;
    noticeEl = document.createElement('span');
    noticeEl.className = 'wr-notice';
    noticeEl.setAttribute('data-testid', 'wr-notice');
    noticeEl.style.display = 'none';
    noticeTxt = document.createElement('span');
    noticeEl.appendChild(noticeTxt);
    const banner = document.getElementById('maskBanner');
    const card = document.querySelector('.card');
    if (banner) banner.appendChild(noticeEl);
    else if (card) card.insertBefore(noticeEl, card.firstChild);
  }
  function showNotice(msg){
    if (!msg) return;
    ensureNotice();
    noticeTxt.textContent = msg;
    noticeEl.style.display = '';
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { noticeEl.style.display = 'none'; noticeTimer = 0; }, NOTICE_MS);
  }

  function stopPoll(){
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = 0; }
  }
  // 退避档位前进（1s→2s→5s→10s 封顶）；hello 成功即复位
  function nextBackoffDelay(){
    const d = RECONNECT_BACKOFF_MS[Math.min(backoffStep, RECONNECT_BACKOFF_MS.length - 1)];
    if (backoffStep < RECONNECT_BACKOFF_MS.length - 1) backoffStep++;
    return d;
  }
  function schedulePoll(delay){
    if (pollTimer) return; // 已有在途调度（唯一 state 定时器，禁双跑）
    if (pollStopped || ended) return;
    pollTimer = setTimeout(pollState, typeof delay === 'number' ? delay : IDLE_POLL_MS);
  }
  // 终态停止：分享已撤销/过期 → 只公告；口令失效/确认 cookie 失效 → 回
  // 分享入口（口令页/确认页），交互面交还页面本身
  function endPolling(notice, toEntry){
    pollStopped = true;
    stopPoll();
    showNotice(notice);
    if (toEntry) {
      setTimeout(() => { try { location.href = '/s/' + SC.token; } catch (e) {} }, 600);
    }
  }
  // 唯一 state 探测（重连前的准入判定）：WS close 拿不到 HTTP 404/410/401
  // （升级失败通常落到 1006），停止条件只能由本端点给出。每轮先探后连：
  //   404/410 → 分享不存在/已过期（停止）
  //   401     → 口令会话失效（停止并回口令页）
  //   redirect→ 一次性确认 cookie 失效（停止并回确认页）
  //   其他非 2xx / 网络闪断 / 非 JSON → 按退避档重试（瞬时故障不判死）
  //   200     → writable||guestInput 即接入（未挂载先惰性挂载）；双关 5s 等待
  async function pollState(){
    pollTimer = 0;
    if (pollStopped || ended || ws) return;
    let res = null;
    try {
      res = await fetch('/s/' + SC.token + '/writable/state', { cache: 'no-store' });
    } catch (e) {
      schedulePoll(nextBackoffDelay()); // silent-by-design: 网络闪断是瞬时态，退避重试即反馈面
      return;
    }
    if (res.status === 401) { endPolling(t('wrPassExpired'), true); return; }
    if (res.status === 404 || res.status === 410) { endPolling(t('wrGone'), false); return; }
    if (res.redirected) { endPolling('', true); return; }
    if (!res.ok) { schedulePoll(nextBackoffDelay()); return; }
    let d = null;
    try { d = await res.json(); } catch (e) { d = null; }
    if (!d || typeof d !== 'object') { schedulePoll(nextBackoffDelay()); return; }
    if (pollStopped || ended || ws) return;
    if (d.writable || d.guestInput) {
      // 开关以探测结果为准：boot 里的 SC 是页面渲染时点的快照，双关页在
      // 主人开启后仍是旧值——不更新则 mountWritable 的门控早退
      SC.writable = !!d.writable;
      SC.guestInput = !!d.guestInput;
      if (mounted) {
        // 已挂载不重入 mountWritable：每次调用是新的函数激活，其 const/let
        // 绑定（reqBox/canType/vp…）都停在 TDZ，connect 的帧处理器会整体
        // 失效（ReferenceError）——重连必须复用首次挂载的闭包
        if (reconnectFn) reconnectFn(); else schedulePoll(nextBackoffDelay());
        return;
      }
      mountWritable(); // 双关页首次开启：惰性建 UI 并接入
      return;
    }
    schedulePoll(IDLE_POLL_MS); // 双关：继续等主人开启
  }

  // ── 可写位挂载（P-20261122-19 ④：IIFE 改可调用）────────────────────
  // 双关页由 pollState 探测到开启后经此惰性挂载——不 reload（访客已滚动的
  // scrollback/选区不被销毁）。幂等：重复调用直接返回（已挂载页的重连走
  // reconnectFn 复用的 connect 闭包，不得重入本函数——见 pollState 注）。
  function mountWritable(){
    if (!SC.writable && !SC.guestInput) return;
    if (mounted) return; // 幂等：重复调用不再新建闭包（重连走 reconnectFn）
    mounted = true;
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

  let wsOpen = false;     // hello 已到 = 接线成立（键入资格另看 mode/hold）
  let canType = false;    // 键入资格：open 模式 hello 即 true；hold 模式随持权
  let holdMode = false;   // 申请批准模式（连接定格）
  // 最近一次 direct_state 的 status（P-20261123-1 ②，applyDirectState 入口
  // 更新）：闸前粘贴的原因分档用它，而不是「申请槽是否在场」——pending 时
  // 申请槽已隐藏，按在场性判定会把「等待批准」误报成「先申请」。
  // 取值 none/pending/held（held 且 canType=false 即他人持权）
  let lastDirectStatus = 'none';
  let stateTimer = 0;     // hold 模式状态对账轮询（10s）
  let remainSec = 0;      // 持权倒计时本地锚（direct_state.remainSeconds）
  // 注意：重连/等待的 state 定时器（pollTimer）在外层生命周期外壳——此处
  // 不得再声明同名变量（内层遮蔽会让外层探测永远停摆）；hold 的 10s 对账
  // 是另一条只在 WS 在场时跑的定时器（stateTimer），两者不共表
  let roTip0 = t('readonlyTip');

  // ── 视口反喂 resize 驱动（P-20261120-8，业界 ttyd/VS Code web 终端「客户端
  // 窗口=终端宽度」语义；P-20261122-16 状态机治理）：键入让渡的画布面——目标
  // 栅格从**视口**算（原生 14px 零留白，替代 3× 巨字放大），经 WS 控制面反喂
  // 主机 PTY。只读页不挂本段（无 WS 上行，「只读页不新增 resize 上行」；只读
  // 栅格跟随主机变化仍走 SSE resize 帧 + scFitGrid 保真渲染）。画布让渡随键入
  // 资格：hold 模式仅持权在窗口期驱动（失权即停用，服务端无持权 resize 帧兜底
  // 忽略）。
  // contention 五闸（P-20261120-8 评审定案 + P-20261122-16 修正）：
  //   ①前端 250ms 防抖 + |目标−已确认栅格|≥2 才发（1 格抖动不发）；
  //   ②服务端 conn 级 1s 节流 + token 500ms 合并窗（访客上报只作请求，栅格以
  //     确认帧为准）；
  //   ③**双态确认**（P-20261122-16 ②）：vp.wantCols/wantRows = 在途请求目标，
  //     hostCols/hostRows = 已确认主机栅格。发送不再本地乐观 setHost——服务端
  //     applied 回执或 SSE 同值回声到达才换栅格；2s 未确认即撤销请求、回滚已
  //     确认栅格并 5s 退避（旧实现乐观先行后无回滚：节流/合并窗/TmuxExternal
  //     拒绝后栅格永远停在「以为自己改成了」的值）；
  //   ④主人动作闸（P-20261122-16 ③/④）：SSE resize 帧值与在途请求不符 = 主人
  //     侧动作（本机窗口/PUT API/其他访客），跟随主人栅格 + 10s 抑制窗 + 置
  //     ownerHold——**不再因状态刷新被清零**（旧实现 hold 模式每 10s 的
  //     direct_state 重跑 setTyping(true) 清 suppressUntil，主人抢回每 10s 被
  //     回踩一次）；ownerHold 只在访客自己改窗口宽（几何真变=显式重新让渡）
  //     或重新获得键入资格时解除；
  //   ⑤窄屏不反喂（P-20261122-16 ⑤）：目标 <80 列（手机竖屏）直接不驱动，渲染
  //     保持主机栅格——硬喂窄列只会把主人终端压成窄条、让自己横滚
  const VP_DEBOUNCE_MS = 250;
  const VP_MIN_DELTA = 2;
  const VP_OWNER_SUPPRESS_MS = 10000;
  const VP_CONFIRM_MS = 2000;        // 请求确认窗（applied / SSE 同值回声）
  const VP_RETRY_BACKOFF_MS = 5000;  // 未确认回滚后的退避
  const VP_OWNER_RETRY_MS = 30000;   // owner_active 拒绝后的退避（不永久停驱动）
  const VP_MIN_FEED_COLS = 80;       // 窄屏下限：目标 <80 列不反喂
  const VP_GEOM_EPS = 8;             // 访客改窗口的判定阈值（px，滤过亚像素抖动）
  // 36 = term-box 左右内边距 20 + 卡片边框 2 + 滚动条让位 14（与 termlayout
  // scTermNeed 同源常量——那侧的 +2 列只服务容器留白，不再被目标计算回读）
  const VP_CHROME_X = 36;
  const vp = {
    on: false,          // 驱动开关（随键入资格；失权/断连即停）
    wantCols: 0, wantRows: 0, // 在途请求目标（0 = 无在途请求）
    pendingUntil: 0,    // 请求确认截止
    // 最近一次 resize_applied 的应用值（P-20261122-16 ②）：applied 回执走 WS、
    // SSE 回声走另一条连接，回执通常先到并清掉在途请求——随后 ≤1s 到的同值
    // SSE 帧若无此锚会被误判成「主人侧动作」（每次自源改格都白进抑制窗）
    appliedCols: 0, appliedRows: 0,
    suppressUntil: 0,   // 主人动作抑制窗
    retryAt: 0,         // 退避截止（未确认 5s / owner_active 30s）
    ownerHold: false,   // 主人改格后「画布以主机为准」棘轮（访客改窗口才解除）
    latchW: 0,          // 置棘轮时的视口宽（几何真变判定基准）
    note: '',           // 状态条后缀（owner_active 等可见提示）
    timer: 0,           // 250ms 防抖
    wait: 0             // 确认窗/退避的一次性重算
  };
  function vpTarget(){
    // 视口稳定宽（P-20261122-16 根因 A）：只从**文档视口**减 .wrap 的 computed
    // 左右内边距与固定 chrome 算——不再读 termBox.clientWidth：它由 --term-need
    // 反推（scTermNeed 写 ceil((n+2)*cw+36)），拿它除以格宽恒得 n+2，每轮 +2 列
    // 正反馈直到视口/500 上限（实测 2048 视口约 17 轮、3840 约 105 轮——「感觉
    // 不停在调整终端面板大小」与 owner 侧 share.wresize toast 风暴的直接成因）。
    // 视口宽不随 --term-need 变化，目标一次到位、后续无差可发
    const docW = document.documentElement.clientWidth;
    const box = $('termBox');
    if (!box || !(docW > 0)) return null;
    let padX = 0;
    const wrap = box.closest('.wrap');
    if (wrap) {
      const wcs = getComputedStyle(wrap);
      padX = (parseFloat(wcs.paddingLeft) || 0) + (parseFloat(wcs.paddingRight) || 0);
    }
    const aw = docW - padX - VP_CHROME_X;
    // 高度照读容器（flex 定高，不参与反喂反馈环）；rows 与 cols 同域钳制
    const bcs = getComputedStyle(box);
    const ah = box.clientHeight - parseFloat(bcs.paddingTop) - parseFloat(bcs.paddingBottom);
    if (!(aw > 0 && ah > 0)) return null;
    const cell = scCellAt(SC_TERM_FONT_SIZE);
    if (!(cell.w > 0 && cell.h > 0)) return null;
    const cols = Math.min(500, Math.floor(aw / cell.w));
    const rows = Math.max(2, Math.min(300, Math.floor(ah / cell.h)));
    return { cols, rows };
  }
  function vpStopTimer(){
    if (vp.timer) { clearTimeout(vp.timer); vp.timer = 0; }
  }
  function vpStopWait(){
    if (vp.wait) { clearTimeout(vp.wait); vp.wait = 0; }
  }
  function vpClearWant(){
    vp.wantCols = 0; vp.wantRows = 0; vp.pendingUntil = 0;
    vpStopWait();
  }
  function vpSchedule(){
    if (!vp.on) return;
    vpStopTimer();
    vp.timer = setTimeout(vpSend, VP_DEBOUNCE_MS);
  }
  // 到点重算（退避到期/抑制窗到期）：统一走防抖入口，届时重新量视口
  function vpArmAt(at){
    vpStopWait();
    if (!vp.on) return;
    vp.wait = setTimeout(function(){ vp.wait = 0; vpSchedule(); }, Math.max(50, at - Date.now()));
  }
  // 确认窗到期：未确认即回滚（栅格本就未乐观改动 → 显式复位已确认值）并退避
  function vpArmConfirm(){
    vpStopWait();
    if (!vp.on || !vp.wantCols) return;
    vp.wait = setTimeout(vpConfirmTimeout, Math.max(50, vp.pendingUntil - Date.now()));
  }
  function vpConfirmTimeout(){
    vp.wait = 0;
    if (!vp.on || !vp.wantCols) return;
    if (Date.now() < vp.pendingUntil) { vpArmConfirm(); return; }
    vpClearWant();
    if (hostCols > 0 && hostRows > 0) setHost(hostCols, hostRows); // 回滚已确认栅格
    vp.retryAt = Date.now() + VP_RETRY_BACKOFF_MS;
    vpArmAt(vp.retryAt);
  }
  function vpSend(){
    vp.timer = 0;
    if (!vp.on || !canType || !ws || ws.readyState !== 1) return;
    const now = Date.now();
    if (now < vp.suppressUntil) { vpArmAt(vp.suppressUntil); return; }
    if (now < vp.retryAt) { vpArmAt(vp.retryAt); return; }
    if (vp.ownerHold) return; // 主人改格后画布以主机为准（访客改窗口才解除）
    if (!term.element) { vpSchedule(); return; } // 字体就绪开门竞态：等 term.open 后重试
    const tgt = vpTarget();
    if (!tgt) return;
    if (tgt.cols < VP_MIN_FEED_COLS) return; // 窄屏不反喂（保持主机栅格）
    const hc = (typeof hostCols === 'number') ? hostCols : 0;
    const hr = (typeof hostRows === 'number') ? hostRows : 0;
    if (Math.abs(tgt.cols - hc) < VP_MIN_DELTA && Math.abs(tgt.rows - hr) < VP_MIN_DELTA) {
      vpClearWant(); // 已确认栅格即目标：无事务
      return;
    }
    if (vp.wantCols && vp.wantCols === tgt.cols && vp.wantRows === tgt.rows &&
      now < vp.pendingUntil) return; // 同目标在确认窗内只发一帧
    vp.wantCols = tgt.cols; vp.wantRows = tgt.rows;
    vp.pendingUntil = now + VP_CONFIRM_MS;
    try { ws.send(JSON.stringify({ type: 'resize', cols: tgt.cols, rows: tgt.rows })); } catch (e) {
      vpClearWant(); return;
    }
    vpArmConfirm();
  }
  // 状态条文案（P-20261122-16 ③）：反喂态备注（owner_active）拼在持权/可写文案后
  // ——状态刷新只更新这一段，不动反喂态本身
  function vpStripText(){
    const base = holdMode
      ? t('wrHeld').replace('{m}', String(Math.max(1, Math.ceil(remainSec / 60))))
      : t('wrOn');
    return vp.note ? base + ' · ' + vp.note : base;
  }
  // 回声对账（termpage SSE resize 帧钩子注入，wrHostResize；帧处理器已 setHost）：
  // 同值 = 自源回声（在途请求值，或刚落地的应用值——applied 回执先到、SSE 回声
  // ≤1s 后到，二者都算自己）→ 确认清账；不同 = 主人侧动作（本机窗口/PUT API/
  // 其他访客）→ 撤销在途请求、进抑制窗并置 ownerHold 棘轮（窗内及之后都不回踩，
  // 直到访客自己改窗口——时间到点就重试会让主人刚调好的尺寸又被悄悄改回去）
  wrHostResize = function(cols, rows){
    if (!vp.on || !(cols > 0 && rows > 0)) return;
    if (vp.wantCols && cols === vp.wantCols && rows === vp.wantRows) { vpClearWant(); return; }
    if (vp.appliedCols && cols === vp.appliedCols && rows === vp.appliedRows) {
      // 应用回执的 SSE 回声（一次性锚：消费后清空，防主人后续同尺寸动作被吞）
      vp.appliedCols = 0; vp.appliedRows = 0;
      vpClearWant();
      return;
    }
    vpClearWant();
    vp.appliedCols = 0; vp.appliedRows = 0;
    vp.suppressUntil = Date.now() + VP_OWNER_SUPPRESS_MS;
    vp.ownerHold = true;
    vp.latchW = document.documentElement.clientWidth;
  };
  // 几何 kick（termpage layout() 钩子注入，wrLayoutHook）：窗口拖拽/横幅折行/
  // 页底浮层引起的容器变化重算目标——复用 scObserve 既有观测链，不另挂观察器。
  // 视口宽真变（>阈值）= 访客显式重新让渡：解除主人棘轮与各路退避（主人可能
  // 已经离开、或访客就是要把新窗口宽度交给主机）；仅挪窗不改宽不解除
  wrLayoutHook = function(){
    if (!vp.on) return;
    const w = document.documentElement.clientWidth;
    if (Math.abs(w - vp.latchW) >= VP_GEOM_EPS) {
      vp.ownerHold = false;
      vp.suppressUntil = 0;
      vp.retryAt = 0;
      vp.latchW = w;
    }
    vpSchedule();
  };

  // Ctrl/Cmd+V 放行（P-20261123-3，用户实测「点击终端后 Ctrl+V 无反应」的根因）：
  // xterm 的 _keyDown 只在 custom handler 返回 false 时提前放行；默认路径把
  // Ctrl+V 译成 \x16 发 PTY 并 cancel(e,true)（preventDefault+stopPropagation）
  // ——浏览器原生 paste 永不派发，window 捕获相的粘贴链（文件/图片→上传→路径）
  // 在聚焦终端后整条失联。条件与产品内终端 useTerminalKeys 同源：ctrl/meta 双
  // 修饰，排除 AltGr（ctrl+alt）与 Ctrl+Shift+V（与复制族 Ctrl+Shift+C 区分）。
  // 显式取舍：Ctrl+V 不再向主机发字面 ^V（vim 块选择等终端内语义让位），文本
  // 粘贴改走原生 paste → xterm onData → WS（commandrisk/审批语义随之生效）。
  // xterm 仅一个 handler 槽位（分享页现无其他 handler）：未来分享页快捷键必须
  // 并入本函数并同步静态断言——二次 attach 会静默覆盖前一个 handler。
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true; // keyup/keypress 也过本槽，非 keydown 一律放行
    const mod = e.ctrlKey || e.metaKey;
    const isV = e.code === 'KeyV' || (e.key && e.key.toLowerCase() === 'v'); // e.code 兜底布局/输入法差异
    if (mod && !e.altKey && !e.shiftKey && isV) return false; // 放行浏览器原生粘贴
    return true;
  });

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
    const was = canType;
    canType = on;
    setStdin(on);
    // 画布让渡随键入资格，但**只在 0→1 这条边上初始化**（P-20261122-16 ③）：
    // hold 模式每 10s 的 direct_state 刷新会重跑本函数，若无条件重置就会清掉
    // 主人抢回的抑制窗、把 vp 栅格锚回主机值、重开已被拒绝停用的驱动——P-8 的
    // 「主人抢回 + 10s 抑制窗」于是每 10s 被清零一次（用户主诉第二条的直接成因）
    if (on && !was) {
      vp.on = true;
      vp.wantCols = 0; vp.wantRows = 0; vp.pendingUntil = 0;
      vp.appliedCols = 0; vp.appliedRows = 0;
      vp.suppressUntil = 0; vp.retryAt = 0; vp.note = '';
      vp.ownerHold = false;
      vp.latchW = document.documentElement.clientWidth;
      vpStopWait();
      vpSchedule();
    } else if (!on) {
      vp.on = false;
      vpStopTimer();
      vpStopWait();
      vp.wantCols = 0; vp.wantRows = 0; vp.pendingUntil = 0;
      vp.appliedCols = 0; vp.appliedRows = 0;
    }
  }

  // hold 模式状态面：direct_state 帧驱动（hello/轮询/迁移点同形）。状态条
  // 与申请槽互斥呈现——none=申请槽在场；pending/held=状态条；他人持权=
  // 状态条（无申请槽，等轮转）
  function applyDirectState(d){
    const st = d.status || 'none';
    lastDirectStatus = st; // 闸前粘贴的原因分档状态源（见声明处注）
    if (st === 'held' && d.mine) {
      remainSec = d.remainSeconds || 0;
      reqBox.style.display = 'none';
      setTyping(true); // 已持权时是幂等刷新（只在 0→1 边初始化反喂态）
      showStrip('on', vpStripText());
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
    } catch (e) { ws = null; schedulePoll(nextBackoffDelay()); return; }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { /* hello 前不开输入——门禁全过才算接入 */ };
    ws.onmessage = (ev) => {
      let m = {};
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      switch (m.type) {
        case 'hello':
          wsOpen = true;
          backoffStep = 0; // 接入成立：退避档位复位（下次断开从 1s 起）
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
          // 持权收回/过期/关通道：服务端随帧断开本连接（onclose 收场）。
          // 原因走独立 notice（P-20261122-19 ③）——状态条会在 teardown 与
          // 重连后的 direct_state none 分支被清掉，留不住「为什么被收回」；
          // 申请槽在重连后按对账态重出
          setTyping(false);
          showNotice(m.reason === 'channel_closed' ? t('wrClosed') : t('wrRevoked'));
          break;
        case 'denied':
          // 并发被写连接达上限（MaxWritersPerToken，服务端在 hello 前回帧
          // 并断开——P-20261122-19 ②）：可见提示 + 由 onclose 的统一退避
          // 重连兜底（一有空位即自动接入，无需刷新；帧丢失时仍按 close 退避）
          setTyping(false);
          showNotice(t('guestLimit'));
          break;
        case 'resize_applied':
          // 服务端应用回执（500ms 合并窗后）：确认我方在途请求（撤销 2s 确认
          // 窗的回滚）并记下应用值——SSE 同值回声随后 ≤1s 到达，靠 appliedCols
          // 锚识别为自源（否则每次自源改格都被误判成主人动作进抑制窗）
          if (m.cols > 0 && m.rows > 0) {
            vp.appliedCols = m.cols; vp.appliedRows = m.rows;
            if (vp.wantCols === m.cols && vp.wantRows === m.rows) vpClearWant();
          }
          vp.note = '';
          // 诚实回执（P-8 必改6 语义保持）：状态条翻「已按你的视口同步终端
          // 尺寸」；hold 模式的 10s 状态刷新随后把它换回持权文案（回执是瞬时
          // 确认不是常驻态）
          if (canType) showStrip('on', t('wrResized'));
          break;
        case 'resize_denied': {
          // 视口 resize 被拒（P-20261122-16）：一律撤销在途请求（栅格本就未乐观
          // 改动，回滚=维持已确认主机栅格）；原因分档决定退避面
          const reason = m.reason || 'denied';
          vpClearWant();
          // 回滚已确认主机栅格（P-20261122-16 ② 的「拒绝即回滚」）：栅格本未
          // 乐观改动，此处是显式收口——防未来引入的乐观路径残留脏栅格
          if (hostCols > 0 && hostRows > 0) setHost(hostCols, hostRows);
          if (reason === 'owner_active') {
            // 主人在本机操作：画布以主机为准，30s 退避后重试（不永久停驱动——
            // 主人关掉终端后视口仍可重新让渡）；状态条给出可见原因
            vp.note = t('wrOwnerActive');
            vp.retryAt = Date.now() + VP_OWNER_RETRY_MS;
            if (canType) showStrip('on', vpStripText());
            vpArmAt(vp.retryAt);
          } else if (reason === 'external_session') {
            // 外部接管会话（TmuxExternal）服务端禁用访客 resize：驱动停用回落
            // 主机栅格保真（后续 SSE resize 帧照常跟随渲染），不重试
            vp.on = false;
            vp.note = '';
            vpStopTimer(); vpStopWait();
            if (canType) showStrip('on', t('wrOn'));
          } else {
            // 会话不在/未知原因：退避后重试（resize 是幂等指令）
            vp.retryAt = Date.now() + VP_RETRY_BACKOFF_MS;
            vpArmAt(vp.retryAt);
          }
          break;
        }
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
          // 直播已结束：停止全部 state 探测（终态不再重连）
          pollStopped = true;
          stopPoll();
          teardown();
          markEnded();
          break;
        case 'writable_off':
          // 开放直入被 owner 关闭：公告原因后断开回落只读（申请通道若在场，
          // onclose 的统一退避探测会带页面重连进 hold 模式申请路径）
          showNotice(t('wrOwnerOff'));
          teardown();
          break;
      }
    };
    // 任何 WS close（含 hello 前的握手失败与 denied 断开）都进入统一退避：
    // 先由 pollState 探测 state 决定接入/等待/停止——WS close 拿不到 HTTP
    // 404/410（升级失败通常落到 1006），停止条件只能由探测给出
    ws.onclose = () => {
      const wasOpen = wsOpen;
      ws = null;
      stopStatePoll();
      if (wasOpen) teardown();
      schedulePoll(nextBackoffDelay());
    };
    ws.onerror = () => {};
  }
  // 首次挂载激活域里的 connect：state 探测的重连入口（见 pollState 注）
  reconnectFn = connect;
  function teardown(){
    wsOpen = false;
    stopStatePoll();
    // 键入资格与画布反喂随通道关闭停用：上行桥断了就没有键入/resize 上行，
    // 显示栅格回落主机保真跟随（SSE resize 帧照常渲染）；重连 hello 重新接线
    setTyping(false);
    hideStrip();
    reqBox.style.display = 'none';
    $('roTip').textContent = roTip0;
    // sub 同步恢复只读文案（P-20261119-3）：writable_off/断连后输入通道已关，
    // 只读表述重新属实（ended 帧走 teardown 后 markEnded 清 sub，恢复值随即
    // 被清不残留）
    $('sub').textContent = t('readonlyTip');
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    // 重连调度不在此：统一由 onclose 的退避入口负责（teardown 也可能由帧
    // 驱动调用，调度收口一处避免双跑/档位互踩）
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

  // 直播已结束（ES hello 已 markEnded）：终端区已被结束态卡片替换，观看侧
  // 动作排/搜索条/粘贴链/轮询全部无对象——整段不挂（状态条等既有语义面
  // 保持前面已建，结束态下本就隐藏）
  if (ended) return;

  // 拖拽导航守卫已上提为访客页族共享注入件（P-20261122-20，dragguard.go
  // scDragGuard）：直播页的注册点与 collab 闸/提示文案都在 termpage.go 主脚本
  // （tip 传本位既有词表键 t('wrDragNoUpload')）。本位不再挂 document 级
  // dragover/drop——双监听会让同一次投放双 preventDefault/双提示；本位只保留
  // 粘贴/上传链的 flashTip 面（.pu-tip，与守卫的 .drag-tip 分桶）。

  // ── 粘贴上传落盘链（P-20261122-1 必改2：访客设备上的文件交给主机的唯一
  // 通道——粘贴=字节面天然无路径难题。用户定向修订：拖拽上传裁撤，访客页
  // 拖拽维持协作收件箱原语义（collabpage drop 监听零改动），粘贴链不与拖拽
  // 共栖；collab 关时的拖拽导航兜底见共享守卫 dragguard.go）──
  //
  // 共栖仲裁（必改3，【用户定向修订】收窄为仅 paste）：collabpage.go 的
  // paste 监听同为 document 捕获相（两监听同相时按注册序触发，collab 脚本
  // 在模板中先注入——document 级无法抢先，实测收件箱会误收），故本监听挂
  // window 捕获相：捕获路径 window → document → …，window 监听恒先于
  // document 上任何同相监听（与注册序无关）。抢先 preventDefault+
  // stopPropagation 后事件不再下行/上行，collab 收不到。判定在事件时刻
  // 现场取 canType：
  //   - 有键入资格（open 模式 hello 后 / hold 模式持权中）→ 文件粘贴归终端
  //     落盘链（抢先 preventDefault）；
  //   - 无键入资格 → 不接管（collab 链原语义「进收件箱」不被破坏，
  //     share-collab.spec 既有断言不翻红的保证）；自 P-20261123-1 起补一条
  //     可见原因提示（collab 关时），提示不 preventDefault、不改流向。
  // 纯文本粘贴不接管（xterm 缺省链 → onData → WS 帧原样）；目标在本终端外
  // 的输入框（留言昵称/搜索框）不接管（输入框语义优先；带文件时自
  // P-20261123-1 起提示先聚焦终端，见闸前可见反馈段）。
  //
  // 上行复用主人端参数（单批 ≤5 / 白名单预筛 / 压缩链 vanilla 移植），服务端
  // 端点 POST /s/{token}/paste-upload 与主人端 UploadPasteImage 同形响应——
  // 落盘路径经 term.paste()（DEC 2004 bracketed paste 语义与主人端一致）入
  // 输入行 → onData → WS Binary 帧 → 服务端 commandrisk 预检（路径不命中
  // danger 直注入，命中挂 owner 审批——安全面与键入同闸）。

  // ── 粘贴面诊断环形缓冲（P-20261122-18 ②）：查询参数 paste=diag 暴露
  // window.__scPasteDiag（最近 10 条）——「Ctrl+V 没反应」的用户主诉在浏览器
  // 之间差异极大（Firefox 文件管理器复制不填 files、iOS Safari 不可用、部分
  // 来源只给 text/html…），没有现场元数据只能靠猜。环形缓冲常驻（10 条小对象
  // 零成本），仅带查询参数时挂到 window（不默认暴露调试面）。
  // P-20261123-1 ①：paste 事件在权限闸/输入框闸之前就记账，meta 拆出
  // targetKind（term/body/input）与 gate（ok/need_conn/need_hold），并带
  // holdMode/directStatus——主失败形态（hold 未持权）从「零记录」变为可定位。
  // 红线：**绝不记剪贴板内容、文件名或路径**——只记形态元数据（types 名/
  // 项数/文件数/目标标签类/授权位/形态位/upload HTTP 状态/字节数/UA 摘要）
  const PU_DIAG_MAX = 10;
  const puDiag = [];
  const puDiagOn = /(^|[?&])paste=diag(&|$)/.test(location.search);
  function puUaBrief(){
    const ua = navigator.userAgent || '';
    const m = /(Edg|OPR|Chrome|Firefox|Version)\/(\d+)/.exec(ua);
    const name = m ? m[1] + '/' + m[2] : 'other';
    const mobile = /Mobile|Android|iPhone|iPad/.test(ua) ? ' mobile' : ' desktop';
    return (name + mobile).slice(0, 40);
  }
  function puTargetOf(el){
    if (!el || !el.tagName) return '';
    const cls = (typeof el.className === 'string' ? el.className : '')
      .split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    return (el.tagName.toLowerCase() + (cls ? '.' + cls : '')).slice(0, 60);
  }
  function puDiagAdd(ev, fields){
    try {
      const ent = { ev: ev, at: Date.now(), ua: puUaBrief() };
      for (const k in (fields || {})) ent[k] = fields[k];
      puDiag.push(ent);
      while (puDiag.length > PU_DIAG_MAX) puDiag.shift();
    } catch (e) { /* silent-by-design: 诊断是旁路，任何失败不得影响粘贴链 */ }
  }
  if (puDiagOn) {
    try {
      window.__scPasteDiag = {
        ua: puUaBrief(),
        max: PU_DIAG_MAX,
        note: 'metadata only — no clipboard content, file names or paths',
        events: puDiag,
      };
    } catch (e) { /* silent-by-design: 非浏览器宿主/冻结 window 时放弃暴露 */ }
  }


  // PASTE_FILE_MAX_COUNT 单批上限（主人端 pasteFiles.ts 同值——两端同参数，
  // 评审裁定 A；超限警告截断同主人端语义）
  const PASTE_FILE_MAX_COUNT = 5;
  // 压缩链参数（主人端 pasteImageCompress.ts 同值近逐行移植——手机访客上行
  // 一个量级提速；任何一步失败降级原图，压缩是增强不是门槛）
  const PU_MAX_EDGE = 1920;
  const PU_JPEG_QUALITY = 0.85;
  const PU_MIN_BYTES = 1024 * 1024;
  // file 形态扩展名白名单（主人端 pasteFiles.ts PASTE_FILE_ALLOWED_EXTS 同表
  // ——前端预筛为即时反馈，判定唯一事实源在服务端白名单）
  const PASTE_FILE_ALLOWED_EXTS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
    '.txt', '.md', '.markdown', '.log', '.csv', '.tsv',
    '.json', '.jsonl', '.xml', '.yml', '.yaml', '.toml',
    '.ini', '.cfg', '.conf', '.sql', '.html', '.htm', '.css',
    '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
    '.py', '.go', '.rs', '.java', '.kt', '.swift',
    '.c', '.h', '.cpp', '.hpp', '.cc',
    '.sh', '.bash', '.zsh', '.bat', '.cmd', '.ps1',
    '.rb', '.php', '.lua', '.pl', '.r',
    '.dart', '.vue', '.svelte',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx',
    '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf', '.epub',
    '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar',
  ]);
  // image 形态 CT 与服务端四类白名单对齐（P-20261122-18 ⑥）：只有服务端认的
  // png/jpeg/gif/webp 走 image 形态；svg/bmp/avif 等其余 image/* 按扩展名走
  // file 白名单或 unsupported——否则服务端收紧 CT 白名单后必吃 400
  const PASTE_IMAGE_CT = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  function pasteUploadKindOf(file){
    const ct = (file.type || '').toLowerCase();
    if (PASTE_IMAGE_CT.has(ct)) return 'image';
    const name = file.name || '';
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
    return PASTE_FILE_ALLOWED_EXTS.has(ext) ? 'file' : 'unsupported';
  }
  function quotePastePath(p){ return /\s/.test(p) ? '"' + p + '"' : p; }

  // 瞬时提示（进度/结果的最小反馈面；textContent 写入防注入，渲染纪律同页头注）
  const puTip = document.createElement('div');
  puTip.className = 'pu-tip';
  puTip.setAttribute('data-testid', 'pu-tip');
  puTip.style.display = 'none';
  document.body.appendChild(puTip);
  let puTipTimer = 0;
  function flashTip(msg){
    if (!msg) return;
    puTip.textContent = msg;
    puTip.style.display = '';
    if (puTipTimer) clearTimeout(puTipTimer);
    puTipTimer = setTimeout(() => { puTip.style.display = 'none'; puTipTimer = 0; }, 2400);
  }

  // 上传期间的状态条呈现与恢复（strip 是协议驱动面——上传借用 wait 态展示
  // 进度，结束后按授权模式恢复常态文案，不与 WS 帧驱动的状态互相踩踏：
  // 仅当「当前由上传持有」时才恢复，协议帧先到则以协议为准）
  let stripHeldByUpload = false;
  function uploadStrip(msg){
    showStrip('wait', msg);
    stripHeldByUpload = true;
  }
  function uploadStripRestore(){
    if (!stripHeldByUpload) return;
    stripHeldByUpload = false;
    if (!canType) { hideStrip(); return; }
    if (holdMode) showStrip('on', t('wrHeld').replace('{m}', String(Math.max(1, Math.ceil(remainSec / 60)))));
    else showStrip('on', t('wrOn'));
  }

  // 压缩链（pasteImageCompress.ts vanilla 移植）：png/jpeg 才压缩；未超尺寸
  // 且 ≤1MB 原样直传；透明 PNG 保格式；编码结果不比原图小回退原图
  function puHasAlpha(rgba){
    for (let i = 3; i < rgba.length; i += 4) { if (rgba[i] !== 255) return true; }
    return false;
  }
  function puPlan(mime, w, h, bytes, hasAlpha){
    if (mime !== 'image/png' && mime !== 'image/jpeg') return null;
    const needsScale = Math.max(w, h) > PU_MAX_EDGE;
    if (!needsScale && bytes <= PU_MIN_BYTES) return null;
    if (mime === 'image/png' && hasAlpha) return needsScale ? 'image/png' : null;
    return 'image/jpeg';
  }
  async function compressPasteImage(file){
    try {
      if (file.type !== 'image/png' && file.type !== 'image/jpeg') return file;
      if (typeof createImageBitmap !== 'function') return file;
      const bitmap = await createImageBitmap(file);
      try {
        const needsScale = Math.max(bitmap.width, bitmap.height) > PU_MAX_EDGE;
        if (!needsScale && file.size <= PU_MIN_BYTES) return file;
        const scale = PU_MAX_EDGE / Math.max(bitmap.width, bitmap.height);
        const w = Math.max(1, Math.round(bitmap.width * (scale < 1 ? scale : 1)));
        const h = Math.max(1, Math.round(bitmap.height * (scale < 1 ? scale : 1)));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return file;
        ctx.drawImage(bitmap, 0, 0, w, h);
        const hasAlpha = file.type === 'image/png' ? puHasAlpha(ctx.getImageData(0, 0, w, h).data) : false;
        const target = puPlan(file.type, bitmap.width, bitmap.height, file.size, hasAlpha);
        if (!target) return file;
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, target, PU_JPEG_QUALITY));
        if (!blob || blob.size >= file.size) return file;
        const ext = target === 'image/jpeg' ? 'jpg' : 'png';
        return new File([blob], 'pasted.' + ext, { type: target });
      } finally { bitmap.close(); }
    } catch (e) { return file; }
  }

  // 单文件上传（image 走 image 字段、file 走 file 字段——主人端分派同形；
  // 429/403 复用既有文案键，错误以异常上抛由调用方逐文件反馈）。诊断只记
  // HTTP 状态与字节数（不记文件名/内容——评审红线 ④）：上传失败时页面
  // flashTip 状态由调用方给出，诊断面留同一状态供 ?paste=diag 现场取证
  async function uploadPasteOne(file, kind){
    const fd = new FormData();
    fd.append('visitorId', visitorId);
    fd.append('nickname', nickOf());
    fd.append(kind === 'image' ? 'image' : 'file', file, file.name || 'pasted');
    const res = await fetch('/s/' + SC.token + '/paste-upload', { method: 'POST', body: fd });
    puDiagAdd('upload', { kind: kind, bytes: file.size, status: res.status });
    if (res.status === 429) throw new Error(t('clLimited'));
    if (res.status === 403) throw new Error(t('wrRevoked'));
    // 400 too_large = 服务端体封顶/单文件上限命中（P-20261123-5）：给可读上限文案
    //（puTooLarge 写死 share 口径 20/10——本页是访客端，owner 100MB 不适用）
    if (res.status === 400) {
      let errBody = {};
      try { errBody = await res.json(); } catch (e) {}
      if (errBody && errBody.error === 'too_large') throw new Error(t('puTooLarge'));
    }
    if (!res.ok) throw new Error(t('puFailed'));
    let d = {};
    try { d = await res.json(); } catch (e) { throw new Error(t('puFailed')); }
    return (d.data && d.data.path) || '';
  }

  // in-flight 锁（主人端 pasteFilesInFlight 同语义：连续 Ctrl+V 去抖，防并发
  // 上传同一批文件重复落盘；全局单锁——误按场景用户只对着一个终端连按）
  let pasteUpInFlight = false;
  async function uploadPasteFiles(rawFiles){
    if (pasteUpInFlight) return;
    if (rawFiles.length > PASTE_FILE_MAX_COUNT) {
      flashTip(t('puTooMany').replace('{n}', String(PASTE_FILE_MAX_COUNT)));
    }
    const files = rawFiles.slice(0, PASTE_FILE_MAX_COUNT);
    pasteUpInFlight = true;
    const paths = [];
    try {
      let i = 0;
      for (const file of files) {
        i++;
        const kind = pasteUploadKindOf(file);
        if (kind === 'unsupported') {
          puDiagAdd('upload', { reason: 'unsupported', bytes: file.size });
          flashTip(t('puUnsupported').replace('{name}', file.name || ''));
          continue;
        }
        uploadStrip(t('puUploading').replace('{i}', String(i)).replace('{n}', String(files.length)));
        try {
          const payload = kind === 'image' ? await compressPasteImage(file) : file;
        // 压缩后预检（P-20261123-6 S2 方案⑥）：__scPasteLimits 注入值现读；
        // 缺失（旧服务/null）→ 不预检（服务端 400/413 可读文案兜底，不回退默认放行）
        const pl = (typeof window.__scPasteLimits === 'object' && window.__scPasteLimits) || null;
        if (pl) {
          const maxMB = kind === 'image' ? pl.imageMB : pl.fileMB;
          if (maxMB > 0 && payload.size > maxMB * 1024 * 1024) {
            flashTip(t('puPrecheckTooLarge').replace('{name}', file.name || '').replace('{max}', String(maxMB)));
            continue;
          }
        }
          const path = await uploadPasteOne(payload, kind);
          if (path) paths.push(quotePastePath(path));
          else flashTip(t('puFailOne').replace('{name}', file.name || ''));
        } catch (err) {
          flashTip((err && err.message) || t('puFailed'));
        }
      }
    } finally {
      pasteUpInFlight = false;
      uploadStripRestore();
    }
    if (!paths.length) return;
    // 路径入输入行（多文件逐文件一行一次贴入，主人端 applyPaste 同构）：
    // bracketed paste 下多行只进编辑缓冲不执行（agent TUI 常态安全）
    try { term.paste(paths.join('\n')); term.focus(); } catch (e) {}
    flashTip(t('puDone').replace('{n}', String(paths.length)));
  }
  // paste 事件的文件载荷（collabpage pasteFiles 同款：files 优先，items 兜底
  // ——部分浏览器/来源 .files 为空而 items 里有 kind=file）
  function pasteFilesOf(dt){
    const out = Array.from(dt.files || []);
    if (out.length) return out;
    for (const it of Array.from(dt.items || [])) {
      if (it.kind === 'file') { const f = it.getAsFile(); if (f) out.push(f); }
    }
    return out;
  }
  // 目标在本终端外的可编辑元素（留言昵称/搜索框）不接管——输入框语义优先
  //（collabpage editableTarget 同判据的「排除 xterm」反转形态）
  function editableOutsideTerm(el){
    if (!el || !el.closest) return false;
    if (el.closest('.xterm')) return false;
    const tag = (el.tagName || '').toLowerCase();
    return tag === 'textarea' || tag === 'input' || !!el.isContentEditable;
  }
  // text/html 内联 data:image 兜底（collabpage htmlImage 先例的 writable 版）：
  // 部分来源（Office 截图/富文本复制）只给 text/html，图片字节在 data: URI 里。
  // 只认服务端四类 CT（与 image 白名单同域）；外链图片跨域读不到字节 → 不接管
  function pasteHtmlImage(html){
    if (!html || html.indexOf('<img') < 0) return null;
    const m = /<img[^>]+src\s*=\s*["']([^"']+)["']/i.exec(html);
    if (!m) return null;
    const d = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(m[1]);
    if (!d) return null;
    try {
      const bin = atob(d[2].replace(/\s+/g, ''));
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const sub = d[1].toLowerCase().split('/')[1];
      const ext = sub === 'jpeg' ? 'jpg' : sub;
      return new File([u8], 'pasted.' + ext, { type: ext === 'jpg' ? 'image/jpeg' : d[1].toLowerCase() });
    } catch (e) { return null; }
  }
  // 「没读到可发送文件」的可见提示（P-20261122-18 ④）：只在无文件且无
  // text/plain/text/html 时出（纯文本粘贴不误报），30s 限频（连按 Ctrl+V
  // 只提示一次；提示本身是引导用户改走上传按钮，重复弹等于噪音）
  let puNoFileTipAt = 0;
  function tipNoClipboardFile(){
    const now = Date.now();
    if (now - puNoFileTipAt < 30000) return;
    puNoFileTipAt = now;
    puDiagAdd('tip', { reason: 'no-clipboard-file' });
    flashTip(t('puNoFile'));
  }
  // 图片补链（P-20261122-18 ③，明确降级）：paste 事件无文件也无文本时，异步
  // navigator.clipboard.read() 找 image/png|jpeg 走同一压缩/上传链。前提 =
  // secure context + 用户授权（LAN http 下 clipboard 为 undefined，拒绝/不支持
  // 均归提示面 → 引导上传按钮）。**不挂 keydown**：异步读来不及 preventDefault
  // 原生文本粘贴，会重复/丢文本；**不覆盖 OS 复制的文件**（只有 paste 事件
  // 的 clipboardData 暴露文件，async read 拿不到——主人端 useTerminalClipboard
  // 同源注记），文件一律靠粘贴事件或上传按钮
  async function tryClipboardImage(){
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
        puDiagAdd('clipread', { reason: 'unsupported' });
        tipNoClipboardFile();
        return;
      }
      const items = await navigator.clipboard.read();
      for (const it of Array.from(items || [])) {
        const ty = ['image/png', 'image/jpeg'].find((x) =>
          Array.from(it.types || []).indexOf(x) >= 0);
        if (!ty) continue;
        const blob = await it.getType(ty);
        const ext = ty === 'image/png' ? 'png' : 'jpg';
        const file = new File([blob], 'pasted.' + ext, { type: ty });
        puDiagAdd('clipread', { reason: 'image', bytes: file.size });
        void uploadPasteFiles([file]);
        return;
      }
      puDiagAdd('clipread', { reason: 'no-image' });
      tipNoClipboardFile();
    } catch (e) {
      // silent-by-design: 授权拒绝/非安全上下文/无用户手势是预期形态，回退
      // 面就是可见提示（用户按了 Ctrl+V 期待有反应，静默等于坏掉）
      puDiagAdd('clipread', { reason: 'denied' });
      tipNoClipboardFile();
    }
  }
  // ── 闸前可见反馈（P-20261123-1）：用户主诉「Ctrl+V 粘图片/文件没反应」的
  // 主失败形态是 hold 未持权/未连线时闸前静默（旧序在 !canType || !wsOpen 直接
  // return，无提示、无诊断——P-18 专为「没反应」建的 ?paste=diag 恰在此形态零
  // 记录）。本段只做可见化，不改丢弃语义：**不 preventDefault、不自动发起申请**。
  //   · 诊断（puDiagAdd）前置到权限闸与输入框闸之前，gate 与 targetKind 分开
  //     记——同一目标在不同授权态走不同分支，混记无法归因；
  //   · 目标在页内输入框：纯文本零动作（原生输入语义不动），带文件且有资格
  //     → puFocusTerm（文件只能进终端粘贴链），无资格 → 走权限/连接原因；
  //   · 目标在终端/body 且无资格 → 按状态给原因后 return；
  //   · 同一原因 10s 限频（per-reason 独立时间戳）：连按不刷屏，原因变了
  //     （申请批下来等）立刻能看到新状态；
  //   · collab 开只记诊断不弹新提示——协作位自身有收件箱/素材框反馈；
  //   · 申请槽在场（状态 none）时粘贴指向入口：reqBox 1.2s 一次性高亮。
  const GATE_TIP_MS = 10000;
  const gateTipAt = {};
  let reqFlashTimer = 0;
  function reqBoxFlash(){
    if (!reqBox || reqBox.style.display === 'none') return;
    reqBox.classList.add('wr-req-flash');
    if (reqFlashTimer) clearTimeout(reqFlashTimer);
    reqFlashTimer = setTimeout(() => {
      reqBox.classList.remove('wr-req-flash');
      reqFlashTimer = 0;
    }, 1200);
  }
  function pasteTip(reason, msg){
    if (!msg || SC.collab) return; // collab：提示面交协作位，避免双提示
    const now = Date.now();
    if (now - (gateTipAt[reason] || 0) < GATE_TIP_MS) return;
    gateTipAt[reason] = now;
    puDiagAdd('tip', { reason: reason });
    flashTip(msg);
  }
  // 无资格原因分档（与状态条同源文案）：未连线 → connecting（复用既有词条，
  // 不新增「连接中」类文案）；hold 已申请待批 → wrWaiting；他人持权 → wrOther；
  // 其余（hold 未申请 / 开放未接线）→ puNeedHold
  function gateReasonTip(){
    // collab 开：整段可见反馈关闭（含申请槽高亮）——协作位自身有收件箱/素材框
    // 反馈，再指一次输入申请入口就是双提示；诊断在调用侧已记账，这里只不弹
    if (SC.collab) return;
    if (!wsOpen) { pasteTip('need_conn', t('connecting')); return; }
    if (holdMode && lastDirectStatus === 'pending') { pasteTip('waiting', t('wrWaiting')); return; }
    if (holdMode && lastDirectStatus === 'held') { pasteTip('other', t('wrOther')); return; }
    pasteTip('need_hold', t('puNeedHold'));
    if (lastDirectStatus === 'none') reqBoxFlash(); // 申请槽在场：指一下入口
  }
  // 目标分类（诊断 targetKind 与分流同源）：term = xterm 内（helper textarea 在
  // .xterm 内）；input = 页内可编辑元素（搜索框/留言昵称/协作素材框）；其余
  //（body 空白，焦点不在终端）归 body——与终端同档走粘贴链/闸门提示
  function pasteTargetKind(el){
    if (el && el.closest && el.closest('.xterm')) return 'term';
    return editableOutsideTerm(el) ? 'input' : 'body';
  }
  // 捕获相仲裁监听（必改3）：判定与流向见段首注——canType 且带文件才抢先；
  // 无文件按下方 P-18 三档处理（文本让位/内联图兜底/无内容提示），不再一律零
  // 动作。挂 window 而非 document：collab 监听在 document 捕获相且注册在前，
  // 同目标同相无抢占手段（见段首注）。
  // P-20261122-18 起补三档无文件面（判定顺序=文本优先）：
  //   ① 无文件但有 text/plain → 让给原生链（xterm 文本粘贴），零动作；
  //   ② 无 text/plain 但 text/html 含内联 data:image → 解成文件走同链；
  //   ③ 三者皆无（Firefox 文件管理器复制/iOS Safari 等已知形态）→ 30s 限频
  //      提示改走上传按钮 + async clipboard.read 图片补链（降级）。
  // 诊断记录每档（?paste=diag），绝不记内容/文件名
  window.addEventListener('paste', (e) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const files = pasteFilesOf(dt);
    // 目标与闸值先定（P-20261123-1 ①）：诊断在任何闸门前记账——主失败形态
    //（hold 未持权/未连线）必须在 ?paste=diag 下可定位。gate 三态：
    // need_conn（WS 未接线）/ need_hold（已接线无键入资格）/ ok（可粘贴）
    const targetKind = pasteTargetKind(e.target);
    const gate = !wsOpen ? 'need_conn' : (!canType ? 'need_hold' : 'ok');
    const meta = {
      types: Array.from(dt.types || []).map((x) => String(x).slice(0, 20)).slice(0, 8),
      items: Array.from(dt.items || []).length,
      files: files.length,
      target: puTargetOf(e.target),
      targetKind: targetKind,
      gate: gate,
      canType: !!canType,
      wsOpen: !!wsOpen,
      holdMode: !!holdMode,
      directStatus: lastDirectStatus,
    };
    if (targetKind === 'input') {
      // 输入框语义优先：纯文本一律零动作（原生输入语义不动，不提示不拦截）；
      // 带文件才分流——有资格提示先聚焦终端（文件只能走终端粘贴链），无资格
      // 走权限/连接原因。两分支都不 preventDefault（输入框侧行为不改变）
      if (!files.length) {
        puDiagAdd('paste', Object.assign({ reason: 'input-text' }, meta));
        return;
      }
      puDiagAdd('paste', Object.assign({ reason: 'input-files' }, meta));
      if (gate === 'ok') pasteTip('focus_term', t('puFocusTerm'));
      else gateReasonTip();
      return;
    }
    if (gate !== 'ok') {
      // 终端/body 但无资格：给一条原因提示再 return——只可见化，丢弃语义不变
      puDiagAdd('paste', Object.assign({ reason: 'gated' }, meta));
      gateReasonTip();
      return;
    }
    if (files.length) {
      puDiagAdd('paste', Object.assign({ reason: 'files' }, meta));
      e.preventDefault(); e.stopPropagation();
      void uploadPasteFiles(files);
      return;
    }
    const textPlain = dt.getData('text/plain') || '';
    if (textPlain) {
      puDiagAdd('paste', Object.assign({ reason: 'text' }, meta));
      return; // 纯文本/带文字：原生粘贴链（xterm onData 或 collab 素材框）
    }
    const html = dt.getData('text/html') || '';
    if (html) {
      const img = pasteHtmlImage(html);
      if (img) {
        puDiagAdd('paste', Object.assign({ reason: 'html-image', bytes: img.size }, meta));
        e.preventDefault(); e.stopPropagation();
        void uploadPasteFiles([img]);
        return;
      }
      puDiagAdd('paste', Object.assign({ reason: 'html' }, meta));
      return; // 富文本无内联图片：交回 collab/浏览器原语义
    }
    puDiagAdd('paste', Object.assign({ reason: 'no-files-no-text' }, meta));
    void tryClipboardImage();
  }, true);

  // ── 选区复制（P-20261122-1 必改4）：Ctrl+Shift+C / 复制钮 / 非安全上下文
  // execCommand 降级链（terminalOsc52Clipboard copyText 降级先例——LAN http
  // 下 navigator.clipboard 为 undefined，健壮性红线同款降级）。快捷键双修饰
  // 约定（ctrlKey || metaKey）健壮性红线同款；无选区不拦（系统复制语义不动）
  async function copyText(text){
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* 降级 execCommand */ }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }
  function copySelection(){
    let sel = '';
    try { if (term.hasSelection()) sel = term.getSelection(); } catch (e) {}
    if (!sel) return Promise.resolve(false);
    return copyText(sel);
  }
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      let has = false;
      try { has = term.hasSelection(); } catch (err) {}
      if (!has) return;
      e.preventDefault();
      void copySelection().then((ok) => flashTip(ok ? t('cpCopied') : t('cpCopyFailed')));
    }
  });

  // ── 极简搜索条（P-20261122-1 必改6）：观看侧可写页的滚动回看搜索面
  //（addon-search vendored 件；只读页明确排除——页面清单定案防蔓延）。
  // 卡片动作排 = 复制钮 + 搜索开关（必改4/6 访客侧 UI 面）。in-flow 挂卡片
  // 首行（见 writableCSS 注：不叠盖终端输出——TUI 全屏时顶右角是真实内容）
  const actions = document.createElement('div');
  actions.className = 'wr-actions';
  actions.setAttribute('data-testid', 'wr-actions');
  // 常驻「上传文件/图片」按钮（P-20261122-18 ①）：Ctrl+V 文件投递在部分浏览器
  // /移动端不可用（Firefox 文件管理器复制不填 files、iOS Safari 不可用、桌面
  // Safari 灰显——根因未证实前不承诺「Ctrl+V 已修」），上传按钮是**唯一跨
  // 浏览器保底**：<input type=file multiple> 选择后复用 uploadPasteFiles 同一
  // 压缩/白名单/≤5/审计链。无键入资格（hold 未持权/open 未 hello）时提示先
  // 申请——与键入同一授权物；选完重置 input（同文件可再次选择）
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.style.display = 'none';
  fileInput.setAttribute('data-testid', 'wr-upload-input');
  // accept 只是文件选择器的初筛提示；真正的判定唯一事实源是 pasteUploadKindOf
  // 与服务端白名单（白名单外仍可选「所有文件」绕过初筛 → 逐文件 unsupported 提示）
  fileInput.accept = Array.from(PASTE_FILE_ALLOWED_EXTS).join(',');
  fileInput.onchange = () => {
    const picked = Array.from(fileInput.files || []);
    fileInput.value = ''; // 重置：同一文件可再次选择（不重置 onchange 不再触发）
    if (!picked.length) return;
    void uploadPasteFiles(picked);
  };
  const uploadBtn = document.createElement('button');
  uploadBtn.type = 'button';
  uploadBtn.className = 'cl-btn';
  uploadBtn.textContent = t('puUploadBtn');
  uploadBtn.title = t('puUploadBtn');
  uploadBtn.setAttribute('aria-label', t('puUploadBtn'));
  uploadBtn.setAttribute('data-testid', 'wr-upload');
  uploadBtn.onclick = () => {
    puDiagAdd('upload', { reason: 'button', canType: !!canType, wsOpen: !!wsOpen });
    if (!canType) { flashTip(t('puNeedHold')); return; }
    try { fileInput.click(); } catch (e) { flashTip(t('puFailed')); }
  };
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'cl-btn';
  copyBtn.textContent = t('cpCopy');
  copyBtn.title = t('cpCopy');
  copyBtn.setAttribute('aria-label', t('cpCopy'));
  copyBtn.setAttribute('data-testid', 'wr-copy');
  copyBtn.onclick = () => { void copySelection().then((ok) => flashTip(ok ? t('cpCopied') : t('cpCopyFailed'))); };
  const searchBtn = document.createElement('button');
  searchBtn.type = 'button';
  searchBtn.className = 'cl-btn';
  searchBtn.textContent = t('seToggle');
  searchBtn.title = t('seToggle');
  searchBtn.setAttribute('aria-label', t('seToggle'));
  searchBtn.setAttribute('data-testid', 'wr-search-toggle');
  actions.append(uploadBtn, fileInput, copyBtn, searchBtn);
  if (card) card.insertBefore(actions, card.firstChild); // 卡片首行（终端区之上）

  let searchAddon = null;
  try {
    searchAddon = new SearchAddon.SearchAddon();
    term.loadAddon(searchAddon);
  } catch (e) { searchAddon = null; }
  const searchBar = document.createElement('div');
  searchBar.className = 'wr-search';
  searchBar.setAttribute('data-testid', 'wr-search');
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = t('seSearch');
  searchInput.setAttribute('data-testid', 'wr-search-input');
  const searchCount = document.createElement('span');
  searchCount.className = 'wr-search-count';
  searchCount.setAttribute('data-testid', 'wr-search-count');
  function mkSearchBtn(labelKey, testid, fn){
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cl-btn';
    b.textContent = t(labelKey);
    b.title = t(labelKey);
    b.setAttribute('aria-label', t(labelKey));
    b.setAttribute('data-testid', testid);
    b.onclick = fn;
    return b;
  }
  function searchRun(dirNext, incremental){
    const q = searchInput.value;
    if (!q || !searchAddon) return;
    const opts = { caseSensitive: false };
    if (incremental) opts.incremental = true;
    try {
      if (dirNext) searchAddon.findNext(q, opts);
      else searchAddon.findPrevious(q, opts);
    } catch (e) {}
  }
  function searchPaint(r){
    if (!searchInput.value) { searchCount.textContent = ''; return; }
    if (!r || !(r.resultCount > 0)) { searchCount.textContent = t('seNoResult'); return; }
    const idx = r.resultIndex >= 0 ? r.resultIndex + 1 : 1;
    searchCount.textContent = String(idx) + '/' + String(r.resultCount);
  }
  if (searchAddon && searchAddon.onDidChangeResults) {
    try { searchAddon.onDidChangeResults((r) => searchPaint(r)); } catch (e) {}
  }
  searchInput.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); searchRun(!e.shiftKey, false); }
    else if (e.key === 'Escape') { e.preventDefault(); searchClose(); }
  };
  searchInput.oninput = () => { if (searchInput.value) searchRun(true, true); else searchPaint(null); };
  function searchClose(){
    searchBar.classList.remove('open');
    if (searchAddon) { try { searchAddon.clearDecorations(); } catch (e) {} }
    searchCount.textContent = '';
    try { term.focus(); } catch (e) {}
  }
  searchBtn.onclick = () => {
    if (searchBar.classList.contains('open')) { searchClose(); return; }
    searchBar.classList.add('open');
    searchInput.focus();
  };
  searchBar.append(
    searchInput, searchCount,
    mkSearchBtn('sePrev', 'wr-search-prev', () => searchRun(false, false)),
    mkSearchBtn('seNext', 'wr-search-next', () => searchRun(true, false)),
    mkSearchBtn('seClose', 'wr-search-close', searchClose),
  );
  if (card) card.appendChild(searchBar);
  connect();
  } // mountWritable

  // 惰性挂载入口（P-20261122-19 ④）：双关只读页的新挂载脚本由外层 state
  // 探测调用；已挂载页重复调用是幂等空操作（重连走 reconnectFn）
  window.__scMountWritable = mountWritable;
  // 启动：开关已开即时挂载；双关页进入 5s state 探测等待主人开启
  //（ended 页不挂——终端区已是结束态卡片）
  if (ended) return;
  if (SC.writable || SC.guestInput) { mountWritable(); return; }
  schedulePoll(IDLE_POLL_MS);
})();
`
