package quickdrop

import (
	"bytes"
	"html/template"
	"net/http"

	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 访客投递页（P-20261006-51）：GET/POST /drop/:token。与 Share 访客页同形态
// ——零外部依赖的单文件 HTML（无 JS：原生 form POST，CSP 最小面），手机浏览器
// 直开直投。token 即门禁：无效/未生成/已撤销一律 404 品牌页（与 POST
// /api/quickdrop 同口径——不暴露端点存在性）。
//
// 提交成功走 303 See Other 回本页 ?sent=1（PRG：刷新不重投）；校验失败
// 重渲染表单并保留已输入内容（html/template 上下文转义）。

// dropPageTemplate 渲染数据
type dropPageTemplate struct {
	// Sent 本次 GET 带成功标记（?sent=1，PRG 回跳）——渲染已送达横幅
	Sent bool
	// Err 校验失败的提示文案（POST 重渲染路径；空 = 无错误）
	Err string
	// Content 校验失败时回填的已输入内容（转义由 template 承担）
	Content string
}

// dropPageHTML 投递页单文件模板（零依赖：无外部 CSS/JS/字体，系统字体栈；
// 配色用 prefers-color-scheme 跟随系统深浅——访客设备未知，不预设主题）。
// 文案双语（中文为主 + English 副行）：服务端渲染链无界面语言上下文，
// 与 share 子服务「访客页文案自持」同一决策口径
const dropPageHTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>快投递 · Quickdrop</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f5f6f8; color: #1f2328; padding: 16px;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1117; color: #e6edf3; }
    .card { background: #161b22 !important; border-color: #30363d !important; }
    textarea { background: #0d1117 !important; color: #e6edf3 !important; border-color: #30363d !important; }
    .hint { color: #8b949e !important; }
    .banner { background: #12351a !important; color: #7ee2a8 !important; }
  }
  .card {
    width: 100%; max-width: 520px; background: #fff; border: 1px solid #d0d7de;
    border-radius: 10px; padding: 24px;
  }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .sub { font-size: 12px; color: #656d76; margin: 0 0 16px; }
  label { display: block; font-size: 13px; margin-bottom: 6px; }
  textarea {
    width: 100%; min-height: 180px; resize: vertical; padding: 10px;
    font-size: 14px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    border: 1px solid #d0d7de; border-radius: 8px; background: #fff; color: inherit;
  }
  .row { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
  .hint { font-size: 12px; color: #656d76; }
  button {
    margin-left: auto; padding: 8px 20px; font-size: 14px; cursor: pointer;
    background: #1f883d; color: #fff; border: none; border-radius: 8px;
  }
  button:active { opacity: .85; }
  .banner {
    background: #e6ffec; color: #1a7f37; border-radius: 8px;
    padding: 10px 12px; font-size: 13px; margin-bottom: 14px;
  }
  .err {
    background: #ffebe9; color: #cf222e; border-radius: 8px;
    padding: 10px 12px; font-size: 13px; margin-bottom: 14px;
  }
  @media (prefers-color-scheme: dark) { .err { background: #3d1a1a; } }
</style>
</head>
<body>
<div class="card">
  <h1>快投递 · Quickdrop</h1>
  <p class="sub">把文本投递到工作台，通知中心即时到达 / Paste text and deliver it to your workbench</p>
  {{if .Sent}}<div class="banner">已送达 ✓ 工作台通知中心已入账（24 小时内有效）。Delivered — see your workbench notification center.</div>{{end}}
  {{if .Err}}<div class="err">{{.Err}}</div>{{end}}
  <form method="post" action="">
    <label for="content">内容 / Content</label>
    <textarea id="content" name="content" autofocus placeholder="报错、代码片段、想法……（≤4KB）">{{.Content}}</textarea>
    <div class="row">
      <span class="hint">送达后出现在工作台通知中心，24h 自动过期。Expires in 24h.</span>
      <button type="submit">投递 / Drop</button>
    </div>
  </form>
</div>
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

// PostDropForm POST /drop/:token——访客页表单提交（与 POST /api/quickdrop
// 共用 ingest 主链；成功 303 PRG 回跳，失败按分型重渲染 HTML：凭据问题 404
// 品牌页、内容问题表单页保留已输入内容——响应形态归本 handler 独占，
// ingest 只裁决不写响应）
func PostDropForm(c *gin.Context) {
	// 表单体上限：内容 4KB + 编码余量（超限按校验失败重渲染，不给裸 413 页）
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, dropMaxBody)
	if err := c.Request.ParseForm(); err != nil {
		renderDropPage(c, http.StatusBadRequest, dropPageTemplate{
			Err: "内容过大 / Content too large (max 4KB)",
		})
		return
	}
	_, ie := ingest(c, c.Param("token"), c.PostForm("content"))
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
// 机制的使用先例，不为单页引入 engine.SetHTMLTemplate 装配面）
func renderDropPage(c *gin.Context, status int, data dropPageTemplate) {
	var buf bytes.Buffer
	if err := dropTmpl.Execute(&buf, data); err != nil {
		// 模板是编译期已验证的静态资产，执行失败属程序错误而非访客输入问题
		c.String(http.StatusInternalServerError, "internal error")
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Header("X-Robots-Tag", "noindex")
	c.Data(status, "text/html; charset=utf-8", buf.Bytes())
}

// renderDropNotFound token 无效的品牌 404 页：与主应用 SPA 404 观感一致的最小
// 形态，不区分「无此链接/已撤销/未生成」（探不出存在性）
func renderDropNotFound(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	c.Header("X-Robots-Tag", "noindex")
	c.Data(http.StatusNotFound, "text/html; charset=utf-8", []byte(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>404 · 快投递</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
    background:#f5f6f8; color:#1f2328; }
  @media (prefers-color-scheme: dark) { body { background:#0d1117; color:#e6edf3; } }
  div { text-align:center; }
  h1 { font-size:15px; font-weight:normal; }
</style>
</head>
<body><div><h1>链接无效或已撤销 · Link not found</h1></div></body>
</html>
`))
}
