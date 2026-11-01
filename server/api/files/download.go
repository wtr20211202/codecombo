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
	checkPath, checkRoot := absPath, absRoot
	if real, e := filepath.EvalSymlinks(absPath); e == nil {
		checkPath = real
	}
	if realRoot, e := filepath.EvalSymlinks(absRoot); e == nil {
		checkRoot = realRoot
	}
	if checkPath != checkRoot && !strings.HasPrefix(checkPath, checkRoot+string(filepath.Separator)) {
		return "", errTraversal
	}
	if absPath != absRoot && !strings.HasPrefix(absPath, absRoot+string(filepath.Separator)) {
		return "", errTraversal
	}
	return absPath, nil
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
