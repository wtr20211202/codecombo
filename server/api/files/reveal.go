package files

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"

	"codecombo/server/api/shared"
	"codecombo/server/errmarkers"
	"codecombo/server/share"

	"github.com/gin-gonic/gin"
)

// 在系统资源管理器中显示（P-20261003-323）：POST /api/projects/:id/reveal {"path"?}
//
// 浏览器形态的 IDE 打不开宿主文件管理器，本端点是 IDE 与系统工具链的桥：
// 路径经分享路径归一 + SafeJoinProject 白名单校验后按平台 exec 打开器——
// windows explorer /select / darwin open -R / linux xdg-open <目录>（Linux 无
// 选中支持，文件退化为打开所在目录）。平台语义差异集中在本目录
// reveal_{windows,darwin,unix}.go 三个构建标签文件（两两分支都必须可编译）。
//
// 安全面：命令名三选一硬编码白名单 + argv 数组直传 exec（不经 shell，无拼接
// 注入面）；路径不出项目根（SafeJoinProject 与下载/写路径同标准）。
//
// 形态语义注记：打开的是**服务实例宿主**的文件管理器——本机实例为主场景；
// 经远程实例代理调用时打开的是实例宿主侧窗口（提案已注记，headless 实例
// 返回 501 明确语义而非静默失败）。

// errRevealNoDisplay headless 无显示环境（Linux 分支专属语义）：DISPLAY 与
// WAYLAND_DISPLAY 全缺时打开器必败，先探测给出明确错误，handler 映射 501。
// 原文是前端 KNOWN_ERROR_I18N 的匹配契约（no display environment），勿改措辞。
// 文本唯一事实源在 errmarkers 注册表（P-20261004-29）
var errRevealNoDisplay = errors.New(errmarkers.RevealNoDisplay)

// revealCmd 「在系统资源管理器中显示 target」的命令拼装（纯函数，不含执行）。
// goos 由调用方注入（runtime.GOOS）而非包内读全局——三平台分支在同一测试
// 进程内可全量断言（wsl-verify 门禁的 GOOS=darwin 交叉编译只保编译，不断言）
func revealCmd(goos, target string, isDir bool) (name string, args []string, err error) {
	switch goos {
	case "windows":
		// explorer /select,<path>：文件与目录同形态（在父窗口中选中定位）
		return "explorer", []string{"/select," + target}, nil
	case "darwin":
		// open -R <path>：Finder 中显示并选中
		return "open", []string{"-R", target}, nil
	case "linux":
		// xdg-open 无选中支持：退化为打开目录（文件取父目录，目录取自身）
		dir := target
		if !isDir {
			dir = filepath.Dir(target)
		}
		return "xdg-open", []string{dir}, nil
	default:
		return "", nil, errors.New("reveal: unsupported platform " + goos)
	}
}

// revealRun 拼装并执行。测试钩子：设置了 SC_REVEAL_STUB_DIR 时不真执行
// （e2e/单测不真开窗），把拼装结果 JSON 落桩文件供断言；生产环境一次 env
// 读的零开销直通 revealExec
func revealRun(goos, target string, isDir bool) (opener string, err error) {
	name, args, err := revealCmd(goos, target, isDir)
	if err != nil {
		return "", err
	}
	dir := os.Getenv("CC_REVEAL_STUB_DIR")
	if dir == "" {
		dir = os.Getenv("SC_REVEAL_STUB_DIR") // 旧名兼容双读（P-20261025-1）
	}
	if dir != "" {
		return name, writeRevealStub(dir, goos, name, args)
	}
	return name, revealExec(name, args)
}

// writeRevealStub 桩文件：argv 数组原样记录（reveal-1.json 递增避让，测试
// 生命周期内条目有限，线性扫足够）
func writeRevealStub(dir, goos, name string, args []string) error {
	payload, err := json.Marshal(gin.H{"goos": goos, "name": name, "args": args})
	if err != nil {
		return err
	}
	for i := 1; ; i++ {
		p := filepath.Join(dir, "reveal-"+strconv.Itoa(i)+".json")
		if _, err := os.Stat(p); os.IsNotExist(err) {
			return os.WriteFile(p, payload, 0o644)
		} else if err != nil {
			return err
		}
	}
}

// revealRequest path 为项目相对路径（正斜杠）；空串 = 项目根本身
type revealRequest struct {
	Path string `json:"path,omitempty"`
}

// RevealFile POST /api/projects/:id/reveal
func RevealFile(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}
	var req revealRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesPayloadInvalid, "reveal failed", err)
		return
	}
	rel := ""
	if req.Path != "" {
		// 分享路径归一先行（反斜杠归一 + 内部 ".." 逐级上跳）：SafeJoinProject
		// 对含 ".." 的原始串一律拒绝，会把合法的 "a/../b" 也拦掉（dir-archive 同序）
		r, err := share.NormalizeRelPath(req.Path)
		if err != nil {
			shared.ErrorWithCode(c, shared.CodeFilesPayloadInvalid, "invalid path", nil)
			return
		}
		rel = r
	}
	absPath, err := SafeJoinProject(p.Path, rel)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesPathOutsideRoot, err.Error(), nil)
		return
	}
	info, err := os.Stat(absPath)
	if err != nil {
		shared.ErrorWithCode(c, shared.CodeFilesNotFound, "path not found", nil)
		return
	}
	opener, err := revealRun(runtime.GOOS, absPath, info.IsDir())
	if err != nil {
		if errors.Is(err, errRevealNoDisplay) {
			// 501 明确语义（提案指定）：headless 宿主无显示环境，非暂时性故障，
			// 客户端不应重试
			shared.Error(c, http.StatusNotImplemented, err.Error(), nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "reveal failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "opener": opener})
}
