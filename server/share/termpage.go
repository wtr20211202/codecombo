package share

import (
	"encoding/json"
	"html/template"
	"io"
)

// 终端只读直播访客页（P-20261003-306）：与文件分享页同族的零外部依赖单文件
// 页——xterm.js / addon-fit / xterm.css 从本服务 /assets/ 同源加载（vendored，
// 见 assets/README.md），字节流经 SSE /s/{token}/stream 只读推送。
//
// 严格只读的三层保证：xterm disableStdin 关键盘输入；页面不挂 onData——
// 不存在把访客按键送回终端的通道；协作通道（P-20261024-1）开放的是独立
// 守卫端点（素材上行 /drop 与直通输入 /direct/*，各有开关门禁/频控/审计
// 防线），不是把访客按键接进终端流——未开协作的分享仍无任何写端点。
// 遮蔽声明横幅按提案要求显著呈现（启发式非绝对的诚实警示）。

type termBootState struct {
	Token string            `json:"token"`
	Lang  string            `json:"lang"`
	Dict  map[string]string `json:"dict"`
	// Wm 溯源水印文本（P-20261005-193；空串 = 记录未开水印，页面不出水印层）
	Wm string `json:"wm,omitempty"`
	// Collab 协作通道开关（P-20261024-1）：true = 页面挂载素材上行位
	//（粘贴/拖入/点击三入口）。缺省 false = 页面无任何协作位（存量语义）
	Collab bool `json:"collab,omitempty"`
	// DirectInput 直通输入档开关（P-20261024-1 第二档独立开关，与 Collab
	// 互不联动）：true = 页面挂载直通输入位（申请-批准握手 UI）
	DirectInput bool `json:"directInput,omitempty"`
	// MsgMax 留言板上限（协作通道 2000 / 缺省 500，boardMsgMax 同源下发）
	MsgMax int `json:"msgMax,omitempty"`
}

var termDictZh = map[string]string{
	"appTitle":     "终端直播",
	"liveBadge":    "直播中",
	"endedBadge":   "已结束",
	"connecting":   "连接中…",
	"maskBanner":   "输出已经敏感值遮蔽（sc 令牌 / password 赋值 / 云密钥 key → ***）。遮蔽靠模式启发式，非绝对——不要在终端里打印高敏凭据。",
	"readonlyTip":  "本页面为只读直播，无任何输入通道",
	"guestLimit":   "同时在线的访客已达上限，请稍后再试",
	"endedTip":     "直播已结束（会话关闭或分享被撤销）",
	"reconnecting": "连接断开，重连中…",
	"poweredBy":    "由 Codecombo 提供",
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
	// 协作位（P-20261024-1）：素材上行 + 直通输入（collabpage.go 单一事实源）
	"clUpTitle":       "协作素材",
	"clUpHint":        "直达会话收件区，主人可一键交给智能体",
	"clDropHint":      "粘贴 / 拖入文件到此，或点击下方按钮上传",
	"clPickFiles":     "选择文件",
	"clCamera":        "拍照 / 相册",
	"clUpNote":        "图片 ≤10MB，文件 ≤20MB，单次 ≤5 个",
	"clDone":          "已上传",
	"clReceived":      "已收到",
	"clUsed":          "已交给会话",
	"clQuota":         "收件区已满，请联系分享者",
	"clLimited":       "上传太频繁，请稍后再试",
	"clFailed":        "上传失败，请重试",
	"clDirectTitle":   "直通输入",
	"clDirectHint":    "向智能体会话补充信息（需分享者批准）",
	"clDirectRequest": "申请输入权",
	"clDirectWaiting": "已申请，等待分享者批准…（60 秒内有效）",
	"clDirectPh":      "补充现场信息给智能体（≤4096 字符）…",
	"clDirectSend":    "发送",
	"clDirectSent":    "已送达会话",
	"clDirectHeld":    "你正在输入 · 剩 {m} 分钟",
	"clDirectOther":   "其他访客正在输入",
	"clDirectRevoked": "输入权已被收回",
	"clDirectGone":    "会话已结束",
	"clDirectMultiline": "粘贴内容包含多行文本，将作为多行输入送达会话。继续？",
	"clDirectTooLong": "粘贴内容超过 4096 字符上限",
}

var termDictEn = map[string]string{
	"appTitle":     "Terminal Live",
	"liveBadge":    "LIVE",
	"endedBadge":   "ENDED",
	"connecting":   "Connecting…",
	"maskBanner":   "Output is masked for sensitive values (sc tokens / password assignments / cloud keys → ***). Masking is heuristic, not absolute — avoid printing high-value credentials in this terminal.",
	"readonlyTip":  "This page is a read-only live view with no input channel",
	"guestLimit":   "Concurrent guest limit reached, try again later",
	"endedTip":     "Live has ended (session closed or share revoked)",
	"reconnecting": "Connection lost, reconnecting…",
	"poweredBy":    "Powered by Codecombo",
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
	// 协作位（P-20261024-1）：素材上行 + 直通输入（collabpage.go 单一事实源）
	"clUpTitle":       "Shared materials",
	"clUpHint":        "Go straight to the session inbox — hand them to the agent in one click",
	"clDropHint":      "Paste / drop files here, or use the buttons below",
	"clPickFiles":     "Choose files",
	"clCamera":        "Camera / photos",
	"clUpNote":        "Images ≤10MB, files ≤20MB, up to 5 per batch",
	"clDone":          "Uploaded",
	"clReceived":      "Received",
	"clUsed":          "Handed to session",
	"clQuota":         "Inbox is full, contact the share owner",
	"clLimited":       "Too many uploads, please try again later.",
	"clFailed":        "Upload failed, try again",
	"clDirectTitle":   "Direct input",
	"clDirectHint":    "Supplement the agent session (owner approval required)",
	"clDirectRequest": "Request input access",
	"clDirectWaiting": "Requested — waiting for owner approval… (valid for 60 seconds)",
	"clDirectPh":      "Supplement on-site info for the agent (≤4096 chars)…",
	"clDirectSend":    "Send",
	"clDirectSent":    "Delivered to the session",
	"clDirectHeld":    "You are typing · {m} min left",
	"clDirectOther":   "Another visitor is typing",
	"clDirectRevoked": "Input access was revoked",
	"clDirectGone":    "Session has ended",
	"clDirectMultiline": "The pasted text contains multiple lines and will be delivered to the session as-is. Continue?",
	"clDirectTooLong": "Paste exceeds the 4096-character limit",
}

func termDictFor(lang string) map[string]string {
	if lang == "zh" {
		return termDictZh
	}
	return termDictEn
}

type termPageData struct {
	Lang  string
	Title string
	Boot  template.JS
	// BoardCSS/BoardJS 访客留言区共享资产（P-20261006-13，guestboard.go
	// 单一事实源——三形态访客页同一段脚本挂载）
	BoardCSS template.CSS
	BoardJS  template.JS
	// CollabCSS/CollabJS 协作位共享资产（P-20261024-1，collabpage.go 单一
	// 事实源——素材上行 + 直通输入，开关在场才挂载）
	CollabCSS template.CSS
	CollabJS  template.JS
}

const termPageTmplSrc = `<!doctype html>
<html lang="{{.Lang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='6' fill='%236a5cff'/%3E%3Cpath d='M4.5 16.5c-1.5 1.5-2 5-2 5s3.5-.5 5-2c.8-.8.8-2.2 0-3-.8-.8-2.2-.8-3 0z' fill='none' stroke='%23fff' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M12 15l-3-3c.5-1.3 1.2-2.6 2-4 3.4-5.9 8.5-8 11-7 .9 2.5-1 7.5-7 11-.9.5-2 1.2-3 2z' fill='none' stroke='%23fff' stroke-width='1.8' stroke-linecap='round'/%3E%3Cpath d='M9 12H4s.5-3.4 2-4.5c1.7-1.2 5 0 5 0' fill='none' stroke='%23fff' stroke-width='1.8' stroke-linecap='round'/%3E%3C/svg%3E">
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
.wrap{position:relative;z-index:1;height:100vh;max-width:1180px;margin:0 auto;padding:22px 22px 10px;
display:flex;flex-direction:column}
.header{flex-shrink:0;display:flex;align-items:center;gap:14px;
background:linear-gradient(135deg,var(--accent),var(--accent2));border-radius:14px;
padding:13px 20px;color:#fff;box-shadow:var(--shadow)}
.header .icon{flex:0 0 auto;width:40px;height:40px;border-radius:10px;background:rgba(255,255,255,.16);
display:flex;align-items:center;justify-content:center}
.header .meta{flex:1;min-width:0}
.header h1{margin:0;font-size:16.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.header .sub{margin-top:2px;font-size:12px;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 「直播中」指示：呼吸点 + 徽标（结束态翻灰） */
.badge{flex:0 0 auto;display:inline-flex;align-items:center;gap:7px;background:rgba(255,255,255,.16);
border:1px solid rgba(255,255,255,.4);border-radius:999px;padding:4px 13px;font-size:12px;font-weight:600;
letter-spacing:.4px;font-variant-numeric:tabular-nums}
.badge .dot{width:8px;height:8px;border-radius:50%;background:#ff5b5b;animation:pulse 1.6s ease-in-out infinite}
.badge.ended .dot{background:#9aa3b5;animation:none}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.8)}}
/* 遮蔽声明横幅（提案要求的双警示之一，显著不折叠） */
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
/* 溯源水印（P-20261005-193）：与文件分享页同款对角双标低透明（4%）——
   DOM 在页内自实现（单文件页零依赖契约，文案构造 share.WatermarkLabel
   服务端共享），样式与 page.go 逐段对齐，改动两端须同步 */
.sc-wm{position:fixed;inset:0;pointer-events:none;z-index:65;
-webkit-user-select:none;user-select:none}
.sc-wm span{position:absolute;font-size:13px;font-weight:600;letter-spacing:.4px;
color:var(--text);opacity:.04;white-space:nowrap;transform:rotate(-24deg)}
.sc-wm .wm-a{top:16%;left:5%}
.sc-wm .wm-b{bottom:16%;right:5%}
{{.BoardCSS}}
{{.CollabCSS}}
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
    <div class="badge" id="badge" data-state="connecting"><span class="dot"></span><span id="badgeText"></span></div>
  </div>
  <div class="banner">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <span id="bannerText"></span>
  </div>
  <div class="card">
    <div class="term-box" id="termBox"></div>
    <div class="state" id="stateBox" style="display:none"></div>
  </div>
  <div class="foot-note"><span id="roTip"></span><span></span></div>
  <div class="footer" id="powered"></div>
</div>
<script src="/assets/xterm.js"></script>
<script src="/assets/addon-fit.js"></script>
<script>
const SC = {{.Boot}};
const t = k => (SC.dict[k] || k);
const $ = id => document.getElementById(id);
document.title = t('appTitle');
$('badgeText').textContent = t('connecting');
$('bannerText').textContent = t('maskBanner');
$('roTip').textContent = t('readonlyTip');
$('powered').textContent = t('poweredBy');

// 溯源水印（P-20261005-193）：文本服务端下发（SC.wm，空 = 不出层），
// textContent 写入防注入；纯视觉叠层与 SSE 数据面无涉
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

// ── xterm 只读实例：disableStdin 关键盘输入（配合服务端无输入端点 =
// 双层只读保证），背景透明融入页面主题，前景色随系统深浅 ──
const dark = matchMedia('(prefers-color-scheme: dark)');
const term = new Terminal({
  disableStdin: true,
  cursorBlink: false,
  cursorInactiveStyle: 'outline',
  convertEol: false,
  scrollback: 5000,
  fontSize: 13.5,
  fontFamily: 'ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace',
  theme: termTheme(),
  allowProposedApi: true
});
function termTheme(){
  return dark.matches
    ? { background: 'rgba(0,0,0,0)', foreground: '#e6eaf3', cursor: 'transparent' }
    : { background: 'rgba(0,0,0,0)', foreground: '#24292f', cursor: 'transparent' };
}
dark.addEventListener('change', () => { term.options.theme = termTheme(); });
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open($('termBox'));
// 只读保险丝：即便 disableStdin 被未来升级松动，页面也不存在任何
// 把输入发回服务端的代码路径（无 POST/WS 写通道可挂）
term.onData(() => {});
function doFit(){ try { fit.fit(); } catch (e) { /* 容器未布局完成时忽略 */ } }
doFit();
window.addEventListener('resize', doFit);

function setBadge(state, text){
  const b = $('badge');
  b.dataset.state = state;
  b.classList.toggle('ended', state === 'ended');
  $('badgeText').textContent = text;
}
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
function b64bytes(b64){
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

let ended = false;
function markEnded(){
  if (ended) return;
  ended = true;
  setBadge('ended', t('endedBadge'));
  $('sub').textContent = '';
  showState(t('endedBadge'), t('endedTip'));
  try { es.close(); } catch (e) {}
}

const es = new EventSource('/s/' + SC.token + '/stream');
es.addEventListener('hello', (ev) => {
  let m = {};
  try { m = JSON.parse(ev.data); } catch (e) {}
  if (m.ended) { markEnded(); return; }
  $('sub').textContent = t('readonlyTip');
  setBadge('live', t('liveBadge'));
  if (m.cols > 0 && m.rows > 0) {
    term.resize(Math.max(2, Math.min(m.cols, 500)), Math.max(2, Math.min(m.rows, 300)));
  }
  doFit();
});
es.addEventListener('tail', (ev) => { term.write(b64bytes(ev.data)); });
es.addEventListener('data', (ev) => { term.write(b64bytes(ev.data)); });
es.addEventListener('limit', () => {
  setBadge('ended', t('connecting'));
  showState(t('guestLimit'), '');
  try { es.close(); } catch (e) {}
});
es.addEventListener('end', () => { markEnded(); });
es.onerror = () => {
  // EventSource 自动重连；服务端重连后重发 hello+tail，重置屏防重复叠加
  if (ended) return;
  setBadge('connecting', t('reconnecting'));
};
es.onopen = () => {
  // 重连成功（首轮 open 也走这里，hello 尚未到、仅清屏无害）
  if (!ended) term.reset();
};

// 访客留言板（P-20261006-13）：页底留言区（三形态访客页同一段脚本，
// 单一事实源 guestboard.go；只读的是终端流，留言是另一条带防线的回流面）
// 协作位（P-20261024-1）：素材上行 + 直通输入（开关在场才挂载，collabpage.go
// 单一事实源——留言板上方插入，是另一条带防线的回流面，非终端按键通道）
{{.CollabJS}}
{{.BoardJS}}
</script>
</body>
</html>`

var termPageTmpl = template.Must(template.New("termlive").Parse(termPageTmplSrc))

// renderTermPage 输出终端直播访客页（已知 token；调用方已做 lookup）。
// wm 为溯源水印文本（P-20261005-193，空串 = 未开水印）。collab/direct 为
// 记录上的协作开关（P-20261024-1）——缺省双关时页面零协作位（存量语义）
func renderTermPage(w io.Writer, token, lang, title, wm string, collab, direct bool) error {
	boot, err := json.Marshal(termBootState{
		Token: token, Lang: lang, Dict: termDictFor(lang), Wm: wm,
		Collab: collab, DirectInput: direct, MsgMax: boardMsgMax(collab),
	})
	if err != nil {
		return err
	}
	return termPageTmpl.Execute(w, termPageData{
		Lang:      lang,
		Title:     "Codecombo " + title,
		Boot:      template.JS(boot),
		BoardCSS:  template.CSS(guestBoardCSS),
		BoardJS:   template.JS(guestBoardJS),
		CollabCSS: template.CSS(collabCSS),
		CollabJS:  template.JS(collabJS),
	})
}
