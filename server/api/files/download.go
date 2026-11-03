package files

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	shared "codecombo/server/api/shared"

	"github.com/gin-gonic/gin"
)

// errTraversal 路径越界（穿越/符号链接外逃）
var errTraversal = errors.New("path traversal not allowed")

// safeJoinProject 项目根内路径解析，供下载端点做边界校验：
//  1. 显式拒绝含 ".." 段的相对路径（第一道闸，规范化前先拒绝）
//  2. filepath.Abs 规范化
//  3. 真实路径（符号链接解析）做「根+分隔符」前缀校验——兄弟目录名前缀伪装
//     与符号链接外逃均被拦截；校验分别作用于真实路径与规范化路径
//
// 返回 (绝对路径, error)
func SafeJoinProject(root, rel string) (string, error) {
	if strings.Contains(rel, "..") {
		return "", errTraversal
	}
	absPath, err := filepath.Abs(filepath.Join(root, rel))
	if err != nil {
		return "", err
	}
	absRoot, _ := filepath.Abs(root)
	checkPath, checkRoot := evalSymlinksNormalized(absPath), evalSymlinksNormalized(absRoot)
	if checkPath != checkRoot && !strings.HasPrefix(checkPath, checkRoot+string(filepath.Separator)) {
		return "", errTraversal
	}
	if absPath != absRoot && !strings.HasPrefix(absPath, absRoot+string(filepath.Separator)) {
		return "", errTraversal
	}
	return absPath, nil
}

// EvalSymlinksNormalized 路径真实化（导出供同层 terminal 域复用）：目标存在
// 直接 EvalSymlinks；不存在解析最近存在的祖先把尾部拼回。语义与注意见私有版
// 注释；server/git 有同值最小实现（互锁注释）
func EvalSymlinksNormalized(absPath string) string {
	return evalSymlinksNormalized(absPath)
}

// evalSymlinksNormalized 路径真实化：目标存在直接 EvalSymlinks；不存在
//（未创建的目标文件/rename 目的地/missing 目录）解析最近存在的祖先并把
// 尾部拼回——裸 EvalSymlinks 是不对称展开（存在侧展开、缺失侧保持原形态），
// Windows 短名（8.3）环境下「缺失目标的短名 vs 已解析 root 的长名」曾误判
// traversal（GitHub windows runner 的 TMP=C:\Users\RUNNER~1\... 实锚）
func evalSymlinksNormalized(absPath string) string {
	if real, err := filepath.EvalSymlinks(absPath); err == nil {
		return real
	}
	p := absPath
	for {
		parent := filepath.Dir(p)
		if parent == p {
			return absPath // 到根仍失败：原样返回（第二闸兜底）
		}
		if real, err := filepath.EvalSymlinks(parent); err == nil {
			// Clean 防拼接错位：大小写不敏感盘（WSL1）上不存在的祖先可能被
			// 解析到形态不同的真实路径（如 /TMP→/），直拼会产生 "//" 冗余
			return filepath.Clean(real + absPath[len(p):])
		}
		p = parent
	}
}

// DownloadFile GET /api/projects/:id/file/download?path= — 下载项目内文件。
// 不受预览策略 text/binary/too-large 限制：下载即原样字节流。
// 路径边界校验与 GetFilePolicy 同标准（见 safeJoinProject）；
// 经 c.File（net/http.ServeFile）输出：Content-Length/Range/断点续传自动处理
func DownloadFile(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}
	filePath := c.Query("path")
	if filePath == "" {
		shared.Error(c, http.StatusBadRequest, "path is required", nil)
		return
	}
	absPath, err := SafeJoinProject(p.Path, filePath)
	if err != nil {
		shared.Error(c, http.StatusForbidden, err.Error(), nil)
		return
	}

	info, err := os.Stat(absPath)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "file not found", nil)
		return
	}
	if info.IsDir() {
		shared.Error(c, http.StatusBadRequest, "path is a directory", nil)
		return
	}

	name := filepath.Base(absPath)
	c.Header("Content-Type", "application/octet-stream")
	// 下载头统一净化 helper（P-20261003-109）：CRLF/引号剥除 + RFC 5987 双形式，
	// 禁止手拼（文件名用户可控，自拼是头注入面）
	c.Header("Content-Disposition", shared.ContentDispositionFile(name))
	c.File(absPath)
}
