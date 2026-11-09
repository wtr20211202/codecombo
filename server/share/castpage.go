package share

import (
	"encoding/json"
	"html/template"
	"io"
)

// 会话回放访客页（P-20261004-103）：直播/定格访客页的同族零外部依赖单文件
// 页——vendored xterm 三件从本服务 /assets/ 同源加载（assets.go 白名单），
// 回放内容经 /s/{token}/cast 一次性取回（创建时的快照，已敏感值兜底遮蔽），
// 页面内按 asciinema v2 时序喂 xterm：播放/暂停/重播/倍速/进度拖动 +
// OSC 133（E→C→D 链）命令章节跳转（与 web/src/components/recording/
// CastReplayer.vue + utils/recording.ts 同一解析语义，双端各自实现——
// 访客页是零依赖单文件契约，不能引用前端 bundle）。
//
// 严格只读：服务端无分享内容写入端点（/gate 口令验证、/view 一次性确认、
// /messages 访客留言均不写分享内容，其余 POST 到 /s/* 405），
// xterm disableStdin 关键盘输入，页面不存在把输入送回服务端的代码路径。
// 数据面是静态快照：无 SSE/轮询/遥测，加载完成后不再有任何网络活动（下载
// 链接是用户显式动作）。快照与录制/会话生命周期解耦：录制删除或会话关闭
// 都不影响本页（内容读自 SnapshotsRoot 隔离区，独立 TTL 管理）。
//
// 加载策略（MVP 全量）：/cast 端点经 http.ServeContent 支持 Range，但回放
// 引擎一次取回并解析整份 cast——体积受录制窗口硬上限（recording 包 15 分钟）
// 与创建面 200MB 护栏双重约束；分块/流式回放列为后续加强（大文件场景优先
// 缩短录制窗口，而非无限放大访客页内存）。

type castBootState struct {
	Token string            `json:"token"`
	Lang  string            `json:"lang"`
	Dict  map[string]string `json:"dict"`
	// Wm 溯源水印文本（P-20261005-193；空串 = 记录未开水印，页面不出水印层）
	Wm string `json:"wm,omitempty"`
}

var castDictZh = map[string]string{
	"appTitle":     "会话回放",
	"replayBadge":  "回放",
	"loadingTip":   "回放加载中…",
	"playingBadge": "回放中",
	"pausedBadge":  "已暂停",
	"doneBadge":    "已播完",
	"maskBanner":   "回放内容来自录制时的终端输出，已做敏感值遮蔽（sc 令牌 / password 赋值 / 云密钥 key → ***）。遮蔽靠模式启发式，非绝对。",
	"readonlyTip":  "本页面为只读回放：无实时推流、无任何输入通道",
	"loadError":    "回放读取失败，链接可能已被撤销、过期或快照已清理",
	"emptyTip":     "录制内容为空（该窗口没有可回放的输出）",
	"play":         "播放",
	"pause":        "暂停",
	"replay":       "重播",
	"chapters":     "命令章节",
	"noChapters":   "未捕获到命令章节（OSC 133 shell integration 未启用）",
	"downloadCast": "下载 cast 文件",
	"poweredBy":    "由 Codecombo 提供",
	"gbTitle":      "留言",
	"gbNick":       "昵称（可选）",
	"gbPh":         "写下你的问题或反馈（≤500 字）…",
	"gbSend":       "发送",
	"gbSending":    "发送中…",
	"gbSent":       "已收到你的留言，分享者可在管理面板看到",
	"gbEmpty":      "还没有留言",
	"gbAnon":       "匿名访客",
	"gbTooLong":    "留言超过 500 字上限",
	"gbLimited":    "发送太频繁，请稍后再试",
	"gbFailed":     "发送失败，请重试",
}

var castDictEn = map[string]string{
	"appTitle":     "Session Replay",
	"replayBadge":  "REPLAY",
	"loadingTip":   "Loading replay…",
	"playingBadge": "PLAYING",
	"pausedBadge":  "PAUSED",
	"doneBadge":    "FINISHED",
	"maskBanner":   "This replay is terminal output captured during recording and is masked for sensitive values (sc tokens / password assignments / cloud keys → ***). Masking is heuristic, not absolute.",
	"readonlyTip":  "This page is a read-only replay: no live stream and no input channel",
	"loadError":    "Failed to load the replay; the link may have been revoked, expired, or its snapshot cleaned up",
	"emptyTip":     "The recording has no replayable output (nothing was captured in this window)",
	"play":         "Play",
	"pause":        "Pause",
	"replay":       "Replay",
	"chapters":     "Command chapters",
	"noChapters":   "No command chapters captured (OSC 133 shell integration was not enabled)",
	"downloadCast": "Download cast",
	"poweredBy":    "Powered by Codecombo",
	"gbTitle":      "Messages",
	"gbNick":       "Nickname (optional)",
	"gbPh":         "Leave a question or feedback (≤500 chars)…",
	"gbSend":       "Send",
	"gbSending":    "Sending…",
	"gbSent":       "Your message was received — the owner will see it in the share manager.",
	"gbEmpty":      "No messages yet",
	"gbAnon":       "Anonymous",
	"gbTooLong":    "Message exceeds the 500-character limit",
	"gbLimited":    "Too many messages, please try again later.",
	"gbFailed":     "Failed to send, try again",
}

func castDictFor(lang string) map[string]string {
	if lang == "zh" {
		return castDictZh
	}
	return castDictEn
}

type castPageData struct {
	Lang  string
	Title string
	Boot  template.JS
	// BoardCSS/BoardJS 访客留言区共享资产（P-20261006-13，guestboard.go
	// 单一事实源——四形态访客页同一段脚本挂载）
	BoardCSS template.CSS
	BoardJS  template.JS
	// LayoutCSS/LayoutJS 终端访客页共用布局件（P-20261106-9，termlayout.go）
	LayoutCSS template.CSS
	LayoutJS  template.JS
}

// 模板与 termpage.go/termpagefrozen.go 同族（头/横幅/卡片/主题化样式逐段
// 对齐），差异在数据面与工具条：cast 是一次性取回的时序事件，页面自带播放
// 引擎与章节跳转。改动三端共有样式时须同步（单文件页各自自包含是本服务的
// 零依赖契约，抽共享模板会让任一页的差异化演进变扭）
const castPageTmplSrc = `<!doctype html>
<html lang="{{.Lang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='6' fill='%236a5cff'/%3E%3Cpath d='M8 5.5v13l11-6.5z' fill='none' stroke='%23fff' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<title>{{.Title}}</title>
<link rel="stylesheet" href="/assets/xterm.css">
<style>
:root{--bg:#f4f6fb;--card:#ffffff;--text:#1b2437;--muted:#667085;--border:#e6e9f0;
--accent:#3d7bfd;--accent2:#6a5cff;--chip:#eef2ff;--warn-bg:#fff7e8;--warn-bd:#f0d9a8;--warn-tx:#8a5b00;--shadow:0 10px 30px rgba(23,43,99,.08)}
@media (prefers-color-scheme: dark){:root{--bg:#0e1320;--card:#161d2f;--text:#e6eaf3;--muted:#8b94a9;
--border:#263149;--chip:#1e2a4a;--warn-bg:#2d2410;--warn-bd:#5a4a1e;--warn-tx:#e8c87a;--shadow:0 10px 30px rgba(0,0,0,.35)}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;color:var(--text);overflow:hidden;
background:radial-gradient(1100px 420px at 50% -180px, rgba(106,92,255,.14), transparent 70%), var(--bg);
font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.blob{position:fixed;border-radius:50%;filter:blur(90px);z-index:0;pointer-events:none}
.b1{width:380px;height:380px;background:rgba(106,92,255,.30);top:-90px;right:-70px}
.b2{width:320px;height:320px;background:rgba(61,123,253,.26);bottom:-90px;left:-60px}
/* .wrap 列容器 / 窄屏断点由 termLayoutCSS 注入（P-20261106-9，termlayout.go
   单一事实源，三终端访客页共用） */
.header{flex-shrink:0;display:flex;align-items:center;gap:14px;
background:linear-gradient(135deg,var(--accent),var(--accent2));border-radius:14px;
padding:13px 20px;color:#fff;box-shadow:var(--shadow)}
.header .icon{flex:0 0 auto;width:40px;height:40px;border-radius:10px;background:rgba(255,255,255,.16);
display:flex;align-items:center;justify-content:center}
.header .meta{flex:1;min-width:0}
.header h1{margin:0;font-size:16.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.header .sub{margin-top:2px;font-size:12px;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.badge{flex:0 0 auto;display:inline-flex;align-items:center;gap:7px;background:rgba(255,255,255,.16);
border:1px solid rgba(255,255,255,.4);border-radius:999px;padding:4px 13px;font-size:12px;font-weight:600;
letter-spacing:.4px;font-variant-numeric:tabular-nums}
.banner{flex-shrink:0;margin-top:12px;display:flex;gap:9px;align-items:flex-start;
background:var(--warn-bg);border:1px solid var(--warn-bd);color:var(--warn-tx);
border-radius:10px;padding:9px 14px;font-size:12.5px;line-height:1.55}
.banner svg{flex:0 0 auto;margin-top:2px}
.card{flex:1;min-height:0;display:flex;flex-direction:column;margin-top:12px;
background:var(--card);border:1px solid var(--border);border-radius:14px;
box-shadow:var(--shadow);overflow:hidden}
/* 回放舞台 + 浮层控件条（P-20261106-9 工具栏浮层化）：终端区占满卡片主体，
   播放控件条悬浮于舞台底部（毛玻璃底，不再独占一行把终端挤矮）；播放中指针
   静止即淡出（终端末行不被遮挡），指针移动/触摸/键盘聚焦即现，暂停/播完常显
  （video 播放器同款交互，触屏点按即现）。舞台底部预留控件条高度，终端末行
   可滚出浮层之上 */
.stage{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
.toolbar{position:absolute;left:12px;right:12px;bottom:12px;z-index:5;
display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;
border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow);
background:var(--card);background:color-mix(in srgb,var(--card) 84%,transparent);
-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);
transition:opacity .25s ease,transform .25s ease}
body.controls-idle .toolbar{opacity:0;transform:translateY(8px);pointer-events:none}
.btn{border:1px solid var(--border);background:var(--chip);color:var(--text);
border-radius:8px;padding:4px 11px;font-size:12.5px;cursor:pointer;font:inherit}
.btn:disabled{opacity:.45;cursor:default}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.speeds{display:flex;gap:3px}
.speeds .btn{padding:3px 8px;font-size:12px}
.speeds .btn.on{background:var(--accent);border-color:var(--accent);color:#fff}
input[type=range]{flex:1;min-width:120px;accent-color:var(--accent)}
.clock{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.dl{margin-left:auto;font-size:12px;color:var(--accent);text-decoration:none;white-space:nowrap}
.dl:hover{text-decoration:underline}
.term-box{flex:1;min-height:0;padding:8px 10px;overflow:auto}
/* 舞台内终端区为浮层控件条预留底部空间（双类选择器特异度高于共用窄屏断点的
   .term-box 内边距覆写，预留不被吞；窄屏控件条可能折两行，预留加高） */
.stage .term-box{padding-bottom:64px}
@media (max-width:640px){.stage .term-box{padding-bottom:104px}}
.term-box .xterm{height:100%}
.term-box .xterm-viewport{background:transparent!important}
.chapters{flex-shrink:0;border-top:1px solid var(--border);padding:6px 12px;max-height:150px;overflow-y:auto}
.chapters-head{font-size:11.5px;color:var(--muted);margin-bottom:4px}
.chapter{display:flex;align-items:center;gap:8px;width:100%;border:none;background:transparent;
color:var(--text);font:inherit;font-size:12px;padding:3px 5px;border-radius:5px;cursor:pointer;text-align:left}
.chapter:hover{background:var(--chip)}
.chapter.on{background:var(--chip)}
.chapter .ct{color:var(--muted);font-variant-numeric:tabular-nums;flex-shrink:0}
.chapter .cl{font-family:ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace;
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chapter .ce{margin-left:auto;color:var(--muted);flex-shrink:0}
.chapter .ce.fail{color:#d03050}
.no-chapters{font-size:12px;color:var(--muted)}
.foot-note{flex-shrink:0;display:flex;justify-content:space-between;gap:12px;
padding:8px 6px 2px;color:var(--muted);font-size:11.5px;opacity:.85}
.state{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
color:var(--muted);text-align:center;padding:30px}
.state .big{width:64px;height:64px;border-radius:18px;background:var(--chip);margin-bottom:14px;
display:flex;align-items:center;justify-content:center}
.state h2{margin:0 0 6px;font-size:16px;color:var(--text)}
.state p{margin:0;font-size:12.5px}
.footer{flex-shrink:0;text-align:center;color:var(--muted);font-size:11.5px;margin-top:9px;opacity:.75}
.sc-wm{position:fixed;inset:0;pointer-events:none;z-index:65;
-webkit-user-select:none;user-select:none}
.sc-wm span{position:absolute;font-size:13px;font-weight:600;letter-spacing:.4px;
color:var(--text);opacity:.04;white-space:nowrap;transform:rotate(-24deg)}
.sc-wm .wm-a{top:16%;left:5%}
.sc-wm .wm-b{bottom:16%;right:5%}
{{.BoardCSS}}
{{.LayoutCSS}}
/* 回放主机栅格渲染（P-20261106-9 / P-20261107-4，须在共用布局件之后才能覆盖）：
   终端按录制 cols×rows 精确渲染、字号在产品同款上限内缩放装进舞台（scFitGrid，
   xterm 元素按栅格定宽居中）；列放宽只多留白——流式下限收回 1180，录制更宽才随
   --term-need 放宽；字号到下限仍装不下时舞台内滚动查看（不折行不裁切） */
:root{--col-floor:1180px}
</style>
</head>
<body>
<div class="blob b1"></div><div class="blob b2"></div>
<div id="app" class="wrap">
  <div class="header">
    <div class="icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M10 8.5l6 3.5-6 3.5z" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
    <div class="meta">
      <h1>{{.Title}}</h1>
      <div class="sub" id="sub"></div>
    </div>
    <div class="badge" id="badgeText"></div>
  </div>
  <div class="banner">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <span id="bannerText"></span>
  </div>
  <div class="card">
    <div class="stage" id="stage" style="display:none">
      <div class="term-box" id="termBox"></div>
      <div class="toolbar" id="toolbar" data-testid="cast-toolbar">
        <button class="btn primary" id="playBtn" disabled></button>
        <button class="btn" id="replayBtn" disabled></button>
        <div class="speeds" id="speeds"></div>
        <input type="range" id="seek" min="0" max="1" step="0.1" value="0" disabled>
        <span class="clock" id="clock">0:00 / 0:00</span>
        <a class="dl" id="download" href="#" download> </a>
      </div>
    </div>
    <div class="chapters" id="chapters" style="display:none">
      <div class="chapters-head" id="chaptersHead"></div>
      <div id="chapterList"></div>
    </div>
    <div class="state" id="stateBox"></div>
  </div>
  <div class="foot-note"><span id="roTip"></span><span></span></div>
  <div class="footer" id="powered"></div>
</div>
<script src="/assets/xterm.js"></script>
<script src="/assets/addon-fit.js"></script>
<script src="/assets/addon-unicode11.js"></script>
<script>
const SC = {{.Boot}};
// 终端访客页共用布局件（P-20261106-9 / P-20261107-4，termlayout.go 单一事实源：
// 渲染常量 SC_TERM_*、scTermOptions、scFitGrid 等）
{{.LayoutJS}}
const t = k => (SC.dict[k] || k);
const $ = id => document.getElementById(id);
document.title = t('appTitle');
$('badgeText').textContent = t('loadingTip');
$('bannerText').textContent = t('maskBanner');
$('roTip').textContent = t('readonlyTip');
$('powered').textContent = t('poweredBy');
$('playBtn').textContent = t('play');
$('replayBtn').textContent = t('replay');
$('chaptersHead').textContent = t('chapters');
$('download').textContent = t('downloadCast');
$('download').href = '/s/' + SC.token + '/cast?dl=1';

// 溯源水印（P-20261005-193）：文本服务端下发（空 = 不出层），textContent 防注入
(function mountWatermark(){
  if (!SC.wm) return;
  const box = document.createElement('div');
  box.className = 'sc-wm';
  ['wm-a', 'wm-b'].forEach(k => {
    const s = document.createElement('span');
    s.className = k;
    s.textContent = SC.wm;
    box.appendChild(s);
  });
  document.body.appendChild(box);
})();

// ── xterm 只读实例：disableStdin + 页面无输入通道代码 = 双层只读保证。
// 按 cast header 的录制栅格渲染（忠实实况，不按容器改写列数——与回放器
// CastReplayer 同口径），渲染参数与产品内终端对齐（P-20261107-4，scTermOptions
// 单一出口），字号随舞台缩放装下整格（scFitGrid）──
const dark = matchMedia('(prefers-color-scheme: dark)');
function termTheme(){
  return dark.matches
    ? { background: 'rgba(0,0,0,0)', foreground: '#e6eaf3', cursor: 'transparent' }
    : { background: 'rgba(0,0,0,0)', foreground: '#24292f', cursor: 'transparent' };
}
const term = new Terminal(scTermOptions({ convertEol: false, theme: termTheme() }));
dark.addEventListener('change', () => { term.options.theme = termTheme(); });
scTermUnicode(term);
let termOpened = false;
function openTerm(){
  if (termOpened) return;
  term.open($('termBox'));
  term.onData(() => {}); // 只读保险丝：不存在把输入送回服务端的路径
  termOpened = true;
}
// 录制栅格 + 舞台尺寸驱动的重排（舞台/章节区/窗口任何变化都按栅格重新定字号）
let castCols = 0, castRows = 0;
function castLayout(){ if (termOpened && castCols > 0) scFitGrid(term, $('termBox'), castCols, castRows); }
const relayout = scObserve($('termBox'), castLayout);

function setBadge(text){ $('badgeText').textContent = text; }
function showState(title, desc){
  $('stage').style.display = 'none';
  const box = $('stateBox');
  box.style.display = '';
  box.replaceChildren();
  const big = document.createElement('div');
  big.className = 'big';
  big.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M10 8.5l6 3.5-6 3.5z" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const h = document.createElement('h2'); h.textContent = title;
  const p = document.createElement('p'); p.textContent = desc;
  box.append(big, h, p);
}
function fmtClock(sec){
  const s = Math.max(0, Math.floor(sec));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function b64utf8(b64){
  try {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(u8);
  } catch (e) { return ''; }
}

// ── cast 解析（与 web/src/utils/recording.ts parseCast 同一语义）：
// header 行对象形态；事件行 [t,"o",text]；OSC133 E→C→D 链提取命令章节 ──
const OSC_RE = /\x1b\]133;([A-Za-z])(?:;([^\x07\x1b]*))?\x07/g;
function parseCast(text){
  const out = { header: {}, events: [], chapters: [] };
  const lines = text.split('\n');
  let pending = '';
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] || '').trim();
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch (e) { continue; }
    if (i === 0 && row && typeof row === 'object' && !Array.isArray(row)) {
      out.header = row; continue;
    }
    if (!Array.isArray(row) || row.length < 3) continue;
    if (typeof row[0] !== 'number' || row[1] !== 'o' || typeof row[2] !== 'string') continue;
    const tt = row[0], raw = row[2];
    out.events.push({ t: tt, text: raw });
    OSC_RE.lastIndex = 0;
    let m;
    while ((m = OSC_RE.exec(raw))) {
      if (m[1] === 'E') pending = b64utf8(m[2] || '');
      else if (m[1] === 'C') { out.chapters.push({ t: tt, label: pending || '…' }); pending = ''; }
      else if (m[1] === 'D' && out.chapters.length) {
        const last = out.chapters[out.chapters.length - 1];
        if (last.exit === undefined) last.exit = parseInt((m[2] || '0').split(';')[0] || '0', 10) || 0;
      }
    }
  }
  return out;
}

// ── 播放引擎（100ms tick，倍速乘数；seek 重置屏幕后重放至目标时刻）──
let events = [], chapters = [], duration = 0;
let elapsed = 0, cursor = 0, speed = 1, playing = false, timer = null, activeChapter = -1;
const SPEEDS = [0.5, 1, 2, 4, 8];

function drain(){
  while (cursor < events.length && events[cursor].t <= elapsed) {
    term.write(events[cursor].text);
    cursor++;
  }
  syncChapter();
}
function syncChapter(){
  let idx = -1;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i].t <= elapsed) idx = i; else break;
  }
  if (idx === activeChapter) return;
  activeChapter = idx;
  const rows = $('chapterList').children;
  for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('on', i === idx);
}
function updateClock(){
  $('clock').textContent = fmtClock(elapsed) + ' / ' + fmtClock(duration);
  $('seek').value = String(Math.min(elapsed, Math.max(duration, 0.1)));
}
function setPlaying(on){
  playing = on;
  document.body.dataset.castPlaying = on ? '1' : '0';
  $('playBtn').textContent = on ? t('pause') : t('play');
  if (on) setBadge(t('playingBadge'));
  else if (elapsed < duration) setBadge(t('pausedBadge'));
  // 浮层控件条：播放中进入静止计时，暂停/播完常显
  if (on) wakeControls(); else showControls();
}
// ── 浮层控件条隐现（P-20261106-9）：播放中指针静止 2.5s 淡出，任何指针/触摸/
// 键盘活动即现；悬停或键盘焦点在控件条内时不淡出（拖动进度条/调倍速不被打断）──
let idleTimer = null;
function showControls(){
  clearTimeout(idleTimer);
  idleTimer = null;
  document.body.classList.remove('controls-idle');
}
function wakeControls(){
  showControls();
  if (!playing) return;
  idleTimer = setTimeout(() => {
    const bar = $('toolbar');
    if (playing && !bar.matches(':hover') && !bar.contains(document.activeElement)) {
      document.body.classList.add('controls-idle');
    }
  }, 2500);
}
['pointermove', 'pointerdown', 'keydown', 'touchstart'].forEach((ev) => {
  document.addEventListener(ev, wakeControls, { passive: true });
});
function play(){
  if (playing || duration <= 0) return;
  if (elapsed >= duration) seekTo(0);
  setPlaying(true);
  timer = setInterval(() => {
    elapsed = Math.min(duration, elapsed + 0.1 * speed);
    drain();
    updateClock();
    if (elapsed >= duration) finish();
  }, 100);
}
function pause(){
  if (timer) { clearInterval(timer); timer = null; }
  setPlaying(false);
}
function finish(){
  pause();
  setBadge(t('doneBadge'));
  document.body.dataset.castDone = '1';
}
function seekTo(v){
  if (!termOpened) return;
  term.reset();
  cursor = 0;
  elapsed = Math.max(0, Math.min(v, duration));
  drain();
  updateClock();
}
function toggle(){ if (playing) pause(); else play(); }

function buildChapters(){
  if (!chapters.length) {
    $('chapters').style.display = '';
    const div = document.createElement('div');
    div.className = 'no-chapters';
    div.textContent = t('noChapters');
    $('chapterList').replaceChildren(div);
    return;
  }
  $('chapters').style.display = '';
  const list = $('chapterList');
  list.replaceChildren();
  chapters.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'chapter';
    b.title = c.label;
    const time = document.createElement('span');
    time.className = 'ct'; time.textContent = fmtClock(c.t);
    const label = document.createElement('span');
    label.className = 'cl'; label.textContent = c.label;
    b.append(time, label);
    if (c.exit !== undefined) {
      const ex = document.createElement('span');
      ex.className = 'ce' + (c.exit !== 0 ? ' fail' : '');
      ex.textContent = 'exit ' + c.exit;
      b.append(ex);
    }
    b.addEventListener('click', () => { pause(); seekTo(c.t); play(); });
    list.appendChild(b);
  });
}

function buildSpeeds(){
  const box = $('speeds');
  box.replaceChildren();
  SPEEDS.forEach((s) => {
    const b = document.createElement('button');
    b.className = 'btn' + (s === speed ? ' on' : '');
    b.textContent = s + '×';
    b.addEventListener('click', () => {
      speed = s;
      for (const el of box.children) el.classList.toggle('on', el === b);
    });
    box.appendChild(b);
  });
}

$('playBtn').addEventListener('click', toggle);
$('replayBtn').addEventListener('click', () => { pause(); seekTo(0); play(); });
$('seek').addEventListener('input', (e) => { pause(); seekTo(parseFloat(e.target.value)); });

// ── 加载：一次性取 cast 快照文本（净本），解析后开播；此后无网络活动 ──
(async () => {
  try {
    const res = await fetch('/s/' + SC.token + '/cast');
    if (!res.ok) { showState(t('replayBadge'), t('loadError')); return; }
    const parsed = parseCast(await res.text());
    if (!parsed.events.length) { showState(t('replayBadge'), t('emptyTip')); return; }
    events = parsed.events;
    chapters = parsed.chapters;
    duration = events[events.length - 1].t;
    document.body.dataset.castEvents = String(events.length);
    document.body.dataset.castDuration = String(duration);
    document.body.dataset.castChapters = String(chapters.length);
    const cols = Math.max(2, Math.min(Number(parsed.header.width) || 80, 500));
    const rows = Math.max(2, Math.min(Number(parsed.header.height) || 24, 300));
    // 内容自适应列宽（P-20261106-9）：按 cast 录制宽度定列容器；终端按录制栅格
    // 精确渲染，字号缩放装进舞台（P-20261107-4 scFitGrid，视口够宽即产品字号居中）
    castCols = cols; castRows = rows;
    scTermNeed(cols);
    term.resize(cols, rows);
    $('stateBox').style.display = 'none';
    $('stage').style.display = '';
    // 产品同款字体就绪再 open（xterm 在 open 时测字宽）；字体晚到则重测重排
    await new Promise((resolve) => scFontsReady(resolve, () => { scRemeasure(term); relayout(); }));
    openTerm();
    castLayout();
    $('playBtn').disabled = false;
    $('replayBtn').disabled = false;
    $('seek').disabled = false;
    $('seek').max = String(Math.max(duration, 0.1));
    buildSpeeds();
    buildChapters();
    setBadge(t('replayBadge'));
    $('sub').textContent = t('readonlyTip');
    document.body.dataset.castReady = '1';
    updateClock();
    if (duration <= 0) { drain(); finish(); } else { play(); }
  } catch (e) {
    showState(t('replayBadge'), t('loadError'));
  }
})();

// 访客留言板（P-20261006-13）：页底留言区（四形态访客页同一段脚本，
// 单一事实源 guestboard.go；回放只读，留言是另一条带防线的回流面）
{{.BoardJS}}
</script>
</body>
</html>`

var castPageTmpl = template.Must(template.New("castreplay").Parse(castPageTmplSrc))

// renderCastPage 输出会话回放访客页（已知 token；调用方已做 lookup）。
// wm 为溯源水印文本（P-20261005-193，空串 = 未开水印）
func renderCastPage(w io.Writer, token, lang, title, wm string) error {
	boot, err := json.Marshal(castBootState{Token: token, Lang: lang, Dict: castDictFor(lang), Wm: wm})
	if err != nil {
		return err
	}
	return castPageTmpl.Execute(w, castPageData{
		Lang:      lang,
		Title:     "Codecombo " + title,
		Boot:      template.JS(boot),
		BoardCSS:  template.CSS(guestBoardCSS),
		BoardJS:   template.JS(guestBoardJS),
		LayoutCSS: template.CSS(termLayoutCSS),
		LayoutJS:  template.JS(termLayoutJS),
	})
}
