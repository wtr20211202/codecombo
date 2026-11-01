package share

// 分享访客页双语词典（P-20261007-22 纯搬运自 page.go，零逻辑改动）：
// bootState 注入页面的启动载荷，dictZh/dictEn 按请求语言二选一（dictFor），
// 词典键是页面模板与访客 JS 的文案契约

type bootState struct {
	Token string            `json:"token"`
	Lang  string            `json:"lang"`
	Dict  map[string]string `json:"dict"`
	// Wm 溯源水印文本（P-20261005-193；空串 = 记录未开水印，页面不出水印层）
	Wm string `json:"wm,omitempty"`
	// MsgMax 留言板上限（协作通道 2000 / 缺省 500，P-20261024-1 boardMsgMax
	// 同源下发——本页无协作位（v1 只挂终端直播页），留言升档生效）
	MsgMax int `json:"msgMax,omitempty"`
}

var dictZh = map[string]string{
	"appTitle":            "文件分享",
	"download":            "下载",
	"downloadZip":         "下载 ZIP",
	"folder":              "文件夹",
	"file":                "文件",
	"colName":             "名称",
	"colSize":             "大小",
	"colModified":         "修改时间",
	"emptyDir":            "此目录为空",
	"unsupportedTip":      "该格式暂不支持在线预览，可下载后查看",
	"textTooLarge":        "文件超过预览大小限制，仅提供下载",
	"errorShareNotFound":  "分享不存在或已被取消",
	"errorShareNotFoundD": "链接可能已失效，请联系分享者重新生成。",
	"errorTargetGone":     "分享的项目已不可用",
	"errorTargetGoneD":    "该项目已被移除或服务端无法访问其目录。",
	"errorTargetMissing":  "文件不存在或已被移动/删除",
	"errorTargetMissingD": "分享仍然有效，文件恢复后可再次访问。",
	"errorLoad":           "加载失败，请重试",
	"loading":             "加载中…",
	"kindLabel":           "类型",
	"sizeLabel":           "大小",
	"modifiedLabel":       "修改时间",
	"poweredBy":           "由 Codecombo 提供",
	"notFoundDesc":        "你访问的分享链接不存在或已被取消。",
	"notFoundHeading":     "链接不存在或已失效",
	"notFoundHint":        "请核对链接是否完整，或联系分享者重新获取",
	"expiredHeading":      "链接已过期",
	"expiredDesc":         "该分享设置的有效期已到，短链随之失效。",
	"expiredHint":         "如仍需查看，请联系分享者重新获取",
	// 一次性分享已消费（P-20261006-27）：与「已过期」刻意区分的语境——
	// 告知访客是「已被查看」触发的焚毁，而非有效期到了
	"consumedHeading":  "此分享已被查看并失效",
	"consumedDesc":     "这是一次性分享（阅后即焚），首次被查看后的短暂宽限已过，链接随之失效。",
	"consumedHint":     "如仍需查看，请联系分享者重新获取新链接",
	"copy":             "复制",
	"copied":           "已复制",
	"copyLink":         "复制页面链接",
	"copyPageShort":    "页面链接",
	"linkCopied":       "页面链接已复制",
	"copyDownloadLink": "复制下载链接",
	"dlLinkCopied":     "下载链接已复制",
	"copyFailed":       "复制失败，请手动选择复制",
	"copyAll":          "复制全文",
	"wrapLines":        "自动换行",
	"lineNumbers":      "行号",
	"largeFilePlain":   "文件较大：已关闭行号与高亮，换行与复制仍可用",
	"openNewTab":       "新标签打开",
	// 目录头摘要（P-20261020-11）：列表接口的 entries/size 前端汇总
	"dirSummary":        "{count} 项 · 共 {size}",
	"exportImage":       "导出图片",
	"exportTip":         "将当前预览导出为 2 倍高清图片（标题 + 内容，不含操作按钮），支持 PNG/JPEG/WebP；超长内容会截断",
	"exportUnsupported": "该预览类型（内嵌 PDF/HTML/媒体）不支持导出图片，可下载后查看",
	"exporting":         "生成中…",
	"exportFailed":      "导出失败，请重试",
	"exportPreview":     "导出预览",
	"exportFmtPng":      "PNG · 无损",
	"exportFmtJpeg":     "JPEG · 更小",
	"exportFmtWebp":     "WebP · 最小",
	"cancel":            "取消",
	"exportDone":        "图片已导出",
	"filterPlaceholder": "按名称过滤…",
	"backHome":          "返回上级",
	"theme":             "主题",
	"themeAuto":         "跟随系统",
	"themeLight":        "GitHub 浅色",
	"themeDark":         "GitHub 深色",
	"themeOneDark":      "One Dark",
	"themeDracula":      "Dracula",
	"refresh":           "刷新",
	// 阅读器顶栏动作（P-20261020-7）：全屏/新标签桌面可见，窄屏收进「⋯」
	"fullscreen":     "全屏",
	"exitFullscreen": "退出全屏",
	"newTab":         "新标签打开",
	"moreActions":    "更多操作",
	"fullWidth":      "全宽",
	"readingWidth":   "阅读列",
	"encodingHint":   "此文件可能不是 UTF-8 编码，部分字符或显示异常，建议下载查看",
	"mobilePdfHint":  "移动端浏览器多数无法内嵌预览 PDF，建议使用下载按钮",
	// HTML 预览保真与脚本隔离（P-20261020-4）：
	//  · 单文件分享的边界就是该 html 文件本身——同目录 css/img 不在分享内，
	//    必须诚实告知（依赖资源自动打包是后续独立件）
	//  · 脚本默认停用（sandbox 无 allow-scripts）；显式 opt-in 才在隔离
	//    沙箱中运行，确认文案要如实说明「仍可发网络请求」的残余风险
	"htmlFileNote":           "这是单文件分享：外部 CSS/图片等资源不会随文件生效，建议分享 HTML 所在文件夹",
	"htmlScriptOff":          "脚本已默认停用，动态内容可能显示不全",
	"htmlScriptOn":           "脚本已在隔离沙箱中运行（无法读取本应用登录态）",
	"htmlScriptRun":          "运行脚本（隔离）",
	"htmlScriptStop":         "停止脚本",
	"htmlScriptConfirmTitle": "运行页面脚本？",
	"htmlScriptConfirmBody":  "脚本将在隔离沙箱中运行：不能读取本应用的登录态或数据、不能提交表单或打开弹窗，但仍可向网络发送请求，并可任意改动本页内容与外观。仅在你信任该页面来源时继续。",
	"htmlScriptConfirmOk":    "仍要运行",
	"csvTruncated":           "文件较大，仅渲染前 {n} 行",
	"outline":                "大纲",
	"snippetLabel":           "文本片段",
	"snippetExpiresAt":       "该片段将于 {time} 自动过期",
	// 冻结快照时点横幅（P-20261005-168）：frozen 记录访客面的内容时点声明
	// ——定格是特性不是错误，中性陈述语气；live 记录不出本条（横幅不渲染）
	"snapshotBanner": "内容快照于 {time}——此后的源项目改动不影响本页",
	// 链接元信息（P-20261020-11）：服务端直出 title/description/OG——
	// 聊天工具/邮件网关不执行页面 JS，首屏 HTML 必须自带文件名与说明。
	// 口令/一次性分享（Sensitive）只走 metaDescGeneric，绝不把记录字段
	// 写进任何元信息（未解锁前的预览抓取面不得泄露文件名/项目名）
	"metaDescGeneric":   "通过 Codecombo 分享的内容，打开链接查看。",
	"metaDescFile":      "{name} · 来自项目 {project} 的文件分享",
	"metaDescFilePlain": "{name} · 文件分享",
	"metaDescDir":       "{name} · 来自项目 {project} 的文件夹分享",
	"metaDescDirPlain":  "{name} · 文件夹分享",
	"metaDescSnippet":   "文本片段 · {name}",
	// 有效期弱提示（P-20261020-5）：非永久分享在访客页声明到期时点
	"shareExpiresAt": "此链接将于 {time} 过期",
	// 访问口令门（P-20261006-25）：口令页文案
	"gateHeading":     "此分享受口令保护",
	"gateDesc":        "输入分享者提供的访问口令后继续查看内容",
	"gatePlaceholder": "访问口令",
	"gateSubmit":      "解锁查看",
	"gateError":       "口令不正确，请重试",
	"gateLimited":     "尝试次数过多，请稍后再试",
	// 一次性分享显式确认页（P-20261020-3）：标题/描述刻意泛化，不含
	// 文件名/分享名/项目名——确认页会先于收件人被预览抓取命中，任何
	// 记录字段都不该在这层泄露
	"confirmHeading": "这是一条一次性分享",
	"confirmDesc":    "点击「查看内容」后 {minutes} 分钟内有效，超时后链接将自动失效。",
	"confirmHint":    "确认后仅当前浏览器可查看；刷新页面不会重新计时。",
	"confirmSubmit":  "查看内容",
	"confirmLimited": "操作过于频繁，请稍后再试",
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

var dictEn = map[string]string{
	"appTitle":            "File Share",
	"download":            "Download",
	"downloadZip":         "Download ZIP",
	"folder":              "Folder",
	"file":                "File",
	"colName":             "Name",
	"colSize":             "Size",
	"colModified":         "Modified",
	"emptyDir":            "This folder is empty",
	"unsupportedTip":      "Preview is not available for this format. You can download it instead.",
	"textTooLarge":        "File exceeds the preview size limit. Download is still available.",
	"errorShareNotFound":  "Share not found or revoked",
	"errorShareNotFoundD": "This link may have expired. Please ask the owner for a new one.",
	"errorTargetGone":     "Shared project is unavailable",
	"errorTargetGoneD":    "The project was removed or its directory is not accessible.",
	"errorTargetMissing":  "File is missing, moved or deleted",
	"errorTargetMissingD": "The share is still valid; visit again once the file is restored.",
	"errorLoad":           "Failed to load, please retry",
	"loading":             "Loading…",
	"kindLabel":           "Type",
	"sizeLabel":           "Size",
	"modifiedLabel":       "Modified",
	"poweredBy":           "Powered by Codecombo",
	"notFoundDesc":        "The share link you visited does not exist or has been revoked.",
	"notFoundHeading":     "This link doesn't exist or has been revoked",
	"notFoundHint":        "Double-check the link is complete, or ask the owner for a new one.",
	"expiredHeading":      "This link has expired",
	"expiredDesc":         "The validity period set for this share has ended, so the link is no longer available.",
	"expiredHint":         "If you still need access, ask the owner for a new link.",
	// View-once consumed (P-20261006-27): distinct from "expired" — tells the
	// visitor the share burned because it was viewed, not that time ran out
	"consumedHeading":  "This share has been viewed and is no longer available",
	"consumedDesc":     "This is a view-once (burn-after-reading) share: the short grace window after the first view has passed, so the link is gone.",
	"consumedHint":     "If you still need access, ask the owner for a new link.",
	"copy":             "Copy",
	"copied":           "Copied",
	"copyLink":         "Copy page link",
	"copyPageShort":    "Page link",
	"linkCopied":       "Page link copied",
	"copyDownloadLink": "Copy download link",
	"dlLinkCopied":     "Download link copied",
	"copyFailed":       "Copy failed — select the text and copy manually",
	"copyAll":          "Copy all",
	"wrapLines":        "Wrap lines",
	"lineNumbers":      "Line numbers",
	"largeFilePlain":   "Large file: line numbers and highlighting are off; wrap and copy still work",
	"openNewTab":       "Open in new tab",
	// Directory header summary (P-20261020-11): aggregated from list entries/sizes
	"dirSummary":        "{count} items · {size} total",
	"exportImage":       "Export image",
	"exportTip":         "Export the current preview as a 2x image (title + content, no controls) — PNG/JPEG/WebP; very long content is truncated",
	"exportUnsupported": "This preview type (inline PDF/HTML/media) cannot be exported as an image. Download instead",
	"exporting":         "Rendering…",
	"exportFailed":      "Export failed, try again",
	"exportPreview":     "Export Preview",
	"exportFmtPng":      "PNG · lossless",
	"exportFmtJpeg":     "JPEG · smaller",
	"exportFmtWebp":     "WebP · smallest",
	"cancel":            "Cancel",
	"exportDone":        "Image exported",
	"filterPlaceholder": "Filter by name…",
	"backHome":          "Up one level",
	"theme":             "Theme",
	"themeAuto":         "Auto (system)",
	"themeLight":        "GitHub Light",
	"themeDark":         "GitHub Dark",
	"themeOneDark":      "One Dark",
	"themeDracula":      "Dracula",
	"refresh":           "Refresh",
	// Reader top-bar actions (P-20261020-7): desktop-visible; ≤700px folds into "⋯"
	"fullscreen":     "Fullscreen",
	"exitFullscreen": "Exit fullscreen",
	"newTab":         "Open in new tab",
	"moreActions":    "More actions",
	"fullWidth":      "Full width",
	"readingWidth":   "Reading width",
	"encodingHint":   "This file may not be UTF-8 encoded; some characters may look wrong. Download for best results.",
	"mobilePdfHint":  "Mobile browsers often cannot preview PDFs inline — use Download instead.",
	// HTML preview fidelity + script isolation (P-20261020-4): a single-file share
	// contains only the html file (sibling css/img are outside the boundary);
	// scripts stay disabled until the visitor explicitly opts in, and the confirm
	// copy states the residual risk (sandboxed scripts can still make requests)
	"htmlFileNote":           "This is a single-file share: external CSS/images are not included. Share the containing folder instead.",
	"htmlScriptOff":          "Scripts are disabled by default; dynamic content may not render fully",
	"htmlScriptOn":           "Scripts are running in an isolated sandbox (no access to this app's sessions)",
	"htmlScriptRun":          "Run scripts (isolated)",
	"htmlScriptStop":         "Stop scripts",
	"htmlScriptConfirmTitle": "Run page scripts?",
	"htmlScriptConfirmBody":  "Scripts will run in an isolated sandbox: they cannot read this app's sessions or data, submit forms, or open popups — but they can still make network requests and arbitrarily change this page's content and appearance. Continue only if you trust the page's source.",
	"htmlScriptConfirmOk":    "Run anyway",
	"csvTruncated":           "Large file: only the first {n} rows are rendered.",
	"outline":                "Outline",
	"snippetLabel":           "Text snippet",
	"snippetExpiresAt":       "This snippet expires automatically at {time}.",
	// Frozen-snapshot time banner (P-20261005-168): content-time declaration for
	// frozen shares — freezing is a feature, not an error, so neutral wording;
	// live shares never render it
	"snapshotBanner": "Content snapshot from {time} — later changes to the source project do not affect this page.",
	// Link metadata (P-20261020-11): server-rendered title/description/OG —
	// chat tools and mail gateways do not run page JS, so the first HTML byte
	// must carry the file name and explanation. Protected shares (Sensitive)
	// only use metaDescGeneric; no record fields may leak into metadata.
	"metaDescGeneric":   "Content shared via Codecombo. Open the link to view it.",
	"metaDescFile":      "{name} · a file shared from project {project}",
	"metaDescFilePlain": "{name} · file share",
	"metaDescDir":       "{name} · a folder shared from project {project}",
	"metaDescDirPlain":  "{name} · folder share",
	"metaDescSnippet":   "Text snippet · {name}",
	// Validity hint (P-20261020-5)
	"shareExpiresAt": "This link expires at {time}.",
	// 访问口令门（P-20261006-25）：口令页文案
	"gateHeading":     "This share is password protected",
	"gateDesc":        "Enter the passphrase provided by the sender to view the content.",
	"gatePlaceholder": "Passphrase",
	"gateSubmit":      "Unlock",
	"gateError":       "Incorrect passphrase, please try again.",
	"gateLimited":     "Too many attempts. Please try again later.",
	// One-time share confirmation page (P-20261020-3): deliberately generic
	// title/description — no file/share/project name. Preview crawlers may hit
	// this page before the recipient, so no record fields may leak here.
	"confirmHeading": "This is a one-time share",
	"confirmDesc":    "Click \"View content\" to open it. The link stays valid for {minutes} minutes after you confirm, then expires automatically.",
	"confirmHint":    "After confirmation only this browser can open the content; refreshing does not restart the window.",
	"confirmSubmit":  "View content",
	"confirmLimited": "Too many attempts. Please try again later.",
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

func dictFor(lang string) map[string]string {
	if lang == "zh" {
		return dictZh
	}
	return dictEn
}
