package share

import (
	"bytes"
	"net/http"
	"path"

	preview "codecombo/server/filepreview"
	"codecombo/server/store"
)

// ── docx-media / docx-embed 端点（P-20261119-4 渲染半边抽包下沉后本文件
// 只剩端点形态：源解析（share resolve 双源）/访客门禁/响应协议在 share，
// zip 簿构建/白名单匹配/解压闸/名字还原/预览分型响应全部调 filepreview
// 单一事实源——archguard 红利：本文件自 1349 行瘦身为端点半边，远离
// 1500 行体量闸） ──

// handleDocxMedia docx 预览图片供给。
//
// GET /s/{token}/docx-media?path=<分享内 docx 路径>&m=<media 部件名>：
// docx 预览 HTML 的 img src 取数端点。路由与 /raw 同款 gateGuard（口令门/
// 一次性确认自动继承）；源解析复用 resolve（frozen 快照目录/live os.Root
// 锚定双源天然同轨）。安全面：m= 只认渲染面映射簿产出（rels 源自包内
// word/_rels/document.xml.rels、Target 强制落 word/media/* 且条目在包内
// 存在——等值匹配天然免疫注入），端点可达面 ⊆ 访客本可经 /raw 全量下载
// 的同一 docx = 零新增泄露面；每请求现开 zip（os.File 是 io.ReaderAt，
// zip.Reader 构造只读 central directory），不建缓存（token+path 缓存有
// live 改写/逐出/清理失效面，live 源逐请求见新字节）；per-media 解压闸
// 施加在解压流上 + 魔数嗅探仅放行 image/*（非图 404）。no-store 入口
// 中间件下多引用同图 N 次拉取与 md 预览图片同口径；nosniff 全局中间件
// 已带，Content-Type 只出嗅探结果。
func (s *Service) handleDocxMedia(w http.ResponseWriter, r *http.Request) {
	res, herr := s.resolve(r)
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	defer s.closeRes(res)
	// 片段/直播/回放（cast/session）无文件锚定（info 零值须先短路再探测，
	// handleHTMLDoc 同款守卫形态）；目录与非 docx 目标不在图片供给面
	//（本端点只被 docx 预览 HTML 引用）
	if res.share.Kind == store.ShareKindSnippet || res.share.Kind == store.ShareKindTerminal ||
		res.share.Kind == store.ShareKindCast || res.share.Kind == store.ShareKindSession ||
		res.info.IsDir() || preview.ForFile(res.info.Name()).Kind != preview.KindDocx {
		writeJSONError(w, errUnrenderable)
		return
	}
	f, err := res.root.Open(res.rel)
	if err != nil {
		writeJSONError(w, errTargetMissing)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		writeJSONError(w, errTargetMissing)
		return
	}
	part, perr := preview.DocxMediaData(f, info.Size(), r.URL.Query().Get("m"))
	switch perr {
	case nil:
	case preview.ErrDocxPartTooLarge:
		// 超单部件解压上限（解压炸弹面）：413 与 md 渲染超限同族语义
		writeJSONError(w, errTooLarge)
		return
	default: // ErrDocxPartMissing（含坏 zip/悬空映射/非图字节伪装条目）
		// 绝不透传，404 让 <img> 自然呈加载失败
		writeJSONError(w, errTargetMissing)
		return
	}
	// CSP sandbox 与 raw 同口径（直开该 URL 呈图片文档且脚本全禁）
	w.Header().Set("Content-Type", part.ContentType)
	w.Header().Set("Content-Security-Policy", "sandbox")
	// ServeContent 提供 Range/HEAD 支持（bytes.Reader 满足 ReadSeeker）
	http.ServeContent(w, r, path.Base(part.Entry), part.ModTime, bytes.NewReader(part.Data))
}

// handleDocxEmbed docx 预览嵌入对象下载/预览。
//
// GET /s/{token}/docx-embed?path=<分享内 docx 路径>&e=<embeddings 部件名>：
// docx 预览嵌入对象（附件）的下载端点。路由/gateGuard/resolve 双源与
// docx-media 同轨；e= 只认渲染面映射簿产出 embeddings 映射（等值匹配
// 天然免疫注入，同 m= 先例），端点可达面 ⊆ 访客本可经 /raw 全量下载的
// 同一 docx = 零新增泄露面。供给头恒 attachment + Content-Type 固定
// application/octet-stream：嵌入字节任意且真实嵌入物就是 .html——
// inline + 嗅探 MIME 即访客 XSS 面，serveRaw 的 inline+扩展名推断形态
// 绝不作本端点模板；Content-Disposition 一律经 contentDisposition()
// （mime.FormatMediaType 按 RFC 2231 编码非 ASCII，安全出口）。文件名
// best-effort：legacy OLE 容器（.bin）里 Ole10Native 流的原始文件名
// 抽取链（P-20261118-1 起簿构建期抽名+GB18030 解码）已下沉 filepreview
// 簿构建侧，任何疑点回落 .bin 直供名。
//
// P-20261118-1 preview=1 分型：&preview=1 走显式扩展名白名单（filepreview
// EmbedPreviewFor），命中才 inline 出预览形态（CSP sandbox + XFO
// SAMEORIGIN 覆写，html 档带 scripts/forms/popups 受限能力参数映射）；
// 白名单外/降级一律忽略参数回归 attachment。威胁模型与三根支柱见
// filepreview.ServeEmbedPreview 注释。
func (s *Service) handleDocxEmbed(w http.ResponseWriter, r *http.Request) {
	res, herr := s.resolve(r)
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	defer s.closeRes(res)
	// 片段/直播/回放零值 info 须先短路再探测；目录与非 docx 目标不在
	// 嵌入供给面（本端点只被 docx 预览 HTML 引用）——docx-media 同款守卫
	if res.share.Kind == store.ShareKindSnippet || res.share.Kind == store.ShareKindTerminal ||
		res.share.Kind == store.ShareKindCast || res.share.Kind == store.ShareKindSession ||
		res.info.IsDir() || preview.ForFile(res.info.Name()).Kind != preview.KindDocx {
		writeJSONError(w, errUnrenderable)
		return
	}
	f, err := res.root.Open(res.rel)
	if err != nil {
		writeJSONError(w, errTargetMissing)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		writeJSONError(w, errTargetMissing)
		return
	}
	part, perr := preview.DocxEmbedData(f, info.Size(), r.URL.Query().Get("e"))
	switch perr {
	case nil:
	case preview.ErrDocxPartTooLarge:
		// 超单部件解压上限（解压炸弹面）：413 与 media 端点同族语义
		writeJSONError(w, errTooLarge)
		return
	default: // ErrDocxPartMissing（含坏 zip/悬空映射）
		writeJSONError(w, errTargetMissing)
		return
	}
	// 统一抽取判定（P-20261118-7 评审必改2）：ui=1 壳页准入与 preview=1
	// 供给面走同一条 EmbedPreviewPayload 链（payload 预算一次，两侧判定
	// 天然一致防漂移）；诊断枚举（评审建议b）在此收口——响应头只出粗粒度
	// 枚举码，容器内部结构细节（路径/名字节）只进服务端日志
	_, ext, pvOK := preview.EmbedPreviewFor(part.Name)
	ui, pv := r.URL.Query().Get("ui") == "1", r.URL.Query().Get("preview") == "1"
	var payload []byte
	if pvOK && (ui || pv) {
		var diag preview.EmbedExtractDiag
		payload, diag = preview.EmbedPreviewPayload(part.Data, ext)
		if payload == nil {
			w.Header().Set(preview.EmbedDiagHeader, string(diag))
			s.logger.Warn("share: docx embed extract failed",
				"diag", string(diag), "token", TokenSummary(res.share.Token),
				"entry", part.Entry, "ext", ext)
		}
	}
	// ui=1 壳页分型（P-20261118-3）：html/htm 档预览进新标签预览器壳页
	//（开关/风险提示/全幅 iframe 各自就位，文档阅读列不再页内 iframe 撑列）。
	// 路由定 &ui=1（评审建议a）：单端点单 URL 词表，gate/resolve/白名单链
	// 全复用；白名单未命中 ui 忽略回归 attachment（与 preview=1 同语义）。
	// P-20261118-7 起抽取失败不再整页回落 attachment 弹下载框（用户实测
	// 主诉）——壳页转诚实回落模式（标题+「暂不支持自动预览」提示+下载
	// 按钮，见 filepreview.ServeEmbedShell）
	if ui && preview.ServeEmbedShell(w, r, part.Name, part.Size, payload, preview.EmbedShellCfg{
		Endpoint: "/s/" + res.share.Token + "/docx-embed",
		Path:     r.URL.Query().Get("path"),
		Entry:    r.URL.Query().Get("e"),
	}) {
		return
	}
	// preview=1 分型（P-20261118-1）：显式白名单命中才 inline 出预览形态；
	// 未命中/降级（伪装图字节/md 超限）preview 参数忽略回归 attachment
	if pv && preview.ServeEmbedPreview(w, r, payload, part.Name, part.ModTime) {
		return
	}
	// 恒 attachment + 固定 octet-stream：绝不按扩展名/字节推断内联形态
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", contentDisposition(part.Name, false))
	// ServeContent 提供 Range/HEAD 支持（Content-Type 已显式置定，name
	// 参数不再参与类型推断）
	http.ServeContent(w, r, part.Name, part.ModTime, bytes.NewReader(part.Data))
}

// docxMediaURL 分享侧 media 端点 URL（渲染面 MediaURLs 构造器的 /s/{token}
// 形态包装；docPath = 该 docx 在分享根内的访客路径，原样透传给端点的
// path= 参数）
func docxMediaURL(token, docPath, media string) string {
	return preview.DocxMediaURL("/s/"+token+"/docx-media", docPath, media)
}

// docxEmbedURL 分享侧 embed 端点 URL（语义与 docxMediaURL 同轨）
func docxEmbedURL(token, docPath, entry string) string {
	return preview.DocxEmbedURL("/s/"+token+"/docx-embed", docPath, entry)
}
