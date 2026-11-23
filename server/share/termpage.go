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
	// Name 分享展示名（P-20261118-9 去品牌前缀）：页面据此校准 h1 与
	// document.title；rename 帧到达前与 <title> 同源
	Name string `json:"name,omitempty"`
	// Wm 溯源水印文本（P-20261005-193；空串 = 记录未开水印，页面不出水印层）
	Wm string `json:"wm,omitempty"`
	// Collab 协作通道开关（P-20261024-1）：true = 页面挂载素材上行位
	//（粘贴/拖入/点击三入口）。缺省 false = 页面无任何协作位（存量语义）
	Collab bool `json:"collab,omitempty"`
	// GuestInput 访客输入·申请通道在场标记（P-20261024-1 直通档 directInput
	// 随统一收编退役后的接替字段，反向极性在 store 落——GuestInputOff）：
	// true = 申请-批准握手入口默认在场（申请通道缺省开；owner 关闭通道即
	// 不渲染申请入口）
	GuestInput bool `json:"guestInput,omitempty"`
	// Writable 开放直入开关（P-20261106-8「对方可直接输入」模式）：
	// true = 键入即开（WS 上行桥 + 出域警示横幅；键入直注主人终端 PTY，
	// writablepage.go 单一事实源）
	Writable bool `json:"writable,omitempty"`
	// MsgMax 留言板上限（协作通道 2000 / 缺省 500，boardMsgMax 同源下发）
	MsgMax int `json:"msgMax,omitempty"`
	// Unfiltered 未过滤标记（P-20261106-9）：true = 分享者创建时关闭了源头
	// 遮蔽（feeder 原样转发），横幅位换「未过滤」警示文案。缺省省略 = 已遮蔽
	//（存量语义）。纯展示位——遮蔽与否在服务端源头已定，页面无过滤逻辑
	Unfiltered bool `json:"unfiltered,omitempty"`
}

var termDictZh = map[string]string{
	"appTitle":         "终端直播",
	"liveBadge":        "直播中",
	"endedBadge":       "已结束",
	"connecting":       "连接中…",
	"maskBanner":       "输出已经敏感值遮蔽（sc 令牌 / password 赋值 / 云密钥 key → ***）。遮蔽靠模式启发式，非绝对——不要在终端里打印高敏凭据。",
	"unfilteredBanner": "未过滤：分享者已关闭敏感值遮蔽，输出原样直播（可能含令牌 / 密码 / 密钥等敏感信息）。请勿转发本链接，看完即可关闭页面。",
	"readonlyTip":      "只读直播：输出只可观看；如需键入或粘贴图片/文件，点击「申请输入」提交申请（分享者批准后生效）",
	"guestLimit":       "同时在线的访客已达上限，请稍后再试",
	"endedTip":         "直播已结束（会话关闭或分享被撤销）",
	"reconnecting":     "连接断开，重连中…",
	"poweredBy":        "由 Codecombo 提供",
	// 主题切换器（P-20261120-1，theme.go guestThemeJS 消费；键名与文件页
	// page_i18n.go 主题段同表，六页同键）
	"theme":        "主题",
	"themeAuto":    "跟随系统",
	"themeLight":   "GitHub 浅色",
	"themeDark":    "GitHub 深色",
	"themeOneDark": "One Dark",
	"themeDracula": "Dracula",
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
	"clUpTitle":   "协作素材",
	"clUpHint":    "直达会话收件区，主人可一键交给智能体",
	"clDropHint":  "拖入文件到页面任意位置，或点击下方按钮上传",
	"clPickFiles": "选择文件",
	"clCamera":    "拍照 / 相册",
	"clUpNote":    "图片 ≤10MB，文件 ≤20MB，单次 ≤5 个",
	"clDone":      "已上传",
	"clReceived":  "已收到",
	"clUsed":      "已交给会话",
	"clQuota":     "收件区已满，请联系分享者",
	"clLimited":   "上传太频繁，请稍后再试",
	"clFailed":    "上传失败，请重试",
	// 协作条折叠态 / 文字素材 / 粘贴兜底（P-20261107-4，collabpage.go 单一事实源）
	"clUploading":      "上传中 {i}/{n}…",
	"clReceivedN":      "已收 {n} 份",
	"clSomeFailed":     "有素材上传失败，展开查看",
	"clDragHint":       "松开即上传为协作素材（发到终端请 Ctrl+V）",
	"clTextTitle":      "文字素材",
	"clTextHint":       "输入或粘贴的文字会作为一份 .txt 素材送达收件区",
	"clTextPh":         "写下或粘贴要交给分享者的文字（日志、报错、复现步骤…）",
	"clTextSend":       "提交为素材",
	"clTextTooLong":    "文字超过 {n} 字上限，请改为上传文件",
	"clTextFile":       "文字素材",
	"clImgFile":        "截图",
	"clPasteRemoteImg": "剪贴板里只有网页图片链接，无法直接读取：请在图片上右键「复制图片」后再粘贴，或保存后用「选择文件」上传",
	// 访客输入位（P-20261106-8 可写分享，P-20261121-1 统一双授权模式）：
	// WS 上行输入位文案（writablepage.go 单一事实源；clDirect* 词表随直通位
	// 退役并入 wr*——申请/等待/持权三态与开放直入同位呈现）。wrOn/wrTip 出域
	// 警示如实提及粘贴上传（P-20261122-1：open 模式持链接即可上传，泄露半径
	// 与键入同等——评审风险注记的诚实呈现）
	"wrOn":        "可写模式 · 你的输入与粘贴上传将直达主人的终端（主人可随时收回）",
	"wrTip":       "可写模式：你的键入与粘贴上传会实时进入主人的终端，请谨慎操作",
	"wrThrottled": "输入太快，部分输入被暂时拦截，请稍慢一点",
	"wrReview":    "粘贴块包含高危命令，已提交主人审批（未批不会执行）…",
	"wrDenied":    "主人未批准（或已超时）该粘贴块，输入被丢弃",
	// 拖拽导航守卫（P-20261122-14 必改1）：拖拽上传经用户定向裁撤，collab 关
	// 的 writable 页拦下拖放缺省导航后提示改走粘贴链（writablepage.go 消费）；
	// P-20261122-18 起补上传按钮出口（Ctrl+V 文件投递分浏览器，按钮是保底）
	"wrDragNoUpload": "拖拽不发送文件，请点「上传文件/图片」按钮或 Ctrl+V 粘贴",
	// 申请批准路径（P-20261121-1 统一收编：申请通道默认在场，申请-批准握手
	// 三态——与开放直入共用状态条与键入通道）
	"wrRequest": "申请输入",
	"wrWaiting": "已申请，等待分享者批准…（10 分钟内有效）",
	"wrHeld":    "你正在输入 · 剩 {m} 分钟",
	"wrOther":   "其他访客正在输入",
	"wrRevoked": "输入权已被收回（可重新申请）",
	"wrClosed":  "申请通道未开放或分享已结束",
	// 生命周期公告（P-20261122-19 ③）：独立 notice 承载收回/关闭/停止原因
	//（wr-strip 会被重连清掉，原因必须活过重连）；waiting 上限复用 guestLimit
	"wrOwnerOff":    "主人已关闭可写模式",
	"wrGone":        "分享已结束或链接已失效",
	"wrPassExpired": "口令校验已失效，正在返回口令页…",
	// 可写页头部副标题（P-20261119-3 sub 所有权二分）：可写页 sub 由
	// writablepage 在 WS hello（键入通道开通）时写入本键、teardown 时恢复
	// readonlyTip——termpage 的 ES hello 在 SC.writable 下不触 sub（到达顺序
	// 不定的双通道竞态在所有权边界消解，见 hello 处理器内注）
	"wrSubLive": "可写直播：键入将直达主人的终端",
	// 视口反喂 resize 诚实回执（P-20261120-8 必改6）：服务端 resize_applied 后
	// 状态条右段的即时反馈——访客视口已反喂为主机终端宽度（文字按视口折行）
	"wrResized": "已按你的视口同步终端尺寸（文字按窗口折行）",
	// 反喂让位原因（P-20261122-16 ③/④）：主人在本机开着该会话的终端时拒绝访客
	// 反喂（owner 的 xterm 不随 PTY 改格重排），状态条后缀给出可见原因——画布
	// 以主机栅格为准，主人离开后 30s 退避到期自动恢复反喂
	"wrOwnerActive": "主人在本机操作，画布以主机为准",
	// 粘贴上传链（P-20261122-1 必改2）：访客页 paste 事件接管的进度与结果文案
	//（writablepage.go 单一事实源；429/403 复用 clLimited/wrRevoked 既有文案）。
	// P-20261122-18 增三键：常驻上传按钮（跨浏览器文件投递保底）/「剪贴板无
	// 文件」提示（无文件且无文本才出，30s 限频）/无键入资格时先申请提示
	"puUploading":   "上传粘贴文件 {i}/{n}…",
	"puDone":        "已落盘 {n} 个文件，路径已贴入终端",
	"puTooMany":     "单次最多上传 {n} 个文件，超出部分已忽略",
	"puUnsupported": "不支持的文件类型：{name}",
	"puFailOne":     "上传失败：{name}",
	"puFailed":      "上传失败，请重试",
	"puUploadBtn":   "上传文件/图片",
	"puNoFile":      "剪贴板里没有可发送的文件，请点「上传文件/图片」按钮",
	"puNeedHold":    "先申请输入权限，获批后再上传",
	// 闸前粘贴可见化（P-20261123-1 ②）：带文件粘贴落在页内输入框（搜索框/
	// 留言昵称/协作素材框）且有键入资格——文件只能走终端粘贴链，提示先聚焦
	// 终端；不 preventDefault（输入框语义与去向都不变）
	"puFocusTerm": "请先点击终端区域再粘贴文件",
	// 选区复制（P-20261122-1 必改4）：Ctrl+Shift+C 与复制钮的反馈文案
	//（cpCopy 是按钮 label 兼 title/aria-label；terminalOsc52Clipboard
	// copyText 降级链先例——失败文案如实「浏览器未放行」）
	"cpCopy":       "复制选中",
	"cpCopied":     "已复制选中文本",
	"cpCopyFailed": "复制失败（浏览器未放行）",
	// 极简搜索条（P-20261122-1 必改6）：观看侧可写页的搜索面文案（addon-search）
	"seToggle":   "搜索",
	"seSearch":   "搜索终端内容…",
	"sePrev":     "上一个匹配",
	"seNext":     "下一个匹配",
	"seClose":    "关闭搜索",
	"seNoResult": "无匹配",
}

var termDictEn = map[string]string{
	"appTitle":         "Terminal Live",
	"liveBadge":        "LIVE",
	"endedBadge":       "ENDED",
	"connecting":       "Connecting…",
	"maskBanner":       "Output is masked for sensitive values (sc tokens / password assignments / cloud keys → ***). Masking is heuristic, not absolute — avoid printing high-value credentials in this terminal.",
	"unfilteredBanner": "Unfiltered: the sharer turned off sensitive-value masking — output is streamed verbatim and may contain tokens, passwords or keys. Do not forward this link; close the page when you are done.",
	"readonlyTip":      "Read-only live: output is view-only; to type or paste images/files, click \"Request input access\" below (takes effect after owner approval)",
	"guestLimit":       "Concurrent guest limit reached, try again later",
	"endedTip":         "Live has ended (session closed or share revoked)",
	"reconnecting":     "Connection lost, reconnecting…",
	"poweredBy":        "Powered by Codecombo",
	// 主题切换器（P-20261120-1；键名与文件页 page_i18n.go 主题段同表）
	"theme":        "Theme",
	"themeAuto":    "Auto (system)",
	"themeLight":   "GitHub Light",
	"themeDark":    "GitHub Dark",
	"themeOneDark": "One Dark",
	"themeDracula": "Dracula",
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
	// 协作位（P-20261024-1）：素材上行（collabpage.go 单一事实源）
	"clUpTitle":   "Shared materials",
	"clUpHint":    "Go straight to the session inbox — hand them to the agent in one click",
	"clDropHint":  "Drop files anywhere on the page, or use the buttons below",
	"clPickFiles": "Choose files",
	"clCamera":    "Camera / photos",
	"clUpNote":    "Images ≤10MB, files ≤20MB, up to 5 per batch",
	"clDone":      "Uploaded",
	"clReceived":  "Received",
	"clUsed":      "Handed to session",
	"clQuota":     "Inbox is full, contact the share owner",
	"clLimited":   "Too many uploads, please try again later.",
	"clFailed":    "Upload failed, try again",
	// 协作条折叠态 / 文字素材 / 粘贴兜底（P-20261107-4，collabpage.go 单一事实源）
	"clUploading":      "Uploading {i}/{n}…",
	"clReceivedN":      "{n} received",
	"clSomeFailed":     "Some uploads failed — expand to see",
	"clDragHint":       "Drop to upload as shared material (Ctrl+V to send to the terminal)",
	"clTextTitle":      "Text material",
	"clTextHint":       "Typed or pasted text is delivered to the inbox as a .txt file",
	"clTextPh":         "Type or paste text for the share owner (logs, errors, repro steps…)",
	"clTextSend":       "Send as material",
	"clTextTooLong":    "Text exceeds the {n}-character limit — upload it as a file instead",
	"clTextFile":       "text-note",
	"clImgFile":        "screenshot",
	"clPasteRemoteImg": "The clipboard only holds a link to a web image, which can't be read directly: right-click the image and choose “Copy image”, or save it and use “Choose files”",
	// 访客输入位（P-20261106-8 可写分享，P-20261121-1 统一双授权模式，
	// 注释见中文表同键条目）
	"wrOn":        "Writable mode · your input and paste uploads go straight to the owner's terminal (owner can revoke anytime)",
	"wrTip":       "Writable mode: your typing and paste uploads enter the owner's terminal live — operate with care",
	"wrThrottled": "Typing too fast — some input was temporarily dropped, slow down a little",
	"wrReview":    "Pasted block contains a high-risk command — submitted for owner approval (nothing executes until approved)…",
	"wrDenied":    "The owner did not approve (or timed out) that pasted block — input was dropped",
	// 拖拽导航守卫（P-20261122-14 必改1，注释见中文表同键条目）
	"wrDragNoUpload": "Dragging does not send files — use “Upload files/images” or Ctrl+V",
	// 申请批准路径（P-20261121-1 统一收编，注释见中文表同键条目）
	"wrRequest": "Request input access",
	"wrWaiting": "Requested — waiting for owner approval… (valid for 10 minutes)",
	"wrHeld":    "You are typing · {m} min left",
	"wrOther":   "Another visitor is typing",
	"wrRevoked": "Input access was revoked (you can request again)",
	"wrClosed":  "Request channel is closed or the share has ended",
	// 生命周期公告（P-20261122-19 ③，注释见中文表同键条目）
	"wrOwnerOff":    "The owner turned off writable mode",
	"wrGone":        "This share has ended or the link is no longer valid",
	"wrPassExpired": "Passphrase session expired — returning to the passphrase page…",
	// 可写页头部副标题（P-20261119-3 sub 所有权二分，注释见中文表同键条目）
	"wrSubLive": "Writable live: keystrokes go to the owner's terminal",
	// 视口反喂 resize 诚实回执（P-20261120-8 必改6，注释见中文表同键条目）
	"wrResized": "Terminal size synced to your viewport (text wraps to the window)",
	// 反喂让位原因（P-20261122-16，注释见中文表同键条目）
	"wrOwnerActive": "Owner is working on this machine — canvas follows the host grid",
	// 粘贴上传链（P-20261122-1 必改2，注释见中文表同键条目）
	"puUploading":   "Uploading paste files {i}/{n}…",
	"puDone":        "Saved {n} file(s) — path(s) pasted into the terminal",
	"puTooMany":     "Up to {n} files per paste — extra files were ignored",
	"puUnsupported": "Unsupported file type: {name}",
	"puFailOne":     "Upload failed: {name}",
	"puFailed":      "Upload failed, try again",
	"puUploadBtn":   "Upload files/images",
	"puNoFile":      "No file in the clipboard — use the “Upload files/images” button",
	"puNeedHold":    "Request input access first — uploads unlock after approval",
	// 闸前粘贴可见化（P-20261123-1 ②，注释见中文表同键条目）
	"puFocusTerm": "Click the terminal area first, then paste files",
	// 选区复制（P-20261122-1 必改4，注释见中文表同键条目）
	"cpCopy":       "Copy selection",
	"cpCopied":     "Selection copied",
	"cpCopyFailed": "Copy failed (browser blocked it)",
	// 极简搜索条（P-20261122-1 必改6，注释见中文表同键条目）
	"seToggle":   "Search",
	"seSearch":   "Search terminal…",
	"sePrev":     "Previous match",
	"seNext":     "Next match",
	"seClose":    "Close search",
	"seNoResult": "No matches",
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
	// LayoutCSS/LayoutJS 终端访客页共用布局件（P-20261106-9，termlayout.go
	// 单一事实源——自适应列容器 + 未过滤横幅样式 + 窄屏断点 + 列宽估算）
	LayoutCSS template.CSS
	LayoutJS  template.JS
	// Unfiltered 未过滤标记（P-20261106-9）：横幅位服务端直出 .unfiltered 类
	Unfiltered bool
	// WritableCSS/WritableJS 可写位共享资产（P-20261106-8，writablepage.go
	// 单一事实源——WS 上行输入位，开关在场才挂载）
	WritableCSS template.CSS
	WritableJS  template.JS
	// EntryCSS/EntryJS 合并入口条（P-20261119-3，entrybar.go 单一事实源——
	// 协作/留言两条入口条并单条双入口的条壳；仅终端直播页注入）
	EntryCSS template.CSS
	EntryJS  template.JS
	// ThemeCSS/ThemeJS 访客页族主题切换注入件（P-20261120-1，theme.go 单一
	// 事实源——四主题 data-theme 覆盖块进 <style>，JS 在 head 先行 initTheme
	// 设 data-theme 防闪白，xterm.js 加载之前）
	ThemeCSS template.CSS
	ThemeJS  template.JS
	// DragJS 访客页族拖拽导航守卫注入件（P-20261122-20，dragguard.go 单一
	// 事实源——document 级 dragover/drop 仅拦含 Files 载荷的缺省导航；本页
	// 只在 !SC.collab 时注册，collab 开时收件箱 drop 是唯一语义）
	DragJS template.JS
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
{{.ThemeCSS}}
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
.header{flex-shrink:0;display:flex;align-items:center;gap:12px;
background:linear-gradient(135deg,var(--accent),var(--accent2));border-radius:14px;
padding:9px 16px;color:#fff;box-shadow:var(--shadow)}
.header .icon{flex:0 0 auto;width:34px;height:34px;border-radius:10px;background:rgba(255,255,255,.16);
display:flex;align-items:center;justify-content:center}
.header .meta{flex:1;min-width:0}
.header h1{margin:0;font-size:16px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.header .sub{margin-top:1px;font-size:12px;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 「直播中」指示：呼吸点 + 徽标（结束态翻灰） */
.badge{flex:0 0 auto;display:inline-flex;align-items:center;gap:7px;background:rgba(255,255,255,.16);
border:1px solid rgba(255,255,255,.4);border-radius:999px;padding:3px 11px;font-size:12px;font-weight:600;
letter-spacing:.4px;font-variant-numeric:tabular-nums}
.badge .dot{width:8px;height:8px;border-radius:50%;background:#ff5b5b;animation:pulse 1.6s ease-in-out infinite}
.badge.ended .dot{background:#9aa3b5;animation:none}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.8)}}
/* 遮蔽声明横幅（提案要求的双警示之一，显著不折叠）——完整文案与警示色不收，
   只收条内纵向 padding 与条间 margin（P-20261118-9 布局紧凑化） */
.banner{flex-shrink:0;margin-top:8px;display:flex;gap:9px;align-items:flex-start;
background:var(--warn-bg);border:1px solid var(--warn-bd);color:var(--warn-tx);
border-radius:10px;padding:6px 12px;font-size:12.5px;line-height:1.5}
.banner svg{flex:0 0 auto;margin-top:2px}
.card{flex:1;min-height:0;display:flex;flex-direction:column;margin-top:8px;
background:var(--card);border:1px solid var(--border);border-radius:14px;
box-shadow:var(--shadow);overflow:hidden}
.term-box{flex:1;min-height:0;padding:8px 10px}
.term-box .xterm{height:100%}
.term-box .xterm-viewport{background:transparent!important}
/* foot-note 并入 footer 单行（P-20261118-9）：原两行（提示行+版权行）合并为
   flex 两端单行——roTip 左、版权右；.footer 锚点语义保留（挂载脚本插入位） */
.foot-note{flex-shrink:0;display:flex;justify-content:space-between;gap:12px;
padding:6px 6px 0;color:var(--muted);font-size:11.5px;opacity:.85}
.state{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
color:var(--muted);text-align:center;padding:30px}
.state .big{width:64px;height:64px;border-radius:18px;background:var(--chip);margin-bottom:14px;
display:flex;align-items:center;justify-content:center}
.state h2{margin:0 0 6px;font-size:16px;color:var(--text)}
.state p{margin:0;font-size:12.5px}
/* 溯源水印（P-20261005-193）：与文件分享页同款对角双标低透明（4%）——
   DOM 在页内自实现（单文件页零依赖契约，文案构造 share.WatermarkLabel
   服务端共享），样式与 page.go 逐段对齐，改动两端须同步。色取常量中性灰
   （P-20261121-4 端面感知裁定）：var(--text) 在浅色档为深色、落在恒深终端
   端面上 4% 不可见——中性灰在浅/深两种面上同档隐现，不随主题翻转 */
.sc-wm{position:fixed;inset:0;pointer-events:none;z-index:65;
-webkit-user-select:none;user-select:none}
.sc-wm span{position:absolute;font-size:13px;font-weight:600;letter-spacing:.4px;
color:#8b94a9;opacity:.04;white-space:nowrap;transform:rotate(-24deg)}
.sc-wm .wm-a{top:16%;left:5%}
.sc-wm .wm-b{bottom:16%;right:5%}
{{.BoardCSS}}
{{.CollabCSS}}
{{.LayoutCSS}}
{{.WritableCSS}}
{{.EntryCSS}}
</style>
<script>{{.ThemeJS}}</script>
</head>
<body>
<div class="blob b1"></div><div class="blob b2"></div>
<div id="app" class="wrap">
  <div class="header">
    <div class="icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12.5 15H17" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
    <div class="meta">
      <h1 id="pageTitle">{{.Title}}</h1>
      <div class="sub" id="sub"></div>
    </div>
    <div class="badge" id="badge" data-state="connecting"><span class="dot"></span><span id="badgeText"></span></div>
    <span id="themeSlot"></span>
  </div>
  <div class="banner{{if .Unfiltered}} unfiltered{{end}}" id="maskBanner" data-testid="share-mask-banner">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <span id="bannerText"></span>
  </div>
  <div class="card">
    <div class="term-box" id="termBox"></div>
    <div class="state" id="stateBox" style="display:none"></div>
  </div>
  <!-- foot-note 并入 footer 单行（P-20261118-9 布局紧凑化）：roTip 左 / 版权右；
       .footer class 保留——guestboard/collab 挂载锚点按它定位插入位 -->
  <div class="footer foot-note"><span id="roTip"></span><span id="powered"></span></div>
</div>
<script src="/assets/xterm.js"></script>
<script src="/assets/addon-fit.js"></script>
<script src="/assets/addon-unicode11.js"></script>
<!-- 观看侧通用件（P-20261122-1 必改5/6/7/8）：web-links 链接可点、search 搜索、
     webgl 渲染、image 图片协议——直播页通用挂载或条件挂载（授权模式无关裁定 D
     /SC.unfiltered 遮蔽闸），frozen/cast 定格页明确排除出范围（评审裁定 D 防蔓延） -->
<script src="/assets/addon-web-links.js"></script>
<script src="/assets/addon-search.js"></script>
<script src="/assets/addon-webgl.js"></script>
<script src="/assets/addon-image.js"></script>
<script>
const SC = {{.Boot}};
// 终端访客页共用布局件（P-20261106-9 / P-20261107-4，termlayout.go 单一事实源：
// 渲染常量 SC_TERM_*、scTermOptions、scFitGrid 等）
{{.LayoutJS}}
// 访客页族拖拽导航守卫（P-20261122-20，dragguard.go 单一事实源）
{{.DragJS}}
const t = k => (SC.dict[k] || k);
const $ = id => document.getElementById(id);
// 拖拽导航守卫注册（P-20261122-20）：原只生在可写位且 writable/guestInput 双关
// 早退——只读直播拖入本地文件仍被浏览器导航到 file:// 整页丢失。本页 collab
// 关时注册（拦缺省动作 + 提示改走 Ctrl+V 粘贴链，词表键 wrDragNoUpload 复用不
// 新增）；collab 开时零注册——collabpage 整页 drop=协作收件箱唯一语义（双收口
// 会同一次投放双上传）。提示面用守卫自带 .drag-tip，可写位 .pu-tip 专属粘贴
// 上传链，两桶互不遮蔽（无双提示）
scDragGuard({ enabled: !SC.collab, tip: t('wrDragNoUpload') });
// 标签页标题 = 分享名（P-20261118-9 去品牌前缀：h1 与标签页都呈现会话本身，
// 「Codecombo 终端 N」「终端直播」泛称双重误导同根）。<title> 已是分享名，
// 此处用 SC.name 校准一次并供 rename 帧复用；name 缺席保持 <title> 原值
function setPageName(name){
  if (!name) return;
  document.title = name;
  const h1 = $('pageTitle');
  if (h1) h1.textContent = name;
}
setPageName(SC.name);
$('badgeText').textContent = t('connecting');
// 横幅位：遮蔽声明 / 未过滤警示二选一（P-20261106-9，记录配置随 boot 下发）
$('bannerText').textContent = t(SC.unfiltered ? 'unfilteredBanner' : 'maskBanner');
$('roTip').textContent = t('readonlyTip');
$('powered').textContent = t('poweredBy');
// 主题切换器（P-20261120-1，theme.go 共享注入件——head 已先行 initTheme 设
// data-theme 防闪白；渐变头部上的落位观感由页面实测门禁三视口裁定）
$('themeSlot').appendChild(makeThemeSelect());

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

// ── xterm 只读实例：渲染参数与产品内终端跨栈对齐（P-20261107-4：字体栈/字号/
// scrollback/Unicode 11 宽度表同产品缺省，scTermOptions 单一出口）；disableStdin
// 关键盘输入（配合服务端无输入端点 = 双层只读保证）──
// 端面恒深色（P-20261121-4）：主人控制台的 ANSI 着色按深色控制台语义发出
// （PSReadLine 命令亮黄、红/绿输出），浅色主题透明底承接 = 深色语义落浅底
// 不可辨，256 色/真彩输出无法靠前景重映射兜底——端面收敛常量深色（底色同
// 各页 OS-dark --bg=#0e1320、前景恒 #e6eaf3，与 termLayoutCSS .term-box 端面
// 同源），页面 chrome（头部/卡片/blob/主题切换器）仍随四主题换装（tmate/
// ttyd/GitHub Live Share 同口径）。旧主题随档接线（前景映射/OS 深浅门禁/
// 事件换装监听，P-20261120-1 段）全量退役（P-20261121-4）
const term = new Terminal(scTermOptions({ convertEol: false, theme: termTheme() }));
function termTheme(){
  return { background: '#0e1320', foreground: '#e6eaf3', cursor: 'transparent' };
}
scTermUnicode(term);
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
// ── 观看侧通用件挂载（P-20261122-1 必改5/7/8，授权模式无关裁定 D——同一张页
// addon 挂载与可写与否无关，只读+可写同享）──
// WebLinks：http(s) 链接 hover 可点、点击新标签打开（noopener 语义由 addon 内
// URL 构造保证；CSP 已放行同源脚本，链接动作是浏览器导航非脚本注入面）
try { term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch (e) { /* 老浏览器缺 URL 构造：降级无链接 */ }
// ImageAddon 条件件（必改8，评审裁定保）：SC.unfiltered 才挂载——Sixel/IIP/
// Kitty 图片像素不在 mask.Masker 模式表内，遮蔽开（缺省）时挂载 = 绕过文本
// 遮蔽的真实语义漏洞，故遮蔽开=禁用（诚实边界：遮蔽本来只作用文本流）
if (SC.unfiltered) { try { term.loadAddon(new ImageAddon.ImageAddon()); } catch (e) {} }
// WebGL 渲染（必改7）：大流量输出性能显著优于 DOM renderer。navigator.webdriver
// 跳过惯例沿用主应用 useTerminalAddons（自动化环境 loadAddon 不抛错但 canvas
// 实际不渲染——保 Playwright DOM 渲染断言面，share-terminal-live spec 依赖）；
// 上下文丢失（活跃 WebGL 上下文 ~16 个上限被驱逐）= dispose 降级 DOM renderer
//（官方支持路径，功能完好大流量性能略降）。访客页无 toast 体系、状态条由协议
// 驱动——降级是透明损耗不播报（单终端单上下文，驱逐风险远低于主人端多 pane）
if (navigator.webdriver !== true) {
  try {
    const webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(() => { try { webgl.dispose(); } catch (e) {} });
    term.loadAddon(webgl);
  } catch (e) { /* 软件 WebGL/老设备：DOM renderer 保底 */ }
}
// 只读保险丝：即便 disableStdin 被未来升级松动，页面也不存在任何
// 把输入发回服务端的代码路径（无 POST/WS 写通道可挂）
term.onData(() => {});
function doFit(){ try { fit.fit(); } catch (e) { /* 容器未布局完成时忽略 */ } }

// 主机栅格（P-20261107-4 渲染保真）：hello/resize 帧给出主机 cols×rows 时按其
// 精确渲染——不让 fit 按访客容器改写列数（栅格与主机不符即 TUI 折行/光标定位
// 错乱），字号收缩装进容器、主机栅格窄于容器时宽度优先放大（P-20261119-2，
// 上限 3×产品字号；放大致纵向超容器走 overset 外层滚动面 + follow 跟随）；主机尺寸未知（会话
// 从未 resize 过）回落容器 fit。重排由终端容器尺寸驱动（横幅/可写条/页底浮层
// 引起的容器变化都会重排，不再底部裁切）
let hostCols = 0, hostRows = 0;
// 视口反喂回声钩子（P-20261120-8，P-20261122-16 起带棘轮语义）：SSE resize 帧
// 到达时通知可写页驱动对账——匹配在途请求值即自源回声清账，不匹配即主人侧
// 动作（进抑制窗 + 「画布以主机为准」棘轮，访客自己改窗口才解除）。只读页
// 无驱动，函数保持 null 零开销；writablepage 在挂载时覆写本钩子
let wrHostResize = null;
// 视口反喂几何钩子（P-20261120-8）：容器几何变化（窗口拖拽/横幅折行/页底浮
// 层）经既有 layout 重排点同步 kick 驱动重算目标——复用 scObserve 的观测链，
// 可写页不再另挂第二个 ResizeObserver
let wrLayoutHook = null;
function layout(){
  if (!term.element) return;
  if (hostCols > 0 && hostRows > 0) {
    scTermNeed(hostCols, term.options.fontSize);
    scFitGrid(term, $('termBox'), hostCols, hostRows);
  } else {
    scClearGrid(term);
    doFit();
  }
  if (wrLayoutHook) wrLayoutHook();
}
const relayout = scObserve($('termBox'), layout);
function setHost(cols, rows){
  if (!(cols > 0 && rows > 0)) return;
  hostCols = Math.max(2, Math.min(cols, 500));
  hostRows = Math.max(2, Math.min(rows, 300));
  // 内容自适应列宽（P-20261106-9）：列容器按主机列数放宽/收窄（宽度仍受视口
  // 约束，不强制铺满；字号按当前生效值回算、钳 ≥ 产品字号，P-20261119-2）；
  // 栅格立即换尺寸（随后到达的字节按主机栅格落屏）
  scTermNeed(hostCols, term.options.fontSize);
  if (term.cols !== hostCols || term.rows !== hostRows) term.resize(hostCols, hostRows);
  // 滚动位不在此处写（P-20261123-2）：栅格重排的默认位由 scFitGrid 的几何真变
  // 检测驱动 scEnsureCursorVisible(force)——同一几何的 1s 对账帧不拽回用户上滚
  // 阅读位置；follow=false 时任何重排都不写
  relayout();
}
// 产品同款字体就绪再 open（xterm 在 open 时测字宽）；字体晚到则重测重排。
// open 后装滚动面（P-20261123-2）：scWheelCapture 捕获相接管 overset 滚轮
// （单面化），scTermDiag 在 ?term=diag 时开诊断环形缓冲
scFontsReady(() => {
  term.open($('termBox'));
  scWheelCapture($('termBox'), term);
  scTermDiag(term, $('termBox'));
  layout();
}, () => { scRemeasure(term); relayout(); });

function setBadge(state, text){
  const b = $('badge');
  b.dataset.state = state;
  b.classList.toggle('ended', state === 'ended');
  $('badgeText').textContent = text;
}
function showState(title, desc){
  $('termBox').style.display = 'none';
  // 可写位观看侧 UI（P-20261122-1：动作排/搜索条，writablepage 挂载）随直播
  // 结束收起——终端区已被结束态卡片替换，复制/搜索无对象；元素缺席即空转
  document.querySelectorAll('.wr-actions,.wr-search,.pu-tip').forEach(function(el){ el.style.display = 'none'; });
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
  // sub 所有权二分（P-20261119-3）：只读页 sub 由本处写只读文案；可写页
  // （SC.writable）sub 归 writablepage 独占——WS hello（键入通道开通）才写
  // 可写文案、teardown 恢复只读文案。ES hello 与 WS hello 到达顺序不定（WS
  // 构造失败还有 5s 轮询窗口），这里无条件写会让可写页头部先钉上「无任何
  // 输入通道」再被翻面/永不翻面，与下方可写横幅同屏矛盾；重连重发 hello
  // 也不回写，竞态在所有权边界消解
  if (!SC.writable) $('sub').textContent = t('readonlyTip');
  setBadge('live', t('liveBadge'));
  // 分享名校准（P-20261118-9）：hello 帧带 name——服务端渲染后到重连重播种
  // 之间记录若已改名，这里对齐 h1 与标签页标题
  setPageName(m.name);
  setHost(m.cols, m.rows);
  relayout();
  // hello 后的首帧定位（P-20261123-2）：首载与 EventSource 重连都经 hello 重播种，
  // 此处 force 把光标行作默认滚动位（重连同几何时 setHost 无几何真变、不触发
  // scFitGrid 的 force，靠这一处兜）；follow=false 时不写（scEnsureCursorVisible
  // 内部守卫）
  scEnsureCursorVisible($('termBox'), term, true);
});
// 会话重命名（P-20261118-9）：与 resize 帧同一 1s 对账 tick（syncName），
// 分享侧改名即达访客——页面加载早于改名的存量连接同享；EventSource 未知
// 事件静默忽略（旧缓存页零破坏）
es.addEventListener('rename', (ev) => {
  let m = {};
  try { m = JSON.parse(ev.data); } catch (e) {}
  setPageName(m.name);
});
// 主机调整窗口（P-20261107-4）：resize 帧排进写入队列——先于它到达的字节按旧
// 栅格解析完再换栅格，随后的重绘字节落新栅格（与主机侧时序一致）。可写页的
// 视口反喂回声对账挂同一帧（wrHostResize 钩子，P-20261120-8：服务端合并窗
// 应用/主人本机调整/API 抢回都经此帧到达，驱动据此分流自源回声与主人动作）
es.addEventListener('resize', (ev) => {
  let m = {};
  try { m = JSON.parse(ev.data); } catch (e) {}
  term.write('', () => setHost(m.cols, m.rows));
  if (wrHostResize) wrHostResize(m.cols, m.rows);
});
// data/tail 写回调跟随（P-20261123-2，取代 P-20261119-2 每写钉底）：写入不改外层
// 几何（scrollHeight 由 scFitGrid 定死），只需 follow 态下让光标行留在窗内——
// scEnsureCursorVisible 最小滚动、rAF 合并（服务端 8ms 合帧写入即每帧一次量测），
// 用户上滚后 follow=false 绝不拽回
es.addEventListener('tail', (ev) => { term.write(b64bytes(ev.data), () => scEnsureCursorVisible($('termBox'), term)); });
es.addEventListener('data', (ev) => { term.write(b64bytes(ev.data), () => scEnsureCursorVisible($('termBox'), term)); });
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
  // 重连成功（首轮 open 也走这里，hello 尚未到、仅清屏无害）。follow 复位
  // （P-20261123-2）：重播种后的内容从新屏开始，之前的阅读位置已无意义——等
  // 随后的 hello 经 scEnsureCursorVisible(force) 定位到光标行
  if (!ended) { term.reset(); scFollowReset($('termBox')); }
};

// 合并入口条（P-20261119-3）：协作/留言两条独立入口条并单条双入口的条壳
// （entrybar.go 单一事实源；先于两挂载脚本执行——它们按条壳在场与否选
// chip/独立条形态）
{{.EntryJS}}
// 访客留言板（P-20261006-13）：页底留言区（三形态访客页同一段脚本，
// 单一事实源 guestboard.go；只读的是终端流，留言是另一条带防线的回流面）
// 协作位（P-20261024-1）：素材上行 + 直通输入（开关在场才挂载，collabpage.go
// 单一事实源——合并条内 chip 形态或独立条，是另一条带防线的回流面，
// 非终端按键通道）
// 可写位（P-20261106-8）：WS 上行键入直注（开关在场才挂载，writablepage.go
// 单一事实源——hello 前不开输入，出域警示随页首横幅右段常驻，粘贴危险块
// 服务端预检）
{{.CollabJS}}
{{.WritableJS}}
{{.BoardJS}}
</script>
</body>
</html>`

var termPageTmpl = template.Must(template.New("termlive").Parse(termPageTmplSrc))

// renderTermPage 输出终端直播访客页（已知 token；调用方已做 lookup）。
// wm 为溯源水印文本（P-20261005-193，空串 = 未开水印）。collab 为记录上的
// 协作开关（P-20261024-1），unfiltered 为记录的未过滤标记（P-20261106-9）
// ——横幅位换「未过滤」警示，guestInput 为申请通道在场（P-20261121-1 统一
// 收编：申请通道缺省开，owner 关闭即 false），writable 为开放直入开关
// （P-20261106-8）——缺省全关时页面零协作/输入位（存量语义）
func renderTermPage(w io.Writer, token, lang, title, wm string, collab, guestInput, unfiltered, writable bool) error {
	boot, err := json.Marshal(termBootState{
		Token: token, Lang: lang, Dict: termDictFor(lang), Wm: wm, Name: title,
		Collab: collab, GuestInput: guestInput, Writable: writable, MsgMax: boardMsgMax(collab),
		Unfiltered: unfiltered,
	})
	if err != nil {
		return err
	}
	// Title 无品牌前缀（P-20261118-9）：h1 与标签页标题 = 纯分享名——访客页
	// 呈现会话本身，「Codecombo 终端 1」的品牌前缀双重出现同根移除；品牌身份
	// 由页脚 poweredBy 承载，IM/邮件网关识别度语义在文件分享页 meta 层独立
	//（page.go fallbackTitle 保持）
	return termPageTmpl.Execute(w, termPageData{
		Lang:        lang,
		Title:       title,
		Boot:        template.JS(boot),
		BoardCSS:    template.CSS(guestBoardCSS),
		BoardJS:     template.JS(guestBoardJS),
		CollabCSS:   template.CSS(collabCSS),
		CollabJS:    template.JS(collabJS),
		LayoutCSS:   template.CSS(termLayoutCSS),
		LayoutJS:    template.JS(termLayoutJS),
		Unfiltered:  unfiltered,
		WritableCSS: template.CSS(writableCSS),
		WritableJS:  template.JS(writableJS),
		EntryCSS:    template.CSS(entryBarCSS),
		EntryJS:     template.JS(entryBarJS),
		ThemeCSS:    template.CSS(GuestThemeCSS),
		ThemeJS:     template.JS(guestThemeJS),
		DragJS:      template.JS(guestDragGuardJS),
	})
}
