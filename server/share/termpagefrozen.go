package share

import (
	"encoding/json"
	"html/template"
	"io"
)

// 终端输出时点冻结快照访客页（P-20261005-205）：直播访客页（termpage.go）
// 的定格变体——同一套零外部依赖单文件形态 + vendored xterm 三件 + 遮蔽
// 声明横幅 + 严格只读三层保证；差异只在数据面：无 SSE 接线，页面加载时
// 一次性取 /raw（快照落盘前已完成遮蔽净化，快照本体即净本——未过滤记录
// P-20261106-9 例外：快照为原样输出，横幅位换「未过滤」警示）写入 xterm
// 定格 buffer，此后不再有任何网络活动。快照与源会话生命周期解耦：会话
// 关闭/进程重启都不影响本页（内容读自服务端快照文件，独立 TTL 管理）。

type termFrozenBootState struct {
	Token string            `json:"token"`
	Lang  string            `json:"lang"`
	Dict  map[string]string `json:"dict"`
	// Wm 溯源水印文本（P-20261005-193；空串 = 记录未开水印，页面不出水印层）
	Wm string `json:"wm,omitempty"`
	// MsgMax 留言板上限（协作通道 2000 / 缺省 500，P-20261024-1 boardMsgMax
	// 同源下发——本页无协作位（v1 只挂终端直播页），留言升档生效）
	MsgMax int `json:"msgMax,omitempty"`
	// Unfiltered 未过滤标记（P-20261106-9）：true = 快照创建时关闭了遮蔽（含
	// 原文、TTL 强制 24h），横幅位换「未过滤」警示。缺省省略 = 已遮蔽净本
	Unfiltered bool `json:"unfiltered,omitempty"`
}

var termFrozenDictZh = map[string]string{
	"appTitle":         "终端输出快照",
	"frozenBadge":      "快照",
	"loadingTip":       "快照加载中…",
	"maskBanner":       "这是创建时刻的输出定格快照，不会随会话更新。输出已经敏感值遮蔽（sc 令牌 / password 赋值 / 云密钥 key → ***）。遮蔽靠模式启发式，非绝对。",
	"unfilteredBanner": "这是创建时刻的输出定格快照，不会随会话更新。未过滤：分享者已关闭敏感值遮蔽，快照为原样输出（可能含令牌 / 密码 / 密钥等敏感信息），链接 24 小时内失效。请勿转发本链接。",
	"frozenTip":        "本页是定格快照：内容固定于创建时刻，无实时推流、无任何输入通道",
	"loadError":        "快照读取失败，链接可能已被撤销或过期",
	"emptyTip":         "快照为空（创建时刻会话暂无输出）",
	"poweredBy":        "由 Codecombo 提供",
	// 访客留言板（P-20261006-13）：页底留言区文案（三形态访客页同表）
	"gbTitle":   "留言",
	"gbNick":    "昵称（可选）",
	"gbPh":      "写下你的问题或反馈（≤500 字）…",
	"gbSend":    "发送",
	"gbSending": "发送中…",
	"gbSent":    "已收到你的留言，分享者可在管理面板看到",
	"gbEmpty":   "还没有留言",
	"gbAnon":    "匿名访客",
	"gbTooLong": "留言超过 500 字上限",
	"gbLimited": "发送太频繁，请稍后再试",
	"gbFailed":  "发送失败，请重试",
}

var termFrozenDictEn = map[string]string{
	"appTitle":         "Terminal Snapshot",
	"frozenBadge":      "SNAPSHOT",
	"loadingTip":       "Loading snapshot…",
	"maskBanner":       "This is a snapshot of the output frozen at creation time; it does not update with the session. Output is masked for sensitive values (sc tokens / password assignments / cloud keys → ***). Masking is heuristic, not absolute.",
	"unfilteredBanner": "This is a snapshot of the output frozen at creation time; it does not update with the session. Unfiltered: the sharer turned off sensitive-value masking — the snapshot is verbatim output and may contain tokens, passwords or keys; the link expires within 24 hours. Do not forward this link.",
	"frozenTip":        "This page is a frozen snapshot: fixed at creation time, no live stream, no input channel",
	"loadError":        "Failed to load the snapshot; the link may have been revoked or expired",
	"emptyTip":         "Snapshot is empty (the session had no output at creation time)",
	"poweredBy":        "Powered by Codecombo",
	// 访客留言板（P-20261006-13）：页底留言区文案（三形态访客页同表）
	"gbTitle":   "Messages",
	"gbNick":    "Nickname (optional)",
	"gbPh":      "Leave a question or feedback (≤500 chars)…",
	"gbSend":    "Send",
	"gbSending": "Sending…",
	"gbSent":    "Your message was received — the owner will see it in the share manager.",
	"gbEmpty":   "No messages yet",
	"gbAnon":    "Anonymous",
	"gbTooLong": "Message exceeds the 500-character limit",
	"gbLimited": "Too many messages, please try again later.",
	"gbFailed":  "Failed to send, try again",
}

func termFrozenDictFor(lang string) map[string]string {
	if lang == "zh" {
		return termFrozenDictZh
	}
	return termFrozenDictEn
}

type termFrozenPageData struct {
	Lang  string
	Title string
	Boot  template.JS
	// BoardCSS/BoardJS 访客留言区共享资产（P-20261006-13，guestboard.go
	// 单一事实源——三形态访客页同一段脚本挂载）
	BoardCSS template.CSS
	BoardJS  template.JS
	// LayoutCSS/LayoutJS 终端访客页共用布局件（P-20261106-9，termlayout.go）
	LayoutCSS template.CSS
	LayoutJS  template.JS
	// Unfiltered 未过滤标记（P-20261106-9）：横幅位服务端直出 .unfiltered 类
	Unfiltered bool
}

// 模板与 termpage.go 同族（头/横幅/卡片/主题化样式逐段对齐），差异：
// 徽标静态无呼吸点（定格非直播）、无 EventSource 接线、foot-note 换定格
// 说明。改动两端共有样式时须双侧同步（无共享模板的取舍：单文件页各自
// 自包含是本服务的零依赖契约，抽共享模板会让任一页的差异化演进变扭）
const termFrozenPageTmplSrc = `<!doctype html>
<html lang="{{.Lang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='6' fill='%236a5cff'/%3E%3Cpath d='M4.5 16.5c-1.5 1.5-2 5-2 5s3.5-.5 5-2c.8-.8.8-2.2 0-3-.8-.8-2.2-.8-3 0z' fill='none' stroke='%23fff' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M12 15l-3-3c.5-1.3 1.2-2.6 2-4 3.4-5.9 8.5-8 11-7 .9 2.5-1 7.5-7 11-.9.5-2 1.2-3 2z' fill='none' stroke='%23fff' stroke-width='1.8' stroke-linecap='round'/%3E%3Cpath d='M9 12H4s.5-3.4 2-4.5c1.7-1.2 5 0 5 0' fill='none' stroke='%23fff' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
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
/* .wrap 列容器 / 未过滤横幅 / 窄屏断点由 termLayoutCSS 注入（P-20261106-9，
   termlayout.go 单一事实源，三终端访客页共用） */
.header{flex-shrink:0;display:flex;align-items:center;gap:14px;
background:linear-gradient(135deg,var(--accent),var(--accent2));border-radius:14px;
padding:13px 20px;color:#fff;box-shadow:var(--shadow)}
.header .icon{flex:0 0 auto;width:40px;height:40px;border-radius:10px;background:rgba(255,255,255,.16);
display:flex;align-items:center;justify-content:center}
.header .meta{flex:1;min-width:0}
.header h1{margin:0;font-size:16.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.header .sub{margin-top:2px;font-size:12px;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 「快照」徽标：静态相机/定格语义，无呼吸点（与直播徽标的动态感刻意区分） */
.badge{flex:0 0 auto;display:inline-flex;align-items:center;gap:7px;background:rgba(255,255,255,.16);
border:1px solid rgba(255,255,255,.4);border-radius:999px;padding:4px 13px;font-size:12px;font-weight:600;
letter-spacing:.4px}
.banner{flex-shrink:0;margin-top:12px;display:flex;gap:9px;align-items:flex-start;
background:var(--warn-bg);border:1px solid var(--warn-bd);color:var(--warn-tx);
border-radius:10px;padding:9px 14px;font-size:12.5px;line-height:1.55}
.banner svg{flex:0 0 auto;margin-top:2px}
.card{flex:1;min-height:0;display:flex;flex-direction:column;margin-top:12px;
background:var(--card);border:1px solid var(--border);border-radius:14px;
box-shadow:var(--shadow);overflow:hidden}
.term-box{flex:1;min-height:0;padding:8px 10px}
.term-box .xterm{height:100%}
.term-box .xterm-viewport{background:transparent!important}
.foot-note{flex-shrink:0;display:flex;justify-content:space-between;gap:12px;
padding:8px 6px 2px;color:var(--muted);font-size:11.5px;opacity:.85}
.state{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
color:var(--muted);text-align:center;padding:30px}
.state .big{width:64px;height:64px;border-radius:18px;background:var(--chip);margin-bottom:14px;
display:flex;align-items:center;justify-content:center}
.state h2{margin:0 0 6px;font-size:16px;color:var(--text)}
.state p{margin:0;font-size:12.5px}
.footer{flex-shrink:0;text-align:center;color:var(--muted);font-size:11.5px;margin-top:9px;opacity:.75}
/* 溯源水印（P-20261005-193）：与直播页/文件分享页同款对角双标低透明（4%）
   ——DOM 在页内自实现（单文件页零依赖契约，文案构造 share.WatermarkLabel
   服务端共享），样式三页逐段对齐，改动任一端须同步 */
.sc-wm{position:fixed;inset:0;pointer-events:none;z-index:65;
-webkit-user-select:none;user-select:none}
.sc-wm span{position:absolute;font-size:13px;font-weight:600;letter-spacing:.4px;
color:var(--text);opacity:.04;white-space:nowrap;transform:rotate(-24deg)}
.sc-wm .wm-a{top:16%;left:5%}
.sc-wm .wm-b{bottom:16%;right:5%}
{{.BoardCSS}}
{{.LayoutCSS}}
</style>
</head>
<body>
<div class="blob b1"></div><div class="blob b2"></div>
<div id="app" class="wrap">
  <div class="header">
    <div class="icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12.5 15H17" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
    <div class="meta">
      <h1>{{.Title}}</h1>
      <div class="sub" id="sub"></div>
    </div>
    <div class="badge" id="badge" data-state="loading"><span id="badgeText"></span></div>
  </div>
  <div class="banner{{if .Unfiltered}} unfiltered{{end}}" id="maskBanner" data-testid="share-mask-banner">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <span id="bannerText"></span>
  </div>
  <div class="card">
    <div class="term-box" id="termBox" style="display:none"></div>
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
// 渲染常量 SC_TERM_*、scTermOptions、scTermNeed/scTextCols 等）
{{.LayoutJS}}
const t = k => (SC.dict[k] || k);
const $ = id => document.getElementById(id);
document.title = t('appTitle');
$('badgeText').textContent = t('loadingTip');
// 横幅位：遮蔽声明 / 未过滤警示二选一（P-20261106-9，记录配置随 boot 下发）
$('bannerText').textContent = t(SC.unfiltered ? 'unfilteredBanner' : 'maskBanner');
$('roTip').textContent = t('frozenTip');
$('powered').textContent = t('poweredBy');

// 溯源水印（P-20261005-193）：与直播页同款（文本服务端下发，空 = 不出层，
// textContent 写入防注入）
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

// ── xterm 只读实例：与直播页同款禁输入配置与产品对齐渲染参数（P-20261107-4，
// scTermOptions 单一出口）；convertEol 开启——快照是剥离 ANSI 后的净化文本
// （裸 \n），非 PTY 原始字节流。定格文本无光标定位语义，栅格按容器 fit 软折行
// （与直播/回放的主机栅格模式刻意不同）──
const dark = matchMedia('(prefers-color-scheme: dark)');
const term = new Terminal(scTermOptions({ convertEol: true, theme: termTheme() }));
function termTheme(){
  return dark.matches
    ? { background: 'rgba(0,0,0,0)', foreground: '#e6eaf3', cursor: 'transparent' }
    : { background: 'rgba(0,0,0,0)', foreground: '#24292f', cursor: 'transparent' }
}
dark.addEventListener('change', () => { term.options.theme = termTheme(); });
scTermUnicode(term);
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
// 只读保险丝（直播页同款）：页面不存在任何把输入发回服务端的代码路径。
// open 放到定格内容就绪后（容器先处于隐藏态铺加载卡，隐藏容器上 open
// 的渲染器尺寸不成立，显示后不重开只 fit）；重排由终端容器尺寸驱动
function doFit(){ try { if (term.element) fit.fit(); } catch (e) { /* 容器未布局完成时忽略 */ } }
const relayout = scObserve($('termBox'), doFit);

function setBadge(text){ $('badgeText').textContent = text; }
function showState(title, desc){
  $('termBox').style.display = 'none';
  const box = $('stateBox');
  box.style.display = '';
  box.replaceChildren();
  const big = document.createElement('div');
  big.className = 'big';
  big.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12.5 15H17" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const h = document.createElement('h2'); h.textContent = title;
  const p = document.createElement('p'); p.textContent = desc;
  box.append(big, h, p);
}

// ── 定格加载：一次性取快照净本（/raw = 快照单文件，服务端 text/plain）
// 写入 xterm 后本页再无任何网络活动（无 SSE/轮询/遥测）──
(async () => {
  try {
    const res = await fetch('/s/' + SC.token + '/raw');
    if (!res.ok) { setBadge(t('frozenBadge')); showState(t('frozenBadge'), t('loadError')); return; }
    const text = await res.text();
    if (!text) { setBadge(t('frozenBadge')); showState(t('frozenBadge'), t('emptyTip')); return; }
    // 内容自适应列宽（P-20261106-9）：按快照行宽 p95 定列容器宽度，再 open/fit
    //（定格文本无主机尺寸元数据，行宽即内容所需）
    scTermNeed(scTextCols(text));
    $('stateBox').style.display = 'none';
    $('termBox').style.display = '';
    // 产品同款字体就绪再 open（xterm 在 open 时测字宽）；字体晚到则重测重排
    scFontsReady(() => {
      term.open($('termBox'));
      term.onData(() => {});
      term.write(text);
      setBadge(t('frozenBadge'));
      $('sub').textContent = t('frozenTip');
      doFit();
    }, () => { scRemeasure(term); relayout(); });
  } catch (e) {
    setBadge(t('frozenBadge'));
    showState(t('frozenBadge'), t('loadError'));
  }
})();

// 访客留言板（P-20261006-13）：页底留言区（三形态访客页同一段脚本，
// 单一事实源 guestboard.go；定格的是输出流，留言是另一条带防线的回流面）
{{.BoardJS}}
</script>
</body>
</html>`

var termFrozenPageTmpl = template.Must(template.New("termfrozen").Parse(termFrozenPageTmplSrc))

// renderTermFrozenPage 输出终端输出冻结快照访客页（已知 token；调用方已做
// lookup）。wm 为溯源水印文本（P-20261005-193，空串 = 未开水印）。collab 为
// 记录上的协作开关（P-20261024-1，仅影响留言上限档位——本页无协作位）。
// unfiltered 为记录的未过滤标记（P-20261106-9）——横幅位换「未过滤」警示
func renderTermFrozenPage(w io.Writer, token, lang, title, wm string, collab, unfiltered bool) error {
	boot, err := json.Marshal(termFrozenBootState{Token: token, Lang: lang, Dict: termFrozenDictFor(lang), Wm: wm,
		MsgMax: boardMsgMax(collab), Unfiltered: unfiltered})
	if err != nil {
		return err
	}
	return termFrozenPageTmpl.Execute(w, termFrozenPageData{
		Lang:       lang,
		Title:      "Codecombo " + title,
		Boot:       template.JS(boot),
		BoardCSS:   template.CSS(guestBoardCSS),
		BoardJS:    template.JS(guestBoardJS),
		LayoutCSS:  template.CSS(termLayoutCSS),
		LayoutJS:   template.JS(termLayoutJS),
		Unfiltered: unfiltered,
	})
}
