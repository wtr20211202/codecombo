package files

// 项目文件直接预览 API（P-20261119-4 S2）：主应用编辑器复用分享预览管线
// 的 auth 门控端点族——渲染/供给判定全部调 server/filepreview 单一事实源
//（与分享访客面同链：修问题/扩展格式一处生效），本文件只做各端点的源
// 解析（SafeJoinProject 同 ReadFile）与响应协议包装。
//
// 安全面（提案钉死项）：
//   - auth：与 ReadFile 同保护面（api 组 LockCSRF/Lock/TokenAuth/AgentGuard
//     四中间件，router.go 同点位挂载），比分享访客面更窄——登录态自用文件；
//   - 越界：全部经 SafeJoinProject（拒 .. 段 + EvalSymlinks 双前缀校验）；
//   - 净化：docx/csv/xlsx 渲染产物过 filepreview 既有净化链（结构化转义/
//     bluemonday），html 档走 htmlview sandbox 面（CSP sandbox+opt-in
//     scripts，绝不 allow-same-origin——父页登录态使 same-origin 泄露面
//     比分享访客更敏感，PreviewPanel SANDBOX_TOKEN 先例同构硬红线）；
//   - 白名单：docx media/embed 的 m=/e= 等值匹配映射簿（等值匹配天然免疫
//     注入，share 同款）；嵌入 preview=1/ui=1 走显式扩展名白名单
//     （EmbedPreviewFor），白名单外恒 attachment；
//   - Range/304：raw/rel/media/embed 统一 http.ServeContent（*os.File 满足
//     ReadSeeker——av 拖动/PDF 渐进加载白拿）；
//   - 审计：六端点全部过 maybeAuditSensitiveRead（raw/rel 等同下载面尤其
//     不可漏——「谁读了密钥」与 ReadFile 同台账）；
//   - 频控：非必需（api GET 无频控现势 + 64MB 解压闸 + localhost 单用户
//     自用面；如需加固挂既有 RateLimitMiddleware 即可）。

import (
	"bytes"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"

	shared "codecombo/server/api/shared"
	preview "codecombo/server/filepreview"

	"github.com/gin-gonic/gin"
)

// filePreviewMediaBase 项目内预览端点的相对基座（前端按 projectId+path 拼
// raw/htmlview/media/embed URL 的唯一落字点；*rel 通配回源端点为
// <base href> 的落点）
func filePreviewMediaBase(projectID string) string {
	return "/api/projects/" + projectID + "/file"
}

// resolvePreviewTarget 预览端点族的公共前半：path 参数 → SafeJoinProject
// → stat（目录 400/缺失 404/越界 403，错误码与 ReadFile 同族）。返回绝对
// 路径、归一相对路径与文件信息
func resolvePreviewTarget(c *gin.Context) (absPath, relPath string, info os.FileInfo, ok bool) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return "", "", nil, false
	}
	filePath := c.Query("path")
	if filePath == "" {
		shared.ErrorWithCode(c, shared.CodeFilesPathRequired, "path is required", nil)
		return "", "", nil, false
	}
	abs, err := SafeJoinProject(p.Path, filePath)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesPathOutsideRoot, err.Error(), nil)
		return "", "", nil, false
	}
	st, err := os.Stat(abs)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesNotFound, "file not found", nil)
		return "", "", nil, false
	}
	if st.IsDir() {
		shared.Error(c, http.StatusBadRequest, "path is a directory", nil)
		return "", "", nil, false
	}
	return abs, NormalizeRelPath(filePath), st, true
}

// previewLang lang 查询参数 → 渲染文案语言（评审必改3c：渲染类端点 lang
// 参数化——不传回落 Accept-Language 探测，前端按 locale 显式传 zh/en）
func previewLang(c *gin.Context, r *http.Request) string {
	switch c.Query("lang") {
	case "zh", "en":
		return c.Query("lang")
	}
	return preview.PrefLang(r)
}

// GetFilePreview GET /api/projects/:id/file/preview?path=&lang=
// 预览元数据 + 渲染类 payload 的单端点：
//   - docx/doc：服务端抽取文本结构渲染净化 HTML（payload.html；图片/嵌入
//     链接经 MediaURLs 注入指向 media/embed 端点）；
//   - csv/tsv/xlsx：服务端解析渲染净化表格（payload.html）；
//   - md：只回 kind 不产 payload（评审必改2 定案 (a)——前端预览复用既有
//     marked+DOMPurify 管线，服务端 md 渲染零新增=双实现消失）；
//   - pdf/image/av/text/html：只回 kind+mime（raw/htmlview 端点供字节面）。
//
// 渲染失败/超限（坏 docx/zip 炸弹闸）html 置空 + previewError 携粗粒度原因
// （前端回落信息卡+下载，与分享侧错误卡同语义；绝不透传容器内部细节）
func GetFilePreview(c *gin.Context) {
	absPath, relPath, info, ok := resolvePreviewTarget(c)
	if !ok {
		return
	}
	desc := preview.ForFile(info.Name())
	maybeAuditSensitiveRead(c, shared.GetProjectFromContext(c), relPath)

	resp := gin.H{"kind": string(desc.Kind), "mime": desc.MIME}
	switch desc.Kind {
	case preview.KindMarkdown, preview.KindPDF, preview.KindImage, preview.KindVideo,
		preview.KindAudio, preview.KindHTML, preview.KindText, preview.KindInfo:
		// 无服务端 payload 的 kind：md 走前端管线（必改2a），其余走
		// raw/htmlview 字节面——只回元数据
	case preview.KindCSV, preview.KindSheet, preview.KindDocx:
		limit := int64(preview.MaxRenderBytes)
		if desc.Kind == preview.KindDocx || desc.Kind == preview.KindSheet {
			limit = int64(preview.MaxDocxBytes)
		}
		content, err := readFileCapped(absPath, limit)
		if err != nil {
			resp["previewError"] = "read-failed"
			c.JSON(http.StatusOK, gin.H{"data": resp})
			return
		}
		if int64(len(content)) > limit {
			resp["previewError"] = "too-large"
			c.JSON(http.StatusOK, gin.H{"data": resp})
			return
		}
		lang := previewLang(c, c.Request)
		var body string
		switch desc.Kind {
		case preview.KindCSV:
			comma := ','
			if strings.HasSuffix(strings.ToLower(info.Name()), ".tsv") {
				comma = '\t'
			}
			body = preview.RenderCSVHTML(content, comma)
		case preview.KindSheet:
			body, err = preview.RenderSheetHTML(content)
			if err != nil {
				// 坏 zip/定位链断：与分享侧错误卡同语义（html 空=前端回落）
				resp["previewError"] = "parse-failed"
			}
		default: // KindDocx
			projectID := c.Param("id")
			docPath := relPath
			urls := &preview.MediaURLs{
				Media: func(m string) string {
					return preview.DocxMediaURL(filePreviewMediaBase(projectID)+"/media", docPath, m)
				},
				Embed: func(e string) string {
					return preview.DocxEmbedURL(filePreviewMediaBase(projectID)+"/embed", docPath, e)
				},
			}
			body, err = preview.RenderDocHTML(content, lang, urls)
			if err != nil {
				resp["previewError"] = "parse-failed"
			}
		}
		resp["html"] = body
	}
	c.JSON(http.StatusOK, gin.H{"data": resp})
}

// readFileCapped 整文件读取（limit 封顶 +1 判超限）
func readFileCapped(absPath string, limit int64) ([]byte, error) {
	f, err := os.Open(absPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, limit+1))
}

// GetFileRaw GET /api/projects/:id/file/raw?path=
// 文件字节内联输出（pdf/image/av 的 <img>/<video>/<iframe> 取数端点 +
// 二进制「原文件」态的下载面）。ServeContent 提供 Range/HEAD/304
// （*os.File 直接满足 ReadSeeker——视频拖动进度条、PDF 渐进加载白拿）；
// CSP sandbox 头与 share serveRaw 同口径（直开该 URL 呈独立文档且脚本全禁，
// .html 原样字节也绝不获得本源脚本能力），XFO SAMEORIGIN 放行同源 iframe。
func GetFileRaw(c *gin.Context) {
	absPath, relPath, info, ok := resolvePreviewTarget(c)
	if !ok {
		return
	}
	maybeAuditSensitiveRead(c, shared.GetProjectFromContext(c), relPath)
	f, err := os.Open(absPath)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesNotFound, "file not found", nil)
		return
	}
	defer f.Close()
	desc := preview.ForFile(info.Name())
	c.Header("Content-Type", preview.RawContentType(desc.MIME))
	c.Header("Content-Security-Policy", "sandbox")
	// PDF 预览以同源 iframe 引用本端点：全局 X-Frame-Options DENY 会连页内
	// 预览一起拦死，这里放宽到同源（CSP sandbox 已挡脚本执行）
	c.Header("X-Frame-Options", "SAMEORIGIN")
	http.ServeContent(c.Writer, c.Request, info.Name(), info.ModTime(), f)
}

// GetFileRel GET /api/projects/:id/file/rel/*rel
// 路径形态的 raw（htmlview 的 <base href> 落点）：html 预览的相对 css/img
// 子资源按 URL 层级回源项目根。query 型做不了 <base href>（相对引用整体
// 替换 base 的 query 子资源全 404——评审必改3b 钉死路径参数型）。语义与
// share /s/{token}/f/{name...} 同构；字体子资源 ACAO 放宽同款（不透明源下
// @font-face 的 CORS 面——本项目 iframe 虽同源，html 档经 sandbox 后仍是
// 不透明源，与分享侧同构收口）
func GetFileRel(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}
	// gin 通配参数保持百分号编码（浏览器按段编码 CJK/空格）——先解码再归一
	rel := strings.TrimPrefix(c.Param("rel"), "/")
	if dec, derr := url.PathUnescape(rel); derr == nil {
		rel = dec
	}
	rel = NormalizeRelPath(rel)
	if rel == "" || rel == "." {
		shared.ErrorWithCode(c, shared.CodeFilesNotFound, "file not found", nil)
		return
	}
	absPath, err := SafeJoinProject(p.Path, rel)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesPathOutsideRoot, err.Error(), nil)
		return
	}
	info, err := os.Stat(absPath)
	if err != nil || info.IsDir() {
		shared.ErrorWithCode(c, shared.CodeFilesNotFound, "file not found", nil)
		return
	}
	maybeAuditSensitiveRead(c, p, rel)
	f, err := os.Open(absPath)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesNotFound, "file not found", nil)
		return
	}
	defer f.Close()
	desc := preview.ForFile(info.Name())
	if strings.HasPrefix(desc.MIME, "font/") { // 字体子资源 CORS 放宽（share isFontMIME 同判式）
		c.Header("Access-Control-Allow-Origin", "*")
	}
	c.Header("Content-Type", preview.RawContentType(desc.MIME))
	c.Header("Content-Security-Policy", "sandbox")
	c.Header("X-Frame-Options", "SAMEORIGIN")
	http.ServeContent(c.Writer, c.Request, info.Name(), info.ModTime(), f)
}

// GetFileMedia GET /api/projects/:id/file/media?path=&m=
// docx 预览图片供给（filepreview.DocxMediaData 单一取件链：映射簿等值
// 白名单 + 解压闸 + 魔数嗅探；伪装条目 404 让 <img> 自然呈加载失败）。
// 可达面 ⊆ raw 可全量下载的同一 docx = 零新增泄露面（share 同款论证）
func GetFileMedia(c *gin.Context) {
	absPath, relPath, info, ok := resolvePreviewTarget(c)
	if !ok {
		return
	}
	if preview.ForFile(info.Name()).Kind != preview.KindDocx {
		shared.Error(c, http.StatusUnprocessableEntity, "not a docx document", nil)
		return
	}
	maybeAuditSensitiveRead(c, shared.GetProjectFromContext(c), relPath)
	f, err := os.Open(absPath)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesNotFound, "file not found", nil)
		return
	}
	defer f.Close()
	part, perr := preview.DocxMediaData(f, info.Size(), c.Query("m"))
	if perr != nil {
		if perr == preview.ErrDocxPartTooLarge {
			shared.Error(c, http.StatusRequestEntityTooLarge, "media part too large", nil)
			return
		}
		shared.ErrorWithCode(c, shared.CodeFilesNotFound, "media not found", nil)
		return
	}
	c.Header("Content-Type", part.ContentType)
	c.Header("Content-Security-Policy", "sandbox")
	c.Header("X-Frame-Options", "SAMEORIGIN")
	http.ServeContent(c.Writer, c.Request, path.Base(part.Entry), part.ModTime, bytes.NewReader(part.Data))
}

// GetFileEmbed GET /api/projects/:id/file/embed?path=&e=&preview=1&ui=1[&scripts=1&forms=1&popups=1]
// docx 嵌入对象端点：恒 attachment 下载为基线；preview=1/ui=1 分型走
// filepreview 显式扩展名白名单（EmbedPreviewFor），命中才 inline（CSP
// sandbox + XFO SAMEORIGIN 覆写，html 档带受限能力参数映射）；ui=1 出
// 新标签预览器壳页（模板参数化复用——Endpoint 指向本端点，评审建议2）。
// 白名单外/抽取降级 preview/ui 参数忽略回归 attachment（P-7 红线：绝不按
// 扩展名/字节推断 inline 形态；恒 octet-stream + RFC 2231 Content-Disposition）
func GetFileEmbed(c *gin.Context) {
	absPath, relPath, info, ok := resolvePreviewTarget(c)
	if !ok {
		return
	}
	if preview.ForFile(info.Name()).Kind != preview.KindDocx {
		shared.Error(c, http.StatusUnprocessableEntity, "not a docx document", nil)
		return
	}
	maybeAuditSensitiveRead(c, shared.GetProjectFromContext(c), relPath)
	f, err := os.Open(absPath)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesNotFound, "file not found", nil)
		return
	}
	defer f.Close()
	part, perr := preview.DocxEmbedData(f, info.Size(), c.Query("e"))
	if perr != nil {
		if perr == preview.ErrDocxPartTooLarge {
			shared.Error(c, http.StatusRequestEntityTooLarge, "embed part too large", nil)
			return
		}
		shared.ErrorWithCode(c, shared.CodeFilesNotFound, "embed not found", nil)
		return
	}
	// 统一抽取判定（P-20261118-7 评审必改2 防漂移）：ui=1 壳页准入与
	// preview=1 供给面同一条 EmbedPreviewPayload 链
	_, ext, pvOK := preview.EmbedPreviewFor(part.Name)
	ui, pv := c.Query("ui") == "1", c.Query("preview") == "1"
	var payload []byte
	if pvOK && (ui || pv) {
		var diag preview.EmbedExtractDiag
		payload, diag = preview.EmbedPreviewPayload(part.Data, ext)
		if payload == nil {
			// 诊断枚举只出枚举码级（容器内部细节不外溢，share 同款收口）
			c.Header(preview.EmbedDiagHeader, string(diag))
		}
	}
	if ui && preview.ServeEmbedShell(c.Writer, c.Request, part.Name, part.Size, payload, preview.EmbedShellCfg{
		Endpoint: filePreviewMediaBase(c.Param("id")) + "/embed",
		Path:     c.Query("path"),
		Entry:    c.Query("e"),
	}) {
		return
	}
	if pv && preview.ServeEmbedPreview(c.Writer, c.Request, payload, part.Name, part.ModTime) {
		return
	}
	c.Header("Content-Type", "application/octet-stream")
	c.Header("Content-Disposition", embedContentDisposition(part.Name))
	http.ServeContent(c.Writer, c.Request, part.Name, part.ModTime, bytes.NewReader(part.Data))
}

// GetFileHtmlView GET /api/projects/:id/file/htmlview?path=[&scripts=1]
// html 档沙箱预览：读取 html、注入 <base href="/api/projects/:id/file/rel/
// <目录>/"> 后以 text/html 供 iframe 引用——相对 css/img 子资源按层级回源
// 项目根。脚本隔离与分享访客面同款红线（P-20261020-4）：默认 CSP sandbox
// （脚本全禁）；显式 ?scripts=1 时只加 allow-scripts——脚本页保持不透明
// 源，绝不叠加 allow-same-origin（父页是登录态，same-origin 泄露面比分享
// 访客更敏感），表单/弹窗/顶层导航仍被沙箱禁用。
func GetFileHtmlView(c *gin.Context) {
	absPath, relPath, info, ok := resolvePreviewTarget(c)
	if !ok {
		return
	}
	if preview.ForFile(info.Name()).Kind != preview.KindHTML {
		shared.Error(c, http.StatusUnprocessableEntity, "not an html document", nil)
		return
	}
	maybeAuditSensitiveRead(c, shared.GetProjectFromContext(c), relPath)
	content, err := readFileCapped(absPath, preview.MaxRenderBytes)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesNotFound, "file not found", nil)
		return
	}
	if int64(len(content)) > preview.MaxRenderBytes {
		shared.Error(c, http.StatusRequestEntityTooLarge, "html too large to preview", nil)
		return
	}
	dir := path.Dir(relPath)
	base := filePreviewMediaBase(c.Param("id")) + "/rel/"
	if dir != "." && dir != "" {
		segs := strings.Split(dir, "/")
		for i := range segs {
			segs[i] = url.PathEscape(segs[i])
		}
		base += strings.Join(segs, "/") + "/"
	}
	c.Header("Content-Type", "text/html; charset=utf-8")
	sandbox := "sandbox"
	if c.Query("scripts") == "1" {
		sandbox += " allow-scripts"
	}
	c.Header("Content-Security-Policy", sandbox)
	// 唯一消费方是应用内同源 sandbox iframe——语义同 raw（XFO 放行同源）
	c.Header("X-Frame-Options", "SAMEORIGIN")
	_, _ = c.Writer.Write(preview.InjectHTMLBase(content, base))
}

// embedContentDisposition 嵌入对象下载名（mime.FormatMediaType 按 RFC 2231
// 编码非 ASCII——与 share contentDisposition 同构的安全出口；inline=false
// 恒 attachment）
func embedContentDisposition(name string) string {
	cd := mime.FormatMediaType("attachment", map[string]string{"filename": name})
	if cd == "" {
		return "attachment"
	}
	return cd
}
