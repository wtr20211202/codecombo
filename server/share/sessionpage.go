package share

import (
	"encoding/json"
	"html/template"
	"io"
)

// 会话回放访客页（P-20261003-77）：与 cast/term 访客页同族的零外部依赖单
// 文件页——内容经 /s/{token}/session 一次性取回（创建时的净本快照：P-108
// 敏感值已在服务端遮蔽，访客面无二次处理也无「显示原文」出口），页内按
// 时间正序渲染 user/assistant/thinking/tool/result 条目。思考块与工具详情
// 按提案口径对访客全量可见（工具输入/结果摘要是解析层的既有紧凑口径）。
//
// 严格只读：服务端无分享内容写入端点（/gate 口令验证、/view 一次性确认、
// /messages 访客留言均不写分享内容，其余 POST 到 /s/* 405），页面
// 不存在把输入送回服务端的代码路径。数据面是静态快照：无 SSE/轮询，加载
// 完成后不再有任何网络活动。快照与源会话生命周期解耦：会话继续写或被删除
// 都不影响本页（内容读自 SnapshotsRoot 隔离区，独立 TTL 管理）。
//
// 与 cast 页的分工：cast 是 xterm 时序回放（终端字节流），本页是结构化
// 时间线（对话语义），故不引入 xterm/播放引擎——纯 DOM 列表即可，长会话
// 由浏览器原生滚动承载（条目文本服务端已按解析层上限截断，DOM 规模有界）。

type sessionBootState struct {
	Token string            `json:"token"`
	Lang  string            `json:"lang"`
	Dict  map[string]string `json:"dict"`
	// Wm 溯源水印文本（P-20261005-193；空串 = 记录未开水印，页面不出水印层）
	Wm string `json:"wm,omitempty"`
}

var sessionDictZh = map[string]string{
	"appTitle":      "会话回放",
	"loadingTip":    "回放加载中…",
	"maskBanner":    "本页为分享创建时刻的会话快照，已做敏感值遮蔽（sc 令牌 / password 赋值 / 云密钥 → ***）。遮蔽靠模式启发式，非绝对；思考块与工具详情对访客可见。",
	"readonlyTip":   "只读回放：无输入通道、无实时更新",
	"loadError":     "回放读取失败，链接可能已被撤销、过期或快照已清理",
	"emptyTip":      "该会话窗口内没有可回放的步骤",
	"truncated":     "会话过长，仅包含最近一段（与登录态回放窗口一致），更早内容未包含在本次分享中",
	"kindUser":      "用户",
	"kindAssistant": "助手",
	"kindThinking":  "思考",
	"kindTool":      "工具",
	"kindResult":    "结果",
	"resultFail":    "失败",
	"stepsLine":     "{n} 个步骤",
	"thinkingLine":  "{n} 条思考",
	"poweredBy":     "由 Codecombo 提供",
	"gbTitle":       "留言",
	"gbNick":        "昵称（可选）",
	"gbPh":          "写下你的问题或反馈（≤500 字）…",
	"gbSend":        "发送",
	"gbSending":     "发送中…",
	"gbSent":        "已收到你的留言，分享者可在管理面板看到",
	"gbEmpty":       "还没有留言",
	"gbAnon":        "匿名访客",
	"gbTooLong":     "留言超过 500 字上限",
	"gbLimited":     "发送太频繁，请稍后再试",
	"gbFailed":      "发送失败，请重试",
}

var sessionDictEn = map[string]string{
	"appTitle":      "Session Replay",
	"loadingTip":    "Loading replay…",
	"maskBanner":    "This is a snapshot of the session taken when the link was created, masked for sensitive values (sc tokens / password assignments / cloud keys → ***). Masking is heuristic, not absolute. Thinking blocks and tool details are visible to visitors.",
	"readonlyTip":   "Read-only replay: no input channel and no live updates",
	"loadError":     "Failed to load the replay; the link may have been revoked, expired, or its snapshot cleaned up",
	"emptyTip":      "This session window has no replayable steps",
	"truncated":     "This session is long; only the most recent segment (the same window as the in-app replay) is included in this share",
	"kindUser":      "User",
	"kindAssistant": "Assistant",
	"kindThinking":  "Thinking",
	"kindTool":      "Tool",
	"kindResult":    "Result",
	"resultFail":    "Failed",
	"stepsLine":     "{n} steps",
	"thinkingLine":  "{n} thinking blocks",
	"poweredBy":     "Powered by Codecombo",
	"gbTitle":       "Messages",
	"gbNick":        "Nickname (optional)",
	"gbPh":          "Leave a question or feedback (≤500 chars)…",
	"gbSend":        "Send",
	"gbSending":     "Sending…",
	"gbSent":        "Your message was received — the owner will see it in the share manager.",
	"gbEmpty":       "No messages yet",
	"gbAnon":        "Anonymous",
	"gbTooLong":     "Message exceeds the 500-character limit",
	"gbLimited":     "Too many messages, please try again later.",
	"gbFailed":      "Failed to send, try again",
}

func sessionDictFor(lang string) map[string]string {
	if lang == "zh" {
		return sessionDictZh
	}
	return sessionDictEn
}

type sessionPageData struct {
	Lang     string
	Title    string
	Boot     template.JS
	BoardCSS template.CSS
	BoardJS  template.JS
}

// 模板与 castpage.go/termpage.go 同族（头/横幅/卡片/主题化样式对齐）。单文件
// 自包含是本服务的零依赖契约（不引用前端 bundle）；与三访客页共有样式近似
// 但不抽共享模板——各页数据面差异大，共享会让任一页演进变扭（castpage 同注）
const sessionPageTmplSrc = `<!doctype html>
<html lang="{{.Lang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='6' fill='%236a5cff'/%3E%3Cpath d='M7 7h10M7 12h10M7 17h6' stroke='%23fff' stroke-width='1.8' stroke-linecap='round'/%3E%3C/svg%3E">
<title>{{.Title}}</title>
<style>
:root{--bg:#f4f6fb;--card:#ffffff;--text:#1b2437;--muted:#667085;--border:#e6e9f0;
--accent:#3d7bfd;--accent2:#6a5cff;--chip:#eef2ff;--warn-bg:#fff7e8;--warn-bd:#f0d9a8;--warn-tx:#8a5b00;
--think-bg:#f7f4ff;--think-bd:#ddd2ff;--tool-bg:#f5f8ff;--tool-bd:#cfe0ff;--fail:#c03050;--shadow:0 10px 30px rgba(23,43,99,.08)}
@media (prefers-color-scheme: dark){:root{--bg:#0e1320;--card:#161d2f;--text:#e6eaf3;--muted:#8b94a9;
--border:#263149;--chip:#1e2a4a;--warn-bg:#2d2410;--warn-bd:#5a4a1e;--warn-tx:#e8c87a;
--think-bg:#201a33;--think-bd:#3b3060;--tool-bg:#141d31;--tool-bd:#27406b;--fail:#ff6b81;--shadow:0 10px 30px rgba(0,0,0,.35)}}
*{box-sizing:border-box}
html,body{min-height:100%}
body{margin:0;color:var(--text);overflow:hidden;
background:radial-gradient(1100px 420px at 50% -180px, rgba(106,92,255,.14), transparent 70%), var(--bg);
font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.blob{position:fixed;border-radius:50%;filter:blur(90px);z-index:0;pointer-events:none}
.b1{width:380px;height:380px;background:rgba(106,92,255,.30);top:-90px;right:-70px}
.b2{width:320px;height:320px;background:rgba(61,123,253,.26);bottom:-90px;left:-60px}
.wrap{position:relative;z-index:1;height:100vh;max-width:1040px;margin:0 auto;padding:22px 22px 10px;
display:flex;flex-direction:column}
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
.trunc{flex-shrink:0;margin-top:8px;border:1px dashed var(--border);border-radius:9px;padding:7px 12px;
font-size:12px;color:var(--muted);display:none}
.card{flex:1;min-height:0;display:flex;flex-direction:column;margin-top:12px;
background:var(--card);border:1px solid var(--border);border-radius:14px;
box-shadow:var(--shadow);overflow:hidden}
.list{flex:1;min-height:0;overflow-y:auto;padding:10px 16px 18px}
.step{display:flex;gap:12px;padding:9px 0;border-bottom:1px solid var(--border)}
.step:last-child{border-bottom:none}
.rail{flex:0 0 auto;width:9px;display:flex;justify-content:center;padding-top:7px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--muted);flex:0 0 auto}
.step[data-kind="user"] .dot{background:#3d7bfd}
.step[data-kind="assistant"] .dot{background:#6a5cff}
.step[data-kind="thinking"] .dot{background:#9b7bff}
.step[data-kind="tool"] .dot{background:#14a38b}
.step[data-kind="result"] .dot{background:#7a8699}
.step[data-kind="result"].is-error .dot{background:var(--fail)}
.body{flex:1;min-width:0}
.meta{display:flex;align-items:center;gap:8px;margin-bottom:3px}
.kind{font-size:11px;font-weight:600;letter-spacing:.3px;color:var(--muted);text-transform:uppercase}
.time{font-size:11.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.tool-name{font-size:12px;font-weight:600;color:var(--accent)}
.text,.input{white-space:pre-wrap;word-break:break-word;margin:0;font:inherit}
.text{font-size:13.5px}
.think{border-left:3px solid var(--think-bd);background:var(--think-bg);border-radius:0 8px 8px 0;
padding:7px 11px;color:var(--text);opacity:.92;font-size:13px}
.tool-box{background:var(--tool-bg);border:1px solid var(--tool-bd);border-radius:8px;padding:7px 10px;margin-top:4px}
.input{font-family:ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace;font-size:12px;line-height:1.5}
.result-box{border:1px solid var(--border);border-radius:8px;padding:7px 10px;margin-top:4px;color:var(--muted);font-size:12.5px}
.result-box.is-error{border-color:var(--fail);color:var(--fail)}
.fail-tag{font-size:10.5px;font-weight:700;color:var(--fail);letter-spacing:.3px}
.state{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
color:var(--muted);text-align:center;padding:30px}
.state .big{width:64px;height:64px;border-radius:18px;background:var(--chip);margin-bottom:14px;
display:flex;align-items:center;justify-content:center}
.state h2{margin:0 0 6px;font-size:16px;color:var(--text)}
.state p{margin:0;font-size:12.5px}
.foot-note{flex-shrink:0;display:flex;justify-content:space-between;gap:12px;
padding:8px 6px 2px;color:var(--muted);font-size:11.5px;opacity:.85}
.footer{flex-shrink:0;text-align:center;color:var(--muted);font-size:11.5px;margin-top:9px;opacity:.75}
.sc-wm{position:fixed;inset:0;pointer-events:none;z-index:65;
-webkit-user-select:none;user-select:none}
.sc-wm span{position:absolute;font-size:13px;font-weight:600;letter-spacing:.4px;
color:var(--text);opacity:.04;white-space:nowrap;transform:rotate(-24deg)}
.sc-wm .wm-a{top:16%;left:5%}
.sc-wm .wm-b{bottom:16%;right:5%}
{{.BoardCSS}}
</style>
</head>
<body>
<div class="blob b1"></div><div class="blob b2"></div>
<div id="app" class="wrap">
  <div class="header">
    <div class="icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8"><path d="M4 6h16M4 12h16M4 18h10" stroke-linecap="round"/></svg></div>
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
  <div class="trunc" id="truncText"></div>
  <div class="card">
    <div class="list" id="list" style="display:none"></div>
    <div class="state" id="stateBox"></div>
  </div>
  <div class="foot-note"><span id="roTip"></span><span></span></div>
  <div class="footer" id="powered"></div>
</div>
<script>
const SC = {{.Boot}};
const t = k => (SC.dict[k] || k);
const $ = id => document.getElementById(id);
document.title = t('appTitle');
$('bannerText').textContent = t('maskBanner');
$('roTip').textContent = t('readonlyTip');
$('powered').textContent = t('poweredBy');
$('badgeText').textContent = t('loadingTip');

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

function setBadge(text){ $('badgeText').textContent = text; }
function showState(title, desc){
  $('list').style.display = 'none';
  const box = $('stateBox');
  box.style.display = '';
  box.replaceChildren();
  const big = document.createElement('div');
  big.className = 'big';
  big.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h16M4 12h16M4 18h10" stroke-linecap="round"/></svg>';
  const h = document.createElement('h2'); h.textContent = title;
  const p = document.createElement('p'); p.textContent = desc;
  box.append(big, h, p);
}
function fmtTime(at){
  const d = new Date(at);
  if (!at || Number.isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
const KIND_LABEL = { user: 'kindUser', assistant: 'kindAssistant', thinking: 'kindThinking', tool: 'kindTool', result: 'kindResult' };

function buildStep(e){
  const step = document.createElement('article');
  step.className = 'step' + (e.kind === 'result' && e.status === 'error' ? ' is-error' : '');
  step.setAttribute('data-kind', e.kind || '');
  step.setAttribute('data-test', 'session-step');
  const rail = document.createElement('div'); rail.className = 'rail';
  const dot = document.createElement('span'); dot.className = 'dot';
  rail.appendChild(dot);
  const body = document.createElement('div'); body.className = 'body';
  const meta = document.createElement('div'); meta.className = 'meta';
  const kind = document.createElement('span'); kind.className = 'kind';
  kind.textContent = t(KIND_LABEL[e.kind] || 'kindResult');
  meta.appendChild(kind);
  const time = fmtTime(e.at);
  if (time) {
    const ts = document.createElement('span'); ts.className = 'time';
    ts.textContent = time; ts.title = e.at;
    meta.appendChild(ts);
  }
  if (e.kind === 'result' && e.status === 'error') {
    const ft = document.createElement('span'); ft.className = 'fail-tag';
    ft.textContent = t('resultFail'); meta.appendChild(ft);
  }
  body.appendChild(meta);

  if (e.kind === 'thinking') {
    const box = document.createElement('div'); box.className = 'think';
    const p = document.createElement('p'); p.className = 'text'; p.textContent = e.text || '';
    box.appendChild(p);
    body.appendChild(box);
  } else if (e.kind === 'tool') {
    const name = document.createElement('div'); name.className = 'tool-name';
    name.textContent = e.tool || t('kindTool');
    body.appendChild(name);
    if (e.input) {
      const box = document.createElement('div'); box.className = 'tool-box';
      const pre = document.createElement('pre'); pre.className = 'input'; pre.textContent = e.input;
      box.appendChild(pre);
      body.appendChild(box);
    }
  } else if (e.kind === 'result') {
    const box = document.createElement('div');
    box.className = 'result-box' + (e.status === 'error' ? ' is-error' : '');
    const p = document.createElement('p'); p.className = 'text'; p.textContent = e.text || '';
    box.appendChild(p);
    body.appendChild(box);
  } else {
    const p = document.createElement('p'); p.className = 'text'; p.textContent = e.text || '';
    body.appendChild(p);
  }
  step.append(rail, body);
  return step;
}

(async () => {
  try {
    const res = await fetch('/s/' + SC.token + '/session');
    if (!res.ok) { showState(t('appTitle'), t('loadError')); return; }
    const snap = await res.json();
    const entries = Array.isArray(snap.entries) ? snap.entries : [];
    if (!entries.length) { showState(t('appTitle'), t('emptyTip')); return; }
    const list = $('list');
    const frag = document.createDocumentFragment();
    entries.forEach(e => frag.appendChild(buildStep(e)));
    list.replaceChildren(frag);
    $('stateBox').style.display = 'none';
    list.style.display = '';
    const thinking = entries.filter(e => e.kind === 'thinking').length;
    $('sub').textContent = t('stepsLine').replace('{n}', String(entries.length)) +
      (thinking ? ' · ' + t('thinkingLine').replace('{n}', String(thinking)) : '');
    if (snap.truncated) {
      const tr = $('truncText');
      tr.style.display = '';
      tr.textContent = t('truncated');
    }
    document.body.dataset.sessionReady = '1';
    document.body.dataset.sessionEntries = String(entries.length);
    document.body.dataset.sessionThinking = String(thinking);
    if (snap.truncated) document.body.dataset.sessionTruncated = '1';
    setBadge(t('appTitle'));
  } catch (e) {
    showState(t('appTitle'), t('loadError'));
  }
})();

// 访客留言板（P-20261006-13）：页底留言区（四形态访客页同一段脚本，
// 单一事实源 guestboard.go；回放只读，留言是另一条带防线的回流面）
{{.BoardJS}}
</script>
</body>
</html>`

var sessionPageTmpl = template.Must(template.New("sessionreplay").Parse(sessionPageTmplSrc))

// renderSessionPage 输出会话回放访客页（已知 token；调用方已做 lookup）。
// wm 为溯源水印文本（P-20261005-193，空串 = 未开水印）
func renderSessionPage(w io.Writer, token, lang, title, wm string) error {
	boot, err := json.Marshal(sessionBootState{Token: token, Lang: lang, Dict: sessionDictFor(lang), Wm: wm})
	if err != nil {
		return err
	}
	return sessionPageTmpl.Execute(w, sessionPageData{
		Lang:     lang,
		Title:    "Codecombo " + title,
		Boot:     template.JS(boot),
		BoardCSS: template.CSS(guestBoardCSS),
		BoardJS:  template.JS(guestBoardJS),
	})
}
