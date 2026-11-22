package filepreview

import (
	"html/template"
	"net/http"
	"net/url"
)

// ── 嵌入对象新标签预览器壳页（P-20261118-3 主刀③；P-20261119-1 开关区折叠；
// P-20261119-4 自 share embedshell.go 抽包下沉+端点参数化——share/api 两侧
// 嵌入端点共用同一模板，差异面收敛进 EmbedShellCfg；P-20261120-2 全幅预览
// 模式 &full=1） ──
//
// GET …/docx-embed?path=&e=&ui=1（路由定 &ui=1，评审建议a：单端点单 URL
// 词表，gate/resolve/白名单链全复用）。html/htm 档预览从「文档内嵌 iframe
// 撑乱阅读列」（用户实测主诉①）改为新标签打开本壳页：标题行（名+大小+
// 下载链接同行常驻，两模式形态一致）+ 开关区（两级开关+风险注记——
// 修订二/三全部语义与硬红线迁入；P-20261119-1 起默认收起，用户实测
// 「三行常驻太遮挡视线」）+ 自适应 iframe 承载原型。
//
// 全幅预览模式（P-20261120-2，&full=1；用户实测主诉：同一原型弹窗本地
// file:// 打开完整、壳页预览顶部被裁——真弹窗 overlay 形态内容高于视口
// 以中心锚上下对称溢出顶部不可达，壳页头部 ~69px 是加重因素：本地视口
// 放得下、壳页 iframe 高=视口−头部恰好放不下）：full=1 时 header 整体
// 条件不渲染（服务端条件渲染，零死 DOM）、iframe 占满 100vh——恰好补回
// 头部高度，弹窗完整度与本地打开对齐。零 JS 纯 URL 参数实现（CSP
// default-src 'none' 禁脚本红线不动）：常规态标题行加「全幅预览 ⤢」
// 入口链接、全幅态右下角固定小圆钮退出（title 双语）。full 分支以预览器
// 模式为前提（评审必改1）：诚实回落态页面唯一内容就是 header，回落态
// full=1 直接忽略按常规渲染。与 P-20261119-1 折叠互补不冲突：折叠=收
// 开关区、全幅=整头部消失；全幅态开关表单不渲染（改开关=退出→改→重进
// 两跳，克隆式互转 URL 携带 scripts/forms 态往返无损）。
//
// 零 JS 纪律：开关切换 = form GET（checkbox+应用按钮带参重渲染）；confirm()
// 在零 JS 下不可用（评审必改⑤），scripts 开关用「风险确认 checkbox+应用
// 按钮」两段式承接修订二显式确认语义——勾选即知悉风险文案、点应用才生效。
// 折叠交互（P-20261119-1）用原生 details/summary：default-src 'none' 下唯一
// 同时满足零 JS/语义/键盘可达/支持面的方案；无 open 属性=默认收起，点
// summary 展开/再点收起。风险提示常驻语义保真：收起态 summary 仍常驻
// 一行状态徽标（三态文案+full 档短警示 StateHint 行内缀——收起态唯一
// 常驻告知面就是这行），完整注记在 details 体内点开可见。
//
// 布局自适应（P-20261119-1 魔数高度退役）：body flex column + header
// flex:none + iframe flex:1 min-height:0——details 开合是纯 CSS 即时重排
//（不重载页面），头部高度变化由 flex 自动吸收，iframe 恒占余幅；全幅态
// iframe 高度零新规则（评审建议4）：header 缺席时 iframe 是唯一流内子
// 元素自然占满 100vh，浮动退出钮 position:fixed 出流不占位。
//
// 分层安全语义：壳页本身是顶级文档（不覆写 XFO，全局 DENY 生效——壳页
// 不该被任何页面嵌套，评审建议e；CSP form-action 'self' 先例组合 +
// frame-src 'self'）；iframe 承载的原型字节面走既有 preview=1 响应
//（EmbedSandboxCSP sandbox + XFO SAMEORIGIN 覆写，CFB 正文抽取+编码规范化
// 在响应侧，壳页零字节面净化职责）——iframe sandbox 属性与响应 CSP 同表
// 产出（EmbedSandboxTokensFor），两层取交集、互斥规则一致，硬红线构造性
// 不变：任何组合绝不 allow-same-origin/allow-top-navigation。full 参数
// 只走壳页自身渲染分型，不进 iframe src 不进 sandbox 词表。

// embedShellCSP 壳页 enforcing CSP（全局页 CSP 被 Set 替换——本页有
// 交互表单与 iframe，逐页收紧同 share writeGate 先例）：表单提交锁同源
// （form GET 自提交面）、iframe 只认同源（原型字节面在 embed 端点同服务）；
// 无脚本无外链，default-src 'none' 兜底
const embedShellCSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; " +
	"form-action 'self'; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'"

// embedShellTemplate 壳页模板（零外部依赖：内联样式深浅双态跟随系统；
// 上下文转义由 html/template 承担——还原文件名/URL 任意字节安全出头）。
// FrameSrc 空 = 诚实回落模式（P-20261118-7 ④）：无 iframe 无开关无折叠
// （无开关可折——<details> 整体缺席是 fallback 守卫断言面），只有标题行
// （下载链接同行）+ 暂不支持提示
var embedShellTemplate = template.Must(template.New("embedshell").Parse(
	`<!doctype html>
<html lang="{{if eq .Lang "zh"}}zh-CN{{else}}en{{end}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>{{.Title}}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
background:#f4f6fb;color:#1f2328;height:100vh;display:flex;flex-direction:column}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}}
.shell-head{padding:10px 16px;border-bottom:1px solid #d0d7de;background:#ffffff;flex:none}
@media (prefers-color-scheme:dark){.shell-head{border-color:#30363d;background:#161b22}}
.shell-title{font-weight:600;overflow-wrap:anywhere;display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px}
.shell-size{font-weight:400;font-size:.85em;opacity:.72}
.shell-note{margin-top:4px;font-size:12.5px;opacity:.82}
/* 开关区折叠（P-20261119-1）：summary 三角指示符跨浏览器自绘——display:flex
已使默认 marker 失位（list-item 语义消失），list-style:none +
::-webkit-details-marker{display:none} 兜 Safari 旧渲染路径，::after
自绘三角随开合旋转；user-select 防双击选中态干扰再点收起 */
.shell-ctl{margin-top:6px}
.shell-ctl summary{display:flex;align-items:baseline;gap:6px;list-style:none;cursor:pointer;
font-size:12.5px;opacity:.88;user-select:none}
.shell-ctl summary::-webkit-details-marker{display:none}
.shell-ctl summary:hover{opacity:1}
.shell-ctl summary::after{content:"▸";margin-left:auto;font-size:10px;color:#57606a;
transition:transform .15s ease}
.shell-ctl[open] summary::after{transform:rotate(90deg)}
@media (prefers-color-scheme:dark){.shell-ctl summary::after{color:#8b949e}}
.shell-state{opacity:.75}
.shell-state-hint{color:#9a6700;font-weight:600}
@media (prefers-color-scheme:dark){.shell-state-hint{color:#d29922}}
.shell-bar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:8px}
.shell-form{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin:0}
.shell-opt{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;cursor:pointer}
.shell-opt input{accent-color:#6a5cff;margin:0}
.shell-apply{border:1px solid #6a5cff;background:transparent;color:#6a5cff;border-radius:999px;
padding:3px 14px;font-size:12.5px;cursor:pointer}
.shell-apply:hover{background:#6a5cff;color:#fff}
@media (prefers-color-scheme:dark){.shell-apply{border-color:#ab7df8;color:#ab7df8}
.shell-apply:hover{background:#ab7df8;color:#fff}}
.shell-dl{font-size:12.5px;color:#0969da;overflow-wrap:anywhere;font-weight:400;margin-left:auto}
@media (prefers-color-scheme:dark){.shell-dl{color:#58a6ff}}
/* 全幅预览（P-20261120-2）：常规态标题行入口链接循 .shell-dl 同族排版
（同一 flex gap 行内、下载链接 margin-left:auto 推右后紧随），全幅态
header 整体不渲染、无 CSS 隐藏死 DOM；退出圆钮 position:fixed 出流不占位
——iframe 仍是 body（100vh flex column）唯一流内子元素，flex:1 自然占满
视口（评审建议4 零新高度规则） */
.shell-full{font-size:12.5px;color:#6a5cff;overflow-wrap:anywhere;font-weight:400}
@media (prefers-color-scheme:dark){.shell-full{color:#ab7df8}}
.shell-full-exit{position:fixed;right:14px;bottom:14px;width:36px;height:36px;border-radius:50%;
display:flex;align-items:center;justify-content:center;text-decoration:none;font-size:16px;
background:#ffffff;border:1px solid #6a5cff;color:#6a5cff;box-shadow:0 1px 4px rgba(31,35,40,.18)}
.shell-full-exit:hover{background:#6a5cff;color:#fff}
@media (prefers-color-scheme:dark){.shell-full-exit{background:#161b22;border-color:#ab7df8;color:#ab7df8}
.shell-full-exit:hover{background:#ab7df8;color:#fff}}
/* iframe 高度自适应（P-20261119-1 魔数高度退役）：flex:1 min-height:0 恒占
header 余幅——details 开合重排由 flex 吸收，不重载页面；窄屏分支一并简化
（高度不再依赖视口魔数，无媒体查询需要） */
.shell-frame{display:block;width:100%;flex:1;min-height:0;border:0;background:#fff}
@media (prefers-color-scheme:dark){.shell-frame{background:#161b22}}
</style>
</head>
<body>
{{if not (and .FrameSrc .Full)}}<header class="shell-head">
  <div class="shell-title">📎 {{.Title}} <span class="shell-size">{{.Size}}</span><a class="shell-dl" href="{{.DownloadURL}}">{{.DownloadLabel}}</a>{{if and .FrameSrc (not .Full)}}<a class="shell-full" href="{{.FullURL}}">⤢ {{.FullLabel}}</a>{{end}}</div>
  {{if .FrameSrc}}<details class="shell-ctl">
    <summary>⚙ {{.CtlTitle}} <span class="shell-state">{{.StateLabel}}</span>{{if .StateHint}} <span class="shell-state-hint">{{.StateHint}}</span>{{end}}</summary>
    <div class="shell-note">{{.Note}}</div>
    <div class="shell-bar">
      <form class="shell-form" method="get" action="{{.Action}}">
        <input type="hidden" name="path" value="{{.Path}}">
        <input type="hidden" name="e" value="{{.Entry}}">
        <input type="hidden" name="ui" value="1">
        <label class="shell-opt"><input type="checkbox" name="scripts" value="1"{{if .ScriptsOn}} checked{{end}}> {{.ScriptsLabel}}</label>
        {{if .ScriptsOn}}<label class="shell-opt"><input type="checkbox" name="forms" value="1"{{if .FormsOn}} checked{{end}}> {{.FormsLabel}}</label>{{end}}
        <button type="submit" class="shell-apply">{{.ApplyLabel}}</button>
      </form>
    </div>
  </details>{{end}}
  {{if not .FrameSrc}}<div class="shell-note">{{.Note}}</div>{{end}}
</header>{{end}}
{{if .FrameSrc}}<iframe class="shell-frame" src="{{.FrameSrc}}" sandbox="{{.Sandbox}}" title="{{.Title}}"></iframe>{{end}}
{{if and .FrameSrc .Full}}<a class="shell-full-exit" href="{{.ExitURL}}" title="{{.FullExitTitle}}" aria-label="{{.FullExitTitle}}">⤢</a>{{end}}
</body>
</html>`))

// embedShellData 壳页渲染数据（转义归 html/template）。CtlTitle/StateLabel/
// StateHint 为 P-20261119-1 收起态 summary 常驻徽标行：三态文案 Go 层预推导
// （模板无 dict 访问能力）；StateHint 仅 full 档非空——收起态唯一常驻告知
// 面=summary 行，最危险一档的「请勿输入真实凭据」要点必须钉在这行。
// Full/FullURL/ExitURL 为 P-20261120-2 全幅模式：Full 仅在预览器模式下
// 才为 true（回落态 full=1 忽略——评审必改1，模板侧 {{if and .FrameSrc .Full}}
// 双保险同语义）；FullURL/ExitURL 由现请求 query 克隆 set/del full 派生
// （评审必改2），FullLabel/FullExitTitle 为入口/退出双语文案
type embedShellData struct {
	Lang, Title, Size, Note                       string
	Action, Path, Entry                           string
	ScriptsLabel, FormsLabel, ApplyLabel          string
	CtlTitle, StateLabel, StateHint               string
	DownloadLabel, DownloadURL, FrameSrc, Sandbox string
	FullLabel, FullURL, ExitURL, FullExitTitle    string
	ScriptsOn, FormsOn, Full                      bool
}

// EmbedShellCfg 壳页装配的端点差异面（P-20261119-4 参数化复用，评审建议2：
// share 侧 Endpoint="/s/{token}/docx-embed"、api 侧
// Endpoint="/api/projects/:id/file/embed"——form action 与下载/iframe URL
// 全由本基座派生）。Path/Entry 原样进 hidden 域与 URL 查询（端点侧 Query
// 语义无感）
type EmbedShellCfg struct {
	Endpoint string // 嵌入端点裸路径（不含 query）
	Path     string // path= 参数值
	Entry    string // e= 参数值
}

// ServeEmbedShell ui=1 分型：渲染预览器壳页。返回 false=白名单未命中
// （调用方落回 attachment——与 preview=1 同语义）。payload 由调用方经
// 统一抽取判定 EmbedPreviewPayload 预算（P-20261118-7 评审必改2：与
// preview=1 供给面同链判定防漂移）：
//
//	payload != nil → 预览器模式（注记条+两段式开关+全幅 iframe 承载
//	                 preview=1 字节面——壳页零字节面净化职责）；
//	payload == nil → **诚实回落模式**（P-20261118-7 ④，用户实测主诉
//	                 「点预览弹出下载框」）：不再整页回落 attachment 静默
//	                 下载，改渲染标题+「该附件结构暂不支持自动预览，可
//	                 下载查看」+下载按钮的诚实页——点「预览」至少得到
//	                 明确交代。
func ServeEmbedShell(w http.ResponseWriter, r *http.Request, name string, size int64, payload []byte, cfg EmbedShellCfg) bool {
	if _, _, ok := EmbedPreviewFor(name); !ok {
		return false
	}
	lang := prefLang(r)
	d := dictFor(lang)
	dlURL := DocxEmbedURL(cfg.Endpoint, cfg.Path, cfg.Entry)
	q := r.URL.Query()
	// 全幅/退出互转 URL（评审必改2）：现请求 query 克隆后 set/del full 键、
	// Encode 回拼 r.URL.Path——绝不手工重拼「endpoint?path&e&ui&full」：
	// scripts/forms 是独立 query 键（下方独立读）且 pvParams 由 query 推导，
	// 手工重拼会把 scripts=1/forms=1 吃掉恰好吃掉要保的状态；克隆改单键
	// 天然覆盖 scripts=1&forms=1&full=1 组合完整性，两方向同法互为镜像
	fullToggleURL := func(on bool) string {
		v := url.Values{}
		for k, vs := range q {
			v[k] = append([]string(nil), vs...)
		}
		if on {
			v.Set("full", "1")
		} else {
			v.Del("full")
		}
		return r.URL.Path + "?" + v.Encode()
	}
	data2 := embedShellData{
		Lang:          lang,
		Title:         name,
		Size:          fmtSize(size),
		DownloadLabel: d["download"],
		DownloadURL:   dlURL,
		FullURL:       fullToggleURL(true),
		ExitURL:       fullToggleURL(false),
		FullLabel:     d["embedShellFull"],
		FullExitTitle: d["embedShellFullExit"],
	}
	if payload == nil {
		// 诚实回落模式：附件结构抽不出正文（含锚点回退也失败）——iframe
		// 里也只会回落 attachment（面一致性），与其让壳页开着空 iframe，
		// 不如给明确交代+下载出口（诊断枚举/日志在端点侧收口）。Full 留
		// false：回落态页面唯一内容就是 header，full=1 直接忽略按常规渲染
		//（评审必改1——无门禁则回落态全幅=无 header 无 iframe 空白页）
		data2.Note = d["embedShellUnsupported"]
	} else {
		// 预览器模式：壳页 UI 两开关推导态（修订二/三语义迁入）：scripts=
		// 一级「运行脚本」、forms=二级「允许表单与弹窗」单开关（组合语义
		// 随表单档同步携带 popups——与旧 JS LEVELS[2] 同形）；直连 preview
		// URL 的裸 popups 参数不进壳页推导（异形组合留给直连 8 组合面）
		scriptsOn := q.Get("scripts") == "1"
		formsOn := q.Get("forms") == "1"
		pvParams := ""
		if scriptsOn {
			pvParams += "&scripts=1"
			if formsOn {
				pvParams += "&forms=1&popups=1"
			}
		}
		note := d["embedNoteOff"]
		if scriptsOn && formsOn {
			note = d["embedNoteFull"]
		} else if scriptsOn {
			note = d["embedNoteScriptsOn"]
		}
		// 收起态徽标三态文案（P-20261119-1）：与上方 note 三态推导同址同风格
		// ——Go 层预推导。StateHint 仅 full 档非空：收起态 summary 徽标行是
		// 唯一常驻告知面，最危险一档的「请勿输入真实凭据」要点必须在这行
		//（service_test 收起态源断言+e2e 收起态 summary 断言各钉一条）
		state := d["embedShellStateOff"]
		stateHint := ""
		if scriptsOn && formsOn {
			state = d["embedShellStateFull"]
			stateHint = d["embedShellStateHint"]
		} else if scriptsOn {
			state = d["embedShellStateScripts"]
		}
		data2.CtlTitle = d["embedShellCtlTitle"]
		data2.StateLabel = state
		data2.StateHint = stateHint
		// form action 是裸端点路径，path/e/ui 以 hidden 域携带——HTML form GET
		// 语义：提交序列化会用表单字段整体替换 action URL 的 query string（实测
		// 踩坑：action 带全参 query 时 checkbox 提交后 path/e 丢失，端点 resolve
		// 落根目录 → not_renderable 错误页）；hidden 域值由浏览器按
		// application/x-www-form-urlencoded 百分号编码（/→%2F、CJK→UTF-8%），与
		// url.QueryEscape 产出同形，端点侧 url.Query().Get 无感
		data2.Note = note
		data2.Action = cfg.Endpoint
		data2.Path = cfg.Path
		data2.Entry = cfg.Entry
		data2.ScriptsLabel = d["embedShellScripts"]
		data2.FormsLabel = d["embedFormsToggle"]
		data2.ApplyLabel = d["embedShellApply"]
		data2.FrameSrc = dlURL + "&preview=1" + pvParams
		data2.Sandbox = EmbedSandboxTokensFor(scriptsOn, formsOn, formsOn)
		data2.ScriptsOn = scriptsOn
		data2.FormsOn = formsOn
		// 全幅模式分型（P-20261120-2）：仅预览器模式生效（评审必改1——
		// FrameSrc 非空前提，模板 {{if and .FrameSrc .Full}} 同语义双保险）；
		// full 只走壳页渲染分型，不进 FrameSrc（iframe src 参数链不变），
		// pvParams 原样携带 scripts/forms 态
		data2.Full = q.Get("full") == "1"
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", embedShellCSP)
	// 顶级文档不覆写 XFO（评审建议e）：全局 DENY 生效——与 iframe 内层
	// preview 响应的 SAMEORIGIN 覆写刻意区分（内层要被壳页嵌、壳页不被嵌）
	return embedShellTemplate.Execute(w, data2) == nil
}
