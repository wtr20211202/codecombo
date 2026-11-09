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
//     PTY 尺寸本身，访客侧的对等物是主机尺寸）。字号在 [9, 14] 内缩放把整格装进
//     容器（产品字号为上限，只缩不放），下限仍装不下则终端区自身滚动查看；主机
//     调整窗口时直播页随 SSE resize 帧换栅格。定格快照是剥 ANSI 的纯文本（无光标
//     定位语义），维持按容器 fit 的软折行
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
.term-box{overflow:auto}
.wrap>.gb-root{position:relative;overflow:visible}
.wrap>.gb-root .gb-body{position:absolute;left:0;right:0;bottom:calc(100% + 6px);z-index:30;
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
//   - scTermNeed(cols)：按列数（产品字号下）估算列容器所需宽度写入 --term-need，
//     返回该宽度（px；0 = 未生效）。+2 列余量吸收设备像素取整；列数钳 [80, 500]
//     （直播 hello 尺寸钳制同上限）。以常量字号而非当前字号计算：栅格缩放改的是
//     终端字号，若按当前字号回算列宽会与缩放互相追逐
//   - scFitGrid(term, box, cols, rows)：主机栅格自适应——终端按 cols×rows 精确
//     resize，字号在 [SC_TERM_MIN_FONT, SC_TERM_FONT_SIZE] 内取「整格装进容器」的
//     最大值（逐 0.25px 校验收敛，保证装得下就绝不出滚动条——否则滚动条出没会让
//     可用宽度来回跳、字号振荡）；字号到下限仍装不下则容器滚动。xterm 元素按栅格
//     定宽居中（右侧预留滚动条宽 SC_TERM_SB，与 FitAddon 同口径）、高度不小于容器
//     （滚轮在整块终端区内都作用于 scrollback）。容器隐藏/未布局时不动作，等下一次观测
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
function scTermNeed(cols){
  if (!(cols > 0)) return 0;
  const cw = scCellAt(SC_TERM_FONT_SIZE).w;
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
  let fs = SC_TERM_FONT_SIZE * Math.min(1, aw / (cols * base.w), ah / (rows * base.h));
  fs = Math.max(SC_TERM_MIN_FONT, Math.min(SC_TERM_FONT_SIZE, Math.floor(fs * 4) / 4));
  let cell = scCellAt(fs);
  while (fs > SC_TERM_MIN_FONT && (cols * cell.w > aw || rows * cell.h > ah)) {
    fs = Math.max(SC_TERM_MIN_FONT, fs - 0.25);
    cell = scCellAt(fs);
  }
  if (term.options.fontSize !== fs) term.options.fontSize = fs;
  if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
  el.style.width = (Math.ceil(cols * cell.w) + SC_TERM_SB) + 'px';
  el.style.height = Math.max(Math.ceil(rows * cell.h), ah) + 'px';
  el.style.margin = '0 auto';
  box.dataset.cols = String(cols);
  box.dataset.rows = String(rows);
  box.dataset.fontSize = String(fs);
  return true;
}
function scClearGrid(term){
  const el = term.element;
  if (!el) return;
  el.style.width = ''; el.style.height = ''; el.style.margin = '';
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
