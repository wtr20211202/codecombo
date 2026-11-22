package share

// 访客页合并入口条（P-20261119-3，collabpage.go/guestboard.go 同款单一事实源
// 模式）：终端直播页的「协作素材」与「留言」两条独立入口条并为单条双入口
//（P-20261118-9 评审遗留完整版——当时评估「两独立 IIFE 合并须动 e2e 断言面」
// 代价失衡降级未做，本案经评审圈定断言迁移面后落地）。本件只建条壳（同槽
// 容器），协作/留言各自的入口钮、计数徽标与向上浮层仍由 mountCollab/
// mountGuestBoard 挂载进槽（挂在条壳内的 chip 形态）——职责不搬，「合并」
// 只是同槽；展开互斥（同锚位不叠）沿用两挂载脚本既有的 document 级监听链，
// 本壳零新增交互逻辑。
//
// 仅终端直播页注入（termpage.go {{.EntryCSS}}/{{.EntryJS}}）：CollabJS 只在
// termpage 挂载，文件/定格/回放页无本件——那些页的留言板维持既有独立单条
// 原样（share-guestbook.spec:150 断言面零触碰）。条壳缺席时两挂载脚本回落
// 既有独立条路径（同旧行为）。
//
// 退化形态：协作位由 SC.collab 门控（mountCollab 自身职责），关闭时协作
// chip 不渲染——「仅留言」单按钮形态合法；留言板无条件挂载，「仅协作」
// 形态同合法。入口钮级 testid（cl-root-btn/gb-root-btn）由各挂载
// 脚本在合并形态下落位（不复用 cl-root/gb-root 于条内 chip，防语义漂移），
// 浮层 testid（cl-drop/cl-panel 等）不动。

// entryBarJS 条壳脚本（termpage 模板以 {{.EntryJS}} 注入主 script，在
// CollabJS/BoardJS 之前——两个挂载脚本按 sc-entrybar 在场与否选挂载形态）
const entryBarJS = `
(function mountEntryBar(){
  const wrap = document.querySelector('.wrap');
  if (!wrap) return;
  // 防御重复注入：已在场不重建
  if (document.querySelector('[data-testid="sc-entrybar"]')) return;
  const bar = document.createElement('div');
  bar.className = 'sc-entrybar';
  bar.setAttribute('data-testid', 'sc-entrybar');
  // 空壳防御：两挂载脚本都未填充（理论上不可能——留言板无条件挂载）时移除，
  // 不留一张空卡；rAF 时点在两个挂载脚本同步执行完之后
  requestAnimationFrame(() => { if (!bar.firstElementChild) bar.remove(); });
  const footer = wrap.querySelector('.footer');
  if (footer) wrap.insertBefore(bar, footer); else wrap.appendChild(bar);
})();
`

// entryBarCSS 合并条样式（termpage 模板以 {{.EntryCSS}} 注入 <style> 尾部——
// 仅终端直播页在场，frozen/cast/文件页零注入零影响；P-20261118-9 评审裁定
// 合并条新样式不进 termlayout.go 三页共享文件）。结构约定：
//   - 条壳 = 单卡两槽（flex 行，chip 均分宽度）；浮层（.cl-panel/.gb-body）
//     锚条定位——chip 必须 position:static，槽内绝对定位元素就近锚到条壳
//     （position:relative），展开横跨整条宽度
//   - chip 复用各自既有 class（.cl-root/.gb-root，.open 开合链与互斥监听
//     零改动），仅覆写条内形态：去卡片底色/边框、头钮居中、箭头随文
//   - .gb-root 基础样式的 overflow:hidden 在条内放开（浮层要溢出 chip 边界）
const entryBarCSS = `
.sc-entrybar{position:relative;flex-shrink:0;display:flex;align-items:stretch;gap:6px;
margin-top:8px;padding:4px 6px;background:var(--card);border:1px solid var(--border);
border-radius:12px}
.sc-entrybar .cl-root,.sc-entrybar .gb-root{position:static;flex:1;min-width:0;margin:0;
background:transparent;border:none;border-radius:10px;overflow:visible}
.sc-entrybar .cl-head,.sc-entrybar .gb-head{justify-content:center;text-align:center;
padding:6px 10px;border-radius:10px}
.sc-entrybar .cl-arrow,.sc-entrybar .gb-arrow{margin-left:6px}
@media (max-width:640px){.sc-entrybar{padding:3px 4px;gap:4px}
.sc-entrybar .cl-head,.sc-entrybar .gb-head{padding:6px 6px;font-size:12px}}
`
