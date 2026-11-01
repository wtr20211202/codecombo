package remote

import (
	"archive/zip"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"path"
	"strings"
	"time"

	shared "codecombo/server/api/shared"

	"github.com/gin-gonic/gin"
)

// ============== 远程目录 zip 流式下载 ==============
//
// 目录浏览器下载此前不可用（只能提示走终端打包）。这里在 fileClient 抽象上
// 递归遍历目录树，边遍历边把文件写进 zip 流（不落盘、不整读进内存），
// SFTP 与 FTP 主机同时受益。上限防御与跨主机互传对齐：
// 条目数/总字节/深度三重上限，触顶后优雅收尾（zip 中央目录正常写出，
// 客户端得到合法但截断的包，slog 记录），而不是半途掐断留下损坏文件。

const (
	// zipMaxEntries 单个目录包最大条目数
	zipMaxEntries = 20000
	// zipMaxTotalBytes 单个目录包未压缩总字节上限（与互传 copyMaxTotalSize 对齐）
	zipMaxTotalBytes = int64(8) << 30
	// zipMaxDepth 递归深度上限（防御符号链接/异常深树导致栈失控）
	zipMaxDepth = 32
)

// zipWalker 目录树遍历回调：p 为远端绝对路径，rel 为包内相对路径（POSIX），
// e 为条目元数据。返回 error 终止遍历
type zipWalker func(p, rel string, e entryMeta) error

type entryMeta struct {
	size  int64
	isDir bool
	mtime int64 // unix 毫秒
}

// walkRemoteTree 先序遍历远端目录树（根目录本身不回调）。depth 从 1 起
func walkRemoteTree(ctx context.Context, fc fileClient, root, rel string, depth int, fn zipWalker) error {
	if depth > zipMaxDepth {
		return fmt.Errorf("tree too deep (>%d) at %s", zipMaxDepth, root)
	}
	entries, err := fc.ListDir(root)
	if err != nil {
		return fmt.Errorf("list %s: %w", root, err)
	}
	for _, e := range entries {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		p := path.Join(root, e.Name)
		childRel := e.Name
		if rel != "" {
			childRel = rel + "/" + e.Name
		}
		meta := entryMeta{size: e.Size, isDir: e.IsDir, mtime: e.Mtime}
		if err := fn(p, childRel, meta); err != nil {
			return err
		}
		if e.IsDir {
			if err := walkRemoteTree(ctx, fc, p, childRel, depth+1, fn); err != nil {
				return err
			}
		}
	}
	return nil
}

// appendTreeZip 把 root 目录树追加到已有 zip writer（归档端点复用）
func appendTreeZip(ctx context.Context, zw *zip.Writer, fc fileClient, root, name string) (int, bool, error) {
	var entries int
	var total int64
	truncated := false
	werr := walkRemoteTree(ctx, fc, root, "", 1, func(fp, rel string, m entryMeta) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if m.isDir {
			return nil // 目录不作为条目写出，靠 rel 路径结构承载层级
		}
		if entries >= zipMaxEntries || total+m.size > zipMaxTotalBytes {
			truncated = true
			return errZipTruncated
		}
		hdr := &zip.FileHeader{Name: path.Join(name, rel), Method: zip.Deflate}
		if m.mtime > 0 {
			hdr.Modified = time.UnixMilli(m.mtime)
		}
		zwEntry, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}
		f, err := fc.Open(fp)
		if err != nil {
			// 单文件打不开不炸整包：写占位说明后继续
			fmt.Fprintf(zwEntry, "[skipped: %v]", err)
			slog.Warn("remote zip: open failed, skipped", "path", fp, "err", err)
			return nil
		}
		n, err := io.Copy(zwEntry, f)
		f.Close()
		entries++
		total += n
		if err != nil {
			return fmt.Errorf("read %s: %w", fp, err)
		}
		return nil
	})
	if werr != nil && werr != errZipTruncated && ctx.Err() == nil {
		// 调用方可能已发出响应头；正常收尾 zip 让客户端拿到可打开的部分包
		slog.Warn("remote zip: walk aborted", "root", root, "err", werr)
	}
	if truncated {
		slog.Warn("remote zip: truncated at limits", "root", root, "entries", entries, "bytes", total)
	}
	return entries, truncated, werr
}

// appendFileZip 把单个远端文件作为 zip 条目追加（条目名 name）
func appendFileZip(ctx context.Context, zw *zip.Writer, fc fileClient, p, name string, mtime int64) (int64, error) {
	hdr := &zip.FileHeader{Name: name, Method: zip.Deflate}
	if mtime > 0 {
		hdr.Modified = time.UnixMilli(mtime)
	}
	zwEntry, err := zw.CreateHeader(hdr)
	if err != nil {
		return 0, err
	}
	f, err := fc.Open(p)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	return io.Copy(zwEntry, f)
}

// DownloadRemoteFilesAsZip GET /api/remotehosts/:id/files/archive?paths=/a&paths=/b
// 归档下载（文件与目录混合，单项多项同一端点；一次拨号，服务端流式打包不落盘）。
// 单目录即「目录下载」，多选即「批量归档」，前端无需区分
func DownloadRemoteFilesAsZip(c *gin.Context) {
	paths := c.QueryArray("paths")
	if len(paths) == 0 || len(paths) > 50 {
		shared.Error(c, http.StatusBadRequest, "paths must contain 1..50 entries", nil)
		return
	}
	for _, p := range paths {
		if validateRemotePath(p) != nil {
			shared.Error(c, http.StatusBadRequest, "invalid path", nil)
			return
		}
	}
	fc, err := dialHostFile(c.Param("id"))
	if err != nil {
		dialFileErr(c, err)
		return
	}
	defer fc.Close()

	// 包名：单项用其名，多项用时间戳归档名
	var zipName string
	if len(paths) == 1 {
		zipName = path.Base(paths[0])
	} else {
		zipName = "archive-" + time.Now().Format("20060102-150405")
	}
	zipName += ".zip"
	c.Header("Content-Type", "application/zip")
	// 下载头统一净化 helper（P-20261003-109）：远端目录/文件名用户可控，同
	// 本地 dir-archive 端点收口
	c.Header("Content-Disposition", shared.ContentDispositionFile(zipName))

	ctx := c.Request.Context()
	zw := zip.NewWriter(c.Writer)
	defer zw.Close()

	// 跨路径聚合上限（appendTreeZip 内部还有单路径上限，双重防御）
	var entries int
	var total int64
	used := map[string]bool{}
	for _, p := range paths {
		if ctx.Err() != nil {
			return
		}
		if entries >= zipMaxEntries || total > zipMaxTotalBytes {
			slog.Warn("remote archive: aggregate limits reached", "entries", entries, "bytes", total)
			return
		}
		_, isDir, err := fc.Stat(p)
		if err != nil {
			slog.Warn("remote archive: stat failed, skipped", "path", p, "err", err)
			continue
		}
		base := uniqueName(used, path.Base(p), isDir)
		if isDir {
			n, _, err := appendTreeZip(ctx, zw, fc, p, base)
			entries += n
			if err != nil && ctx.Err() == nil {
				slog.Warn("remote archive: dir walk aborted", "root", p, "err", err)
			}
			continue
		}
		// 文件 mtime 不回查（fileClient.Stat 只给 size/isDir；时间戳缺省可接受）
		n, err := appendFileZip(ctx, zw, fc, p, base, 0)
		if err != nil {
			slog.Warn("remote archive: file append failed, skipped", "path", p, "err", err)
			continue
		}
		entries++
		total += n
	}
}

// uniqueName 多选路径 basenames 冲突时追加序号（/a/x.txt 与 /b/x.txt 同包）
func uniqueName(used map[string]bool, base string, isDir bool) string {
	name := base
	for i := 2; used[name]; i++ {
		if isDir {
			name = fmt.Sprintf("%s-%d", base, i)
		} else {
			ext := path.Ext(base)
			name = fmt.Sprintf("%s-%d%s", strings.TrimSuffix(base, ext), i, ext)
		}
	}
	used[name] = true
	return name
}

// errZipTruncated 触达打包上限的内部哨兵（不视为错误路径）
var errZipTruncated = fmt.Errorf("zip limits reached")
