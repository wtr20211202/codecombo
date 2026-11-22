package filepreview

import (
	"fmt"
	"net/http"
	"strings"
)

// 预览渲染产物内的用户可见文案（zh/en 双语词典）。
//
// P-20261119-4 抽包下沉后本词典是 docx 占位块与嵌入壳页文案的单一事实源
//（值与 share 页面词典 origin 键逐字节对齐——share 侧页面壳层（下载/预览
// 动作条等）仍消费 page_i18n.go 的同名键，两处取值同源同形）。渲染类端点
// 的 lang 参数（评审必改3c）：share 侧取 Accept-Language（PrefLang）、主
// 应用预览 API 侧由前端显式传 ?lang=（缺省回落 Accept-Language 探测），
// 保证占位块/壳页文案与用户语境一致。

// dictFor lang → 文案表（未知 lang 回落英文）
func dictFor(lang string) map[string]string {
	if lang == "zh" {
		return dictZH
	}
	return dictEN
}

// dictZH 中文文案
var dictZH = map[string]string{
	"download":               "下载",
	"docEmbedPreview":        "预览",
	"docEmbedFile":           "嵌入文件，可下载",
	"docImgMissing":          "图片未随预览内嵌，下载文档可见",
	"docImgMetafile":         "该图片为 EMF/WMF 等浏览器不支持的图元格式，下载文档可见",
	"docEmbedMissing":        "嵌入文件无法从预览取回，下载文档可见",
	"embedShellUnsupported":  "该附件结构暂不支持自动预览，可下载查看",
	"embedNoteOff":           "脚本已停用——原型交互需运行脚本（沙箱隔离，读不到本应用登录态）",
	"embedNoteScriptsOn":     "隔离运行中：脚本已放开（读不到本应用登录态）；表单/弹窗仍禁用",
	"embedNoteFull":          "隔离运行中：脚本/表单/弹窗已放开——内容为第三方来源，请勿在此输入真实凭据",
	"embedFormsToggle":       "允许表单与弹窗",
	"embedShellScripts":      "运行该原型页的脚本（隔离沙箱：读不到本应用登录态，仍会向网络发请求）",
	"embedShellApply":        "应用",
	"embedShellCtlTitle":     "脚本与弹窗：",
	"embedShellStateOff":     "未放开 · 默认拦截",
	"embedShellStateScripts": "已放开脚本",
	"embedShellStateFull":    "已放开脚本+表单弹窗",
	"embedShellStateHint":    "请勿输入真实凭据",
	"embedShellFull":         "全幅预览",
	"embedShellFullExit":     "显示标题栏",
}

// dictEN 英文文案
var dictEN = map[string]string{
	"download":               "Download",
	"docEmbedPreview":        "Preview",
	"docEmbedFile":           "Embedded file — click to download",
	"docImgMissing":          "Image not shown in preview. Download the document to view it.",
	"docImgMetafile":         "This image is an EMF/WMF metafile that browsers cannot render. Download the document to view it.",
	"docEmbedMissing":        "This embedded file cannot be fetched from the preview. Download the document to view it.",
	"embedShellUnsupported":  "This attachment's structure can't be auto-previewed yet — download it to view.",
	"embedNoteOff":           "Scripts are disabled — interactive prototypes need scripts (isolated sandbox, no access to this app's sessions)",
	"embedNoteScriptsOn":     "Isolated: scripts enabled (no access to this app's sessions); forms and popups stay blocked",
	"embedNoteFull":          "Isolated: scripts/forms/popups enabled — third-party content, never enter real credentials here",
	"embedFormsToggle":       "Allow forms & popups",
	"embedShellScripts":      "Run this prototype's scripts (isolated sandbox: no access to this app's sessions; network requests are still possible)",
	"embedShellApply":        "Apply",
	"embedShellCtlTitle":     "Scripts & popups:",
	"embedShellStateOff":     "blocked · default",
	"embedShellStateScripts": "scripts enabled",
	"embedShellStateFull":    "scripts + forms/popups enabled",
	"embedShellStateHint":    "never enter real credentials",
	"embedShellFull":         "Full preview",
	"embedShellFullExit":     "Show header",
}

// PrefLang Accept-Language → 渲染语言（zh 系 → 中文，其余英文）。
// 导出：主应用预览 API 的 lang 参数缺省时走同一探测（share prefLang 同源语义）
func PrefLang(r *http.Request) string {
	al := r.Header.Get("Accept-Language")
	if al != "" {
		al = strings.ToLower(al)
		if idx := strings.Index(al, "zh"); idx >= 0 {
			// "zh" 出现在偏好列表里即中文（zh-CN/zh-TW/*；简单语义足够）
			return "zh"
		}
	}
	return "en"
}

// prefLang 包内简写（渲染面既有调用点语义不变）
func prefLang(r *http.Request) string { return PrefLang(r) }

// fmtSize 渲染块内尺寸展示（share 页面 FmtSize 同构——两处文案消费者
// 不同面：本表只进 docx 渲染产物，share 页面壳层用其自有 FmtSize）
func fmtSize(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1fMB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1fKB", float64(n)/(1<<10))
	default:
		return fmt.Sprintf("%dB", n)
	}
}
