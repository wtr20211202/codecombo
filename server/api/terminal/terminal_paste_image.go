package terminal

import (
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	shared "codecombo/server/api/shared"
	"codecombo/server/pastetmp"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 粘贴上传限额单一事实源 = server/pastetmp（P-20261123-5）：owner 端 file 100MB /
// image 20MB / body 104MB（用户主诉 20MB 过紧；104 = 100 + 4MB multipart 余量）。
// share/remote 两端各自引用 pastetmp.Share / pastetmp.Remote，三端不再各写字面量。
// pasteOwnerLimits 当前生效的 owner 端限额（P-20261123-6）：每次上传请求现读
// settings 生效值——设置页/PUT /api/settings 保存即按请求热生效，无需重启。
// store 为 nil（测试/早期路径）回落 P-5 默认 100/20；BodyMax 按 file 生效值 +4MB
// 推导（pastetmp.BodyMaxForMB 统一算式）。owner file 1~512MB 可上调（multipart
// spool+二次落盘约 2× 峰值磁盘，UI 明示），image 1~64MB
func pasteOwnerLimits() (pastetmp.Limit, int64) {
	lim := pastetmp.Owner
	if st := store.Get(); st != nil && st.Settings != nil && st.Settings.Get() != nil {
		lim, _, _ = st.Settings.Get().Server.EffectivePasteLimits()
	}
	return lim, pastetmp.BodyMaxForMB(lim.FileMB, 4)
}

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
	// 104MB = file 形态本体 100MB 上限 + multipart 编码开销余量（P-20261123-5）
	lim, bodyMax := pasteOwnerLimits()
	shared.LimitBody(c, bodyMax)
	// Content-Length 早拒（P-20261123-5 方案①）：声明超限时按 file 上限口径回
	// 413——用户拿到「文件上限 N MB」这个可行动信息；同时省超限请求的整体 spool
	//（快路径；chunked 的 ContentLength=-1 走 MaxBytesReader 兜底）
	if cl := c.Request.ContentLength; cl > bodyMax {
		shared.Error(c, http.StatusRequestEntityTooLarge, "Upload paste file failed",
			fmt.Errorf("file too large: %s (max %s)", pastetmp.MBText(cl), pastetmp.MBText(lim.FileMB*1024*1024)))
		return
	}
	// 读超时延长（P-20261123-5 方案①）：全局 ReadTimeout 30s 对 100MB 慢链路不够，
	// 本路由延长到 5 分钟；不动全局（其他端点维持既有 DoS 面）。gin 1.12
	// responseWriter 有 Unwrap，ResponseController 可达底层连接；设置失败（如
	// httptest.ResponseRecorder 无底层连接）不阻断主流程，保护降级为全局超时
	if rc := http.NewResponseController(c.Writer); rc != nil {
		_ = rc.SetReadDeadline(time.Now().Add(5 * time.Minute))
	}

	// 优先 file 形态（P-20261024-2）；缺省回落既有 image 形态（旧前端兼容）。
	// 用 ErrMissingFile 判别「字段不存在」而非错误即回落——file 字段在但解析失败
	//（超限/非 multipart）必须如实回告，不能静默换字段二次解析
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		if shared.BodyTooLarge(err) {
			shared.Error(c, http.StatusRequestEntityTooLarge, "Upload paste file failed",
				fmt.Errorf("request body too large (max %s)", pastetmp.MBText(bodyMax)))
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
					fmt.Errorf("request body too large (max %s)", pastetmp.MBText(bodyMax)))
				return
			}
			shared.Error(c, http.StatusBadRequest, "Upload paste image failed", err)
			return
		}
		uploadPasteImage(c, file, header, lim)
		return
	}
	uploadPasteFile(c, file, header, lim)
}

// uploadPasteFile file 形态：扩展名白名单 + 20MB 上限，落位/命名/清理与 image
// 形态共用 sc-paste-* 生命周期
func uploadPasteFile(c *gin.Context, file multipart.File, header *multipart.FileHeader, lim pastetmp.Limit) {
	ext, err := validatePasteFile(header, lim)
	if err != nil {
		shared.Error(c, http.StatusBadRequest, "Upload paste file failed", err)
		return
	}
	writePasteTempFile(c, file, header, ext, "Upload paste file failed")
}

// uploadPasteImage image 形态（既有语义）：Content-Type 四类精确白名单 + 10MB 上限
func uploadPasteImage(c *gin.Context, file multipart.File, header *multipart.FileHeader, lim pastetmp.Limit) {
	if header.Size > lim.ImageMB*1024*1024 {
		shared.Error(c, http.StatusBadRequest, "Upload paste image failed",
			fmt.Errorf("image too large: %s (max %s)", pastetmp.MBText(header.Size), pastetmp.MBText(lim.ImageMB*1024*1024)))
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
func validatePasteFile(header *multipart.FileHeader, lim pastetmp.Limit) (string, error) {
	if header.Size > lim.FileMB*1024*1024 {
		return "", fmt.Errorf("file too large: %s (max %s)", pastetmp.MBText(header.Size), pastetmp.MBText(lim.FileMB*1024*1024))
	}
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !pasteFileAllowedExts[ext] {
		return "", fmt.Errorf("unsupported paste file type: %q", ext)
	}
	return ext, nil
}

// writePasteTempFile 落盘共用尾段：sc-paste-<unixms>.<ext> 命名 + 流式拷贝 +
// Windows 正斜杠路径回告（shell 兼容，既有惯例）。命名与 O_EXCL 独占创建在
// pastetmp 微包（P-20261122-1 访客粘贴上传链共用同一事实源——同前缀即共享
// paste-cleaner 生命周期，同 O_EXCL 防同毫秒碰撞/共享 /tmp symlink 劫持）
func writePasteTempFile(c *gin.Context, file multipart.File, header *multipart.FileHeader, ext string, errMsg string) {
	dst, fullPath, err := pastetmp.Create(os.TempDir(), pastetmp.Name(ext))
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
