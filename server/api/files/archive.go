package files

import (
	"archive/zip"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/middleware"
	"codecombo/server/share"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// ============== 本地目录 zip 流式下载（P-20261002-115） ==============
//
// 远程主机面板早有目录 zip 取件（remotehost_zip.go），本地文件树的目录此前
// 只能逐文件下载——备份/转移/离线查看得开终端打包或绕远程面板。本端点把
// 本地目录流式打包为 zip 响应（不落盘、不整读进内存），语义对齐两处既有实现：
//   - 护栏对齐 remotehost_zip：条目数/总字节双上限，触顶优雅收尾（zip 中央
//     目录正常写出，客户端拿到合法但截断的包）；响应头先于流发出，截断无法
//     事后回传，故前端走 probe=1 先行预估规模（dirZipScale），截断提示据此
//   - 锚定与链接策略对齐 share：SafeJoinProject 三道闸 + os.Root 双层锚定
//     （stat.go statTarget 同款），符号链接条目一律跳过不打包（包内链接可被
//     解压侧还原为指向包外任意路径的链接，zip-slip 变体，share/writeZip 同策略）
//   - 出域防线对齐 P-26 分享扫描：打包前跑 share.ScanSensitive（文件名级
//     确定性匹配，同一扫描器零分叉），命中警示 + override 二次请求流同款

const (
	// dirZipMaxEntries 单目录包最大条目数（remotehost_zip zipMaxEntries 同值）
	dirZipMaxEntries = 20000
	// dirZipMaxTotalBytes 单目录包未压缩总字节上限（remotehost_zip zipMaxTotalBytes 同值）
	dirZipMaxTotalBytes = int64(8) << 30
)

// dirZipLimits 打包护栏（条目数/总字节）+ 排除面；limit 独立成参供单测用
// 小上限验证截断语义（statTarget/scanSensitive 同款）
type dirZipLimits struct {
	maxEntries int
	maxBytes   int64
	excludeGit bool
}

// dirZipScale 打包规模预估（probe 响应，前端截断提示与成功 toast 的数据源）
type dirZipScale struct {
	Entries   int64 `json:"entries"`   // 将写入包内的文件条目数（目录占位与符号链接不计）
	Bytes     int64 `json:"bytes"`     // 未压缩内容字节总量
	Truncated bool  `json:"truncated"` // 超护栏预估：实际打包会在上限处截断
}

// DownloadDirArchive GET /api/projects/:id/dir-archive?path=&probe=1&override=1
//
//   - probe=1：不出包，返回 {data: 规模预估, warnings: 敏感命中, scanTruncated}
//   - 默认：敏感扫描命中且未确认（override!=1）时不出包，409 拦回 warnings
//     （与分享创建同流；P-20261030-2 起取包直链化，200+JSON 会被浏览器存成
//     假 zip，故拦回改错误状态码——下载条显式失败，载荷形态不变）；
//     确认或无命中则以 application/zip 流式响应
//
// .git 目录默认排除（历史对象树占大头，打包带走的是工作区快照；
// excludeGit=0 可带）——排除面与 probe 预估口径一致
func DownloadDirArchive(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}
	// NormalizeRelPath 先行：反斜杠归一 + 内部 ".." 逐级上跳（SafeJoinProject
	// 对含 ".." 的原始串一律拒绝，会把合法的 "a/../b" 也拦掉；归一后再过三道闸）
	rel, err := share.NormalizeRelPath(c.Query("path"))
	if err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid path", nil)
		return
	}
	absPath, err := SafeJoinProject(p.Path, rel)
	if err != nil {
		shared.Error(c, http.StatusForbidden, err.Error(), nil)
		return
	}
	info, err := os.Stat(absPath)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "directory not found", nil)
		return
	}
	if !info.IsDir() {
		shared.Error(c, http.StatusBadRequest, "not a directory", nil)
		return
	}

	// probe：敏感扫描 + 规模预估一次返回（两走树都是元数据级，本地盘同步
	// 路径可承受；share 创建分享前同款同步扫描先例）。前端据此决定弹警示框
	// 还是直接取包，截断预估也让「触顶截断」有提示通道
	if c.Query("probe") == "1" {
		scan, err := share.ScanSensitive(p.Path, rel)
		if err != nil {
			shared.Error(c, http.StatusInternalServerError, "scan directory failed", err)
			return
		}
		scale := dirZipScaleOf(p.Path, absPath, dirZipLimits{
			maxEntries: dirZipMaxEntries, maxBytes: dirZipMaxTotalBytes,
			excludeGit: c.Query("excludeGit") != "0",
		})
		c.JSON(http.StatusOK, gin.H{
			"data":          scale,
			"warnings":      scan.Warnings,
			"scanTruncated": scan.Truncated,
		})
		return
	}

	// 出域防线（P-26 同款）：命中警示未确认时不出包
	scan, err := share.ScanSensitive(p.Path, rel)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "scan directory failed", err)
		return
	}
	if len(scan.Warnings) > 0 && c.Query("override") != "1" {
		slog.Info("dir archive blocked by sensitive scan", "project", p.Name, "path", rel,
			"hits", len(scan.Warnings), "truncated", scan.Truncated)
		// 409 而非 200+JSON（P-20261030-2）：取包已直链化——直链响应 200 会被
		// 浏览器按 a.download 存成假 zip（JSON 内容 .zip 名）。拦回属「确认
		// 冲突」语义，409 让浏览器显式下载失败（下载条可见），载荷形态不变
		c.JSON(http.StatusConflict, gin.H{"warnings": scan.Warnings, "scanTruncated": scan.Truncated})
		return
	}

	zipName := info.Name()
	if rel == "" {
		zipName = filepath.Base(mustAbsRoot(p.Path)) // 项目根本身：取目录名
	}
	zipName += ".zip"
	c.Header("Content-Type", "application/zip")
	// 下载头统一净化 helper（P-20261003-109）：目录名用户可控，同 download.go
	c.Header("Content-Disposition", shared.ContentDispositionFile(zipName))

	excludeGit := c.Query("excludeGit") != "0"
	lim := dirZipLimits{maxEntries: dirZipMaxEntries, maxBytes: dirZipMaxTotalBytes, excludeGit: excludeGit}
	st := streamDirZip(c.Writer, p.Path, absPath, lim)
	if st.err != nil {
		// 头已发出，只能日志留痕（前端表现为 zip 提前截断/损坏，remotehost_zip 同）
		slog.Warn("dir archive: zip streaming aborted", "project", p.Name, "path", rel, "err", st.err)
	}
	slog.Info("dir archive downloaded", "project", p.Name, "path", rel,
		"entries", st.entries, "bytes", st.bytes, "truncated", st.truncated)
	// 审计入账：目录打包把项目内容批量带出本机，与分享创建同族数据出域动作
	// （P-26 修正项：zip 不应成为绕过扫描的旁路，也不应绕过留痕）
	detail := fmt.Sprintf("%s: %s (%d entries)", p.Name, rel, st.entries)
	if st.truncated {
		detail += " truncated"
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditFileDirArchive,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: detail,
	})
}

// dirZipStats 打包统计（审计与日志摘要；err 为走树中断原因，不影响已写出部分）
type dirZipStats struct {
	entries   int64
	bytes     int64
	truncated bool
	err       error
}

// streamDirZip 把 absTarget 目录树流式打包写入 w。os.Root 双层锚定（项目根 +
// 目标目录），符号链接条目跳过，.git 目录按 lim.excludeGit 整枝跳过；护栏
// 触顶停止追加并置 truncated，zip 中央目录照常写出（合法但截断的包）。
// 深度无显式上限：os.Root.FS 不沿符号链接深入（链接条目直接跳过），WalkDir
// 递归深度即真实树深且被条目上限兜住，不构成栈失控面
func streamDirZip(w io.Writer, rootPath, absTarget string, lim dirZipLimits) dirZipStats {
	var st dirZipStats
	zw := zip.NewWriter(w)
	if err := appendDirTree(zw, rootPath, absTarget, "", &st, lim); err != nil && st.err == nil {
		st.err = err
	}
	// 中央目录必须写出：即使走树中断也让客户端拿到可打开的部分包
	if cerr := zw.Close(); cerr != nil && st.err == nil {
		st.err = cerr
	}
	return st
}

// appendDirTree 把 absTarget 目录树追加进 zw（P-20261003-250 自 streamDirZip
// 参数化抽出，供多选批量归档与单目录包共用一条走树实现）。条目名 =
// prefix + 树内相对路径：prefix 传空 = 单目录包语义（包结构以所选目录为根，
// 不再包一层目录名）；批量归档传「去重后 basename + /」让多个选择项同包
// 各自成根。st 跨目标聚合（多选一包共用护栏），触顶置 truncated 停止追加。
// 符号链接条目跳过、.git 按 lim.excludeGit 整枝跳过、单条目不可读即中止
// 走树（静默跳过会低报包内容，日志留痕为准）等语义与原实现一致
func appendDirTree(zw *zip.Writer, rootPath, absTarget, prefix string, st *dirZipStats, lim dirZipLimits) error {
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return err
	}
	defer root.Close()
	dir, closeDir, err := openRootAt(root, rootPath, absTarget)
	if err != nil {
		return err
	}
	defer closeDir()

	fsys := dir.FS()
	return fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err // 单条目不可读即中止走树：静默跳过会低报包内容，日志留痕为准
		}
		if p == "." {
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		if lim.excludeGit && d.IsDir() && d.Name() == ".git" {
			return fs.SkipDir
		}
		fi, err := d.Info()
		if err != nil {
			return err
		}
		hdr, err := zip.FileInfoHeader(fi)
		if err != nil {
			return err
		}
		hdr.Name = dirZipEntryName(prefix+p, d.IsDir())
		hdr.Modified = fi.ModTime().Truncate(time.Second) // 秒级精度（跨平台 zip 时间戳口径，share writeZip 同）
		if d.IsDir() {
			hdr.Method = zip.Store
			if _, err := zw.CreateHeader(hdr); err != nil {
				return err
			}
			return nil
		}
		// 护栏：条目数/总字节触顶即停止追加（先记账后写头部，保证 truncated
		// 当且仅当确有未打包条目）
		if st.entries >= int64(lim.maxEntries) || st.bytes+fi.Size() > lim.maxBytes {
			st.truncated = true
			return fs.SkipAll
		}
		hdr.Method = zip.Deflate
		out, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}
		f, err := fsys.Open(p)
		if err != nil {
			return err
		}
		n, err := io.Copy(out, f)
		f.Close()
		st.entries++
		st.bytes += n
		return err
	})
}

// dirZipScaleOf 打包规模预估（元数据走树，与 streamDirZip 同排除面同护栏口径：
// 符号链接与 .git 不计，触顶即收尾并置 Truncated）。仅供 probe 响应展示
func dirZipScaleOf(rootPath, absTarget string, lim dirZipLimits) dirZipScale {
	var sc dirZipScale
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return sc
	}
	defer root.Close()
	dir, closeDir, err := openRootAt(root, rootPath, absTarget)
	if err != nil {
		return sc
	}
	defer closeDir()
	_ = fs.WalkDir(dir.FS(), ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || p == "." {
			return nil // 单条目不可读不阻断预估（下界口径，stat.go statTarget 同）
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		if d.IsDir() {
			if lim.excludeGit && d.Name() == ".git" {
				return fs.SkipDir
			}
			return nil
		}
		// 先记账后上限：第 lim.maxEntries+1 个条目触发收尾——由此
		// Truncated=true 当且仅当确有未预估条目（scan.go scanSensitive 同语义）
		if sc.Entries >= int64(lim.maxEntries) || sc.Bytes >= lim.maxBytes {
			sc.Truncated = true
			return fs.SkipAll
		}
		sc.Entries++
		if fi, e := d.Info(); e == nil {
			sc.Bytes += fi.Size()
		}
		return nil
	})
	return sc
}

// openRootAt 把 SafeJoinProject 产出的绝对路径折回根内 / 分隔相对路径并收紧
// 到该目录（os.Root API 契约只认 / 分隔；stat.go statTarget 同款双层锚定）。
// 目标即项目根（rel=""）时直接复用外层 Root；返回的 closeDir 只关本函数
// 真正打开的子 Root（外层 Root 归调用方）
func openRootAt(root *os.Root, rootPath, absTarget string) (*os.Root, func(), error) {
	rel := ""
	if trimmed := strings.TrimPrefix(absTarget, mustAbsRoot(rootPath)); trimmed != "" {
		rel = filepath.ToSlash(strings.TrimPrefix(trimmed, string(filepath.Separator)))
	}
	if rel == "" {
		return root, func() {}, nil
	}
	sub, err := root.OpenRoot(rel)
	if err != nil {
		return nil, func() {}, err
	}
	return sub, func() { sub.Close() }, nil
}

// dirZipEntryName 包内条目名（fs 路径直接承载层级，目录补尾斜杠；share
// writeZip zipEntryName 同约定）
func dirZipEntryName(p string, isDir bool) string {
	if isDir {
		return p + "/"
	}
	return p
}
