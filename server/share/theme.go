package share

// 访客页族主题切换共享注入件（P-20261120-1）。循 guestboard/collabpage/
// termlayout 注入范式：单一事实源的 CSS/JS 常量经模板字段注入各页（终端系
// 三页 + 会话回放页），文件分享页经 pageTmplSrc 常量拼接、快投递两页经
// share 包引用（server/api/quickdrop/page.go）取同一份 CSS——六页主题词表
// 单一来源，不手抄。
//
// THEME_KEY 沿用文件页既有 'sc.share.theme'（page_js_core.go 原段切出），
// 且刻意跨页共享：访客在任一访客页选过的主题，其余访客页自动记住（预期
// 行为非缺陷——全访客面偏好一次设置全局生效）。auto 档不写任何覆盖规则，
// 回落各页既有 :root 双 prefers-color-scheme 块。
//
// 扩展 token（评审必改1）：文件页主题块只含基础十枚 token，而终端系/会话/
// 快投递页在基础族之外还消费警示/危险/思考/工具/成败/弱 accent 等扩展 token
// （--warn-* termpage:243 消费 .banner 与 writablepage 横幅、--danger-*
// termlayout:53/55 消费 .banner.unfiltered、--think/--tool/--fail sessionpage
// :124 消费 :168-:182、--accent-weak/--ok/--err quickdrop page.go:149-150
// 消费面十余处）。html[data-theme=…]（特异度 0,1,1）压过 @media :root
// （0,1,0）——主题块缺行时这些扩展 token 在显式主题下保留 OS 媒体取值，
// 浅色 OS 选深色主题会出「奶油色警示横幅贴深色页」的破绽。故四主题块统一
// 携带全部扩展 token（未消费的页面上是惰性自定义属性，零开销）；one-dark/
// dracula 属深色族，语义面 token 沿用深色档取值，--accent-weak 按各主题
// accent2 同透明度派生。light/dark 档扩展 token 与各页 OS 媒体档逐值相同
// ——显式 light/dark 与 auto 观感一致，只锁档不换肤。
//
// JS 依赖宿主页的 t(key) 词典函数与 SC.dict（六页均有；注入件只在函数体
// 内引用 t，head 注入的 initTheme() 先行调用不触词典——防闪白，评审建议4）。
// 主题五键词条由各页词典自持（termpage/cast/frozen/session 四套 + quickdrop
// 双语硬编码），文件页用 page_i18n.go 既有键，键名六页同表。

// GuestThemeCSS 四款显式主题的 token 覆盖块 + .theme-select 控件规则（评审
// 必改4：控件规则原住 page_css.go:61-63 通用段，不在主题块内——只搬主题块
// 六页 select 裸奔无样式）。基础十枚 token 与原文件页主题块逐值相同。
const GuestThemeCSS = `/* ── 主题切换（P-20261120-1 访客页族共享注入件，theme.go 单一事实源）──
   四款显式主题 token 覆盖块（调色板对齐主应用 themes/：GitHub Light /
   GitHub Dark / One Dark / Dracula）；auto 档回落各页既有 :root 双
   prefers-color-scheme 块。扩展 token 为终端系/会话/快投递页消费面补行
   （缺失时显式主题下保留 OS 媒体取值——浅色 OS 选深色主题出浅色警示横幅
   贴深色页的破绽）；one-dark/dracula 属深色族沿用深色语义面取值，
   --accent-weak 按各主题 accent2 同透明度派生 */
html[data-theme="light"]{--bg:#f6f8fa;--card:#ffffff;--text:#1f2328;--muted:#59636e;--border:#d1d9e0;
--accent:#0969da;--accent2:#8250df;--hover:#eaf1f8;--chip:#ddf4ff;--shadow:0 10px 30px rgba(31,35,40,.08);
--warn-bg:#fff7e8;--warn-bd:#f0d9a8;--warn-tx:#8a5b00;
--danger-bg:#fff1f0;--danger-bd:#f3b8b4;--danger-tx:#b42318;
--think-bg:#f7f4ff;--think-bd:#ddd2ff;--tool-bg:#f5f8ff;--tool-bd:#cfe0ff;--fail:#c03050;
--accent-weak:rgba(130,80,223,.10);--ok-bg:#e6ffec;--ok:#1a7f37;--err-bg:#ffebe9;--err:#cf222e}
html[data-theme="dark"]{--bg:#0d1117;--card:#161b22;--text:#e6edf3;--muted:#9198a1;--border:#3d444d;
--accent:#4493f8;--accent2:#ab7df8;--hover:#151b23;--chip:#1c2a3a;--shadow:0 10px 30px rgba(0,0,0,.4);
--warn-bg:#2d2410;--warn-bd:#5a4a1e;--warn-tx:#e8c87a;
--danger-bg:#3a1714;--danger-bd:#7a2e28;--danger-tx:#ffb4ab;
--think-bg:#201a33;--think-bd:#3b3060;--tool-bg:#141d31;--tool-bd:#27406b;--fail:#ff6b81;
--accent-weak:rgba(171,125,248,.14);--ok-bg:#12351a;--ok:#7ee2a8;--err-bg:#3d1a1a;--err:#ff8182}
html[data-theme="one-dark"]{--bg:#282c34;--card:#21252b;--text:#abb2bf;--muted:#7f848e;--border:#3e4451;
--accent:#61afef;--accent2:#c678dd;--hover:#2f333d;--chip:#2c313a;--shadow:0 10px 30px rgba(0,0,0,.4);
--warn-bg:#2d2410;--warn-bd:#5a4a1e;--warn-tx:#e8c87a;
--danger-bg:#3a1714;--danger-bd:#7a2e28;--danger-tx:#ffb4ab;
--think-bg:#201a33;--think-bd:#3b3060;--tool-bg:#141d31;--tool-bd:#27406b;--fail:#ff6b81;
--accent-weak:rgba(198,120,221,.14);--ok-bg:#12351a;--ok:#7ee2a8;--err-bg:#3d1a1a;--err:#ff8182}
html[data-theme="dracula"]{--bg:#282a36;--card:#21222c;--text:#f8f8f2;--muted:#6272a4;--border:#44475a;
--accent:#bd93f9;--accent2:#ff79c6;--hover:#343746;--chip:#3b3d4f;--shadow:0 10px 30px rgba(0,0,0,.45);
--warn-bg:#2d2410;--warn-bd:#5a4a1e;--warn-tx:#e8c87a;
--danger-bg:#3a1714;--danger-bd:#7a2e28;--danger-tx:#ffb4ab;
--think-bg:#201a33;--think-bd:#3b3060;--tool-bg:#141d31;--tool-bd:#27406b;--fail:#ff6b81;
--accent-weak:rgba(255,121,198,.14);--ok-bg:#12351a;--ok:#7ee2a8;--err-bg:#3d1a1a;--err:#ff8182}
/* 主题切换控件（六页同款；文件页「⋯」菜单内的全宽形态由 .more-theme 修饰，
   窄屏收菜单的 .desktop-only 语义仍是文件页自身规则） */
.theme-select{flex:0 0 auto;border:1px solid var(--border);background:var(--card);color:var(--text);
padding:5px 8px;border-radius:8px;font-size:12px;cursor:pointer;outline:none}
.theme-select option{color:var(--text);background:var(--card)}`

// guestThemeJS 主题原语 + 切换器构造（page_js_core.go:19-29 主题段与
// page_js_shell.go makeThemeSelect 切出参数化）。自包含：不引用宿主页的
// el()/SC（终端页无此二名），仅函数体内引用 t(key) 词典函数（调用点都在
// 宿主脚本定义 t 之后）。文件页按 page.go:82 拼接同形切出（评审建议3），
// 终端系/会话页 <head> 注入（xterm.js 之前 initTheme 先设 data-theme 防闪白）。
const guestThemeJS = `// ── 主题切换（访客页族共享注入件，theme.go 单一事实源）。THEME_KEY 跨页
// 共享：文件页选过的主题终端/会话/快投递页自动记住，任一处切换全局生效 ──
const THEME_KEY = 'sc.share.theme';
const THEMES = ['auto', 'light', 'dark', 'one-dark', 'dracula'];
function applyTheme(name){
  if (!THEMES.includes(name)) name = 'auto';
  document.documentElement.dataset.theme = name;
  // sc:themechange（detail.theme=主题名）：sel.onchange 是赋值语义，页面侧
  // 再挂回调会被覆盖——xterm 页经事件解耦监听换装，不依赖切换器引用
  try { document.dispatchEvent(new CustomEvent('sc:themechange', { detail: { theme: name } })); }
  catch (e) { /* 无 CustomEvent 环境：切换仍生效，仅失去即时换装通知 */ }
}
function initTheme(){
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* 无存储环境走默认 */ }
  applyTheme(saved || 'auto');
}
initTheme();
// 已创建切换器登记表：任一处改动即时同步其余（文件页桌面顶栏 + 「⋯」菜单
// 双份同表；单切换器页登记一项，同步循环自然零命中）
const themeSelects = [];
function themeOptions(){
  return [['auto', t('themeAuto')], ['light', t('themeLight')], ['dark', t('themeDark')],
    ['one-dark', t('themeOneDark')], ['dracula', t('themeDracula')]];
}
function makeThemeSelect(cls){
  const sel = document.createElement('select');
  sel.className = 'theme-select' + (cls ? ' ' + cls : '');
  sel.title = t('theme');
  sel.setAttribute('aria-label', t('theme'));
  themeOptions().forEach(pair => {
    const opt = document.createElement('option');
    opt.value = pair[0]; opt.textContent = pair[1];
    sel.appendChild(opt);
  });
  try { sel.value = localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { sel.value = 'auto'; }
  sel.onchange = () => {
    applyTheme(sel.value);
    try { localStorage.setItem(THEME_KEY, sel.value); } catch (e) { /* ignore */ }
    themeSelects.forEach(other => {
      if (other !== sel && other.value !== sel.value) other.value = sel.value;
    });
  };
  themeSelects.push(sel);
  return sel;
}
`
