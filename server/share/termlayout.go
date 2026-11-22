package share

// 终端输出三访客页（直播 termpage / 定格 termpagefrozen / 回放 castpage）共用的
// 布局与遮蔽标注件（P-20261106-9）。与 guestboard.go / collabpage.go 同一注入
// 范式：单一事实源的 CSS/JS 常量经模板字段注入各页——单文件页零外部依赖契约
// 不变（不新增任何外部资源请求，字体/宽度表同为本服务 /assets/ 白名单件），
// 只是同一段文本不再三处手抄。CSS 注入在各页 <style> 末尾（同特异度规则后者
// 胜出：窄屏断点覆盖各页基础样式），JS 注入点在各页脚本首部（函数声明提升
// 可见；const 常量在各页构造 xterm 之前已求值）。
//
// 布局取向（2026-11-06 用户定向：自适应以美观合理为准，不强制铺满全屏）：
// 列宽 = max(内容所需, 流式下限) 与视口取小。流式下限 --col-floor =
// clamp(1180px, 82vw, 2000px)：随视口按比例放大（大屏不再是「视口中间一小块」，
// 又留两侧呼吸边不铺满；1180 下界保持旧版定宽观感不缩水，2000 上界防超宽屏下
// 行长失控）。内容所需由页面脚本在终端列数已知时写入 --term-need（直播 =
// hello/resize 帧主机列数；定格 = 快照行宽 p95；回放 = cast header 宽度）：主机
// 终端比流式下限还宽时继续放宽——访客栅格窄于主机即折行错乱。
// 高度跟随视口（dvh 兜底移动端地址栏伸缩），窄屏收紧边距让终端占主体。
//
// 渲染保真（P-20261107-4，总纲「访客页查看体验与产品内终端一致」；跨栈常量对齐，
// 不承诺同一配置源——访客页零依赖、不读主人 settings）：
//   - 参数对齐：字体栈 = 产品缺省 XTERM_FONT_STACKS.jetbrains（JetBrains Mono 本体
//     随 /assets/ 分发，与 web/public/fonts 同一份 OFL 文件——访客机器没装也一致）、
//     字号 = 产品缺省 FONT_DEFAULTS.terminal 14、scrollback = 产品缺省 20000
//     （terminal.DefaultScrollbackLines）、宽字符宽度表 = Unicode 11（产品内终端
//     同款 addon；缺它时 xterm 回落 v6 表，CJK/emoji 列宽与主机侧应用的计算不一致，
//     TUI 整行错位）。三处常量的漂移由 termlayout_test 对账产品侧定义源钉死
//   - 栅格 = 主机栅格：直播/回放按主机（录制）cols×rows 精确渲染，不让 fit 按访客
//     容器改写列数——栅格与主机不符即 TUI 折行/光标定位错乱（产品内终端栅格就是
//     PTY 尺寸本身，访客侧的对等物是主机尺寸）。字号布局宽度优先（P-20261120-8
//     必改0 修订 P-20261107-4 的「宽高双拟合」）：放大段只看宽度（主机栅格窄于
//     容器，上限 SC_TERM_MAX_FONT = 3×产品字号，P-20261119-2 定 cap）、收缩段只
//     随宽度收缩到装得下为止——高度溢出一律走既有 overset 滚动 + scPinBottom 钉底
//     跟随（P-20261118-9 机制），不再压缩字号迁就高度（压高不救宽：网格宽度不变
//     居中留白原样，高会话×矮终端区必然字号缩+两侧大空白，用户第三轮主诉即此收
//     缩分支盲区）。主机调整窗口时直播页随 SSE resize 帧换栅格。定格快照是剥 ANSI
//     的纯文本（无光标定位语义），维持按容器 fit 的软折行
//   - 重排触发 = 终端容器尺寸（ResizeObserver，回落 window resize）：横幅/可写
//     条/页底浮层任何一处让容器变化都会重排，不再出现「容器缩了 xterm 没跟」的
//     底部裁切
//
// 页底协作/留言浮层化（P-20261107-4）：终端页的留言板展开区改浮层（向上覆于
// 终端卡片之上），不再进列流撑高、挤压终端区（协作素材位同款见 collabpage.go）。
// 文件分享页不注入本件，留言板在那里仍是列流内展开（页面本就可滚动）。
//
// 未过滤标注：分享者创建时关闭了源头遮蔽（记录 Unfiltered）——横幅位（即遮蔽
// 声明 maskBanner 位）由服务端按记录直出 .unfiltered 类换危险色，文案取各页
// 字典 unfilteredBanner 键。纯展示：遮蔽与否在服务端源头已定，页面不存在任何
// 过滤逻辑（访客侧渲染过滤可被脚本绕过即得原文，不构成防线）。

// termLayoutCSS 产品同款终端字体 + 列容器自适应 + 未过滤横幅 + 页底浮层 + 窄屏
// 断点（变量命名与三页基础调色板同族；暗色由 prefers-color-scheme 同步切换）
const termLayoutCSS = `@font-face{font-family:'JetBrains Mono';src:url('/assets/JetBrainsMono-Regular.woff2') format('woff2');font-weight:400;font-style:normal;font-display:swap}
@font-face{font-family:'JetBrains Mono';src:url('/assets/JetBrainsMono-Bold.woff2') format('woff2');font-weight:700;font-style:normal;font-display:swap}
:root{--danger-bg:#fff1f0;--danger-bd:#f3b8b4;--danger-tx:#b42318;
--pad-x:clamp(10px,2.2vw,36px);--term-need:0px;--col-floor:clamp(1180px,82vw,2000px)}
@media (prefers-color-scheme: dark){:root{--danger-bg:#3a1714;--danger-bd:#7a2e28;--danger-tx:#ffb4ab}}
.wrap{position:relative;z-index:1;height:100vh;height:100dvh;width:100%;
max-width:calc(max(var(--term-need),var(--col-floor)) + 2 * var(--pad-x));margin:0 auto;
padding:clamp(10px,1.6vw,24px) var(--pad-x) 10px;display:flex;flex-direction:column}
.banner.unfiltered{background:var(--danger-bg);border-color:var(--danger-bd);color:var(--danger-tx);font-weight:600}
.card{position:relative}
/* 端面恒深底+圆角（P-20261121-4）：xterm 端面（termTheme 恒深 #0e1320 同源值）
   铺满容器内边距区——浅色主题下卡片 chrome（var(--card) 白底）与深端面的分界
   圆角化；单一事实源勿三页各抄。透明 viewport 收敛规则与[data-overset]条目
   不受影响（透明承接面从此换为不透明端面底） */
.term-box{overflow:auto;background:#0e1320;border-radius:10px}
/* overset 双滚动条收敛（P-20261118-9）：最小字号仍装不下时 scFitGrid 写
[data-overset]，隐藏 term-box 自身滚动条视觉（滚动功能保留，overflow:auto
不动——滚轮经 scWheelRoute 放行冒泡驱动；键盘/触摸滚动同走原生行为），
避免「外层超集条 × xterm 内滚动条」双条并现。scrollbar-width 无效时由
::-webkit-scrollbar 兜底（旧 Chromium/Edge 内核）。xterm 的 scrollback
导航不经过 .xterm-viewport（vendored build 实勘：viewport 是空元素、滚动
状态由 scrollable-element 内部管理 + 自绘 slider），其 overflow-y:scroll
（xterm.css 原生规则）只是常驻死槽——本域内收为 hidden 净掉一条伪滚动条，
对 scrollback 可达性零影响 */
.term-box[data-overset]{scrollbar-width:none}
.term-box[data-overset]::-webkit-scrollbar{display:none}
.term-box .xterm-viewport{overflow-y:hidden}
.wrap>.gb-root{position:relative;overflow:visible}
/* 浮层规则加选合并入口条形态（P-20261119-3）：留言 chip 挂进 sc-entrybar 后
   浮层锚条定位（chip position:static 由 entryBarCSS 覆写，就近锚到条壳）。
   纯加选——无 sc-entrybar 的页面（frozen/cast/文件页）选择器不命中，既有
   独立单条形态零变化 */
.wrap>.gb-root .gb-body,.sc-entrybar .gb-root .gb-body{position:absolute;left:0;right:0;bottom:calc(100% + 6px);z-index:30;
max-height:min(62vh,520px);overflow:auto;padding:12px 14px;background:var(--card);
border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow)}
@media (max-width:640px){
.header{padding:10px 14px;gap:10px;border-radius:12px}
.header .icon{width:34px;height:34px}
.header h1{font-size:15px}
.banner{margin-top:8px;padding:7px 11px;font-size:12px}
.card{margin-top:8px;border-radius:12px}
.term-box{padding:6px}
.foot-note{flex-direction:column;gap:2px}
}`

// termLayoutJS 渲染参数常量 + 布局助手（注入各页脚本首部）：
//   - SC_TERM_*：与产品内终端对齐的渲染常量（见文件头注「渲染保真」）
//   - scTermOptions(extra)：三页 xterm 构造参数的单一出口（只读三件套 + 对齐常量；
//     extra 只放页面差异项 convertEol/theme）
//   - scTermUnicode(term)：装 Unicode 11 宽度表（addon 缺席时静默回落，返回是否生效）
//   - scFontsReady(cb, late)：等产品同款字体就绪再 open（xterm 在 open/改字体时
//     测字宽，未就绪就测会把回退字体的字宽钉进栅格）；1.5s 超时先放行，字体晚到
//     由 late 回调触发重测，弱网访客不白等
//   - scRemeasure(term)：字体晚到后的强制重测（等价字体栈两种写法互换，xterm 因
//     选项值变化重测字宽；不碰私有 API）
//   - scCellAt(fs)：按字号测单元格（DOM 量 32 个 'W'，与 xterm 字宽测量同法——
//     宽 = 字宽、高 = 字高按设备像素上取整；不碰 xterm 私有渲染器 API）
//   - scTermNeed(cols, fs)：按列数与字号估算列容器所需宽度写入 --term-need，
//     返回该宽度（px；0 = 未生效）。+2 列余量吸收设备像素取整；列数钳 [80, 500]
//     （直播 hello 尺寸钳制同上限）。字号半边参数化且 helper 内部钳 ≥ 产品字号
//     （P-20261119-2；调用点传当前字号）——只放宽不收窄：放大段按实际字号回算
//     列宽，闭环 fs_{n+1} = 14·min(aw/栅格宽, 3) 单调递增被 3× cap 兜底收敛到
//     稳定点、且 f 单调不减无 2-循环，不与缩放互相追逐；收缩段若按收缩后字号
//     回算列宽会单调递减螺旋跌向下限附近才稳（视觉回退），钳 ≥14 后 fits/shrink
//     两态与只缩时代逐字节等价
//   - scFitGrid(term, box, cols, rows)：主机栅格自适应——终端按 cols×rows 精确
//     resize，栅格列数行数恒不变。字号布局宽度优先（P-20261120-8 必改0）：放大段
//     （14px 整格装得下容器宽，P-20261119-2 起）fs = 产品字号 × min(宽度比,
//     SC_TERM_MAX_FONT/SC_TERM_FONT_SIZE)，0.25px 步进向下取整并逐 0.25 校验宽
//     度装得下（量测非线性防御）；收缩段（14px 整格装不下容器宽）fs 在
//     [SC_TERM_MIN_FONT, SC_TERM_FONT_SIZE] 内取「宽度装进容器」的最大值（逐
//     0.25px 校验收敛，宽度装得下绝不出横向滚动条——否则滚动条出没会让可用宽度
//     来回跳、字号振荡），到下限仍装不下则容器横滚。两段高度都不设限——纵向超出
//     走 overset 滚动 + scPinBottom 钉底（见下注），不再压缩字号迁就高度（旧
//     min(1,wR,hR) 把高会话/矮终端区压成小字窄条居中，两侧留白原样）。xterm
//     元素按栅格定宽居中（右侧预留滚动条宽 SC_TERM_SB，与 FitAddon 同口径）、
//     高度不小于容器（滚轮在整块终端区内都作用于 scrollback）。容器隐藏/未布局
//     时不动作，等下一次观测。纵向装不下（overset）时写 box.dataset.overset='1'
//     （撤销即删）——scWheelRoute 据此把滚轮让给容器、CSS 收敛双滚动条（见下
//     注），并 scPinBottom 钉底使提示符（最新输出）可见
//   - scWheelRoute(term, box)：overset 双滚动条收敛的滚轮路由（P-20261118-9）。
//     装得下（fits）返回 true = xterm 照常消费滚轮做 scrollback 导航；装不下
//     （overset，scFitGrid 已标记）返回 false = xterm 不消费不 preventDefault，
//     wheel 事件冒泡到 term-box（overflow:auto）滚动超集栅格——否则外层原生
//     滚动条与 xterm 内滚动面同时在场（用户截图双条并现），外条藏了滚轮也到
//     不了它。attachCustomWheelEventHandler 是 vendored build（5.x+）实勘在
//     场的 API：handler 返回 false 时事件放行冒泡（_handleWheel 入口短路）
//   - scPinBottom(box, force, rowY)：overset 底部跟随（P-20261119-2）：超集栅格
//     顶对齐时最新输出（提示符）不可见——条件钉底，钉到「最新输出行在窗内」：
//     滚到光标行顶（rowY = 光标行顶 y，scCursorRowY 供给）再被 maxTop 钳制——
//     满屏输出（光标在格底）即贴底；新鲜空格提示符在格顶时只滚到提示符行为止
//     （钉到格底会留「提示符在折叠线上方一格」的空窗态）。用户上滚即解钉（后续
//     写入不再拽回，外层上滚只见栅格窗内旧行、更深 scrollback 历史仍须拖自绘
//     slider——P-9 既有权衡非本案引入），滚回底部重新钉。force=true（scFitGrid
//     进入/维持 overset 的重排）强制回钉——栅格重排本身跳滚动位（scrollHeight
//     跳变被浏览器钳制），此时光标行 = 唯一有意义的默认位。挂点 = live 页
//     data/tail 写回调 + setHost 尾部、cast 页 drain() 批尾（批量写一次钉勿逐
//     write 挂回调——100ms tick 批面）；清态面两处 = overset 撤销（scFitGrid
//     fits 分支复位钉底态与 scrollTop）与 scClearGrid 同撤——残留钉底态在非溢出
//     容器空转/顶对齐误判
//   - scCursorRowY(term)：光标行顶 y（px，px 级锚点供给 scPinBottom）——
//     buffer.active.cursorY 是栅格内行号（0..rows-1），单元高与 scFitGrid 同源
//     scCellAt 按当前字号量测；实例未开放/异常回落 0
//   - scClearGrid(term)：撤销栅格模式内联尺寸（回落容器 fit 时用）
//   - scObserve(el, fn)：容器尺寸观测（ResizeObserver，回落 window resize；rAF
//     合并同帧多次变化），返回可手动触发的 kick
//   - scTextCols(text)：纯文本行宽的 p95（ceil 取位：≤20 行即最大值；东亚宽字符记 2 列、Tab 推进到 8 的
//     倍数）——定格快照的「内容所需列数」，取 p95 而非最大值：个别超长日志行
//     不应把整页撑满（超出部分由 xterm 软折行承接）。一次线性扫描 + 行宽排序，
//     快照有界（≤16MB）一次性开销
const termLayoutJS = `const SC_TERM_FONT = "'JetBrains Mono', 'Cascadia Code', Consolas, 'Courier New', monospace";
const SC_TERM_FONT_SIZE = 14;
const SC_TERM_MIN_FONT = 9;
// 放大上限 = 3×产品字号（P-20261119-2）：80 列主机在 ~2000px 视口恰好填满
// （80×25.2≈2016px）；guest-only 常量（无产品侧对应物，访客呈现选择）——
// cap 兜底防超宽屏下字号失控，也为放大段闭环提供收敛锚（fs_{n+1} ≤ cap）
const SC_TERM_MAX_FONT = 42;
const SC_TERM_SCROLLBACK = 20000;
const SC_TERM_SB = 14;
function scTermOptions(extra){
  return Object.assign({
    disableStdin: true,
    cursorBlink: false,
    cursorInactiveStyle: 'outline',
    scrollback: SC_TERM_SCROLLBACK,
    fontSize: SC_TERM_FONT_SIZE,
    fontFamily: SC_TERM_FONT,
    allowProposedApi: true
  }, extra || {});
}
function scTermUnicode(term){
  try {
    if (typeof Unicode11Addon === 'undefined') return false;
    term.loadAddon(new Unicode11Addon.Unicode11Addon());
    term.unicode.activeVersion = '11';
    document.body.dataset.termUnicode = term.unicode.activeVersion;
    return true;
  } catch (e) { return false; }
}
function scFontsReady(cb, late){
  let fired = false;
  const go = () => { if (!fired) { fired = true; cb(); } };
  try {
    if (document.fonts && document.fonts.load) {
      const spec = SC_TERM_FONT_SIZE + 'px "JetBrains Mono"';
      Promise.all([document.fonts.load(spec), document.fonts.load('bold ' + spec)]).then(() => {
        if (fired) { if (late) late(); } else go();
      }, go);
      setTimeout(go, 1500);
      return;
    }
  } catch (e) { /* 无 FontFaceSet：直接放行 */ }
  go();
}
function scRemeasure(term){
  try {
    term.options.fontFamily = term.options.fontFamily === SC_TERM_FONT ? SC_TERM_FONT + ' ' : SC_TERM_FONT;
  } catch (e) { /* 实例已销毁 */ }
}
function scCellAt(fs){
  let el = scCellAt.el;
  if (!el) {
    el = document.createElement('span');
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:absolute;left:-9999em;top:0;visibility:hidden;white-space:pre;line-height:normal;letter-spacing:0';
    el.textContent = 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW';
    document.body.appendChild(el);
    scCellAt.el = el;
  }
  el.style.fontFamily = SC_TERM_FONT;
  el.style.fontSize = fs + 'px';
  const r = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return { w: r.width / 32, h: Math.ceil(r.height * dpr) / dpr };
}
function scTermNeed(cols, fs){
  if (!(cols > 0)) return 0;
  // 半边参数化钳 ≥ 产品字号（P-20261119-2，只放宽不收窄——理由见头注 scTermNeed 条目）
  fs = Math.max(SC_TERM_FONT_SIZE, fs || 0);
  const cw = scCellAt(fs).w;
  if (!(cw > 0)) return 0;
  const n = Math.max(80, Math.min(cols, 500));
  // 36 = term-box 左右内边距 20 + 卡片边框 2 + 滚动条让位 14
  const need = Math.ceil((n + 2) * cw + 36);
  const v = need + 'px';
  const root = document.documentElement.style;
  if (root.getPropertyValue('--term-need') !== v) root.setProperty('--term-need', v);
  return need;
}
function scFitGrid(term, box, cols, rows){
  const el = term.element;
  if (!el || !box || !(cols > 0 && rows > 0)) return false;
  const cs = getComputedStyle(box);
  const aw = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - SC_TERM_SB;
  const ah = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (!(aw > 0 && ah > 0)) return false;
  const base = scCellAt(SC_TERM_FONT_SIZE);
  if (!(base.w > 0 && base.h > 0)) return false;
  const wR = aw / (cols * base.w);
  let fs, cell;
  if (wR >= 1) {
    // 放大段（P-20261119-2）：宽度优先——fs 单调递增被 3× cap 兜底收敛（头注
    // 闭环推演），0.25 步进向下取整对齐收缩段取整惯例；逐 0.25 校验宽度装得下
    // （cell 量测随字号非线性，不按比例线性外推）；高度不设限，纵向超出走 overset。
    // P-20261120-8 必改0：不再要求 hR>=1——高会话/矮终端区（hR<1）此前掉收缩段
    // 被压字号、网格保持 host cols 基础宽居中两侧留白（用户第三轮主诉的收缩分支
    // 盲区），宽度优先 + overset 钉底后纵向溢出不再吞掉宽度放大
    fs = SC_TERM_FONT_SIZE * Math.min(wR, SC_TERM_MAX_FONT / SC_TERM_FONT_SIZE);
    fs = Math.max(SC_TERM_FONT_SIZE, Math.floor(fs * 4) / 4);
    cell = scCellAt(fs);
    while (fs > SC_TERM_FONT_SIZE && cols * cell.w > aw) {
      fs = Math.max(SC_TERM_FONT_SIZE, fs - 0.25);
      cell = scCellAt(fs);
    }
  } else {
    // 收缩段：宽度优先（P-20261120-8 必改0 修订 P-20261107-4 的 min(1, wR, hR)
    // 双拟合）——字号只随宽度收缩到装得下为止，高度溢出交给下方 overset 钉底而
    // 非压缩字号（压高不救宽：网格宽度不变居中留白原样，且字号缩小迁就高度是
    // 用户主诉的直接成因）；0.25 步进收敛惯例不变
    fs = SC_TERM_FONT_SIZE * Math.min(1, wR);
    fs = Math.max(SC_TERM_MIN_FONT, Math.min(SC_TERM_FONT_SIZE, Math.floor(fs * 4) / 4));
    cell = scCellAt(fs);
    while (fs > SC_TERM_MIN_FONT && cols * cell.w > aw) {
      fs = Math.max(SC_TERM_MIN_FONT, fs - 0.25);
      cell = scCellAt(fs);
    }
  }
  if (term.options.fontSize !== fs) term.options.fontSize = fs;
  if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
  el.style.width = (Math.ceil(cols * cell.w) + SC_TERM_SB) + 'px';
  el.style.height = Math.max(Math.ceil(rows * cell.h), ah) + 'px';
  el.style.margin = '0 auto';
  // overset 标记（P-20261118-9）：整格高于容器——双滚动条收敛的开关面（CSS 隐藏
  // 外层滚动条 + scWheelRoute 放行滚轮给容器）；装得下即撤并复位钉底态与
  // scrollTop（清态面：残留钉底态会在非溢出容器空转/顶对齐误判）。overset 态经
  // scPinBottom(true) 强制回钉（重排跳滚动位，光标行=最新输出=默认位，见头注）
  if (rows * cell.h > ah) {
    box.dataset.overset = '1';
    scPinBottom(box, true, scCursorRowY(term));
  } else {
    delete box.dataset.overset;
    delete box.dataset.pinBottom;
    box.scrollTop = 0;
  }
  box.dataset.cols = String(cols);
  box.dataset.rows = String(rows);
  box.dataset.fontSize = String(fs);
  return true;
}
function scWheelRoute(term, box){
  if (!term || typeof term.attachCustomWheelEventHandler !== 'function') return;
  term.attachCustomWheelEventHandler(function(){
    // false = xterm 不消费、不 preventDefault，滚轮冒泡到 term-box 滚超集
    // 栅格（overset 才让位；fits 态 scrollback 导航原样）
    return !(box && box.dataset && box.dataset.overset === '1');
  });
}
function scCursorRowY(term){
  // 光标行顶 y（px）：最新输出行锚点（buffer.active.cursorY = 栅格内行号 0..rows-1，
  // 单元高与 scFitGrid 同源 scCellAt 按当前字号量测）；未开放/异常回落 0
  try {
    const cy = term.buffer.active.cursorY;
    if (!(cy > 0)) return 0;
    return cy * scCellAt(term.options.fontSize).h;
  } catch (e) { return 0; }
}
function scPinBottom(box, force, rowY){
  if (!box) return;
  // 无纵向溢出（fits/容器隐藏）：清钉底态——残留会在非溢出容器空转/顶对齐误判
  if (!(box.scrollHeight > box.clientHeight + 1)) { delete box.dataset.pinBottom; return; }
  // 贴底判定留 1px 容差吸收亚像素取整；贴底即钉（含重排强制回钉），上滚解钉、
  // 滚回底部由下一次挂点调用重新钉。量测读写均为既有布局面，写回调频度低
  // （服务端 8ms 合帧），无热路径顾虑
  const maxTop = box.scrollHeight - box.clientHeight;
  if (force || box.scrollTop + box.clientHeight >= box.scrollHeight - 1) {
    box.dataset.pinBottom = '1';
    // 钉到最新输出行在窗内：滚到光标行顶（maxTop 钳制）——满屏输出即贴底，
    // 新鲜空格提示符在格顶时只滚到提示符行为止（rowY=0 即空格/未知，顶对齐）
    box.scrollTop = (rowY > 0 && rowY < maxTop) ? rowY : maxTop;
  } else {
    delete box.dataset.pinBottom;
  }
}
function scClearGrid(term){
  const el = term.element;
  if (!el) return;
  el.style.width = ''; el.style.height = ''; el.style.margin = '';
  // 回落容器 fit（主机尺寸未知/撤销栅格）：overset 标记随内联尺寸一起撤——
  // 残留会把滚轮路由钉在「让给容器」态而容器此时无溢出，scrollback 导航失灵。
  // 钉底态与 scrollTop 同撤（P-20261119-2 清态面②）：软折行无超集滚动面，残留
  // 钉底态会在容器回涨到溢出时把首屏误拽到底部
  const box = el.parentElement;
  if (box && box.dataset) {
    delete box.dataset.overset;
    delete box.dataset.pinBottom;
    box.scrollTop = 0;
  }
}
function scObserve(el, fn){
  let raf = 0;
  const kick = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; fn(); });
  };
  try {
    if (window.ResizeObserver && el) { new ResizeObserver(kick).observe(el); return kick; }
  } catch (e) { /* 回落 window resize */ }
  window.addEventListener('resize', kick);
  return kick;
}
function scWideCp(cp){
  return cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd));
}
function scTextCols(text){
  const widths = [];
  let cur = 0;
  for (const ch of text) {
    if (ch === '\n') { if (cur > 0) widths.push(cur); cur = 0; continue; }
    if (ch === '\r') continue;
    if (ch === '\t') { cur = (Math.floor(cur / 8) + 1) * 8; continue; }
    cur += scWideCp(ch.codePointAt(0)) ? 2 : 1;
  }
  if (cur > 0) widths.push(cur);
  if (widths.length === 0) return 0;
  widths.sort((a, b) => a - b);
  // ceil：小样本（≤20 行）即取最大值，大样本才剔除顶部 ~5% 离群长行
  return widths[Math.ceil((widths.length - 1) * 0.95)];
}`
