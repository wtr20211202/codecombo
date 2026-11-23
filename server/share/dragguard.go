package share

// 访客页族拖拽导航守卫共享注入件（P-20261122-20）。循 theme.go/termlayout.go
// 注入范式：单一事实源的 JS 常量经模板字段注入各页——终端系三页（直播/定格/
// 回放）与会话回放页走 {{.DragJS}}，文件分享页经 pageTmplSrc 常量拼接（与
// guestThemeJS 的两种装配形态一致）。
//
// 背景（P-20261122-14 遗留面）：该守卫原只生在可写页 mountWritable 内（且
// writable/guestInput 双关早退）——只读直播、终端定格、回放、会话、文件分享页
// 拖入本地文件仍触发浏览器缺省动作「导航到 file://」，分享视图整页丢失。本件
// 把守卫上提为五页族共享面，可写页旧监听同步删除（双监听会同一次投放双
// preventDefault/双提示）。
//
// 边界纪律：
//   - 仅当 e.dataTransfer.types 含 'Files' 才 preventDefault——types 只是类型
//     表，不读文件字节、不发起任何上传（访客页没有文件接收面，拖入无落点）；
//     非 Files 拖拽（页内文字/选区拖动）零动作，不打断浏览器原生语义；
//   - collab 闸由调用方给：直播页 collab 开时整段不注册（collabpage 的整页
//     drop = 协作收件箱唯一语义，双收口会让同一次投放双上传）；定格/回放/
//     会话/文件页无协作位（无 SC.collab 注入）恒注册；
//   - 提示与守卫分离：文案由调用方经 opts.tip 给（直播页传既有词表键
//     t('wrDragNoUpload')，不新增键），缺省用本件自带依 SC.lang 的 zh/en 两串
//     ——不往五页字典各拷一份（词表不扩散）；
//   - 提示元素由本件自建（内联样式；颜色走各页既有 CSS 变量，五页同观感）：
//     定格/回放/会话/文件页没有可写页 .pu-tip 面，自包含才能五页同形。
//     data-testid=drag-tip 与可写页 .pu-tip（粘贴/上传链专属提示）分桶——
//     两个独立反馈面各自断言，互不遮蔽。
//
// 量级考量：dragover 在拖拽期间高频触发，但处理体只有 types 小表（通常 1~2
// 项）的 Array.from 包含判定 + 条件 preventDefault——无 DOM 读写、无网络、
// 无分配放大的常态路径；dragover 不拦则 drop 不可取消，两处监听缺一不可。
const guestDragGuardJS = `// ── 拖拽导航守卫（访客页族共享注入件，dragguard.go 单一事实源）──
// 浏览器对「拖入本地文件」的缺省动作是导航到 file://：分享页整页被替换、
// 终端/回放视图丢失。守卫只在 document 级拦含 Files 载荷的缺省动作（不读
// 文件字节、不上传），drop 后给一次性提示。
// opts.enabled === false → 零注册（直播页 collab 开 = 收件箱 drop 唯一语义）
// opts.tip：提示文案（宿主词表；直播页传 t('wrDragNoUpload')）；缺省用本件
// 自带依 SC.lang 的 zh/en 两串（不扩散五页字典）
function scDragGuard(opts){
  opts = opts || {};
  if (opts.enabled === false) return;
  function hasFiles(e){
    const ty = e.dataTransfer && e.dataTransfer.types;
    return !!ty && Array.from(ty).indexOf('Files') >= 0;
  }
  function tipText(){
    if (opts.tip) return opts.tip;
    let zh = false;
    try { zh = typeof SC !== 'undefined' && SC.lang === 'zh'; } catch (e) { /* 无 boot 环境走英文 */ }
    return zh ? '拖入的文件不会发送：本页没有文件上传通道'
      : 'Dropped files are not sent: this page has no upload channel';
  }
  let tipEl = null, tipTimer = 0;
  function showTip(){
    const msg = tipText();
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.setAttribute('data-testid', 'drag-tip');
      tipEl.setAttribute('role', 'status');
      // 观感对齐可写页 .pu-tip（底部居中轻提示）；颜色走各页既有 CSS 变量
      tipEl.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:80;' +
        'background:var(--card);border:1px solid var(--border);border-radius:10px;padding:6px 14px;' +
        'font-size:12.5px;color:var(--text);box-shadow:var(--shadow);max-width:86vw;text-align:center';
      document.body.appendChild(tipEl);
    }
    tipEl.textContent = msg;
    tipEl.style.display = '';
    if (tipTimer) clearTimeout(tipTimer);
    tipTimer = setTimeout(() => { tipEl.style.display = 'none'; tipTimer = 0; }, 2600);
  }
  // dragover 不拦则 drop 根本不可取消（浏览器只把 drop 派给 dragover 已
  // preventDefault 的落点）；两处都只对 Files 载荷动作
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    showTip();
  });
}
`
