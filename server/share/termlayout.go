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
//     随宽度收缩到装得下为止——高度溢出一律走 overset 外层滚动面 + follow 跟随
//     （P-20261118-9 引入、P-20261123-2 单面化收口），不再压缩字号迁就高度
//     （压高不救宽：网格宽度不变
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
--pad-x:clamp(10px,2.2vw,36px);--term-need:0px;--col-floor:clamp(1180px,82vw,2000px);
--sc-term-sb-thumb:#30363d;--sc-term-sb-hover:#484f58}
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
.term-box{overflow:auto;background:#0e1320;border-radius:10px;
scrollbar-gutter:stable;overflow-anchor:none}
/* overset 滚动条归属外层（P-20261123-2，取代 P-9 的 scrollbar-width:none）：
外层 term-box 是唯一可见滚动面——滚轮已由捕获相 scWheelCapture 接管驱动它，
滚动条与滚轮作用于同一面；xterm 自绘 slider 在 overset 态隐藏（DOM 实勘：
.xterm-scrollable-element > .scrollbar.vertical/.horizontal，vendored build
的平滑滚动件直挂 scrollable-element）。scrollbar-gutter:stable 常驻预留滚动条
位（出没不再改可用宽，字号不因条宽抖动重算）；overflow-anchor:none 关掉浏览器
滚动锚定（xterm 写入改的是画布像素/行 DOM，锚定会在内容变化时把 scrollTop 拽回
上一次锚点，与 follow 语义打架）。配色取产品暗色滚动条口径（web/src/assets/
base.css 的 --scrollbar-thumb/#30363d、hover #484f58，即 themes/dark.ts 值）：
端面恒深 #0e1320，四主题下都按暗档呈现，故写访客页局部变量而非引产品主题
（访客页零依赖、不读主人主题）。.xterm-viewport overflow-y:scroll 是常驻死槽
（viewport 空元素，scrollback 由 scrollable-element 内部管理），本域内收为
hidden 净掉一条伪滚动条，对 scrollback 可达性零影响 */
.term-box[data-overset]{scrollbar-width:thin;
scrollbar-color:var(--sc-term-sb-thumb) transparent}
.term-box[data-overset]::-webkit-scrollbar{width:8px;height:8px}
.term-box[data-overset]::-webkit-scrollbar-track{background:transparent}
.term-box[data-overset]::-webkit-scrollbar-thumb{background:var(--sc-term-sb-thumb);border-radius:4px}
.term-box[data-overset]::-webkit-scrollbar-thumb:hover{background:var(--sc-term-sb-hover)}
.term-box[data-overset]::-webkit-scrollbar-corner{background:transparent}
.term-box[data-overset] .xterm-scrollable-element > .scrollbar{display:none}
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
//     走 overset 外层滚动面（见 scWheelCapture/scEnsureCursorVisible 条目），不再
//     压缩字号迁就高度（旧 min(1,wR,hR) 把高会话/矮终端区压成小字窄条居中，两侧
//     留白原样）。xterm 元素按栅格定宽居中（右侧预留滚动条宽 SC_TERM_SB，与
//     FitAddon 同口径）、高度不小于容器（滚轮在整块终端区内都作用于超集栅格）。
//     容器隐藏/未布局时不动作，等下一次观测。纵向装不下（overset）时写
//     box.dataset.overset='1'（撤销即删）——CSS 切外层滚动条归属、捕获相接管
//     滚轮（见下注）；几何真变（cols/rows/字号/容器高之一变化=首载/主机改格/
//     字号收敛）才 scEnsureCursorVisible(force) 把光标行作默认位，同几何重复观测
//     不写 scrollTop（用户上滚阅读时 ResizeObserver 空转不拽回）
//   - scWheelCapture(box, term)：overset 滚轮单面化（P-20261123-2）。捕获相监听
//     （passive:false）只有 box.dataset.overset='1' 且确有溢出时生效：ctrl/meta
//     （含触控板捏合）只 stopPropagation 不 preventDefault（放行浏览器缩放、不让
//     xterm 内层吞）；shift+wheel 与纯横向 deltaX 忽略（无横向滚动面）；deltaMode
//     归一（pixel / line×字高 / page×clientHeight，触控板小数累积到整像素再动）
//     后 preventDefault+stopPropagation 并 rAF 合并写入 box.scrollTop。接管理由：
//     xterm 的 wheel 监听挂在 .xterm-scrollable-element（SmoothScrollableElement），
//     事件目标在它内部，捕获相先于内层——旧的 attachCustomWheelEventHandler 返回
//     false 只是让 xterm 的 _handleWheel 早退，事件仍被外层光滑滚动件消费，滚轮
//     从未真正到达 term-box（P-20261123-2 立案实测：outer scrollTop 恒不跟随）。
//     同时挂 scroll 监听区分「用户原生滚动（触摸/拖条）」与自家程序写（写后 500ms
//     内同位视为自家）：前者按是否触底刷新 follow
//   - scEnsureCursorVisible(box, term, force)：overset 跟随（P-20261123-2 取代
//     P-20261119-2 的每写钉底）。follow 状态初始 true；force=true（首载/重连 hello
//     /几何真变）把光标行顶作默认滚动位（rowY=0 是有效顶位）；否则仅在光标行
//     下沿越过可视窗下沿时最小滚动到刚可见。follow=false（用户 wheel 上滚或触摸
//     上滑）绝不写 scrollTop——上滚阅读不被新输出拽回；滚回底部（wheel 到底或
//     原生滚动触底）恢复 follow。光标行跑到可视窗上方（清屏/整屏重绘，光标跳回
//     格顶）不向上追随：那等于每次 TUI 重绘都把视口拽到格顶，正是被治理的「跳
//     光标锚」。alt-screen（全屏 TUI）与 fit=window 回退态改底部锚 maxTop（P-20261123-4
//     ③：状态/输入行在格底，尾部截头使访客 buffer 停在 normal 时由 fit 强制
//     底部锚，不单押 altScreen 探测）。写入路径统一进 scFlushScroll 的单一 rAF
//     写口（P-20261124-3 S1：一帧最多一次 scrollTop——旧实现 ensure 与 wheel 各自
//     一条 rAF，同帧先后写两次，视口抖动/闪烁的主要成因），clamp [0, maxTop]
//   - scFollowReset(box)：follow 回 true（重连 term.reset()/cast seek 重置屏幕后
//     调用），下一次 scEnsureCursorVisible（hello/setHost/drain）重新定位
//   - scCursorRowY(term)：光标行顶 y（px，px 级锚点供给 scEnsureCursorVisible）——
//     buffer.active.cursorY 是栅格内行号（0..rows-1，0 = 有效顶位），单元高与
//     scFitGrid 同源 scCellAt 按当前字号量测；实例未开放/异常回落 -1（未知哨兵，
//     与合法 0 区分）
//   - scTermDiag(term, box)：现场诊断（P-20261123-2 ④；P-20261123-4 ⑥ 扩展；
//     P-20261124-3 增历史模式/写入审计）——?term=diag 时暴露 window.__scTermDiag
//     （≤50 条环形：wheel dy/归一值/是否接住、outer scrollTop/scrollHeight/clientHeight、
//     follow、overset、inner ydisp/baseY/hasScrollback/historyMode、layout cols/rows/fs、
//     altScreen、fsWidth/fsFit、fitMode、geomTs、userGesture、visibleRows；绝不含
//     终端内容）+ snapshot() 即时快照 + writes（≤40 条滚动位写入审计：flush 序号/
//     from/to——证明「一帧最多一次写」与非回拽）。未开启时 scDiagPush/scDiagWrite
//     只过一条布尔判断，热路径零成本
//   - scFitMode(box)：'window' = 完整显示（fit，P-20261123-4 ④ 显式 opt-in）/
//     'auto' = 缺省档（P-20261124-3 S2：装不下整格且 fit 字号可达 SC_TERM_FIT_MIN
//     时自动按 window 走，否则回退宽度优先——页头开关可切显式 window/width）/
//     'width' = 宽度优先；读 data-fit-mode，页面脚本控制（cast/frozen 不设 = width）
//   - scIsAlt(term)：当前是否 alternate buffer（全屏 TUI）——锚定基准分叉用
//   - scOnBufferChange(term, box, relayout)：进入/退出 alt-screen 时重排 + force
//     重新锚定（xterm 不自动重排；旧内核无该事件时静默跳过）
//   - scHistoryEnter/scHistoryWheel/scHistoryExit(box, term)：overset 历史模式兜底
//     （P-20261124-3 S2）。S1 的显式取舍「overset 态 xterm scrollback 不可达」在
//     宽矮视口 fit 不可行（fs<SC_TERM_FIT_MIN）时仍是能力缺口：外层已到顶
//     （scrollTop==0）还继续上滚 → 把滚动面临时交还 xterm scrollback（term.scrollLines
//     驱动 buffer.ydisp），外层不回写、follow 置 false；页内浮层按钮「回到实时」
//     （#histBack，页面提供）是主出口。scHistoryEnter 返回是否进入——页面无浮层
//     （cast/frozen）时返回 false，调用方落回普通外层滚动，零行为变化；滚回
//     inner 底（viewportY≥baseY）、重连（scFollowReset）、外层原生滚动（触摸/拖条）
//     也是退出路径，退出时 scrollToBottom + force 定位。只有 normal buffer 有
//     scrollback（alt-screen 的 baseY 恒 0，天然不进），且复用既有两个监听
//     （wheel/scroll）不新增事件注册——fits 态与 cast/frozen 零变化
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
// fit=window 完整适配的可读下限（P-20261123-4 ④）：宽矮视口下 40 行要全见往往
// 需要 14 以下的字号；再低即纯损失（9px 不可读），装不下就回退宽度字号 + 底部锚
const SC_TERM_FIT_MIN = 12;
// 滚动/写入稳定化阈值（P-20261124-3 S1，全部 guest-only 呈现选择）：
//   - 触底容差：滚动条/触控板停在底部附近时 ±1px 抖动不反复翻 follow（真丢跟随时
//     用户会离底 >2px）；原 1px 在亚像素滚动设备上抖动频发
//   - 用户手势抑制窗：wheel/原生滚动后 150ms 内不落程序写——服务端 8ms 合帧下
//     ensure 与用户手势交错是「视口被拽一下」的成因；150ms 覆盖触控板惯性尾巴
//   - overset 滞回：整格高与容器高在 ±2px 内不切换滚动面归属（出没滚动条+内容
//     跳变=闪），代价是最多 2px 行被裁
//   - 字号应用阈值：候选字号与现值差 ≤0.25px 不写 xterm 字号（每次写都整屏重排），
//     同时用现值重算 cell 保持元素尺寸与实际字号一致
const SC_TERM_BOTTOM_EPS = 2;
const SC_TERM_USER_MS = 150;
const SC_TERM_OVER_HYST = 2;
const SC_TERM_FS_EPS = 0.25;
const SC_TERM_RO_EPS = 1;
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
function scTermNeed(cols, fs, allowSmall){
  if (!(cols > 0)) return 0;
  // 半边参数化钳 ≥ 产品字号（P-20261119-2，只放宽不收窄——理由见头注 scTermNeed 条目）。
  // fit=window 模式（P-20261123-4 ④）允许 <14：容器跟随实际字号变窄，避免两侧大留白
  fs = allowSmall ? (fs || 0) : Math.max(SC_TERM_FONT_SIZE, fs || 0);
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
// fit 模式（P-20261123-4 ④；P-20261124-3 S2 增 auto）：'window' = 完整显示（缩小
// 字号让全部行可见），'auto' = 缺省档（overset 且 fit 可行才实际缩字号，不可行
// 与 width 等价），'width' = 缺省宽度优先放大。落在 data-fit-mode 上，三页脚本
// 零改动即可读；未设/异形值一律 width（cast/frozen 不设 → 行为零变化）
function scFitMode(box){
  const m = box && box.dataset ? box.dataset.fitMode : '';
  return m === 'window' || m === 'auto' ? m : 'width';
}
// alt-screen 判定（P-20261123-4 ③）：全屏 TUI（vim/less/htop）切到 alternate buffer，
// 状态/输入行固定在格底——访客滚动锚改底部；normal 保持光标行锚。try 兜底旧内核
function scIsAlt(term){
  try { return term.buffer.active.type === 'alternate'; } catch (e) { return false; }
}
function scFitGrid(term, box, cols, rows){
  const el = term.element;
  if (!el || !box || !(cols > 0 && rows > 0)) return false;
  const cs = getComputedStyle(box);
  // 可用宽（P-20261123-4 ② 单次收敛）：稳定视口源 documentElement.clientWidth
  // 减 wrap 内边距与固定 chrome 36（= term-box 左右内边距 20 + 卡片边框 2 + 滚动条
  // 让位 14，与 scTermNeed/vpTarget 同源口径）——替代 box.clientWidth（其宽受
  // --term-need 反推控制，读回来再算字号构成「反推→读回→再反推」收敛环，首载
  // 多次收敛 22.5→22.75→26.25 派发多次原生 scroll 正是 follow 误清的触发面）。
  // 高度仍读 box（视口高稳定，不参与环）。wrap 定宽口径下与旧「加回 gutter 占位」
  // 稳态逐字节等价（1836+10−20−14 = 1920−72−36），只是不再依赖中间态
  const vw = document.documentElement.clientWidth;
  const wrapPad = (function(){
    const wrap = box.closest('.wrap') || box.parentElement;
    if (!wrap) return 0;
    const wcs = getComputedStyle(wrap);
    return (parseFloat(wcs.paddingLeft) || 0) + (parseFloat(wcs.paddingRight) || 0);
  })();
  const aw = Math.max(SC_TERM_MIN_FONT * 8, vw - wrapPad - 36);
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
    // 盲区），宽度优先 + overset 外层滚动面后纵向溢出不再吞掉宽度放大
    fs = SC_TERM_FONT_SIZE * Math.min(wR, SC_TERM_MAX_FONT / SC_TERM_FONT_SIZE);
    fs = Math.max(SC_TERM_FONT_SIZE, Math.floor(fs * 4) / 4);
    cell = scCellAt(fs);
    while (fs > SC_TERM_FONT_SIZE && cols * cell.w > aw) {
      fs = Math.max(SC_TERM_FONT_SIZE, fs - 0.25);
      cell = scCellAt(fs);
    }
  } else {
    // 收缩段：宽度优先（P-20261120-8 必改0 修订 P-20261107-4 的 min(1, wR, hR)
    // 双拟合）——字号只随宽度收缩到装得下为止，高度溢出交给下方 overset 滚动面而
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
  // fit 完整适配（P-20261123-4 ④ opt-in；P-20261124-3 S2 起 'auto' 缺省档同样走
  // 此分支）：宽度 fs 以内 0.25 步进向下找「rows*cellH ≤ ah 且 fs≥SC_TERM_FIT_MIN」
  // 的最大字号——装得下即无 overset、全行可见（xterm scrollback 天然可达）；装不下
  // （fs<12 仍溢出）回退宽度 fs+底部锚，不降到 9px 纯损失。宽度方向仍须装得下
  // （cell 随字号非线性，逐 0.25 校验同主链）。先做一次廉价不可行判定：cellH 随
  // 字号单调不减，12px 格高都超过容器高即无解，省去整条 0.25 量测链（auto 缺省档
  // 下每个观测都会走这里，量测=强制重排，热路径量级考量）
  const fsWidth = fs;
  const st = scScrollState(box);
  const fitMode = scFitMode(box);
  let fsFit = 0;
  if (fitMode !== 'width' && rows * cell.h > ah) {
    if (rows * scCellAt(SC_TERM_FIT_MIN).h <= ah) {
      let ffs = fs;
      while (ffs > SC_TERM_FIT_MIN && (rows * scCellAt(ffs).h > ah || cols * scCellAt(ffs).w > aw)) {
        ffs = Math.max(SC_TERM_FIT_MIN, ffs - 0.25);
      }
      if (ffs >= SC_TERM_FIT_MIN && rows * scCellAt(ffs).h <= ah && cols * scCellAt(ffs).w <= aw) {
        fs = ffs;
        cell = scCellAt(fs);
        fsFit = fs;
      }
    }
    // 装不下：保持宽度 fs（外层 overset + 底部锚兜底——不降 9px 纯损失）
  }
  // 字号应用阈值（P-20261124-3 S1）：候选与现值差 ≤0.25px 不写 xterm 字号——
  // 写字号 = 整屏重排（ResizeObserver 每轮观测都写即整屏闪）；跳过时用现值重算
  // cell，元素尺寸与真实字号保持一致
  const curFs = term.options.fontSize;
  if (Math.abs(curFs - fs) > SC_TERM_FS_EPS + 1e-6) {
    term.options.fontSize = fs;
    st.geomTs = Date.now();
  } else if (curFs !== fs) {
    fs = curFs;
    cell = scCellAt(fs);
    if (fsFit) fsFit = fs;
  }
  // 诊断面（P-20261123-4 ⑥）：宽度基线字号（无 fit 时为实际生效值）/ fit 实际
  // 字号 / 可见行数供 e2e 断言
  st.fsWidth = fsFit > 0 ? fsWidth : fs;
  st.fsFit = fsFit;
  st.visibleRows = cell.h > 0 ? Math.floor(ah / cell.h) : 0;
  if (term.cols !== cols || term.rows !== rows) { term.resize(cols, rows); st.geomTs = Date.now(); }
  el.style.width = (Math.ceil(cols * cell.w) + SC_TERM_SB) + 'px';
  el.style.height = Math.max(Math.ceil(rows * cell.h), ah) + 'px';
  el.style.margin = '0 auto';
  // overset 标记（P-20261118-9；P-20261123-2 起为外层滚动面开关）：整格高于容器
  // ——CSS 切外层滚动条归属、scWheelCapture 捕获相接管滚轮。几何真变（cols/rows/
  // 字号/容器高之一变化 = 首载、主机改格、字号收敛）才 force 定位光标行（唯一
  // 有意义的默认位）；同几何的重复观测不写 scrollTop——ResizeObserver 空转或横幅
  // 折叠时用户的阅读位置不被拽回。装得下即撤并复位滚动位与 follow（清态面：残留
  // overset 会让捕获相吞滚轮而容器此时无溢出，xterm scrollback 导航失灵）。
  // 滞回（P-20261124-3 S1）：临界 ±SC_TERM_OVER_HYST px 内不切换滚动面归属——
  // 旧实现在 rows*cellH 与 ah 差 1px 时因字号取整/滚动条让位反复 toggle，滚动条
  // 出没与内容跳变即用户可见的闪；fit 生效时全行必然装下，直接按非 overset 处理
  //（fit 搜索的装下容差恰在临界带内，不能被滞回留住旧态）
  const overflow = rows * cell.h - ah;
  const wantOverset = fsFit > 0 ? false
    : (scOverset(box) ? overflow > -SC_TERM_OVER_HYST : overflow > SC_TERM_OVER_HYST);
  if (wantOverset) {
    box.dataset.overset = '1';
    const geom = cols + 'x' + rows + '@' + fs + '/' + Math.round(ah);
    if (box.dataset.gridGeom !== geom) {
      box.dataset.gridGeom = geom;
      // 几何真变进抑制窗（P-20261123-4 ①）：字号/容器收敛触发的原生 scroll 在
      // 400ms 内不推断 follow（首载 follow=true 不被清——beta.10 回归修复点）
      st.geomTs = Date.now();
      scEnsureCursorVisible(box, term, true);
    }
  } else {
    delete box.dataset.overset;
    delete box.dataset.gridGeom;
    if (st.hist) scHistoryExit(box, st.term, false);
    scSetFollow(box, true);
    box.scrollTop = 0;
  }
  box.dataset.cols = String(cols);
  box.dataset.rows = String(rows);
  box.dataset.fontSize = String(fs);
  return true;
}
// ── overset 滚动单面化（P-20261123-2）────────────────────────────────────
// 为什么：产品内终端只有一个滚动面（FitAddon 把 xterm 栅格 fit 到 pane，
// term.onResize 回灌 PTY resize，滚动唯一面是 xterm 内部的 SmoothScrollableElement）；
// 分享页因主机栅格可高于访客终端区，.term-box{overflow:auto} 形成第二个「外层
// 超集面」——两面竞争 + 每写钉底/光标重锚就是用户实测的滚动闪烁/跳位。本段把
// overset 态收敛为外层唯一面：捕获相 wheel 接管 + 滚动条归属外层（CSS）+ follow
// 光标可见性最小滚动。显式取舍（正式收口 P-9/19-2 权衡）：overset 态 wheel 不再
// 送达 TUI 鼠标上报（xterm 的 mouse 上报在同一 wheel 消费链之后），xterm
// scrollback 历史也不再可达（外层只滚超集栅格）——分享页是主机屏视窗，优先可
// 滚动；fits 态零变化（外层无溢出，xterm 内部面照旧单面）。
function scScrollState(box){
  if (!box.__scScroll) {
    box.__scScroll = {
      follow: true,   // 跟随最新输出（首载 true；用户上滚清、滚回底恢复）
      writeAt: -1,    // 最近一次程序写落位（与原生滚动区分）
      writeTs: 0,
      geomTs: 0,      // 最近一次几何/字号/容器变化时刻（P-20261123-4 ①）：抑制窗
                      // 内不做 follow 推断——字号收敛造成的浏览器原生 scroll 调整
                      // 不再被误判成用户滚动（beta.10「follow 首载丢失」回归根因）
      acc: 0,         // 触控板小数累积（整像素才动）
      pending: 0,     // 待应用的用户 wheel 位移（进唯一写口）
      target: null,   // 待应用的程序定位（进唯一写口；null=无）
      writeRaf: 0,    // 唯一写口 rAF（P-20261124-3 S1：一帧最多一次 scrollTop）
      flushId: 0,     // 写口序号（诊断审计：同一 flush 内不得二次写）
      frameTs: 0,     // 当前写口的 rAF 时间戳（同帧写入审计）
      force: false,   // 待应用的强制定位（首载/重连/几何真变）
      ensureRaf: 0,
      ensureInfo: null, // 待应用程序定位的来源信息（write 审计/ensure 诊断）
      followCand: null, // 原生滚动的触底候选（连续两帧确认后才落 follow）
      followSeq: 0,
      hist: false,    // 历史模式（overset 到顶继续上滚 → 交还 xterm scrollback）
      histAcc: 0,     // 历史模式的逐行小数累积
      term: null,     // scWheelCapture 装入（历史模式/退出定位用）
      // 诊断面（P-20261123-4 ⑥）：fsWidth=宽度优先基线字号、fsFit=fit 实际字号
      //（0=fit 未生效）、visibleRows=当前字号下可见行数、userTs=最近用户手势时刻
      fsWidth: 0,
      fsFit: 0,
      visibleRows: 0,
      userTs: 0
    };
  }
  return box.__scScroll;
}
function scSetFollow(box, on){
  const st = scScrollState(box);
  st.follow = !!on;
  box.dataset.follow = on ? '1' : '0';
  if (!on) { st.acc = 0; st.pending = 0; st.target = null; st.ensureInfo = null; }
}
// 唯一写口（P-20261124-3 S1）：wheel 位移与 ensure 程序定位都只登记到同一 rAF，
// 帧内合并为一次 scrollTop 写——旧实现 ensure/wheel 各自一条 rAF，同帧先后各写
// 一次（外加各自引发的 scroll 事件），是「滚动时闪」的写入面成因
function scQueueWrite(box){
  const st = scScrollState(box);
  if (st.writeRaf) return;
  st.writeRaf = requestAnimationFrame(function(ts){ st.writeRaf = 0; st.frameTs = ts || 0; scFlushScroll(box); });
}
function scQueueScroll(box, top){
  const st = scScrollState(box);
  st.target = top;
  scQueueWrite(box);
}
function scFlushScroll(box){
  const st = scScrollState(box);
  if (!scOverset(box)) { st.pending = 0; st.target = null; st.ensureInfo = null; return; }
  // follow=false（用户阅读态）：程序目标一律丢弃（ensure 上游也已拒绝），只落用户 wheel
  if (!st.follow) { st.target = null; st.ensureInfo = null; }
  const maxTop = scMaxTop(box);
  const from = box.scrollTop;
  let next = from;
  let wheeled = false;
  let programmatic = false; // 本帧实际应用了 ensure 目标（写审计/诊断口径）
  if (st.pending) {
    next = Math.max(0, Math.min(maxTop, from + st.pending));
    st.pending = 0;
    wheeled = true;
  }
  // 用户手势后 SC_TERM_USER_MS 内不落程序写（抑制窗）：目标保留，输出继续推时
  // 下一帧/下一次 ensure 再试——与 wheel 交错造成的「拽一下」由此消除
  if (st.target != null && Date.now() - (st.userTs || 0) >= SC_TERM_USER_MS) {
    const t = Math.max(0, Math.min(maxTop, st.target));
    st.target = null;
    if (Math.abs(t - next) >= 0.5) { next = t; programmatic = true; }
    else st.ensureInfo = null; // 目标已被当前位置覆盖：不产生 ensure 事件
  }
  // wheel 触底判定用 ≥2px 容差（亚像素滚动条/触控板在底部 ±1px 抖动不翻 follow）
  if (wheeled) scSetFollow(box, next >= maxTop - SC_TERM_BOTTOM_EPS);
  if (Math.abs(next - from) < 0.5) { if (programmatic) st.ensureInfo = null; return; }
  st.flushId++;
  box.scrollTop = next;
  // 记锚：紧跟的 scroll 事件（用户/程序写都会派发）据此区分来源
  st.writeAt = box.scrollTop;
  st.writeTs = Date.now();
  st.geomTs = st.writeTs; // 程序写同样进入几何抑制窗（P-20261123-4 ①）
  scDiagWrite(box, from, box.scrollTop, programmatic);
  // ensure 诊断只在程序目标真的落写时记（wheel-only 写不冒充 ensure 事件）
  if (programmatic && st.ensureInfo) {
    scDiagNote('ensure', st.term, box, Object.assign(
      { from: Math.round(from), to: Math.round(box.scrollTop) }, st.ensureInfo));
    st.ensureInfo = null;
  }
}
// 原生滚动触底推断的连续两帧确认（P-20261124-3 S1）：单帧抖动不翻 follow，
// 两帧后位置结论一致才落（true→false / false→true 双向）
function scFollowConfirm(box){
  const st = scScrollState(box);
  st.followCand = box.scrollTop >= scMaxTop(box) - SC_TERM_BOTTOM_EPS;
  const seq = ++st.followSeq;
  requestAnimationFrame(function(){
    requestAnimationFrame(function(){
      if (seq !== st.followSeq) return; // 期间有新滚动/几何事件：本轮作废
      const cand = box.scrollTop >= scMaxTop(box) - SC_TERM_BOTTOM_EPS;
      if (cand === st.followCand) scSetFollow(box, cand);
    });
  });
}
function scMaxTop(box){ return Math.max(0, box.scrollHeight - box.clientHeight); }
function scOverset(box){ return !!(box && box.dataset && box.dataset.overset === '1'); }
function scTermCellH(term){
  try {
    const h = scCellAt(term.options.fontSize).h;
    return h > 0 ? h : SC_TERM_FONT_SIZE;
  } catch (e) { return SC_TERM_FONT_SIZE; }
}
// deltaMode 归一：0=pixel 原值；1=line（×字高）；2=page（×视口高）
function scNormWheel(e, cellH, pageH){
  const raw = e.deltaY || 0;
  if (e.deltaMode === 1) return raw * cellH;
  if (e.deltaMode === 2) return raw * pageH;
  return raw;
}
function scWheelCapture(box, term){
  if (!box || box.__scWheelOn) return;
  box.__scWheelOn = true;
  scScrollState(box).term = term;
  scSetFollow(box, true);
  // 捕获相接管（passive:false）：xterm 的 wheel 监听挂在 .xterm-scrollable-element
  // 上，捕获相先于它；不 stopPropagation 的话内层光滑滚动件照常消费（旧
  // attachCustomWheelEventHandler 的「放行」只在 _handleWheel 入口短路，事件
  // 仍被外层消费——P-20261123-2 立案实测 wheel 后 outer scrollTop 恒不变）
  box.addEventListener('wheel', function(e){
    const st = scScrollState(box);
    // 仅 overset 且确有溢出：fits 态外层是死容器，xterm 内部面即单面（行为原样）；
    // 历史模式中若几何变化使超集面消失，先退出历史模式（滚轮交还内层）
    if (!scOverset(box) || !(box.scrollHeight > box.clientHeight + 1)) {
      if (st.hist) scHistoryExit(box, term, false);
      // 诊断：fits 态 wheel 落到 xterm 内部面（inner 消费的实证面，含 inner ydisp）
      scDiagNote('wheel-inner', term, box, { dy: e.deltaY || 0, mode: e.deltaMode, handled: false });
      return;
    }
    // ctrl/meta（含触控板捏合）= 浏览器缩放：拦下内层 xterm，但不改缺省（缩放照常）
    if (e.ctrlKey || e.metaKey) { e.stopPropagation(); return; }
    // shift+wheel（浏览器常转成横向）与纯横向分量：本页无横向滚动面，忽略
    if (e.shiftKey) return;
    const cellH = scTermCellH(term);
    const dy = scNormWheel(e, cellH, box.clientHeight);
    if (!dy) return;
    e.preventDefault();
    e.stopPropagation();
    st.userTs = Date.now(); // 用户手势时刻（P-20261123-4 ⑥ 诊断）
    // 历史模式（P-20261124-3 S2）：外层已交还滚动面，滚轮直接驱动 xterm scrollback
    if (st.hist) {
      scHistoryWheel(box, term, dy);
      scDiagNote('wheel', term, box, { dy: dy, norm: Math.round(dy), mode: e.deltaMode, handled: true, hist: 1 });
      return;
    }
    // 进入历史模式：overset 已到顶（scrollTop≤1）仍继续上滚，且 normal buffer 确有
    // scrollback + 页面提供退出浮层。alt-screen/fits 态天然不进（见 scCanHistory）；
    // scHistoryEnter 返回 false（cast/frozen 无浮层）时落回下方普通外层滚动路径
    if (dy < 0 && box.scrollTop <= 1 && scHistoryEnter(box, term)) {
      scHistoryWheel(box, term, dy);
      scDiagNote('wheel', term, box, { dy: dy, norm: Math.round(dy), mode: e.deltaMode, handled: true, hist: 1 });
      return;
    }
    st.acc += dy;
    const whole = st.acc > 0 ? Math.floor(st.acc) : Math.ceil(st.acc);
    if (!whole) {
      // 触控板小数（<1px/帧）累积到整像素才动，避免反复写同位
      scDiagNote('wheel', term, box, { dy: dy, norm: 0, mode: e.deltaMode, handled: true });
      return;
    }
    st.acc -= whole;
    st.pending += whole;
    scQueueWrite(box); // 唯一写口（P-20261124-3 S1：与 ensure 同帧只落一次）
    scDiagNote('wheel', term, box, { dy: dy, norm: whole, mode: e.deltaMode, handled: true });
  }, { passive: false, capture: true });
  // 原生滚动（触摸/拖滚动条/键盘）：与程序写区分——写后 500ms 内同位视为自家
  // 回写；用户滚动按是否触底刷新 follow（触摸上滑清 follow 即走此路）
  box.addEventListener('scroll', function(){
    const st = scScrollState(box);
    const own = Math.abs(box.scrollTop - st.writeAt) <= 1 && Date.now() - st.writeTs < 500;
    // 几何抑制窗（P-20261123-4 ①）：scFitGrid 字号/容器收敛后的 400ms 内浏览器
    // 会派发原生 scroll（几何变化调整 scrollTop）——此窗内**不做 follow 推断**
    //（只记诊断），否则宽度优先放大（22.5→22.75→26.25）的偏移被判成用户滚动
    // → follow=false → scEnsureNow 恒 return → 视图停中间、底部被截（beta.10
    // 回归根因）。窗内 own 锚照常维护（500ms 内同位仍是程序写回写）
    if (Date.now() - st.geomTs < 400) {
      scDiagNote('scroll-geomts', term, box, { own: own });
      return;
    }
    if (!own) {
      // 双向 truth table（P-20261123-4 ①）+ 连续两帧确认（P-20261124-3 S1）：
      // 窗外非 own scroll 一律按触底判定（离开底部即 false、回底即 true），但
      // 单帧抖动不落，两帧后位置一致才写 follow
      st.userTs = Date.now(); // 用户手势时刻（P-20261123-4 ⑥ 诊断）
      if (st.hist) scHistoryExit(box, term, false);
      scFollowConfirm(box);
      st.acc = 0;
    }
    scDiagNote('scroll', term, box, { own: own });
  }, { passive: true });
}
// ── 历史模式兜底（P-20261124-3 S2）──────────────────────────────────────
// 进入条件：overset 外层已到顶（scrollTop≤1）仍继续上滚 + normal buffer 确有
// scrollback（baseY>0）+ 页面提供退出浮层（#histBack；cast/frozen 无此元素 →
// 零启用零变化）。alt-screen 的 baseY 恒 0（xterm 不保留历史），天然不进。
// 退出路径：滚回 inner 底（viewportY≥baseY）/ 浮层按钮 / 外层原生滚动 / 重连
//（scFollowReset）/ 几何回落到 fits（scFitGrid 清态）——统一 scrollToBottom +
// 需要时 scFollowReset 语义的 force 定位，绝不留在历史态
function scHistButton(){ return document.getElementById('histBack'); }
function scCanHistory(term){
  try {
    const b = term.buffer.active;
    return b.type === 'normal' && b.baseY > 0;
  } catch (e) { return false; }
}
function scHistoryEnter(box, term){
  const st = scScrollState(box);
  if (st.hist) return true;
  // 页面必须提供退出浮层（#histBack；cast/frozen 无此元素 → 不进历史模式）。
  // 返回是否进入：调用方据此决定是否消费本轮 wheel——旧写法在无浮层页仍调用
  // scHistoryWheel，cast 回放页会在 overset 到顶后静默滚 inner xterm（无处退出，
  // 违反「frozen/cast 零变化」）
  if (!scHistButton() || !scCanHistory(term)) return false;
  st.hist = true;
  st.histAcc = 0;
  st.term = term;
  scSetFollow(box, false);
  box.dataset.history = '1';
  const btn = scHistButton();
  if (btn) btn.hidden = false;
  scDiagNote('history-in', term, box, { hist: 1 });
  return true;
}
function scHistoryWheel(box, term, dy){
  const st = scScrollState(box);
  if (!st.hist) return; // 防御：只有进入历史模式后 wheel 才驱动 inner scrollback
  const cellH = scTermCellH(term);
  st.histAcc += dy / (cellH > 0 ? cellH : SC_TERM_FONT_SIZE);
  const lines = st.histAcc > 0 ? Math.floor(st.histAcc) : Math.ceil(st.histAcc);
  if (!lines) return;
  st.histAcc -= lines;
  try { term.scrollLines(lines); } catch (e) { scHistoryExit(box, term, true); return; }
  // 回底：inner viewportY 追平 baseY → 交还实时（退出时 force 定位）
  try {
    const b = term.buffer.active;
    if (b.viewportY >= b.baseY) scHistoryExit(box, term, true);
  } catch (e) { scHistoryExit(box, term, true); }
}
function scHistoryExit(box, term, reposition){
  if (!box) return;
  const st = scScrollState(box);
  if (!st.hist) return;
  const t = term || st.term;
  st.hist = false;
  st.histAcc = 0;
  delete box.dataset.history;
  const btn = scHistButton();
  if (btn) btn.hidden = true;
  try { if (t) t.scrollToBottom(); } catch (e) { /* 实例已销毁 */ }
  if (reposition && t) {
    // 退出是显式动作（按钮/回底）：清用户手势时刻，让 force 定位当帧落地
    st.userTs = 0;
    scSetFollow(box, true);
    scEnsureCursorVisible(box, t, true);
  }
  scDiagNote('history-out', t, box, { hist: 0 });
}
function scEnsureCursorVisible(box, term, force){
  if (!box || !term) return;
  const st = scScrollState(box);
  if (force) st.force = true;
  if (st.ensureRaf) return;
  // rAF 合并：写入回执里可能每 8ms 一次（服务端合帧），同一帧只量一次几何
  st.ensureRaf = requestAnimationFrame(function(){ st.ensureRaf = 0; scEnsureNow(box, term); });
}
function scEnsureNow(box, term){
  const st = scScrollState(box);
  const force = st.force;
  st.force = false;
  if (!term.element) return;
  // 无超集面（fits/清态/隐藏/结束态）：不写滚动位（隐藏时 clientHeight=0，
  // scrollHeight 亦为 0，一并被此守卫拦下）
  if (!scOverset(box) || !(box.scrollHeight > box.clientHeight + 1)) return;
  // follow=false：绝不写 scrollTop（含 force 场景）——用户上滚阅读的位置优先，
  // 重排/新输出都不许把视口拽走；follow 由滚回底部或重连/seek 的 scFollowReset 恢复
  if (!st.follow) return;
  // 用户手势后 SC_TERM_USER_MS 内抑制程序写（P-20261124-3 S1）：服务端 8ms 合帧下
  // ensure 与 wheel 交错会把视口拽一下（闪烁主因）；此窗内 force 一并让位——用户
  // 正在交互时首载/几何定位不该抢回视口，后续输出/ensure 在窗外自然重算
  if ((st.userTs || 0) && Date.now() - st.userTs < SC_TERM_USER_MS) return;
  // 锚定基准（P-20261123-4 ③）：alt-screen（全屏 TUI——状态/输入行固定在格底，
  // tail 截头导致访客 buffer 停在 normal 时由 fit=window/可见开关强制底部锚）与
  // fit=window 回退态（装不下只能外层滚）一律底部锚 maxTop；normal 保持光标行锚
  const anchorBottom = scIsAlt(term) || scFitMode(box) === 'window';
  const rowY = scCursorRowY(term);   // -1 = 未知
  if (!anchorBottom && rowY < 0) return;
  const cellH = scTermCellH(term);
  const maxTop = scMaxTop(box);
  const top = box.scrollTop;
  const h = box.clientHeight;
  let next = top;
  if (anchorBottom) {
    // 底部锚：首载/几何真变与跟随都贴格底（底部状态行/输入行可见）
    next = maxTop;
  } else if (force) {
    // 首载/重连 hello/几何真变：光标行顶 = 默认位（rowY=0 是有效顶位，不再当未知
    // 落 maxTop——旧实现把新鲜提示符页拽到格底即「934→88」跳位的一半成因）
    next = rowY;
  } else if (rowY + cellH > top + h + 0.5) {
    // 跟随：光标行下沿越过窗底才最小滚动到刚可见（只向下——光标跑到窗上方是
    // 清屏/整屏重绘，向上追随会在每次 TUI 重绘时把视口拽到格顶，正是要治理的
    // 「跳光标锚」）
    next = rowY + cellH - h;
  } else {
    return;
  }
  next = Math.max(0, Math.min(maxTop, next));
  if (Math.abs(next - top) < 0.5) return;
  // 进唯一写口（P-20261124-3 S1）：与 wheel 同帧合并，最多一次 scrollTop 写；
  // ensure 诊断在落写时由 scFlushScroll 记账（from/to 为实际落位）
  st.ensureInfo = { force: force, rowY: Math.round(rowY) };
  scQueueScroll(box, next);
}
function scFollowReset(box){
  if (!box) return;
  const st = scScrollState(box);
  // 重连/seek 重置屏后历史模式无意义（buffer 已换/回底）：先退出再复位 follow
  if (st.hist) scHistoryExit(box, st.term, false);
  scSetFollow(box, true);
}
// 缓冲区切换重排（P-20261123-4 ③）：进入/退出 alt-screen 只换 xterm 缓冲，不自动
// 触发容器观测——不重排就沿旧字号/旧 overset 态，且新旧缓冲的锚定基准不同（alt
// 底部 / normal 光标）。此钩子 relayout + force 一次；旧内核无 onBufferChange 时
// 静默跳过（几何观测仍兜底）
function scOnBufferChange(term, box, relayout){
  try {
    if (!term.buffer || typeof term.buffer.onBufferChange !== 'function') return;
    term.buffer.onBufferChange(function(){
      if (relayout) relayout();
      scEnsureCursorVisible(box, term, true);
      scDiagNote('buffer', term, box, {});
    });
  } catch (e) { /* 旧内核/已销毁实例：忽略 */ }
}
function scCursorRowY(term){
  // 光标行顶 y（px）：最新输出行锚点（buffer.active.cursorY = 栅格内行号 0..rows-1，
  // 单元高与 scFitGrid 同源 scCellAt 按当前字号量测）；rowY=0 是有效顶位（新鲜
  // 提示符/清屏后），实例未开放/异常回落 -1（未知哨兵——旧实现回落 0 与合法顶位
  // 混淆，逼出「rowY=0 当未知、落 maxTop」的跳位）
  try {
    const cy = term.buffer.active.cursorY;
    if (!(cy >= 0)) return -1;
    const h = scCellAt(term.options.fontSize).h;
    return h > 0 ? cy * h : -1;
  } catch (e) { return -1; }
}
// 现场诊断（P-20261123-2 ④；P-20261124-3 增 inner baseY/历史模式与写入审计）：
// ?term=diag 暴露 window.__scTermDiag（≤50 条环形，绝不含终端内容）。字段：wheel
// 的 dy/归一值/是否接住、outer scrollTop/scrollHeight/clientHeight、follow、
// overset、inner ydisp(viewportY)/baseY/hasScrollback、historyMode、layout
// cols/rows/fs——滚动类主诉据此定性（inner 消费/拽回/重排）。writes 是滚动位写入
// 审计（≤40 条：flush 序号/from/to），证明「一帧最多一次写」与非回拽。未开启时
// scDiagPush/scDiagWrite 只过一条布尔判断
let scDiagOn = false;
function scDiagFields(term, box, extra){
  const st = scScrollState(box);
  const out = {
    top: Math.round(box.scrollTop), sh: box.scrollHeight, ch: box.clientHeight,
    follow: box.dataset.follow === '1', overset: scOverset(box),
    ydisp: -1, baseY: 0, hasSb: false, historyMode: !!st.hist, cols: 0, rows: 0, fs: 0,
    // 布局/锚定诊断（P-20261123-4 ⑥）：altScreen=当前是否 alternate buffer、
    // fsWidth=宽度优先基线字号、fsFit=fit 实际字号（0=未生效）、fitMode=模式、
    // geomTs=最近几何变化时刻、userGesture=最近用户手势时刻（0=无）、
    // visibleRows=当前字号下终端区可见行数
    altScreen: false, fsWidth: st.fsWidth || 0, fsFit: st.fsFit || 0,
    fitMode: scFitMode(box), geomTs: st.geomTs || 0, userGesture: st.userTs || 0,
    visibleRows: st.visibleRows || 0
  };
  try {
    const b = term.buffer.active;
    out.ydisp = b.viewportY;
    out.baseY = b.baseY;
    out.hasSb = b.baseY > 0;
    out.altScreen = b.type === 'alternate';
    out.cols = term.cols;
    out.rows = term.rows;
    out.fs = term.options.fontSize;
  } catch (e) { /* 实例未开放：保留哨兵值 */ }
  if (extra) Object.assign(out, extra);
  return out;
}
function scDiagPush(kind, fields){
  if (!scDiagOn) return;
  const d = window.__scTermDiag;
  if (!d) return;
  const e = { t: Date.now(), kind: kind };
  if (fields) Object.assign(e, fields);
  d.entries.push(e);
  if (d.entries.length > 50) d.entries.splice(0, d.entries.length - 50);
}
// 写入审计（P-20261124-3 S1）：每次真实 scrollTop 写记一条（与 entries 分离，
// 不挤占 wheel/scroll/ensure 序列；≤40 条，绝不含终端内容）
function scDiagWrite(box, from, to, programmatic){
  if (!scDiagOn) return;
  const d = window.__scTermDiag;
  if (!d || !d.writes) return;
  const st = scScrollState(box);
  d.writes.push({ t: Date.now(), frame: st.frameTs || 0, flush: st.flushId,
    from: Math.round(from), to: Math.round(to), prog: !!programmatic });
  if (d.writes.length > 40) d.writes.splice(0, d.writes.length - 40);
}
// 采集包装：关闭时零字段采集（scDiagFields 含 buffer/几何读，不做事先构造）
function scDiagNote(kind, term, box, extra){
  if (!scDiagOn) return;
  scDiagPush(kind, scDiagFields(term, box, extra));
}
function scTermDiag(term, box){
  let on = false;
  try { on = /(?:^|[?&])term=diag(?:&|$)/.test(location.search || ''); } catch (e) { on = false; }
  if (!on || !box) return null;
  window.__scTermDiag = {
    entries: [],
    writes: [],
    clear: function(){ this.entries.length = 0; this.writes.length = 0; },
    // 即时快照（e2e 读 inner ydisp/baseY/historyMode 的变化用；仅在 diag 开启时存在）
    snapshot: function(){ return scDiagFields(term, box); }
  };
  scDiagOn = true;
  scDiagPush('attach', scDiagFields(term, box));
  return window.__scTermDiag;
}
function scClearGrid(term){
  const el = term.element;
  if (!el) return;
  el.style.width = ''; el.style.height = ''; el.style.margin = '';
  // 回落容器 fit（主机尺寸未知/撤销栅格）：overset 标记随内联尺寸一起撤——
  // 残留会让捕获相吞滚轮而容器此时无溢出，xterm scrollback 导航失灵。滚动位与
  // follow 同复位（P-20261123-2）：软折行无超集滚动面，残留滚动位会在容器回涨到
  // 溢出时把首屏误留在旧位置
  const box = el.parentElement;
  if (box && box.dataset) {
    if (box.__scScroll && box.__scScroll.hist) scHistoryExit(box, box.__scScroll.term, false);
    // fit 生效态标记随栅格一起撤（P-20261124-3）：回落容器 fit 时不再按 fit 字号
    // 放开 --col-floor/列宽——页面脚本的 fitEngaged() 读 fsFit，残留会让容器-fit
    // 页停留在放流式下限的观感
    if (box.__scScroll) box.__scScroll.fsFit = 0;
    delete box.dataset.overset;
    delete box.dataset.gridGeom;
    scSetFollow(box, true);
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
    if (window.ResizeObserver && el) {
      // contentRect 阈值过滤（P-20261124-3 S1）：亚像素抖动/滚动条让位等 <1px 的
      // 观测不触发重排（重排=字号重算+整屏重排的潜在源）；首帧必放行，手动 kick
      // （setHost/hello 的重排点）不受此过滤
      let lw = -1, lh = -1, first = true;
      new ResizeObserver(function(entries){
        const r = entries && entries[0] && entries[0].contentRect;
        if (r) {
          if (!first && Math.abs(r.width - lw) < SC_TERM_RO_EPS && Math.abs(r.height - lh) < SC_TERM_RO_EPS) return;
          lw = r.width; lh = r.height; first = false;
        }
        kick();
      }).observe(el);
      return kick;
    }
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
