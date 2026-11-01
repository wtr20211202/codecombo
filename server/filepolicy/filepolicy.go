// Package filepolicy 文件预览策略：按「大小 × 类型」分级决定文件如何呈现，
// 避免把超大文件或二进制内容整读进内存再序列化发给前端。
//
// 对标主流产品的阈值依据（docs/perf-report.md 详述）：
//   - VSCode：>50MB 拒开编辑器，20MB 起降级编辑特性；
//   - JetBrains：默认 >20MB 拒开；
//   - GitHub Web：blob >2MB 不渲染内容，仅提供 raw 入口。
//
// 本项目为本地工具，阈值取「编辑器体验优先」的 10MB 全文预览线（与既有服务端
// 上限一致），10MB 以上走元信息卡；二进制按扩展名 + 内容嗅探判定，永不发内容。
// 各阈值为包级变量（可测试调整，后续可挂到配置），本包全部为纯函数——
// 文件读取/嗅探由调用方完成后以参数传入，保持包自身无 IO、可单测。
package filepolicy

import (
	"fmt"
	"path/filepath"
	"strings"
)

// 阈值（字节）。var 便于测试覆盖；改动不影响调用方。
var (
	// TextPreviewLimit 全文预览上限：≤ 此值且非二进制 → 编辑器全文打开
	TextPreviewLimit int64 = 10 * 1024 * 1024
	// PartialPreviewLimit 部分预览上限：元信息卡「预览前 N 字节」的读取上限
	PartialPreviewLimit int64 = 1 * 1024 * 1024
	// SniffMax 内容嗅探建议读取量（由调用方执行）
	SniffMax int64 = 8 * 1024
)

// Kind 分类结果
type Kind string

const (
	// KindText 可全文预览（编辑器打开）
	KindText Kind = "text"
	// KindTooLarge 超过全文预览上限 → 元信息卡 + 可选部分预览
	KindTooLarge Kind = "too-large"
	// KindBinary 二进制/不可预览类型 → 元信息卡（无内容预览按钮）
	KindBinary Kind = "binary"
)

// Decision 分类决策（HTTP 与前端共享的形态）
type Decision struct {
	Kind       Kind   `json:"kind"`
	Size       int64  `json:"size"`
	SizeHuman  string `json:"sizeHuman"`
	Limit      int64  `json:"limit,omitempty"`      // KindText 时无意义；TooLarge 时为 TextPreviewLimit
	PartialMax int64  `json:"partialMax,omitempty"` // TooLarge 时可部分预览的上限；Binary 恒 0
	Reason     string `json:"reason,omitempty"`     // binary 判定依据（ext/sniff），便于提示与排查
}

// HumanBytes 字节数人性化（KB/MB/GB，一位小数）
func HumanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGTPE"[exp])
}

// binaryByExt 按扩展名判定的不可预览类型集合（可扩展：新增类型加一行）
var binaryByExt = map[string]bool{
	// 可执行 / 库
	".exe": true, ".dll": true, ".so": true, ".dylib": true, ".bin": true, ".o": true, ".a": true,
	// 归档
	".zip": true, ".gz": true, ".tgz": true, ".tar": true, ".7z": true, ".rar": true, ".xz": true, ".bz2": true,
	// 镜像 / 磁盘
	".iso": true, ".img": true, ".dmg": true, ".vhd": true,
	// 媒体
	".mp4": true, ".mkv": true, ".avi": true, ".mov": true, ".mp3": true, ".flac": true, ".wav": true, ".ogg": true, ".webm": true,
	// 图片（前端后续可走 raw 展示，当前归入元信息卡）
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".ico": true, ".bmp": true, ".tiff": true,
	// 文档 / 办公
	".pdf": true, ".doc": true, ".docx": true, ".xls": true, ".xlsx": true, ".ppt": true, ".pptx": true,
	// 数据库 / 字体
	".db": true, ".sqlite": true, ".sqlite3": true, ".woff": true, ".woff2": true, ".ttf": true, ".otf": true, ".eot": true,
}

// IsBinaryExt 扩展名是否属于不可预览的二进制类型
func IsBinaryExt(ext string) bool {
	return binaryByExt[strings.ToLower(ext)]
}

// NeedsSniff 该扩展名是否需要内容嗅探兜底（不在已知二进制清单内 → 需嗅探）
func NeedsSniff(ext string) bool {
	return !IsBinaryExt(ext)
}

// KindFor 纯逻辑判定：调用方已完成嗅探（hasNUL = 头部是否含 NUL 字节；
// ext 已命中二进制清单时可传 false 跳过嗅探）。
// ext 大小写不敏感；size 为文件字节数
func KindFor(ext string, size int64, hasNUL bool) Decision {
	ext = strings.ToLower(ext)
	if IsBinaryExt(ext) {
		return Decision{Kind: KindBinary, Size: size, SizeHuman: HumanBytes(size), Reason: "ext:" + ext}
	}
	if size <= TextPreviewLimit {
		if hasNUL {
			return Decision{Kind: KindBinary, Size: size, SizeHuman: HumanBytes(size), Reason: "sniff:nul-byte"}
		}
		return Decision{Kind: KindText, Size: size, SizeHuman: HumanBytes(size)}
	}
	if hasNUL {
		return Decision{Kind: KindBinary, Size: size, SizeHuman: HumanBytes(size), Reason: "sniff:nul-byte"}
	}
	return Decision{
		Kind: KindTooLarge, Size: size, SizeHuman: HumanBytes(size),
		Limit: TextPreviewLimit, PartialMax: PartialPreviewLimit,
	}
}

// ExtOf 取小写扩展名（无扩展名返回空串）
func ExtOf(path string) string {
	return strings.ToLower(filepath.Ext(path))
}
