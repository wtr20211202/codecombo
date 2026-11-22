package filepreview

import (
	"bytes"
	"net/http"
	"strings"
	"time"
)

// ── 嵌入对象 preview=1 分型响应（P-20261119-4 自 share serveEmbedPreview
// 迁入：响应头形态由渲染面单一产出，share/api 两侧嵌入端点共用） ──

// ServeEmbedPreview preview=1 的分型响应（P-20261118-1 ③）。payload 由
// 调用方经统一抽取判定 embedPreviewPayload 预算（与 ui=1 壳页准入守卫
// 同链=评审必改2 防漂移；诊断枚举/服务端日志也在调用方收口）；返回
// false = 白名单未命中或 payload nil（调用方落回 attachment 形态，
// preview 参数忽略）。P-7「恒 attachment」红线的威胁模型=「任意字节×
// 嗅探 MIME×同源脚本」，preview=1 三根支柱逐条对上（评审裁决：有条件
// 成立）：①ext 来自还原名显式白名单（非嗅探非字节推断，.bin 回落名天然
// 白名单外）；②html/md 响应 CSP sandbox（opaque origin 脚本默认禁，
// scripts=1 opt-in 后仍不透明源——embedSandboxCSP 构造性不含
// allow-same-origin/allow-top-navigation）；③image kind 复用魔数嗅探
// （伪装条目回落 attachment，评审建议e——P-20261118-7 起闸在
// embedPreviewPayload，对容器抽取产物与 passthrough 字节一致生效）。
// 各 kind 响应头与访客页在用通路同族（serveRaw/handleHTMLDoc 先例：
// CSP sandbox + X-Frame-Options SAMEORIGIN 覆写——全局 DENY 不覆写则
// 分享页 iframe/直开语义被拦，CSP Set 替换语义天然移除页面级
// frame-ancestors 'none'）。相对子资源语义：不发 base，html/md 相对引用
// 解析到 /s/{t}/ 根 404（嵌入物无分享内兄弟文件语境——诚实 404 与 md
// 同构，复审建议e）。
// P-20261118-2 补齐 pdf/图型接线（评审必改2）：CFB 包裹的 pdf/图片不再
// 把容器原始字节按 application/pdf·image/* inline 出坏页/破图——统一
// 走抽取器+魔数自洽（不过 normalizeTextBytes：looksBinaryMagic %PDF 必拒
// nil，文本规范化只属文本族）
func ServeEmbedPreview(w http.ResponseWriter, r *http.Request, payload []byte, name string, modTime time.Time) bool {
	mime, ext, ok := EmbedPreviewFor(name)
	if !ok || payload == nil {
		return false
	}
	switch {
	case ext == "md" || ext == "markdown":
		// md 渲染：bluemonday 管线（修订一）——净化产物装进自包含壳；
		// maxRenderBytes 已在 embedPreviewPayload 施加在净化后的实际渲染
		// 输入上（容器大而正文小的嵌入不再被容器体积误杀）
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Security-Policy", "sandbox")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		_, _ = w.Write(MDShell(name, RenderMarkdownHTML(payload)))
	case mime == "text/html":
		// html/htm：净化后的原型字节（与既有 KindHTML 访客预览语义同源：
		// handleHTMLDoc 原样+CSP sandbox；脚本档=embedSandboxCSP 参数映射）
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Security-Policy", EmbedSandboxCSP(r))
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		_, _ = w.Write(payload)
	case mime == "application/pdf":
		// serveRaw 同款整体照抄（浏览器原生查看器承接 Range/拖动进度条）；
		// payload 已过 %PDF 魔数自洽闸（抽取产物或 passthrough 字节）
		w.Header().Set("Content-Type", mime)
		w.Header().Set("Content-Security-Policy", "sandbox")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		http.ServeContent(w, r, name, modTime, bytes.NewReader(payload))
	case strings.HasPrefix(mime, "image/"):
		// 魔数匹配闸在 embedPreviewPayload（sniffImageMime==mime）
		w.Header().Set("Content-Type", mime)
		w.Header().Set("Content-Security-Policy", "sandbox")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		http.ServeContent(w, r, name, modTime, bytes.NewReader(payload))
	default:
		// text 族：一律 text/plain（白名单值即 text/plain）——nosniff 全局
		// 已带，直开文档呈纯文本，无脚本面；规范化已在 embedPreviewPayload
		//（UTF-16/GBK 文本转码 UTF-8，乱码消除）
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Content-Security-Policy", "sandbox")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		http.ServeContent(w, r, name, modTime, bytes.NewReader(payload))
	}
	return true
}
