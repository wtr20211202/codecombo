package share

// 分享访客页内联 CSS 段（P-20261007-22 纯搬运自 page.go 的 pageTmplSrc
// 模板段，零逻辑改动）：pageTmplSrc 按「页头 + 本段 + body 开篇 + JS 三段 +
// 收尾」常量拼接装配（见 page.go），段间零字节增减

const pageTmplCssSrc = `<style id="page-css">
:root{--bg:#f4f6fb;--card:#ffffff;--text:#1b2437;--muted:#667085;--border:#e6e9f0;
--accent:#3d7bfd;--accent2:#6a5cff;--hover:#f0f4ff;--chip:#eef2ff;--shadow:0 10px 30px rgba(23,43,99,.08)}
@media (prefers-color-scheme: dark){:root{--bg:#0e1320;--card:#161d2f;--text:#e6eaf3;--muted:#8b94a9;
--border:#263149;--hover:#1d2740;--chip:#1e2a4a;--shadow:0 10px 30px rgba(0,0,0,.35)}}
/* 主题切换（跟随系统=auto 走上方媒体查询；显式主题覆盖全部变量，调色板对齐
   主应用 themes/：GitHub Light / GitHub Dark / One Dark / Dracula） */
html[data-theme="light"]{--bg:#f6f8fa;--card:#ffffff;--text:#1f2328;--muted:#59636e;--border:#d1d9e0;
--accent:#0969da;--accent2:#8250df;--hover:#eaf1f8;--chip:#ddf4ff;--shadow:0 10px 30px rgba(31,35,40,.08)}
html[data-theme="dark"]{--bg:#0d1117;--card:#161b22;--text:#e6edf3;--muted:#9198a1;--border:#3d444d;
--accent:#4493f8;--accent2:#ab7df8;--hover:#151b23;--chip:#1c2a3a;--shadow:0 10px 30px rgba(0,0,0,.4)}
html[data-theme="one-dark"]{--bg:#282c34;--card:#21252b;--text:#abb2bf;--muted:#7f848e;--border:#3e4451;
--accent:#61afef;--accent2:#c678dd;--hover:#2f333d;--chip:#2c313a;--shadow:0 10px 30px rgba(0,0,0,.4)}
html[data-theme="dracula"]{--bg:#282a36;--card:#21222c;--text:#f8f8f2;--muted:#6272a4;--border:#44475a;
--accent:#bd93f9;--accent2:#ff79c6;--hover:#343746;--chip:#3b3d4f;--shadow:0 10px 30px rgba(0,0,0,.45)}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;color:var(--text);overflow:hidden;
background:radial-gradient(1100px 420px at 50% -180px, rgba(106,92,255,.14), transparent 70%), var(--bg);
font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
/* 品牌氛围背景（与 404 页同源）：双 blob 模糊光斑 */
.blob{position:fixed;border-radius:50%;filter:blur(90px);z-index:0;pointer-events:none}
.b1{width:380px;height:380px;background:rgba(106,92,255,.30);top:-90px;right:-70px}
.b2{width:320px;height:320px;background:rgba(61,123,253,.26);bottom:-90px;left:-60px}
a{color:var(--accent);text-decoration:none}
/* ── 访客页 reader 形态（P-20261020-7）：细顶栏 + 无卡片全幅内容 ──
   此前是 wrap(1080 居中) / 渐变 hero / 圆角卡片 / preview 内衬四层套框，
   内容和操作都被框在中间；现在收成「顶栏 + reader」两段，内容贴页面底色。
   移动端 100dvh（地址栏收放不裁底）+ safe-area；≤700px 次级动作收进
   「⋯」菜单（下载常驻一级，菜单项 40px 热区）。 */
.wrap{position:relative;z-index:1;height:100vh;height:100dvh;margin:0;
padding-bottom:env(safe-area-inset-bottom);display:flex;flex-direction:column}
.header{flex-shrink:0;display:flex;align-items:center;gap:10px;
padding:9px max(16px, env(safe-area-inset-right)) 9px max(16px, env(safe-area-inset-left));
padding-top:calc(9px + env(safe-area-inset-top));
border-bottom:1px solid var(--border);color:var(--text)}
.header .icon{flex:0 0 auto;width:32px;height:32px;border-radius:8px;background:var(--hover);
display:flex;align-items:center;justify-content:center}
.header .meta{flex:1;min-width:0}
.header h1{margin:0;font-size:15.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.header .sub{margin-top:1px;font-size:11.5px;color:var(--muted);
white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.actions{flex:0 0 auto;display:flex;align-items:center;gap:8px;position:relative}
.btn{flex:0 0 auto;border:1px solid var(--border);background:var(--card);color:var(--text);
padding:6px 12px;border-radius:8px;font-size:12.5px;line-height:1.4;cursor:pointer;
transition:border-color .15s,background .15s,color .15s}
.btn:hover{border-color:var(--accent);color:var(--accent)}
.btn.primary{background:linear-gradient(135deg,var(--accent),var(--accent2));border-color:transparent;
color:#fff;font-weight:600}
.btn.primary:hover{color:#fff;filter:brightness(1.08)}
.btn:disabled{opacity:.45;cursor:default;border-color:var(--border);color:var(--muted)}
.icon-btn{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;
border:1px solid var(--border);background:var(--card);color:var(--muted);border-radius:8px;cursor:pointer}
.icon-btn:hover{border-color:var(--accent);color:var(--accent)}
.theme-select{flex:0 0 auto;border:1px solid var(--border);background:var(--card);color:var(--text);
padding:5px 8px;border-radius:8px;font-size:12px;cursor:pointer;outline:none}
.theme-select option{color:var(--text);background:var(--card)}
/* 「⋯」动作菜单：≤700px 时承接导出/复制/主题/全屏/新标签，桌面隐藏 */
.more{position:relative;flex:0 0 auto;display:none}
.more-btn{display:none;align-items:center;justify-content:center;min-width:40px;height:40px;
padding:0 10px;border:1px solid var(--border);background:var(--card);color:var(--text);
border-radius:8px;font-size:18px;line-height:1;cursor:pointer}
.more-btn:hover{border-color:var(--accent);color:var(--accent)}
.more-menu{display:none;position:absolute;right:0;top:calc(100% + 6px);z-index:55;min-width:212px;
max-height:calc(100dvh - 76px);overflow:auto;flex-direction:column;gap:2px;padding:6px;
background:var(--card);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow)}
.more.open .more-menu{display:flex}
.more-item{display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:0 10px;
border:none;background:transparent;color:var(--text);border-radius:8px;font-size:13px;
text-align:left;cursor:pointer;font-family:inherit}
.more-item:hover{background:var(--hover)}
.more-item:disabled{opacity:.45;cursor:default;background:transparent}
.more-sep{height:1px;background:var(--border);margin:5px 4px}
.more-theme{display:flex;align-items:center;gap:8px;min-height:40px;padding:0 10px;
font-size:12.5px;color:var(--muted)}
.more-theme .theme-select{flex:1;min-width:0}
/* 冻结快照时点横幅（P-20261005-168）：frozen 记录专属（live 零渲染）。
   定格是特性不是错误——中性说明色（chip 底/常规文字/静音图标），刻意
   不用终端页遮蔽声明横幅的警示黄；打印不隐藏（纸面留存的定格件同该
   带时点声明，与水印不进打印隐藏清单同理） */
.snap-banner{flex-shrink:0;display:flex;gap:8px;align-items:flex-start;
background:var(--chip);border-bottom:1px solid var(--border);color:var(--text);
padding:7px max(16px, env(safe-area-inset-right)) 7px max(16px, env(safe-area-inset-left));
font-size:12px;line-height:1.55}
.snap-banner svg{flex:0 0 auto;margin-top:2px;color:var(--muted)}
/* reader：顶栏之下的全部内容（目录/文件同壳；无卡片边框/阴影） */
.reader{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.crumbs{flex-shrink:0;display:flex;flex-wrap:wrap;gap:4px;align-items:center;
padding:7px max(16px, env(safe-area-inset-right)) 7px max(16px, env(safe-area-inset-left));
border-bottom:1px solid var(--border)}
.crumb{background:transparent;color:var(--muted);border:none;border-radius:6px;padding:3px 6px;
/* 有效期弱提示（P-20261020-5）：与快照横幅同款扁平条，无卡片框 */
.expiry-banner{flex-shrink:0;display:flex;gap:8px;align-items:flex-start;
background:var(--chip);border-bottom:1px solid var(--border);color:var(--text);
padding:7px max(16px, env(safe-area-inset-right)) 7px max(16px, env(safe-area-inset-left));
font-size:12px;line-height:1.55}
.expiry-banner svg{flex:0 0 auto;margin-top:2px;color:var(--muted)}
font-size:12px;cursor:pointer;max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.crumb:hover{background:var(--hover);color:var(--text)}
.crumb.cur{color:var(--text);font-weight:600;cursor:default;background:transparent}
.up-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;
border:1px solid var(--border);background:transparent;color:var(--muted);border-radius:8px;
cursor:pointer;margin-right:2px;transition:all .12s}
.up-btn:hover{border-color:var(--accent);color:var(--accent)}
.sep{color:var(--muted);font-size:12px}
@media (hover:none){.row-acts{opacity:1}}
.scroll{flex:1;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
/* 目录表固定列宽：名称列吃剩余空间按 ellipsis 收敛，大小/修改时间/行内操作
   定宽——自动布局下长文件名会把表撑出容器，窄屏行内下载/复制被裁到视口外
   （P-20261020-7 全宽表格回归）。行内操作列表头留空占位，保证列数与
   tbody 的四个单元格对齐 */
table.list{width:100%;border-collapse:collapse;table-layout:fixed}
.list th{position:sticky;top:0;background:var(--bg);font-size:11.5px;color:var(--muted);font-weight:500;
text-align:left;padding:9px 16px;border-bottom:1px solid var(--border);z-index:1}
/* 安全区只吃表格外侧单元格的内边距（每格都加会让定宽列在刘海/横屏下内容区
   被挤掉）；操作列宽额外让出右侧安全区 */
.list th:first-child{padding-left:max(16px, env(safe-area-inset-left))}
.list th:last-child{padding-right:max(16px, env(safe-area-inset-right))}
.list th:first-child{width:auto}
.list .col-size{width:88px}
.list .col-modified{width:160px}
.list .acts-col{width:calc(104px + env(safe-area-inset-right))}
.list th.r,.list td.r{text-align:right}
.list td{padding:9px 16px;border-bottom:1px solid var(--border);font-size:13.5px}
.list td:first-child{padding-left:max(16px, env(safe-area-inset-left))}
.list td:last-child{padding-right:max(16px, env(safe-area-inset-right))}
.list tbody tr:last-child td{border-bottom:none}
.list tbody tr{cursor:pointer}
.list tbody tr:hover{background:var(--hover)}
.cell-name{display:flex;align-items:center;gap:10px;min-width:0}
.cell-name .nm-box{min-width:0;display:flex;flex-direction:column}
.cell-name .nm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 窄屏把修改时间下移到名称副行（列在 ≤700px 隐藏） */
.mtime-m{display:none}
.dim{color:var(--muted);font-size:12.5px;white-space:nowrap}
.empty{padding:48px 0;text-align:center;color:var(--muted)}
.status{display:flex;gap:14px;align-items:flex-start;padding:40px 30px;text-align:left}
.status .big{width:50px;height:50px;border-radius:14px;background:var(--chip);
display:flex;align-items:center;justify-content:center;flex:0 0 auto}
.status h2{margin:2px 0 6px;font-size:16px}
.status p{margin:0;color:var(--muted);font-size:13px}
.info{padding:44px 24px;text-align:center}
.info .big{width:76px;height:76px;border-radius:20px;background:var(--chip);margin:0 auto 16px;
display:flex;align-items:center;justify-content:center}
.info h2{margin:0 0 4px;font-size:16px;word-break:break-all}
.info .tip{color:var(--muted);font-size:12.5px;margin-bottom:18px}
.info .kv{display:flex;flex-wrap:wrap;justify-content:center;gap:8px 26px;
margin-bottom:20px;color:var(--muted);font-size:12.5px}
.info .kv b{display:block;color:var(--text);font-weight:600;font-size:13px;margin-top:2px}
.btn2{display:inline-block;border:none;background:linear-gradient(135deg,var(--accent),var(--accent2));
color:#fff;padding:9px 24px;border-radius:8px;font-size:13px;cursor:pointer}
.btn2:hover{filter:brightness(1.08)}
/* ── 预览：贴 reader 铺满，无内衬/圆角（HTML/PDF 边到边）；文本滚动交给
   .scroll 单一滚动区；图片/音视频在页面画布居中适配 ── */
.preview{display:flex;flex-direction:column;min-height:100%}
.preview.fill{height:100%;min-height:0}
.preview.media{height:100%;min-height:100%;align-items:center;justify-content:center;padding:16px}
.preview iframe{flex:1;min-height:0;width:100%;border:none;border-radius:0;background:var(--bg)}
.preview img{margin:auto;max-width:100%;max-height:100%;border-radius:0;object-fit:contain}
.preview video,.preview audio{margin:auto;max-width:100%;max-height:100%;outline:none}
.preview audio{width:100%}
.preview pre{margin:0;padding:16px max(16px, env(safe-area-inset-right)) 28px max(16px, env(safe-area-inset-left));
background:transparent;overflow:visible;min-height:100%;
font:12.5px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre;tab-size:4}
.preview.fill .doc-note{margin:8px 12px 0}
.preview.doc>.doc-note{max-width:860px;width:calc(100% - 32px);margin:12px auto 0}
.preview.text>.doc-note{margin:12px 16px 0}
/* markdown / word 抽取文本：页内注入（单滚动区），760~860px 阅读列；全宽
   切换由顶栏 .wide-btn / 「⋯」菜单驱动（.md-article.wide 解除列宽上限） */
.md-article{max-width:860px;margin:0 auto;padding:26px 32px 72px;width:100%}
.md-article.wide{max-width:none}
.md-article.csv{max-width:none;padding-left:max(16px, env(safe-area-inset-left));
padding-right:max(16px, env(safe-area-inset-right))}
.md-article h1,.md-article h2,.md-article h3,.md-article h4{line-height:1.35;margin:1.3em 0 .55em;font-weight:650}
.md-article h1{font-size:1.6em;margin-top:.2em}
.md-article h2{font-size:1.3em;padding-bottom:.25em;border-bottom:1px solid var(--border)}
.md-article h3{font-size:1.12em}
.md-article p{margin:.7em 0}
.md-article img{max-width:100%;border-radius:6px}
.md-article hr{border:none;border-top:1px solid var(--border);margin:1.8em 0}
.md-article blockquote{margin:1em 0;padding:.2em 1em;color:var(--muted);
border-left:3px solid var(--accent);background:var(--chip);border-radius:0 8px 8px 0}
.md-article code{font:87%/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;
background:var(--hover);border:1px solid var(--border);border-radius:5px;padding:.1em .35em}
.md-article pre{background:var(--hover);border:1px solid var(--border);border-radius:10px;
padding:13px 16px;overflow-x:auto;line-height:1.6}
.md-article pre code{background:none;border:none;padding:0;font-size:100%}
.md-article table{border-collapse:collapse;margin:1.1em 0;width:100%;font-size:.95em}
.md-article th,.md-article td{border:1px solid var(--border);padding:6px 12px;text-align:left}
.md-article th{background:var(--hover);font-weight:600}
/* ── md 表格列宽（P-20261010-1）：HTML table 自动布局按内容长度分配，长文本列
   贪婪扩张会把短列压到内容最小宽以下（中文无空格可断 →「待回复」逐字竖排）。
   ① min-width 短列下限：四字以内短词（待回复/已完成等）在挤压下保证单行；
   ② overflow-wrap:anywhere 长列上限兜底：窄屏下长列仍可断行不撑破容器
   （二者正交——下限保短词单行，上限保容器不横溢，tbl-wrap 横滚承接极端）。
   min-width 取 calc(4em+26px)：页面 * 为 border-box，min-width 含单元格左右
   padding 24px 与折叠边框——补回这层壳，内容区才是 4em（短词单行的语义基准
   是内容宽，裸 4em 实际只给两字空间） ── */
.md-article th,.md-article td{min-width:calc(4em + 26px);overflow-wrap:anywhere}
/* ③ 列宽拖拽手柄（th 右缘 4px，交互逻辑见下方 enableTableColResize） */
.md-article th{position:relative}
.col-handle{position:absolute;top:0;right:0;width:4px;height:100%;cursor:col-resize;
touch-action:none;-webkit-user-select:none;user-select:none;z-index:1}
.col-handle:hover,.col-handle.dragging{background:var(--accent2);opacity:.55}
/* 切 fixed 后超长内容单元格按管理列表同款纪律收敛（ellipsis + title 悬浮全文，
   title 由 JS 只落在实际截断的单元格上，见 syncClipTitles） */
.md-article table.sc-cols-fixed{table-layout:fixed}
.md-article table.sc-cols-fixed th,.md-article table.sc-cols-fixed td{
white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 窄屏（<700px）触屏形态列宽拖拽交互不成立：隐藏手柄回落纯自动布局（JS 同步守卫） */
@media (max-width:699px){.col-handle{display:none}}
.md-article input[type=checkbox]{margin-right:.45em;vertical-align:middle}
.md-article ul,.md-article ol{padding-left:1.5em}
.md-article li{margin:.28em 0}
.md-article a:hover{text-decoration:underline}
/* 内容增强（对 md/docx/未来片段类型统一生效） */
.tbl-wrap{overflow-x:auto;margin:1.1em 0;border:1px solid var(--border);border-radius:10px}
.tbl-wrap table{margin:0;width:100%}
.tbl-wrap th,.tbl-wrap td{border:none}
.tbl-wrap tr+tr td{border-top:1px solid var(--border)}
.pre-wrap{position:relative}
.pre-copy{position:absolute;top:8px;right:8px;border:1px solid var(--border);background:var(--card);
color:var(--muted);border-radius:6px;padding:2px 9px;font-size:11.5px;cursor:pointer;opacity:0;transition:opacity .12s}
.pre-wrap:hover .pre-copy{opacity:1}
.pre-copy:hover{color:var(--text);border-color:var(--muted)}
/* 触屏无 hover：复制按钮必须常显（P-20261020-11） */
@media (hover:none){.pre-copy{opacity:1}}
/* 阅读工具条（P-20261020-11）：文本复制全文/换行/行号 + 内嵌预览新标签；
   按钮常显，移动端同样可命中（不复用 hover 才可见的 .pre-copy 形态） */
.preview-tools{flex-shrink:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 2px 10px}
.tool-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);
background:var(--card);color:var(--muted);border-radius:8px;padding:4px 11px;font-size:12.5px;
cursor:pointer;transition:all .12s}
.tool-btn:hover{color:var(--text);border-color:var(--muted)}
.tool-btn.on{color:var(--accent);border-color:var(--accent);background:var(--chip)}
.tool-btn:disabled{opacity:.55;cursor:default}
/* 文本预览：行号与内容同层（换行时行号停在逻辑行首，仍可对齐）；大文件
   降级为单个 pre——行级 DOM 数量与整文高亮正则开销都有上限。
   文本主体不铺自己的底色、不自成滚动容器（P-20261020-7 读者页硬约束：
   页面底色单滚动，pre 自身不滚）——底色与滚动都交给 .scroll，长行横向
   溢出由页面级滚动承接，与旧 .preview pre 的 overflow:visible 同口径 */
.text-body{flex:1;min-height:0;overflow:visible;background:transparent}
.text-lines{min-height:100%;padding:12px 0;font:12.5px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;
tab-size:4}
.tl{display:flex;align-items:flex-start}
.tl-n{flex:0 0 auto;width:4.2em;padding:0 12px 0 10px;text-align:right;color:var(--muted);
opacity:.65;user-select:none;font-variant-numeric:tabular-nums}
.tl-c{flex:1;min-width:0;white-space:pre;padding-right:18px}
.text-lines.with-wrap .tl-c{white-space:pre-wrap;overflow-wrap:anywhere}
.text-lines:not(.with-ln) .tl-n{display:none}
.text-body .text-plain{height:auto;min-height:100%;margin:0;border-radius:0;background:transparent;
white-space:pre}
.text-body .text-plain.with-wrap{white-space:pre-wrap;overflow-wrap:anywhere}
/* 工具条占高后，媒体预览的 100% 上限扣除工具条，避免纵向溢出裁切 */
.preview.has-tools img,.preview.has-tools video{max-height:calc(100% - 46px)}
.h-anchor{margin-left:7px;color:var(--accent);text-decoration:none;opacity:0;font-weight:400}
h1:hover .h-anchor,h2:hover .h-anchor,h3:hover .h-anchor,h4:hover .h-anchor{opacity:1}
.lightbox{position:fixed;inset:0;background:rgba(6,10,20,.82);display:flex;align-items:center;
justify-content:center;z-index:60;cursor:zoom-out}
.lightbox img{max-width:94%;max-height:92%;border-radius:8px;box-shadow:0 18px 60px rgba(0,0,0,.5)}
/* 行内操作：默认半透明可见（纯 hover 显隐让访客难以发现/命中下载与复制），
   悬停行时全亮；触屏设备恒定全亮 */
.row-acts { display: inline-flex; gap: 4px; opacity: .4; transition: opacity .12s; }
tr:hover .row-acts { opacity: 1; }
.row-act { border: 1px solid var(--border); background: var(--card); color: var(--muted);
border-radius: 6px; padding: 1px 9px; font-size: 12.5px; cursor: pointer; }
.row-act:hover { color: var(--text); border-color: var(--muted); }
@media (hover:none){.row-acts{opacity:1}}
.toast { position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%) translateY(8px);
background: var(--text); color: var(--card); padding: 8px 18px; border-radius: 999px;
font-size: 12.5px; opacity: 0; pointer-events: none; transition: all .18s; z-index: 80; }
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
/* 溯源水印（P-20261005-193）：对角双标低透明（4%），单角被裁剪另一角仍可
   归因；不做全屏平铺（不干扰阅读）。pointer-events:none 不挡交互、
   user-select:none 不进选中复制；z-index 高于灯箱（缩放查看的截图同样带
   水印）、低于 toast/导出弹层。打印样式不隐藏——纸面外传同属归因范围 */
.sc-wm{position:fixed;inset:0;pointer-events:none;z-index:65;
-webkit-user-select:none;user-select:none}
.sc-wm span{position:absolute;font-size:13px;font-weight:600;letter-spacing:.4px;
color:var(--text);opacity:.04;white-space:nowrap;transform:rotate(-24deg)}
.sc-wm .wm-a{top:16%;left:5%}
.sc-wm .wm-b{bottom:16%;right:5%}
/* 导出图片内的水印随图：容器形态（绝对定位于导出画布根，样式复用上层） */
.sc-wm-host{position:relative}
.sc-wm.sc-wm-abs{position:absolute}
.filter-row{flex-shrink:0;display:flex;align-items:center;gap:8px;
padding:8px max(16px, env(safe-area-inset-right)) 8px max(16px, env(safe-area-inset-left));
border-bottom:1px solid var(--border)}
.filter-row input{flex:0 1 280px;border:1px solid var(--border);border-radius:8px;
padding:5px 11px;font-size:12.5px;background:var(--hover);color:var(--text);outline:none}
.filter-row input:focus{border-color:var(--accent)}
.filter-row .cnt{color:var(--muted);font-size:12px}
.topbar{position:fixed;top:0;left:0;height:3px;width:0;background:linear-gradient(90deg,var(--accent),var(--accent2));
z-index:70;transition:width .25s ease,opacity .3s;opacity:1}
.doc-err{padding:26px 10px;text-align:center;color:var(--muted)}
.spin{width:26px;height:26px;border:3px solid var(--border);border-top-color:var(--accent);
border-radius:50%;margin:60px auto;animation:sp 1s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
/* 内容提示条（编码差异/移动端 PDF/CSV 截断/HTML 脚本与单文件提示共用） */
.doc-note{margin:0 0 12px;padding:8px 12px;border:1px solid var(--border);
background:var(--chip);color:var(--muted);border-radius:8px;font-size:12.5px}
/* HTML 预览提示条的操作按钮（P-20261020-4）：运行脚本（隔离）/停止脚本 */
.doc-note .note-act{margin-left:10px;border:1px solid var(--accent);background:transparent;color:var(--accent);
border-radius:999px;padding:2px 10px;font-size:12px;cursor:pointer;white-space:nowrap}
.doc-note .note-act:hover{background:var(--accent);color:#fff}
/* 访客确认弹层（脚本运行风险）：与导出弹层同视觉家族，只承载一段说明+二选 */
.confirm-mask{position:fixed;inset:0;background:rgba(6,10,20,.62);display:flex;align-items:center;
justify-content:center;z-index:95;padding:24px}
.confirm-dialog{background:var(--card);border:1px solid var(--border);border-radius:14px;
box-shadow:0 24px 80px rgba(0,0,0,.4);width:min(460px,94vw);padding:20px 22px}
.confirm-dialog h3{margin:0 0 8px;font-size:15px;font-weight:600}
.confirm-dialog p{margin:0 0 16px;color:var(--muted);font-size:12.5px;line-height:1.65}
.confirm-acts{display:flex;justify-content:flex-end;gap:8px}
.confirm-acts .btn-ghost{padding:7px 16px;font-size:12.5px}
.confirm-acts .btn2{padding:7px 18px;font-size:12.5px}
/* 目录工具行：刷新按钮贴面包屑右侧 */
.crumb-refresh{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;
width:24px;height:24px;border:1px solid var(--border);border-radius:6px;background:transparent;
color:var(--muted);cursor:pointer;flex:0 0 auto}
.crumb-refresh:hover{border-color:var(--accent);color:var(--accent)}
/* 列排序 */
th.sortable{cursor:pointer;user-select:none;white-space:nowrap}
th.sortable:hover{color:var(--accent)}
.sort-ind{font-size:10px;margin-left:3px;color:var(--accent)}
/* md 长文档大纲 */
.md-outline{border:1px solid var(--border);border-radius:10px;padding:6px 12px;margin:0 0 16px}
.md-outline summary{cursor:pointer;color:var(--muted);font-size:12.5px;user-select:none}
.md-outline nav{max-height:46vh;overflow:auto;margin-top:6px}
.md-outline a{display:block;color:var(--text);text-decoration:none;padding:3px 0;font-size:13px;
border-radius:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.md-outline a:hover{color:var(--accent);background:var(--hover)}
.md-outline .ol-2{padding-left:14px}.md-outline .ol-3{padding-left:28px}.md-outline .ol-4{padding-left:42px}
/* 轻量代码高亮（中间调配色，深浅主题均可读） */
.md-article pre .tok-c{color:#7c869b;font-style:italic}
.md-article pre .tok-s{color:#b3805d}
.md-article pre .tok-n{color:#4f9e8f}
.md-article pre .tok-k{color:#5b7fd4}
/* 访客留言区（guestboard 共享资产挂在 wrap 子级，不再有页脚作锚点）：
   分享页统一无卡片——只留顶部分隔线，两侧/底部留安全边 */
.wrap>.gb-root{flex-shrink:0;margin:8px max(12px, env(safe-area-inset-right)) 8px max(12px, env(safe-area-inset-left));
background:transparent;border:none;border-top:1px solid var(--border);border-radius:0}
.nf-body{height:100%;display:flex;align-items:center;justify-content:center;overflow:auto}
.nf{max-width:520px;width:100%;margin:0 18px;background:var(--card);border:1px solid var(--border);
border-radius:18px;box-shadow:var(--shadow);padding:52px 40px;text-align:center}
.nf .code{font-size:52px;font-weight:700;background:linear-gradient(135deg,var(--accent),var(--accent2));
-webkit-background-clip:text;background-clip:text;color:transparent}
.nf p{color:var(--muted);margin:10px 0 0}
/* 导出预览弹层：栅格化结果先预览，选格式后另存（PNG/JPEG/WebP）。
   预览区铺棋盘格底——透明 PNG 的边界可辨，不与页面底色混淆 */
.export-mask{position:fixed;inset:0;background:rgba(6,10,20,.62);display:flex;align-items:center;
justify-content:center;z-index:90;padding:24px}
.export-dialog{background:var(--card);border:1px solid var(--border);border-radius:14px;
box-shadow:0 24px 80px rgba(0,0,0,.4);width:min(880px,94vw);max-height:92vh;
display:flex;flex-direction:column;overflow:hidden}
.export-head{display:flex;align-items:center;gap:10px;padding:13px 18px;border-bottom:1px solid var(--border)}
.export-head h3{margin:0;font-size:14.5px;font-weight:600;flex:1;min-width:0;
white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.export-head .dim{font-size:12px;color:var(--muted);white-space:nowrap}
.export-body{flex:1;min-height:120px;overflow:auto;padding:14px;
background:repeating-conic-gradient(var(--hover) 0% 25%, var(--card) 0% 50%) 50%/18px 18px}
.export-body img{display:block;margin:0 auto;max-width:100%;border:1px solid var(--border);border-radius:8px}
.export-foot{display:flex;align-items:center;gap:8px;padding:12px 18px;border-top:1px solid var(--border);flex-wrap:wrap}
.export-foot .dim{font-size:12px;color:var(--muted)}
.export-foot .sp{flex:1}
.seg{display:inline-flex;border:1px solid var(--border);border-radius:999px;overflow:hidden}
.seg button{border:none;background:transparent;color:var(--text);padding:6px 14px;font-size:12.5px;cursor:pointer}
.seg button+button{border-left:1px solid var(--border)}
.seg button.on{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff}
.seg button:not(.on):hover{background:var(--hover)}
.btn-ghost{border:1px solid var(--border);background:transparent;color:var(--muted);
padding:8px 20px;border-radius:999px;font-size:13px;cursor:pointer}
.btn-ghost:hover{color:var(--text);border-color:var(--muted)}
/* ── ≤700px：下载常驻一级，次级动作进「⋯」菜单；HTML/PDF 边到边、文本
   12~16px 内边距；目录表隐藏修改时间列（下移到名称副行）；信息卡 kv 换行 ── */
@media (max-width:700px){
.more{display:block}
.more-btn{display:inline-flex}
.desktop-only{display:none!important}
.header{gap:8px;padding-left:max(12px, env(safe-area-inset-left));
padding-right:max(12px, env(safe-area-inset-right))}
.header .icon{display:none}
.header h1{font-size:14.5px}
.header .sub{font-size:11px}
.btn{padding:7px 12px;font-size:12.5px}
.snap-banner,.crumbs,.filter-row{padding-left:max(12px, env(safe-area-inset-left));
padding-right:max(12px, env(safe-area-inset-right))}
.list th,.list td{padding-left:12px;padding-right:12px}
.list th:first-child,.list td:first-child{padding-left:max(12px, env(safe-area-inset-left))}
.list th:last-child,.list td:last-child{padding-right:max(12px, env(safe-area-inset-right))}
.list .col-modified{display:none}
/* 窄屏收口定宽列：名称列保底 ~150px，行内下载/复制仍完整可见（不靠横滚取用） */
.list .col-size{width:76px}
.list .acts-col{width:calc(96px + env(safe-area-inset-right))}
.mtime-m{display:block;margin-top:1px;font-size:11px;color:var(--muted);white-space:nowrap;
overflow:hidden;text-overflow:ellipsis}
.md-article{padding:18px max(16px, env(safe-area-inset-right)) 56px max(16px, env(safe-area-inset-left))}
.md-article.csv{padding-left:max(12px, env(safe-area-inset-left));padding-right:max(12px, env(safe-area-inset-right))}
.preview pre{padding:12px max(12px, env(safe-area-inset-right)) 24px max(12px, env(safe-area-inset-left));
font-size:12px}
/* 行级文本（P-20261020-11）不走 pre：窄屏 12px 档在同源规则上补齐，
   与降级 pre 的窄屏字号一致（读者页窄屏可读性基线，P-20261020-7） */
.text-lines{font-size:12px}
.preview.media{padding:12px max(12px, env(safe-area-inset-right)) 12px max(12px, env(safe-area-inset-left))}
.preview.doc>.doc-note{width:calc(100% - 24px)}
.preview.text>.doc-note{margin:10px max(12px, env(safe-area-inset-right)) 0 max(12px, env(safe-area-inset-left))}
.info{padding:36px max(16px, env(safe-area-inset-right)) 36px max(16px, env(safe-area-inset-left))}
.info .kv{gap:8px 18px}
.status{padding:32px max(16px, env(safe-area-inset-right)) 32px max(16px, env(safe-area-inset-left))}
}
/* ── 打印 / 存 PDF：导航操作与装饰不进纸；暗色主题 token 全量翻转为黑字
   白底（浏览器打印默认去背景，靠深底衬托的浅色文字必须显式翻转才可读；
   :root[data-theme] 压过 html[data-theme=dark] 等显式主题选择器）；
   滚动容器放开高度与裁剪让内容自然分页，代码块/表格防跨页截断，
   pre 放开换行防横向溢出页宽 ── */
@media print{
:root,:root[data-theme]{--bg:#fff;--card:#fff;--text:#000;--muted:#555;--border:#ccc;
--accent:#0969da;--accent2:#8250df;--hover:#f2f2f2;--chip:#eef1f4;--shadow:none}
html,body{height:auto;overflow:visible}
body{color:#000;background:#fff}
.blob,.topbar,.spin,.header .actions,.more,.crumbs,.filter-row,.md-outline,.toast,.lightbox,.export-mask,
.confirm-mask,.pre-copy,.h-anchor,.row-acts,.icon-btn,.preview-tools{display:none!important}
.wrap{height:auto;max-width:none;padding:0}
.header{background:none;color:#000;box-shadow:none;border:none;border-bottom:2px solid #000;padding:0 0 10px}
.header .icon{display:none}
.reader{display:block;overflow:visible}
.scroll,.preview{height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important}
.preview pre{height:auto;white-space:pre-wrap;word-break:break-word;overflow:visible}
.text-body{height:auto!important;overflow:visible!important}
.text-lines .tl-c{white-space:pre-wrap;overflow-wrap:anywhere}
.md-article{max-width:100%;padding:0}
.md-article pre{white-space:pre-wrap;word-break:break-word;overflow:visible}
.tbl-wrap,.pre-wrap{overflow:visible}
/* 拖拽切 fixed 的表打印时不按 ellipsis 截断（纸上无法悬浮 title 看全文） */
.md-article table.sc-cols-fixed th,.md-article table.sc-cols-fixed td{white-space:normal;overflow:visible}
.md-article pre,.preview pre,.md-article table,.tbl-wrap,.md-article img,.list tr{break-inside:avoid}
.list th{position:static}
}
{{.BoardCSS}}
</style>
`
