package terminal

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	shared "codecombo/server/api/shared"

	"github.com/gin-gonic/gin"
)

const (
	// pasteImageBodyMaxBytes 粘贴上传请求体上限（multipart 开销余量随最大形态走）
	// 单字段上限另行校验：image 形态 10MB / file 形态 20MB（P-20261024-2）
	pasteImageBodyMaxBytes = int64(22) << 20

	// pasteImageMaxBytes image 形态（截图 blob）单文件上限：截图通常 < 2MB，留余量
	pasteImageMaxBytes = 10 << 20
	// pasteFileMaxBytes file 形态（P-20261024-2 通用文件粘贴）单文件上限
	pasteFileMaxBytes = 20 << 20
)

// pasteFileAllowedExts file 形态扩展名白名单（P-20261024-2：常见文档/文本/代码/
// 压缩/office 族 + 图片）。按扩展名而非 Content-Type 判定——paste 事件 File 的
// MIME 常为空或通用 octet-stream（浏览器按扩展名猜、猜不出即空），扩展名是上传
// 意图的最直白信号。v1 有意收窄（不是通用网盘上传：目的是把 OS 里复制的文件
// 引用交给终端/agent），扩充时与 web/src/utils/pasteFiles.ts PASTE_FILE_ALLOWED_EXTS
// 及 server/api/remote/remotehost_terminal.go remotePasteFileExt 三处对账
var pasteFileAllowedExts = map[string]bool{
	// 图片（OS 里复制的图片文件走 file 形态；截图 blob 才走 image 形态）
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".bmp": true, ".svg": true,
	// 纯文本 / 结构化文本
	".txt": true, ".md": true, ".markdown": true, ".log": true, ".csv": true, ".tsv": true,
	".json": true, ".jsonl": true, ".xml": true, ".yml": true, ".yaml": true, ".toml": true,
	".ini": true, ".cfg": true, ".conf": true, ".sql": true, ".html": true, ".htm": true, ".css": true,
	// 常见源码
	".js": true, ".mjs": true, ".cjs": true, ".ts": true, ".tsx": true, ".jsx": true,
	".py": true, ".go": true, ".rs": true, ".java": true, ".kt": true, ".swift": true,
	".c": true, ".h": true, ".cpp": true, ".hpp": true, ".cc": true,
	".sh": true, ".bash": true, ".zsh": true, ".bat": true, ".cmd": true, ".ps1": true,
	".rb": true, ".php": true, ".lua": true, ".pl": true, ".r": true,
	".dart": true, ".vue": true, ".svelte": true,
	// office / 文档
	".pdf": true, ".doc": true, ".docx": true, ".xls": true, ".xlsx": true,
	".ppt": true, ".pptx": true, ".odt": true, ".ods": true, ".odp": true, ".rtf": true, ".epub": true,
	// 压缩包
	".zip": true, ".tar": true, ".gz": true, ".tgz": true, ".bz2": true, ".xz": true, ".7z": true, ".rar": true,
}

// UploadPasteImage 接收前端粘贴链捕获的上传载荷，保存到系统临时目录，返回文件
// 绝对路径。前端把该路径作为 text paste 到终端，让 claude code 等 CLI 工具读取。
//
// 两种形态按 multipart 字段分派（P-20261024-2 通用化，同端点增量扩展）：
//   - "image"：截图 blob（右键粘贴 / Ctrl+V 截图兜底的 read() 链），Content-Type
//     四类精确白名单，10MB 上限——既有语义不变（旧前端只发此形态，兼容不破坏）；
//   - "file"：OS 复制的任意白名单文件（paste 事件 clipboardData.files），扩展名
//     白名单，20MB 上限。单次多文件由前端逐个请求（每请求恰一个 file 段；单次
//     粘贴 ≤5 个的总量闸在前端 pasteFiles.ts PASTE_FILE_MAX_COUNT）。
//
// 临时文件命名 sc-paste-<unixms>.<ext>（碰撞时 -<n> 后缀），由 paste-cleaner
// 按 24h 清理（前缀匹配，对本扩展零改动）。
func UploadPasteImage(c *gin.Context) {
	// body 上限在 multipart 解析前套上：FormFile 会先把整个 multipart 体
	// 读入内存/临时文件，无上限时超大请求体在 header.Size 检查前已付出代价。
	// 22MB = file 形态本体 20MB 上限 + multipart 编码开销余量
	shared.LimitBody(c, pasteImageBodyMaxBytes)

	// 优先 file 形态（P-20261024-2）；缺省回落既有 image 形态（旧前端兼容）。
	// 用 ErrMissingFile 判别「字段不存在」而非错误即回落——file 字段在但解析失败
	//（超限/非 multipart）必须如实回告，不能静默换字段二次解析
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		if shared.BodyTooLarge(err) {
			shared.Error(c, http.StatusRequestEntityTooLarge, "Upload paste file failed",
				fmt.Errorf("request body too large (max %d bytes)", pasteImageBodyMaxBytes))
			return
		}
		if !errors.Is(err, http.ErrMissingFile) {
			shared.Error(c, http.StatusBadRequest, "Upload paste file failed", err)
			return
		}
		file, header, err = c.Request.FormFile("image")
		if err != nil {
			if shared.BodyTooLarge(err) {
				shared.Error(c, http.StatusRequestEntityTooLarge, "Upload paste image failed",
					fmt.Errorf("request body too large (max %d bytes)", pasteImageBodyMaxBytes))
				return
			}
			shared.Error(c, http.StatusBadRequest, "Upload paste image failed", err)
			return
		}
		uploadPasteImage(c, file, header)
		return
	}
	uploadPasteFile(c, file, header)
}

// uploadPasteFile file 形态：扩展名白名单 + 20MB 上限，落位/命名/清理与 image
// 形态共用 sc-paste-* 生命周期
func uploadPasteFile(c *gin.Context, file multipart.File, header *multipart.FileHeader) {
	ext, err := validatePasteFile(header)
	if err != nil {
		shared.Error(c, http.StatusBadRequest, "Upload paste file failed", err)
		return
	}
	writePasteTempFile(c, file, header, ext, "Upload paste file failed")
}

// uploadPasteImage image 形态（既有语义）：Content-Type 四类精确白名单 + 10MB 上限
func uploadPasteImage(c *gin.Context, file multipart.File, header *multipart.FileHeader) {
	if header.Size > pasteImageMaxBytes {
		shared.Error(c, http.StatusBadRequest, "Upload paste image failed",
			fmt.Errorf("image too large: %d bytes (max %d)", header.Size, pasteImageMaxBytes))
		return
	}
	ext := ".png"
	switch header.Header.Get("Content-Type") {
	case "image/png":
		ext = ".png"
	case "image/jpeg":
		ext = ".jpg"
	case "image/gif":
		ext = ".gif"
	case "image/webp":
		ext = ".webp"
	}
	writePasteTempFile(c, file, header, ext, "Upload paste image failed")
}

// validatePasteFile file 形态校验：大小上限 + 扩展名白名单，返回落盘扩展名。
// 扩展名取自原始文件名（File.name 只有 basename，无目录成分；lowercase 归一），
// 白名单外的扩展名（含无扩展名文件——Makefile 等在 v1 白名单外，引导走文件树
// 上传链）一律拒绝
func validatePasteFile(header *multipart.FileHeader) (string, error) {
	if header.Size > pasteFileMaxBytes {
		return "", fmt.Errorf("file too large: %d bytes (max %d)", header.Size, pasteFileMaxBytes)
	}
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !pasteFileAllowedExts[ext] {
		return "", fmt.Errorf("unsupported paste file type: %q", ext)
	}
	return ext, nil
}

// writePasteTempFile 落盘共用尾段：sc-paste-<unixms>.<ext> 命名 + 流式拷贝 +
// Windows 正斜杠路径回告（shell 兼容，既有惯例）
func writePasteTempFile(c *gin.Context, file multipart.File, header *multipart.FileHeader, ext string, errMsg string) {
	tmpDir := os.TempDir()
	name := fmt.Sprintf("sc-paste-%d%s", time.Now().UnixNano()/int64(time.Millisecond), ext)
	dst, fullPath, err := createUniquePasteFile(tmpDir, name)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, errMsg, err)
		return
	}
	defer dst.Close()

	if _, err := io.Copy(dst, file); err != nil {
		os.Remove(fullPath)
		shared.Error(c, http.StatusInternalServerError, errMsg, err)
		return
	}

	// Windows 路径反斜杠在 shell 里需要正斜杠或转义；统一返回正斜杠
	path := fullPath
	if runtime.GOOS == "windows" {
		path = filepath.ToSlash(fullPath)
	}

	c.JSON(http.StatusOK, gin.H{
		"data": gin.H{
			"path": path,
			"size": header.Size,
		},
	})
}

// createUniquePasteFile 在 dir 下以 name 创建独占新文件：O_EXCL 两重保障——
// ① 同毫秒多次上传的命名碰撞不互相覆盖（批量粘贴逐个请求的现实形态，也是
// 既有 image 链的潜在 bug）；② 不跟随符号链接（多用户 Linux 的共享 /tmp 上，
// 预埋 sc-paste-* symlink 可劫持写入路径——远端形态 remotePasteName 随机后缀
// 同因）。0600：粘贴载荷可能含敏感内容，收敛到本用户可读（原 os.Create 为
// 0666&umask）。碰撞时按 sc-paste-<ms>-1.<ext> 步进（cleaner 前缀匹配不受影响）
func createUniquePasteFile(dir, name string) (*os.File, string, error) {
	full := filepath.Join(dir, name)
	base := strings.TrimSuffix(name, filepath.Ext(name))
	ext := filepath.Ext(name)
	for i := 0; i < 100; i++ {
		f, err := os.OpenFile(full, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err == nil {
			return f, full, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return nil, "", err
		}
		full = filepath.Join(dir, fmt.Sprintf("%s-%d%s", base, i+1, ext))
	}
	return nil, "", fmt.Errorf("cannot create unique paste file in %s", dir)
}

// ============== 临时文件清理 ==============
// 粘贴上传产生的 sc-paste-* 文件（image/file 两形态同前缀）由本服务管理生命周期：
// - 启动时清理一次（清掉上次运行遗留的过期文件）
// - 内核调度器每 6h 清理一次（删 24h 前的，paste-cleaner 模块托管）
// 避免长期运行累积占用磁盘（系统 TMP 自身清理策略不可靠）

const (
	pasteImageMaxAge        = 24 * time.Hour // 超过 24h 的 sc-paste-* 视为可清理
	pasteImageCleanInterval = 6 * time.Hour  // 定时清理间隔
)

// CleanupStalePasteImages 扫描系统临时目录，删除超过 maxAge 的 sc-paste-* 文件
func CleanupStalePasteImages(maxAge time.Duration) {
	tmpDir := os.TempDir()
	entries, err := os.ReadDir(tmpDir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-maxAge)
	removed := 0
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		// 仅匹配本服务产生的 sc-paste-<unixms>[-<n>].<ext> 文件
		if !strings.HasPrefix(name, "sc-paste-") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			if os.Remove(filepath.Join(tmpDir, name)) == nil {
				removed++
			}
		}
	}
	if removed > 0 {
		fmt.Printf("[terminal] cleaned %d stale paste file(s) older than %s\n", removed, maxAge)
	}
}
