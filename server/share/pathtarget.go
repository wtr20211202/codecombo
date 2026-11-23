package share

// 分享路径归一与管理面目标探测（P-20261122-1 自 service.go 整块迁移——
// service.go 是体量基线看护文件（1753 行登记值不许增长），本块是自成一体的
// 纯路径/探测工具面，与 Handler/端点逻辑无耦合；包内迁移零行为变化）。

import (
	"io/fs"
	"os"
	"strings"
)

// ── 小工具 ──

// NormalizeRelPath 分享路径归一（对外语义的唯一权威实现，管理面与
// 访客面共用）：反斜杠 → 斜杠、丢弃空段与 "."、内部 ".." 逐级上跳；
// 试图越过根的路径（顶层多余的 ../）返回错误——分享根是能力边界，
// 归一只做安全的等价变换，绝不钳制改写指向。
// 病态路径防御：总长/段数超限直接拒绝（访客路径会逐段 Lstat，超长
// 输入不应换取系统调用放大）
func NormalizeRelPath(p string) (string, error) {
	if len(p) > 1024 {
		return "", errPathEscape
	}
	parts := strings.Split(strings.ReplaceAll(p, "\\", "/"), "/")
	if len(parts) > 64 {
		return "", errPathEscape
	}
	var stack []string
	for _, seg := range parts {
		switch {
		case seg == "", seg == ".":
		case seg == "..":
			if len(stack) == 0 {
				return "", errPathEscape
			}
			stack = stack[:len(stack)-1]
		default:
			stack = append(stack, seg)
		}
	}
	return strings.Join(stack, "/"), nil
}

// TargetInfo 管理面创建分享前的目标探测结果
type TargetInfo struct {
	Name  string
	IsDir bool
	Size  int64
}

// StatTarget 校验 rootDir 下 rel 真实存在并返回展示信息。
// 与访问路径同一套归一与逃逸防护（os.Root），rootDir 本身必须是
// 已校验的项目根；分享目标路径上的符号链接一律拒绝——保证分享根
// 从创建那一刻起就是真实目录/文件，不存在被链接偷换的起点
func StatTarget(rootDir, rel string) (TargetInfo, error) {
	rel, err := NormalizeRelPath(rel)
	if err != nil {
		return TargetInfo{}, err
	}
	root, err := os.OpenRoot(rootDir)
	if err != nil {
		return TargetInfo{}, err
	}
	defer root.Close()
	if herr := rejectSymlinkPath(root, rel); herr != nil {
		return TargetInfo{}, fs.ErrNotExist
	}
	fsRel := rel
	if fsRel == "" {
		fsRel = "."
	}
	info, err := root.Stat(fsRel)
	if err != nil {
		return TargetInfo{}, err
	}
	return TargetInfo{Name: info.Name(), IsDir: info.IsDir(), Size: info.Size()}, nil
}
