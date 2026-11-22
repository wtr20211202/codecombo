package quickdrop

import (
	"bytes"
	"html/template"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"codecombo/server/share"
	"codecombo/server/store"
)

// 访客投递页（P-20261006-51）：GET/POST /drop/:token。与 Share 访客页同形态
// ——零外部依赖的单页（自持脚本外链同源 /drop/assets/app.js，见 assets.go/
// assets/app.js），手机浏览器直开直投。token 即门禁：无效/未生成/已撤销一律
// 404 品牌页（与 POST /api/quickdrop 同口径——不暴露端点存在性）。
//
// 提交成功走 303 See Other 回本页 ?sent=1（PRG：刷新不重投）；校验失败
// 重渲染表单并保留已输入内容（html/template 上下文转义）。
//
// P-20261117-2-S2 产品化：暂存式多文件交互（拖入/粘贴/多选 → 暂存清单 →
// 单批 multipart XHR 进度上行）由自持脚本承载；品牌头/accent 深浅双态对齐
// share 访客页（--accent2 #6a5cff，page_css.go:9 同源）；enforcing CSP
// script-src 'self' 下内联脚本不可用——页面零内联脚本，事件全部由 app.js
// addEventListener 接线。urlencoded 原生 form 在脚本缺席时仍走 303 PRG
// （人面并存零破坏）。

// dropCSP 投递页 enforcing CSP（全局中间件只有 Report-Only，securityheaders
// .go:96-107；本页是唯一带自持脚本的公开页，逐页收紧）：script 锁同源（外链
// app.js）、XHR 锁同源、表单提交锁同源（覆盖 PRG 自提交）。不设 default-src
// ——内联 <style>/blob: 缩略图（img 未列即不受限）保持可用
const dropCSP = "script-src 'self'; connect-src 'self'; form-action 'self'"

// brandMarkSVG 品牌啮合弧动态 mark（P-20261119-6）：几何源 web/public/favicon.svg
// （P-20261101-1 精修版——真圆弧 A 命令 + 端点节点 r3.4 + 中轴毂点/光晕），
// 动态形态源 web/src/components/common/AppLogo.vue（logo-animated：双轨道虚线
// 圈反向旋转 + 节点/毂点脉冲）。配色映射到本页 token：AppLogo 的
// --accent-blue/--accent-blue-hover/--text-primary → --accent/--accent2/--text
// （quickdrop 页无该三变量，双 accent 与页面渐变主按钮同源，深浅双态随页面
// 既有 prefers-color-scheme 块自然切换）。替换此前临时手绘 SVG（圆角块+播放
// 三角，非任何产品资产）。48 viewBox 与两处槽位（投递页 26px / 404 页 40px）
// 同源；内联零外部依赖（CSP 无 default-src，页面既有内联 <style> 同理放行）。
// 投递页与 404 页共用本常量——品牌 mark 单一事实源，不手抄两份。
const brandMarkSVG = `<svg class="logo logo-animated" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <circle cx="24" cy="24" r="18" stroke="var(--accent)" stroke-width="1" opacity="0.35" stroke-dasharray="4 6" class="logo-orbit-outer"/>
      <circle cx="24" cy="24" r="12" stroke="var(--accent)" stroke-width="1" opacity="0.25" stroke-dasharray="3 5" class="logo-orbit-inner"/>
      <path d="M24 8A16 16 0 0 0 8 24" stroke="var(--accent)" stroke-width="4.2" stroke-linecap="round"/>
      <path d="M24 40A16 16 0 0 0 40 24" stroke="var(--accent2)" stroke-width="4.2" stroke-linecap="round"/>
      <circle cx="8" cy="24" r="3.4" fill="var(--accent)" class="logo-node-a"/>
      <circle cx="40" cy="24" r="3.4" fill="var(--accent2)" class="logo-node-b"/>
      <circle cx="24" cy="24" r="5.2" fill="var(--text)" opacity="0.18"/>
      <circle cx="24" cy="24" r="2.6" fill="var(--text)" class="logo-core"/>
    </svg>`

// brandMarkCSS 品牌 mark 动态形态规则：逐条搬 AppLogo.vue 的 logo-animated 段
// （动画名/时长/缓动/transform-origin 原值），class 选择器与 SVG 内 class 同名
// 故可直接复用；末尾 prefers-reduced-motion 降级静态（无障碍惯例——前庭敏感
// 用户关动效，节点脉冲/轨道旋转全停）。两页共注入，与 brandMarkSVG 成对。
const brandMarkCSS = `  .logo-animated .logo-orbit-outer {
    animation: logo-orbit-cw 12s linear infinite;
    transform-origin: 24px 24px;
    will-change: transform;
  }
  .logo-animated .logo-orbit-inner {
    animation: logo-orbit-ccw 18s linear infinite;
    transform-origin: 24px 24px;
    will-change: transform;
  }
  .logo-animated .logo-node-a {
    animation: logo-pulse 2s ease-in-out infinite;
    transform-box: fill-box;
    transform-origin: center;
    will-change: transform, opacity;
  }
  .logo-animated .logo-node-b {
    animation: logo-pulse 2s ease-in-out 0.5s infinite;
    transform-box: fill-box;
    transform-origin: center;
    will-change: transform, opacity;
  }
  .logo-animated .logo-core {
    animation: logo-core-glow 2.5s ease-in-out infinite;
    transform-box: fill-box;
    transform-origin: center;
    will-change: transform, opacity;
  }
  @keyframes logo-orbit-cw { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
  @keyframes logo-orbit-ccw { from { transform: rotate(0deg) } to { transform: rotate(-360deg) } }
  @keyframes logo-pulse { 0%,100% { transform: scale(1); opacity: 1 } 50% { transform: scale(2); opacity: 0.6 } }
  @keyframes logo-core-glow { 0%,100% { transform: scale(1); opacity: 1 } 50% { transform: scale(2.5); opacity: 0.4 } }
  @media (prefers-reduced-motion: reduce) {
    .logo-animated .logo-orbit-outer,
    .logo-animated .logo-orbit-inner,
    .logo-animated .logo-node-a,
    .logo-animated .logo-node-b,
    .logo-animated .logo-core { animation: none; }
  }`

// brandFaviconHref 品牌 mark favicon（P-20261119-6）：web/public/favicon.svg
// （P-20261101-1 精修版）的 data-uri 静态形态——访客页此前 head 零 icon link
// （实勘），浏览器地址栏/书签回落空白图标。取 data-uri 而非新增 /drop/assets
// 白名单资产：零新路由零新 CSP 面（无 img-src/default-src 不限 data:），页面
// 自成一体。静态形态去动画组件、保品牌原色（favicon 在页面 CSS 上下文外
// var() 不可解析）。内层单引号 + # 转 %23，href 外层双引号即可（本串只经
// html/template 静态透传，无动态转义面）。改 favicon.svg 时同步此处（两份
// 事实源无法共享：web/public 资产随前端构建、不进 Go embed）。
const brandFaviconHref = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48' fill='none'%3E%3Cpath d='M24 8A16 16 0 0 0 8 24' stroke='%2379c0ff' stroke-width='4.2' stroke-linecap='round'/%3E%3Cpath d='M24 40A16 16 0 0 0 40 24' stroke='%23388bfd' stroke-width='4.2' stroke-linecap='round'/%3E%3Ccircle cx='8' cy='24' r='3.4' fill='%2379c0ff'/%3E%3Ccircle cx='40' cy='24' r='3.4' fill='%23388bfd'/%3E%3Ccircle cx='24' cy='24' r='5.2' fill='%23e6edf3' opacity='0.18'/%3E%3Ccircle cx='24' cy='24' r='2.6' fill='%23e6edf3'/%3E%3C/svg%3E`

// brandFaviconLink 两页 head 共用的 favicon 标签（单一事实源）
const brandFaviconLink = `<link rel="icon" type="image/svg+xml" href="` + brandFaviconHref + `">`

// brandBlobCSS/brandBlobDivs 品牌氛围背景层（P-20261120-6）：双 blob 模糊光斑，
// 取值逐字同 share 访客页族（page_css.go:25-27 / termpage.go:272-274；单值不分
// 深浅档，循 termpage 先例）。此前访客页族「两有一无」——文件/终端分享页有
// 氛围层、快投递只有径向光晕，#f4f6fb 底+纯白卡对比微弱整页读作纯白。固定层
// z-index:0，内容列以 position:relative;z-index:1 压其上（termpage .wrap
// z-index:1 同构先例——仅靠 body flex 子项树序不显式，两处都写明防回归）；
// pointer-events:none 不挡交互。快投递无打印面，share 打印豁免清单
// （page_css.go:439）不适用。投递页与 404 页共用本常量——brandMark 三件套
// 同款单一事实源模式，不手抄两份。
const brandBlobCSS = `  .blob { position: fixed; border-radius: 50%; filter: blur(90px); z-index: 0; pointer-events: none; }
  .b1 { width: 380px; height: 380px; background: rgba(106,92,255,.30); top: -90px; right: -70px; }
  .b2 { width: 320px; height: 320px; background: rgba(61,123,253,.26); bottom: -90px; left: -60px; }`

// brandBlobDivs 两页 body 开篇的 blob 挂载标记（share page.go:79 / termpage
// .go:332 同形态）
const brandBlobDivs = `<div class="blob b1"></div><div class="blob b2"></div>`

// dropPageTemplate 渲染数据
type dropPageTemplate struct {
	// Sent 本次 GET 带成功标记（?sent=1，PRG 回跳）——渲染已送达横幅
	Sent bool
	// Err 校验失败的提示文案（POST 重渲染路径；空 = 无错误）
	Err string
	// Content 校验失败时回填的已输入内容（转义由 template 承担）
	Content string
}

// dropPageHTML 投递页模板（零外部依赖：系统字体栈 + 内联 CSS + 外链自持
// 脚本；配色用 prefers-color-scheme 跟随系统深浅——访客设备未知，不预设
// 主题）。文案双语（中文为主 + English 副行）：服务端渲染链无界面语言上下
// 文，与 share 子服务「访客页文案自持」同一决策口径。
//
// 结构：品牌头（左 logo+名，右上角标：上传进度/历史记录）+ 卡片（横幅区 →
// 双栏区：左=文件区 label+dropzone+暂存清单，右=内容区 label+textarea+进度
// 条——≥760px 三行等高网格（P-20261120-7），<760px 单栏堆叠，P-20261118-8；
// 动作行（hint+提交）在双栏区之下全宽）。移动端一等入口=多选 input+粘贴
// （iOS Safari 无拖拽），拖拽降级增强不阻塞主链。
//
// P-20261119-6：品牌 logo 换产品啮合弧 mark 的动态形态（brandMarkSVG/
// brandMarkCSS）+ data-uri favicon（brandFaviconLink）；body 改 flex 列视口
// 垂直居中（大屏「上半截内容下半全空」消除，内容高于视口时 auto 边距收敛
// 从顶部可滚）。三处共享常量在下方拼接注入，两页同一事实源。
var dropPageHTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
` + brandFaviconLink + `
<title>快投递 · Quickdrop</title>
<style>
  :root {
    color-scheme: light dark;
    --bg:#f4f6fb; --card:#ffffff; --text:#1b2437; --muted:#667085; --border:#e2e6f0;
    --accent:#3d7bfd; --accent2:#6a5cff; --accent-weak:rgba(106,92,255,.10);
    --ok-bg:#e6ffec; --ok:#1a7f37; --err-bg:#ffebe9; --err:#cf222e;
    --shadow:0 10px 30px rgba(23,43,99,.08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0d1117; --card:#161b22; --text:#e6edf3; --muted:#8b949e; --border:#30363d;
      --accent:#4493f8; --accent2:#ab7df8; --accent-weak:rgba(171,125,248,.14);
      --ok-bg:#12351a; --ok:#7ee2a8; --err-bg:#3d1a1a; --err:#ff8182;
      --shadow:0 10px 30px rgba(0,0,0,.35);
    }
  }
` + share.GuestThemeCSS + `
  * { box-sizing: border-box; }
  /* 视口垂直居中（P-20261119-6）：body 变 flex 列，.top 顶 margin:auto + main
     底 margin:auto 把「品牌头+卡片」作为一组在视口内垂直居中（大屏不再上半截
     内容下半全空）。用 auto 边距而非 justify-content:center——内容高于视口时
     Flexbox 规范把 auto 边距按 0 收敛，内容从顶部起排可完整滚动；justify-content
     :center 溢出时上溢部分滚不到（经典 flex 居中截断）。移动端/小视口零回归。
     min-height 两行回落：旧浏览器忽略 dvh 取 vh；100dvh 让移动端 URL 栏收展
     不产生整页跳动 */
  body {
    margin: 0; min-height: 100vh; min-height: 100dvh;
    display: flex; flex-direction: column;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
    /* 头部径向光晕参数与 share 访客页同形态（page_css.go:25），紫色取值不随
       --accent 漂移——光晕是品牌氛围层，accent 是交互色，两语义分开 */
    background:
      radial-gradient(1100px 420px at 50% -180px, rgba(106,92,255,.14), transparent 70%),
      var(--bg);
    color: var(--text); padding: 14px;
  }
` + brandBlobCSS + `
  /* ── 品牌头 + 角标 ── */
  /* 列宽一档放大（P-20261120-6）：860px 阅读列在宽屏四周大留白（截图实锤），
     改 min(92vw,1120px)——≥1217px 视口封顶 1120px，以下随宽 92vw 留呼吸边距；
     position/z-index 压 blob 氛围层之上（见 brandBlobCSS 注）；顶部 auto 边距
     承担垂直居中（见 body 注） */
  .top {
    max-width: min(92vw, 1120px); position: relative; z-index: 1;
    margin: auto auto 16px; display: flex; align-items: center; gap: 10px;
  }
  main { margin-bottom: auto; position: relative; z-index: 1; }
  .brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
  /* 品牌 mark 无底色板（啮合弧 + 节点）：26px 起步与旧方块 logo 同槽位，
     P-20261120-6 随内容一档放大到 28px（头部行高由 badge 36px 决定不漂移） */
  .logo { width: 28px; height: 28px; flex: none; display: block; }
` + brandMarkCSS + `
  .brand-name { font-weight: 700; font-size: 16px; letter-spacing: .2px; }
  .brand-page { color: var(--muted); font-size: 13px; white-space: nowrap; }
  .badges { margin-left: auto; display: flex; gap: 8px; }
  .badge {
    display: inline-flex; align-items: center; gap: 5px; min-height: 36px; padding: 0 10px;
    border: 1px solid var(--border); border-radius: 999px; background: var(--card);
    color: var(--accent); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
  }
  .badge[hidden] { display: none; }
  .badge svg { flex: none; }
  /* ── 历史面板（右上角弹卡） ── */
  /* right 跟随容器右缘（宽屏贴卡不对视口）：fixed 无法感知 .top 位置，用
     (100vw-列宽)/2 取容器外边距（body padding 左右对称恒抵消，公式与卡片
     右缘精确对齐）——窄屏负值回落 max 的 14px 视口边距；≤520px 媒体查询
     另收 10px。公式随 P-20261120-6 新列宽同步 */
  .hist-panel {
    position: fixed; top: 58px; right: max(14px, calc((100vw - min(92vw, 1120px)) / 2)); z-index: 30;
    width: min(340px, calc(100vw - 28px));
    background: var(--card); border: 1px solid var(--border); border-radius: 12px;
    box-shadow: var(--shadow); padding: 12px 14px;
  }
  .hist-panel[hidden] { display: none; }
  .hist-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
  .hist-title { font-size: 13px; font-weight: 600; }
  .hist-sub { font-size: 11px; color: var(--muted); }
  .hist-clear {
    margin-left: auto; border: none; background: none; color: var(--accent);
    font: inherit; font-size: 12px; cursor: pointer; padding: 4px;
  }
  .hist-list { list-style: none; margin: 0; padding: 0; max-height: 260px; overflow-y: auto; }
  .hist-item { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-top: 1px solid var(--border); }
  .hist-item:first-child { border-top: none; }
  .hist-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--ok); }
  .qd-hist-fail .hist-dot { background: var(--err); }
  .qd-hist-partial .hist-dot { background: #d29922; }
  .hist-main { min-width: 0; display: flex; flex-direction: column; }
  .hist-time { font-size: 11px; color: var(--muted); }
  .hist-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hist-size { font-size: 11px; color: var(--muted); flex: none; }
  .hist-empty { font-size: 12px; color: var(--muted); margin: 4px 0 0; }
  /* ── 卡片 ── */
  .card {
    max-width: min(92vw, 1120px); margin: 0 auto; background: var(--card); border: 1px solid var(--border);
    border-radius: 12px; padding: 28px; box-shadow: var(--shadow);
  }
  /* 字号/内衬一档放大（P-20261120-6）：h1 18→22px、副行 12→13px、卡片内衬
     22→28px——宽屏卡片放大后内部仍保持呼吸感；≤520px 媒体查询回落窄屏内衬 */
  h1 { font-size: 22px; margin: 0 0 2px; }
  .sub { font-size: 13px; color: var(--muted); margin: 0 0 18px; }
  /* ── 双栏区（P-20261120-7 等高对齐）：基础（<760px 单栏回落）display:block
     自然堆叠（文件列→内容列，DOM 序即视序，16px 块间距承既有 grid gap 语义）；
     ≥760px 切三行等高网格（摆位规则在样式尾部 @media (min-width: 760px) 块
     ——须晚于 .dz/.staged/textarea 基础规则出场才能覆盖 dz 的块流下边距）。
     横幅区（.banner/.err/#qd-msg）是 .card 平铺子节点，留在 .cols 之上全宽 */
  .cols { display: block; }
  .col + .col { margin-top: 16px; }
  /* 暂存区：拖入/点击选择（粘贴在页级接）；min-height 与右列 textarea 归一
     200px（P-20261120-6 一档放大到 140px → P-20261120-7 等高归一——两值不一
     期间两框恒差一档，用户截图主诉）。窄屏单栏同样受益 */
  .dz {
    display: flex; align-items: center; gap: 12px; min-height: 200px;
    border: 1.5px dashed var(--border); border-radius: 10px;
    padding: 16px; margin-bottom: 14px; cursor: pointer; color: var(--muted);
    transition: border-color .15s, background-color .15s;
  }
  .dz:hover, .dz:focus-visible, .dz.qd-over { border-color: var(--accent); background: var(--accent-weak); }
  .dz svg { flex: none; color: var(--accent); }
  .dz-main { font-size: 14px; color: var(--text); line-height: 1.55; }
  /* 限额说明 chips：一行长串在窄卡里折行出孤行悬尾，拆成可换行的药丸组；
     英文副行独立一行保留双语结构（中文 chips + English 副行） */
  .dz-sub { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .chip {
    display: inline-block; padding: 2px 8px; font-size: 11px; color: var(--muted);
    border: 1px solid var(--border); border-radius: 999px; background: var(--card); white-space: nowrap;
  }
  .dz-en { font-size: 11px; color: var(--muted); margin-top: 4px; }
  /* 暂存清单 */
  .staged { list-style: none; margin: 0 0 4px; padding: 0; }
  .qd-item {
    display: flex; align-items: center; gap: 10px; padding: 7px 8px;
    border: 1px solid var(--border); border-radius: 9px; margin-bottom: 6px; font-size: 12px;
  }
  .qd-item-err { border-color: var(--err); background: var(--err-bg); }
  .qd-thumb {
    width: 34px; height: 34px; border-radius: 6px; flex: none; object-fit: cover;
    background: var(--accent-weak); display: inline-flex; align-items: center; justify-content: center;
  }
  .qd-thumb-icon::before { content: "📄"; font-size: 15px; }
  .qd-item-main { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .qd-item-name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qd-item-size { font-size: 11px; color: var(--muted); }
  .qd-item-err .qd-item-size { color: var(--err); }
  .qd-item-del {
    margin-left: auto; flex: none; width: 34px; height: 34px;
    border: none; border-radius: 8px; background: none; color: var(--muted); cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .qd-item-del:hover { background: var(--err-bg); color: var(--err); }
  .staged-summary { font-size: 12px; color: var(--muted); margin: 2px 0 10px; min-height: 1em; }
  label { display: block; font-size: 14px; margin-bottom: 6px; }
  textarea {
    width: 100%; min-height: 200px; resize: vertical; padding: 12px;
    font-size: 14px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    border: 1px solid var(--border); border-radius: 8px; background: var(--card); color: inherit;
  }
  textarea:focus, .dz:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  /* 进度条 */
  .pwrap { margin-top: 10px; }
  .pwrap[hidden] { display: none; }
  .pbar { height: 8px; border-radius: 999px; background: var(--accent-weak); overflow: hidden; }
  .pbar-fill { height: 100%; width: 0%; border-radius: 999px; background: var(--accent); transition: width .12s linear; }
  .plabel { font-size: 12px; color: var(--muted); display: inline-block; margin-top: 5px; }
  .row { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
  .hint { font-size: 12px; color: var(--muted); }
  /* 动作行的显性告知行（P-20261118-8 校验传达）：「只发文字也合法」——空
     表单拦截语义是「内容与文件至少一项」，历史标签只说「可留空」被误读为
     「文件必须」 */
  .hint-line { font-size: 12px; color: var(--muted); margin: 10px 0 0; }
  /* 主按钮：双 accent 渐变 + hover brightness——share 访客页 .btn.primary
     同款（page_css.go:54-56）；active/disabled 沿用 opacity 方案；
     :focus-visible 显式环与 textarea/.dz 焦点面一致（渐变按钮失焦态可辨）。
     min-height:44px 是触达红线（P-20261120-6 放大只加内衬不缩热区） */
  button.qd-send {
    margin-left: auto; padding: 12px 30px; font-size: 15px; font-weight: 600; cursor: pointer;
    background: linear-gradient(135deg, var(--accent), var(--accent2)); color: #fff;
    border: none; border-radius: 9px; min-height: 44px;
  }
  button.qd-send:hover { filter: brightness(1.08); }
  button.qd-send:active { opacity: .85; }
  button.qd-send:disabled { opacity: .55; cursor: default; }
  button.qd-send:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .banner {
    background: var(--ok-bg); color: var(--ok); border-radius: 8px;
    padding: 10px 12px; font-size: 13px; margin-bottom: 14px;
  }
  .err {
    background: var(--err-bg); color: var(--err); border-radius: 8px;
    padding: 10px 12px; font-size: 13px; margin-bottom: 14px;
  }
  .qd-msg { border-radius: 8px; padding: 10px 12px; font-size: 13px; margin-bottom: 12px; }
  .qd-msg[hidden] { display: none; }
  .qd-msg-err { background: var(--err-bg); color: var(--err); }
  .qd-msg-ok { background: var(--ok-bg); color: var(--ok); }
  /* ── ≥760px 三行等高网格（P-20261120-7 两框等高+列底齐）：行1=双 label
     对齐行（同轨顶对齐——右列长 label 换行不牵动左列框顶）、行2=两框同轨
     （grid 缺省 align-items:stretch 即同轨等高语义，两框高度恒等于轨道高度；
     min-height 已归一 200px——此前显式 start 两列各按内容收缩 + 140/180 两值
     不一 + 动作行只在右列是等高失效三根因，用户截图双箭头实锚）、行3=尾行
     同轨（左=暂存清单/汇总、右=进度条，列底恒齐——清单增长撑高尾行，两框
     保持同高：等高优先于随列拉伸的语义定案）。动作行（hint+提交）脱离右列
     移 .cols 之下全宽（业界分栏表单通例，提交钮右对齐 margin-left:auto 既有）。
     display:contents 让 .col 退化为逻辑分组——grid 项按显式摆位入轨不受 DOM
     序影响；<760px 回落 .col 复原 display:block（.cols 基础规则），DOM 序=
     视序自然堆叠零变化；老浏览器不识 display:contents 时该声明作废回块流，
     退化双列平铺仍可用。form 外扩包裹 .cols+动作行：urlencoded 原生提交与
     XHR 锚（qd-form/qd-send/content/qd-msg）零位移，file input 无 name 不入
     提交体（原生与 FormData 双路 payload 不变）。块间距逐项对齐旧节奏：label
     下边距 6px 承 label→框距、.ftail 上边距 14px 承旧 dz 下边距、进度条 10px
     上边距不变 */
  @media (min-width: 760px) {
    .cols { display: grid; grid-template-columns: 1fr 1fr; column-gap: 24px; }
    .col { display: contents; }
    .col > * { min-width: 0; }
    .lb-files { grid-column: 1; grid-row: 1; }
    .lb-content { grid-column: 2; grid-row: 1; }
    .dz { grid-column: 1; grid-row: 2; margin-bottom: 0; }
    textarea { grid-column: 2; grid-row: 2; }
    .ftail { grid-column: 1; grid-row: 3; margin-top: 14px; }
    #qd-progress { grid-column: 2; grid-row: 3; }
  }
  /* 移动端触达面积：窄屏提交钮整行、加大触点 */
  @media (max-width: 520px) {
    body { padding: 10px; }
    .card { padding: 16px; border-radius: 12px; }
    .brand-page { display: none; }
    .row { flex-direction: column-reverse; align-items: stretch; gap: 8px; }
    button.qd-send { width: 100%; margin-left: 0; }
    .hist-panel { right: 10px; }
  }
</style>
</head>
<body>
` + brandBlobDivs + `
<header class="top">
  <div class="brand">
    ` + brandMarkSVG + `
    <span class="brand-name">Codecombo</span>
    <span class="brand-page">· 快投递 Quickdrop</span>
  </div>
  <div class="badges">
    <span id="qd-theme-slot"></span>
    <button type="button" id="qd-upload-badge" class="badge" hidden data-testid="qd-upload-badge" title="上传中">
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 19V5m0 0l-6 6m6-6l6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span class="qd-badge-progress">0%</span>
    </button>
    <button type="button" id="qd-history-badge" class="badge" hidden data-testid="qd-history-badge" title="投递记录（仅保存在本机）" aria-label="投递记录">
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3.5 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <span class="qd-badge-count">0</span>
    </button>
  </div>
</header>
<div id="qd-history-panel" class="hist-panel" hidden data-testid="qd-history-panel">
  <div class="hist-head">
    <span class="hist-title">投递记录</span>
    <span class="hist-sub">仅保存在本机 · 24h 后服务端自动过期</span>
    <button type="button" id="qd-history-clear" data-testid="qd-history-clear">清空</button>
  </div>
  <ul id="qd-history-list" class="hist-list"></ul>
  <p id="qd-history-empty" class="hist-empty" hidden>暂无记录 / No records yet</p>
</div>
<main>
  <div class="card">
    <h1>快投递 · Quickdrop</h1>
    <p class="sub">截图 / 日志 / 文件一把投到工作台 · Send screenshots, logs and files to your workbench</p>
    {{if .Sent}}<div class="banner">已送达 ✓ 工作台通知中心已入账（24 小时内有效）。Delivered — see your workbench notification center.</div>{{end}}
    {{if .Err}}<div class="err">{{.Err}}</div>{{end}}
    <div id="qd-msg" class="qd-msg" hidden data-testid="qd-msg"></div>
    <form id="qd-form" method="post" action="">
      <div class="cols">
        <div class="col">
          <label class="lb-files" for="qd-file-input">文件 / Files</label>
          <div id="qd-dropzone" class="dz" data-testid="qd-dropzone" role="button" tabindex="0" aria-label="添加文件：拖入、点击选择或粘贴">
            <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d="M12 16V4m0 0L7 9m5-5l5 5M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <div class="dz-main">
              <strong>拖入文件</strong> 或 <strong>点击选择</strong>（可多选）· 也可直接粘贴截图
              <div class="dz-sub">
                <span class="chip">最多 20 个 / 批</span><span class="chip">图片 ≤10MB</span><span class="chip">文件 ≤200MB</span><span class="chip">共 2GB</span>
              </div>
              <div class="dz-en">Drag &amp; drop, pick or paste · Up to 20 files · Images ≤10MB · Files ≤200MB · 2GB total</div>
            </div>
          </div>
          <input id="qd-file-input" type="file" multiple hidden>
          <div class="ftail">
            <ul id="qd-staged-list" class="staged" data-testid="qd-staged-list"></ul>
            <p id="qd-staged-summary" class="staged-summary" data-testid="qd-staged-summary"></p>
          </div>
        </div>
        <div class="col">
          <label class="lb-content" for="content">内容 / Content（有文件时可留空 / optional if files attached）</label>
          <textarea id="content" name="content" autofocus placeholder="报错、代码片段、想法……（≤4KB）">{{.Content}}</textarea>
          <div id="qd-progress" class="pwrap" hidden data-testid="qd-progress">
            <div class="pbar"><div id="qd-progress-bar" class="pbar-fill" data-testid="qd-progress-bar"></div></div>
            <span id="qd-progress-label" class="plabel" data-testid="qd-progress-label"></span>
          </div>
        </div>
      </div>
      <p class="hint-line">只投文字也可以，无文件直接投 / Text-only drops are fine</p>
      <div class="row">
        <span class="hint">送达后出现在工作台通知中心，24h 自动过期。Expires in 24h.</span>
        <button id="qd-send" type="submit" class="qd-send" data-testid="qd-send">投递 / Drop</button>
      </div>
    </form>
  </div>
</main>
<script src="/drop/assets/app.js" defer></script>
</body>
</html>
`

// dropTmpl 包级编译的投递页模板（Must：静态资产解析失败在进程启动的包初始化
// 期即 panic，不留运行期半态）
var dropTmpl = template.Must(template.New("drop").Parse(dropPageHTML))

// GetDropPage GET /drop/:token——投递页渲染（token 无效 404 品牌页）
func GetDropPage(c *gin.Context) {
	if !store.Get().QuickdropToken.Validate(c.Param("token")) {
		renderDropNotFound(c)
		return
	}
	renderDropPage(c, http.StatusOK, dropPageTemplate{Sent: c.Query("sent") == "1"})
}

// PostDropForm POST /drop/:token——访客页表单提交入口（形态分流）：
// urlencoded 旧表单走既有 303 PRG 人面（与 POST /api/quickdrop 共用 ingest
// 主链；失败按分型重渲染 HTML）；multipart 走多文件上行（files.go，JSON
// 机器契约，S2 访客页 XHR 消费）。token 门禁前置：先于任何读体校验凭据
// （评审必改②——无效凭据的大体量请求零字节读取即 404，不白吃带宽不落地；
// 404 品牌页口径不变）
func PostDropForm(c *gin.Context) {
	st := store.Get()
	if st == nil {
		renderDropPage(c, http.StatusInternalServerError, dropPageTemplate{
			Err: "服务暂不可用，请稍后重试 / Temporarily unavailable, try again",
		})
		return
	}
	token := c.Param("token")
	if !st.QuickdropToken.Validate(token) {
		renderDropNotFound(c)
		return
	}
	if strings.HasPrefix(c.Request.Header.Get("Content-Type"), "multipart/") {
		postDropMultipart(c, token)
		return
	}
	// 表单体上限：内容 4KB + 编码余量（超限按校验失败重渲染，不给裸 413 页）
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, dropMaxBody)
	if err := c.Request.ParseForm(); err != nil {
		renderDropPage(c, http.StatusBadRequest, dropPageTemplate{
			Err: "内容过大 / Content too large (max 4KB)",
		})
		return
	}
	_, ie := ingest(c, token, c.PostForm("content"))
	switch ie {
	case ingestOK:
		// PRG：303 回本页成功态（刷新不重投）
		c.Redirect(http.StatusSeeOther, "/drop/"+c.Param("token")+"?sent=1")
	case ingestErrToken:
		renderDropNotFound(c)
	case ingestErrEmpty:
		renderDropPage(c, http.StatusBadRequest, dropPageTemplate{
			Err: "内容为空 / Content is empty",
		})
	case ingestErrTooLarge:
		renderDropPage(c, http.StatusBadRequest, dropPageTemplate{
			Err:     "内容过大 / Content too large (max 4KB)",
			Content: c.PostForm("content"),
		})
	default:
		// 存储不可用：500 状态 + 通用重试文案（保留输入，重试可恢复）
		renderDropPage(c, http.StatusInternalServerError, dropPageTemplate{
			Err:     "服务暂不可用，请稍后重试 / Temporarily unavailable, try again",
			Content: c.PostForm("content"),
		})
	}
}

// renderDropPage 渲染投递页：html/template 上下文转义（回显用户输入面）+
// 私有内容 no-store——token 在 URL、输入可能在重渲染回显，不在任何中间层
// 留缓存。经包级模板实例渲染成字节后 c.Data 输出（本仓库无 gin HTML 模板
// 机制的使用先例，不为单页引入 engine.SetHTMLTemplate 装配面）。enforcing
// CSP 逐页施加（dropCSP 注：全局中间件只有 Report-Only）
func renderDropPage(c *gin.Context, status int, data dropPageTemplate) {
	var buf bytes.Buffer
	if err := dropTmpl.Execute(&buf, data); err != nil {
		// 模板是编译期已验证的静态资产，执行失败属程序错误而非访客输入问题
		c.String(http.StatusInternalServerError, "internal error")
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Header("X-Robots-Tag", "noindex")
	c.Header("Content-Security-Policy", dropCSP)
	c.Data(status, "text/html; charset=utf-8", buf.Bytes())
}

// dropNotFoundHTML token 无效的品牌 404 页（P-20261118-8 立居中卡，P-20261119-6
// 换品牌动态 mark + favicon）：与投递页同套 token（双 accent 取值同源）——
// 品牌啮合弧 mark + 渐变 404 大字 + 双语文案。两处品牌组件（brandMarkSVG/
// brandMarkCSS/brandFaviconLink）与投递页共享同一常量，不手抄。文案
// 「链接无效」是 files_test 门禁断言串（投放前门禁 404 页口径），改动须同步。
//
// 主题面（P-20261120-1）：data-theme 覆盖块随 share.GuestThemeCSS 注入——
// 本页零 JS 的话 data-theme 永不设置（dropCSP 禁内联），主题块即死代码，
// 故引用同源自持脚本 app.js（评审必改2 三选一裁定 (ii)：app.js 全 null-guard
// 实勘零新资产）——initTheme 只读 localStorage 偏好设 data-theme（跨页共享：
// 访客在文件/终端/投递页选过的主题在此生效），无切换器（slot 缺席挂载跳过）。
var dropNotFoundHTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
` + brandFaviconLink + `
<title>404 · 快投递</title>
<style>
  :root { color-scheme: light dark;
    --bg:#f4f6fb; --card:#ffffff; --text:#1b2437; --muted:#667085; --border:#e2e6f0;
    --accent:#3d7bfd; --accent2:#6a5cff; --shadow:0 10px 30px rgba(23,43,99,.08); }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#0d1117; --card:#161b22; --text:#e6edf3; --muted:#8b949e; --border:#30363d;
    --accent:#4493f8; --accent2:#ab7df8; --shadow:0 10px 30px rgba(0,0,0,.35); } }
` + share.GuestThemeCSS + `
  /* 居中卡沿用 P-20261118-8 的 flex 居中；min-height 两行回落——旧浏览器忽略
     dvh 取 vh，100dvh 让移动端 URL 栏收展不产生整页跳动（与投递页同口径） */
  body { margin:0; min-height:100vh; min-height:100dvh; display:flex; align-items:center; justify-content:center; padding:14px;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: radial-gradient(1100px 420px at 50% -180px, rgba(106,92,255,.14), transparent 70%), var(--bg);
    color: var(--text); }
` + brandBlobCSS + `
  /* 404 卡不放大（420px 品牌卡口径保留），仅补 position/z-index 压 blob 之上
     （P-20261120-6——share 访客页族 404/口令页同挂氛围层，page_aux.go:30-32/:51） */
  .nf-card { max-width:420px; width:100%; background:var(--card); border:1px solid var(--border);
    border-radius:12px; box-shadow:var(--shadow); padding:44px 36px; text-align:center;
    position:relative; z-index:1; }
  /* 品牌 mark 40px（与旧方块 logo 同槽位），无底色板故去圆角；display:block 收
     内联基线间隙、margin 自动居中不依赖 card 的 text-align */
  .nf-card .logo { width:40px; height:40px; display:block; margin:0 auto; }
` + brandMarkCSS + `
  .nf-code { margin:16px 0 0; font-size:44px; font-weight:700; line-height:1;
    background:linear-gradient(135deg,var(--accent),var(--accent2));
    -webkit-background-clip:text; background-clip:text; color:transparent; }
  h1 { font-size:15px; font-weight:600; margin:10px 0 0; }
  p { color:var(--muted); font-size:12.5px; margin:8px 0 0; }
</style>
</head>
<body>
` + brandBlobDivs + `
<div class="nf-card">
  ` + brandMarkSVG + `
  <div class="nf-code">404</div>
  <h1>链接无效或已撤销 · Link not found</h1>
  <p>请向分享人确认链接或重新索取 / Confirm the link with the sender</p>
</div>
<script src="/drop/assets/app.js" defer></script>
</body>
</html>
`

// renderDropNotFound 渲染 token 无效品牌 404 页：不区分「无此链接/已撤销/未生
// 成」（探不出存在性）。CSP 同口径施加（无脚本面，防御性一致——资产路由
// 的未知名也走本页）
func renderDropNotFound(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	c.Header("X-Robots-Tag", "noindex")
	c.Header("Content-Security-Policy", dropCSP)
	c.Data(http.StatusNotFound, "text/html; charset=utf-8", []byte(dropNotFoundHTML))
}
