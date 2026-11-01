package remote

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"strings"
	"time"

	shared "codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/ftpclient"
	"codecombo/server/middleware"
	"codecombo/server/sshclient"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// ============== 远程主机文件管理（SFTP / FTP 双协议） ==============
//
// 浏览/下载/上传/建目录/重命名/删除按主机 protocol 分派；
// 跨主机互传仅 SFTP 主机间可用（FTP 侧无流式打开→写通道的对称实现，且
// FTP 为明文协议，作为互传中转端不合适）。
// 路径是远端主机文件系统路径，在远端用户权限内操作——不做服务器侧路径
// 穿越白名单（穿越目标是远端而非本机），但拒绝空路径、NUL 字节与超长路径。

const (
	// filesMaxPathLen 远程路径长度上限（防御性）
	filesMaxPathLen = 4096
	// filesUploadMaxBytes 单文件上传上限
	filesUploadMaxBytes = int64(1) << 30 // 1 GiB
)

// validateRemotePath 基础合法性校验
func validateRemotePath(p string) error {
	if strings.TrimSpace(p) == "" {
		return fmt.Errorf("path is required")
	}
	if len(p) > filesMaxPathLen {
		return fmt.Errorf("path too long")
	}
	if strings.ContainsRune(p, 0) {
		return fmt.Errorf("path contains null byte")
	}
	return nil
}

// fileClient 文件管理通道抽象（SFTP 与 FTP 双实现，api 层只面向该接口）
type fileClient interface {
	ListDir(p string) ([]sshclient.DirEntry, error)
	Stat(p string) (size int64, isDir bool, err error)
	Open(p string) (io.ReadCloser, error)
	Upload(r io.Reader, p string) error
	Mkdir(p string) error
	MkdirAll(p string) error
	Rename(from, to string) error
	RemoveAll(p string) error
	// Chmod 远端权限位设置（编辑器写路径保权限用；FTP 无对应语义，恒 nil——
	// 编辑器读写入口已按协议拒入 FTP，此实现仅为接口完整性）
	Chmod(p string, mode os.FileMode) error
	// Mode 远端文件权限位（编辑器写路径读取原权限；读不到返回 err，调用方
	// 落默认 0644）
	Mode(p string) (os.FileMode, error)
	Close() error
}

// sftpFileClient sshclient.Client 适配
type sftpFileClient struct{ c *sshclient.Client }

func (a *sftpFileClient) ListDir(p string) ([]sshclient.DirEntry, error) { return a.c.ListDir(p) }
func (a *sftpFileClient) Stat(p string) (int64, bool, error) {
	fi, err := a.c.StatRemote(p)
	if err != nil {
		return 0, false, err
	}
	return fi.Size(), fi.IsDir(), nil
}
func (a *sftpFileClient) Open(p string) (io.ReadCloser, error)   { return a.c.OpenRemote(p) }
func (a *sftpFileClient) Mkdir(p string) error                   { return a.c.MkdirRemote(p) }
func (a *sftpFileClient) MkdirAll(p string) error                { return a.c.MkdirAllRemote(p) }
func (a *sftpFileClient) Rename(from, to string) error           { return a.c.RenameRemote(from, to) }
func (a *sftpFileClient) RemoveAll(p string) error               { return a.c.RemoveAllRemote(p) }
func (a *sftpFileClient) Chmod(p string, mode os.FileMode) error { return a.c.ChmodRemote(p, mode) }
func (a *sftpFileClient) Mode(p string) (os.FileMode, error) {
	fi, err := a.c.StatRemote(p)
	if err != nil {
		return 0, err
	}
	return fi.Mode().Perm(), nil
}
func (a *sftpFileClient) Close() error { return a.c.Close() }
func (a *sftpFileClient) Upload(r io.Reader, p string) error {
	out, err := a.c.CreateRemote(p)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, r)
	return err
}

// ftpFileClient ftpclient.Client 适配
type ftpFileClient struct{ c *ftpclient.Client }

func (a *ftpFileClient) ListDir(p string) ([]sshclient.DirEntry, error) { return a.c.ListDir(p) }
func (a *ftpFileClient) Stat(p string) (int64, bool, error)             { return a.c.Stat(p) }
func (a *ftpFileClient) Open(p string) (io.ReadCloser, error)           { return a.c.Open(p) }
func (a *ftpFileClient) Upload(r io.Reader, p string) error             { return a.c.UploadStream(r, p) }
func (a *ftpFileClient) Mkdir(p string) error                           { return a.c.Mkdir(p) }
func (a *ftpFileClient) MkdirAll(p string) error                        { return a.c.MkdirAll(p) }
func (a *ftpFileClient) Rename(from, to string) error                   { return a.c.Rename(from, to) }
func (a *ftpFileClient) RemoveAll(p string) error                       { return a.c.RemoveAll(p) }
func (a *ftpFileClient) Chmod(p string, mode os.FileMode) error         { return nil }
func (a *ftpFileClient) Mode(p string) (os.FileMode, error)             { return 0, os.ErrNotExist }
func (a *ftpFileClient) Close() error                                   { return a.c.Quit() }

// dialFileClient 按主机协议解析凭据并建立文件管理通道。
// SSH 主机走 per-host 连接池（P-20261005-159：短操作复用单连接，免每请求
// 全套握手；凭据/指纹/主机配置变更由 CRUD 侧 FlushHost 即时失效）；
// FTP 为明文单控制连接协议，ftpclient 自管连接，无池语义
func dialFileClient(rh *config.RemoteHost) (fileClient, error) {
	if rh.IsFTP() {
		fc, err := ftpclient.Dial(ftpclient.ConnectOptions{
			Host: rh.Host, Port: rh.Port, User: rh.User,
			Password: rh.Password, Timeout: 15 * time.Second,
		})
		if err != nil {
			return nil, err
		}
		return &ftpFileClient{c: fc}, nil
	}
	return leaseHostFile(rh)
}

// dialHostFile 按主机 ID 解析 + 建通道（错误映射 404/502）
func dialHostFile(id string) (fileClient, error) {
	rh, err := store.Get().RemoteHost.Get(id)
	if err != nil {
		return nil, err
	}
	if err := ResolveRemoteHostAuth(rh); err != nil {
		return nil, err
	}
	return dialFileClient(rh)
}

// dialFileErr 拨号/解析错误统一状态码
func dialFileErr(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	if strings.Contains(err.Error(), "not found") {
		shared.Error(c, http.StatusNotFound, "remote host not found", err)
		return true
	}
	respondRemoteDialError(c, "remote host dial failed", err)
	return true
}

// dialHostByID 按主机 ID 解析 + 从池借出连接（互传用；SFTP 主机专用）。
// 返回的租约须 End（调用方 defer）；连接级失败 MarkDead 弃置不回池
func dialHostByID(id string) (*sshclient.PoolLease, *config.RemoteHost, error) {
	rh, err := store.Get().RemoteHost.Get(id)
	if err != nil {
		return nil, nil, err
	}
	if err := ResolveRemoteHostAuth(rh); err != nil {
		return nil, nil, err
	}
	lease, err := conns.Get(rh.ID, dialOptions(rh))
	if err != nil {
		return nil, nil, err
	}
	return lease, rh, nil
}

// dialHostErr 按 dialHostByID 错误类别给状态码
func dialHostErr(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	if strings.Contains(err.Error(), "not found") {
		shared.Error(c, http.StatusNotFound, "remote host not found", err)
		return true
	}
	respondRemoteDialError(c, "remote host dial failed", err)
	return true
}

// ListRemoteFiles GET /api/remotehosts/:id/files/list?path=/foo
func ListRemoteFiles(c *gin.Context) {
	p := c.Query("path")
	if err := validateRemotePath(p); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid path", err)
		return
	}
	fc, err := dialHostFile(c.Param("id"))
	if err != nil {
		dialFileErr(c, err)
		return
	}
	defer fc.Close()
	entries, err := fc.ListDir(p)
	if err != nil {
		shared.Error(c, http.StatusBadGateway, "remote list failed", err)
		return
	}
	// 列目录成功 = 连接认证通过：主机状态点升级为绿（已连通）
	MarkAuthOK(c.Param("id"))
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"path": p, "entries": entries}})
}

// DownloadRemoteFile GET /api/remotehosts/:id/files/download?path=/foo/bar
// 流式回传（128KB 分片 + 客户端断开感知），不整读进内存
func DownloadRemoteFile(c *gin.Context) {
	p := c.Query("path")
	if err := validateRemotePath(p); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid path", err)
		return
	}
	fc, err := dialHostFile(c.Param("id"))
	if err != nil {
		dialFileErr(c, err)
		return
	}
	defer fc.Close()

	_, isDir, err := fc.Stat(p)
	if err != nil {
		shared.Error(c, http.StatusBadGateway, "remote stat failed", err)
		return
	}
	if isDir {
		shared.Error(c, http.StatusBadRequest, "path is a directory", nil)
		return
	}
	f, err := fc.Open(p)
	if err != nil {
		shared.Error(c, http.StatusBadGateway, "remote open failed", err)
		return
	}
	defer f.Close()

	name := path.Base(p)
	c.Header("Content-Type", "application/octet-stream")
	// 下载头统一净化 helper（P-20261003-109）：远端文件名用户可控，RFC 5987
	// 双形式与本地下载端点同源产出（filename 兜底 + filename* 承载真实名）
	c.Header("Content-Disposition", shared.ContentDispositionFile(name))
	// 不设 Content-Length：远端文件可在 Stat 与读取之间变化（日志/构建产物增长），
	// 声明长度与实际不符会让客户端静默截断或协议报错，chunked 传输更健壮

	buf := make([]byte, 128*1024)
	for {
		if c.Request.Context().Err() != nil {
			return // 客户端断开：停止远端读取
		}
		n, rerr := f.Read(buf)
		if n > 0 {
			if _, werr := c.Writer.Write(buf[:n]); werr != nil {
				return
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return // 写头已发出，无法再改状态码；断开连接让客户端感知失败
		}
	}
}

// UploadRemoteFile POST /api/remotehosts/:id/files/upload
// multipart 两种表单：
//   - files=多文件（批量，推荐）：path=目标目录，一次拨号传完
//   - file=单文件（兼容旧客户端）：path=目标目录
//
// 同名覆盖；批量模式部分失败以 failed 回报，状态码仍 200
func UploadRemoteFile(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, filesUploadMaxBytes)
	dir := c.PostForm("path")
	if err := validateRemotePath(dir); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid path", err)
		return
	}

	fc, err := dialHostFile(c.Param("id"))
	if err != nil {
		dialFileErr(c, err)
		return
	}
	defer fc.Close()

	// 批量表单优先
	if form := c.Request.MultipartForm; form != nil && len(form.File["files"]) > 0 {
		saved := make([]gin.H, 0, len(form.File["files"]))
		failed := make([]gin.H, 0)
		for _, fh := range form.File["files"] {
			fhFile, err := fh.Open()
			if err != nil {
				failed = append(failed, gin.H{"name": fh.Filename, "error": err.Error()})
				continue
			}
			dst := path.Join(dir, sanitizeFilename(fh.Filename))
			if err := fc.Upload(fhFile, dst); err != nil {
				fhFile.Close()
				failed = append(failed, gin.H{"name": fh.Filename, "error": err.Error()})
				continue
			}
			fhFile.Close()
			size, _, _ := fc.Stat(dst) // FTP 侧无法从上传过程得到字节数，回读为准
			saved = append(saved, gin.H{"name": fh.Filename, "path": dst, "size": size})
		}
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"saved": saved, "failed": failed}})
		return
	}

	file, header, err := c.Request.FormFile("file")
	if err != nil {
		shared.Error(c, http.StatusBadRequest, "remote upload failed", err)
		return
	}
	defer file.Close()

	dst := path.Join(dir, sanitizeFilename(header.Filename))
	if err := fc.Upload(file, dst); err != nil {
		shared.Error(c, http.StatusBadGateway, "remote upload failed", err)
		return
	}
	size, _, _ := fc.Stat(dst) // FTP 侧无法从上传过程得到字节数，回读为准
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"path": dst, "size": size}})
}

// sanitizeFilename 剥离上传文件名里的路径成分（浏览器一般已给裸名，防御性再剥一次）
func sanitizeFilename(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	if idx := strings.LastIndex(name, "/"); idx >= 0 {
		name = name[idx+1:]
	}
	if name == "" || name == "." || name == ".." {
		return "upload.bin"
	}
	return name
}

// MkdirRemoteFile POST /api/remotehosts/:id/files/mkdir {path}
func MkdirRemoteFile(c *gin.Context) {
	var req struct {
		Path string `json:"path"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || validateRemotePath(req.Path) != nil {
		shared.Error(c, http.StatusBadRequest, "invalid path", err)
		return
	}
	fc, err := dialHostFile(c.Param("id"))
	if err != nil {
		dialFileErr(c, err)
		return
	}
	defer fc.Close()
	if err := fc.Mkdir(req.Path); err != nil {
		shared.Error(c, http.StatusBadGateway, "remote mkdir failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// RenameRemoteFile POST /api/remotehosts/:id/files/rename {from, to}
func RenameRemoteFile(c *gin.Context) {
	var req struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request", err)
		return
	}
	if validateRemotePath(req.From) != nil || validateRemotePath(req.To) != nil {
		shared.Error(c, http.StatusBadRequest, "invalid path", nil)
		return
	}
	fc, err := dialHostFile(c.Param("id"))
	if err != nil {
		dialFileErr(c, err)
		return
	}
	defer fc.Close()
	if err := fc.Rename(req.From, req.To); err != nil {
		shared.Error(c, http.StatusBadGateway, "remote rename failed", err)
		return
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditFileRename,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s: %s → %s", c.Param("id"), req.From, req.To),
	})
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// DeleteRemoteFiles POST /api/remotehosts/:id/files/delete {paths: []}
// 目录递归删除。部分失败：已删除的保留，失败项回报
func DeleteRemoteFiles(c *gin.Context) {
	var req struct {
		Paths []string `json:"paths"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request", err)
		return
	}
	if len(req.Paths) == 0 || len(req.Paths) > 100 {
		shared.Error(c, http.StatusBadRequest, "paths must contain 1..100 entries", nil)
		return
	}
	fc, err := dialHostFile(c.Param("id"))
	if err != nil {
		dialFileErr(c, err)
		return
	}
	defer fc.Close()

	deleted, failed := make([]string, 0, len(req.Paths)), make([]gin.H, 0)
	for _, p := range req.Paths {
		if validateRemotePath(p) != nil {
			failed = append(failed, gin.H{"path": p, "error": "invalid path"})
			continue
		}
		if err := fc.RemoveAll(p); err != nil {
			failed = append(failed, gin.H{"path": p, "error": err.Error()})
			continue
		}
		deleted = append(deleted, p)
	}
	// 审计入账：远程删除不可恢复（只记主机与相对路径）
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditFileDelete,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s: %s", c.Param("id"), strings.Join(deleted, ", ")),
	})
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"deleted": deleted, "failed": failed}})
}

// TransferRemoteFiles POST /api/remotehosts/:id/files/transfer
// {paths: [], targetHostIds: [], targetDir?: string}
// 服务器作流式中转（源 SFTP → 目标 SFTP，不落盘），逐目标顺序执行；
// 目录递归整树复制。部分失败以 per-target 结果回报，状态码仍 200。
// FTP 主机不支持互传（任一端为 FTP 即拒绝）
func TransferRemoteFiles(c *gin.Context) {
	var req struct {
		Paths        []string `json:"paths"`
		TargetHostID []string `json:"targetHostIds"`
		TargetDir    string   `json:"targetDir"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request", err)
		return
	}
	if len(req.Paths) == 0 || len(req.Paths) > 50 {
		shared.Error(c, http.StatusBadRequest, "paths must contain 1..50 entries", nil)
		return
	}
	if len(req.TargetHostID) == 0 || len(req.TargetHostID) > 10 {
		shared.Error(c, http.StatusBadRequest, "targetHostIds must contain 1..10 entries", nil)
		return
	}
	for _, p := range req.Paths {
		if validateRemotePath(p) != nil {
			shared.Error(c, http.StatusBadRequest, "invalid path", nil)
			return
		}
	}
	dstDir := strings.TrimSpace(req.TargetDir)
	if dstDir == "" {
		dstDir = "/"
	}
	if validateRemotePath(dstDir) != nil {
		shared.Error(c, http.StatusBadRequest, "invalid targetDir", nil)
		return
	}
	srcID := c.Param("id")

	srcRH, err := store.Get().RemoteHost.Get(srcID)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "remote host not found", err)
		return
	}
	if srcRH.IsFTP() {
		shared.Error(c, http.StatusBadRequest, "FTP host does not support cross-host transfer", nil)
		return
	}

	// 目标先全量校验协议（任一 FTP 直接拒绝，避免部分成功）
	for _, targetID := range req.TargetHostID {
		if targetID == srcID {
			continue
		}
		rh, err := store.Get().RemoteHost.Get(targetID)
		if err != nil {
			shared.Error(c, http.StatusNotFound, "remote host not found", err)
			return
		}
		if rh.IsFTP() {
			shared.Error(c, http.StatusBadRequest, "FTP host does not support cross-host transfer", nil)
			return
		}
	}

	src, _, err := dialHostByID(srcID)
	if err != nil {
		dialHostErr(c, err)
		return
	}
	srcClient := src.Client()
	// 源侧租约全程持有（跨目标的搬树都压在这条连接上）；任一目标报连接级
	// 失败即弃置（可能病在源侧，保守弃置由下次借出重建自愈）
	srcDead := false
	defer func() {
		if srcDead {
			src.MarkDead()
		}
		src.End()
	}()

	results := make([]gin.H, 0, len(req.TargetHostID))
	for _, targetID := range req.TargetHostID {
		if targetID == srcID {
			results = append(results, gin.H{"hostId": targetID, "ok": false, "error": "target equals source"})
			continue
		}
		dstRH, err := store.Get().RemoteHost.Get(targetID)
		if err != nil {
			results = append(results, gin.H{"hostId": targetID, "ok": false, "error": err.Error()})
			continue
		}
		files, firstErr, connLevel := transferTreeToTarget(c, srcClient, dstRH, dstDir, req.Paths)
		if connLevel {
			srcDead = true
		}
		if firstErr != "" {
			results = append(results, gin.H{"hostId": targetID, "ok": false, "files": files, "error": firstErr})
			continue
		}
		results = append(results, gin.H{"hostId": targetID, "ok": true, "files": files})
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"results": results}})
}

// transferTreeToTarget 从池借出目标连接搬整树（目标侧短租约：借出探活 +
// 连接级首错弃置重建一次重跑，与池 WithLease 同语义）。返回迁移文件数、
// 首个错误原文（错误字符串形态与既有 per-target 回报契约一致）、末次错误
// 是否连接级（供调用方保守弃置源侧连接）
func transferTreeToTarget(c *gin.Context, src *sshclient.Client, dstRH *config.RemoteHost, dstDir string, paths []string) (int, string, bool) {
	// sshkey 引用型目标就地解析私钥（原 dialHostByID 内的步骤随池化上移：
	// 池借出只认 dialOptions，凭据解析留在调用侧）
	if err := ResolveRemoteHostAuth(dstRH); err != nil {
		return 0, err.Error(), false
	}
	files := 0
	firstErr := ""
	connLevel := false
	err := conns.WithLease(dstRH.ID, dialOptions(dstRH), func(dst *sshclient.Client) error {
		files, firstErr = 0, "" // 重试整树重跑：计数与首错从头计
		for _, p := range paths {
			if c.Request.Context().Err() != nil {
				return nil // 客户端已放弃
			}
			n, terr := src.TransferTree(p, dstDir, dst)
			files += n
			if terr == nil {
				continue
			}
			if firstErr == "" {
				firstErr = terr.Error()
			}
			if sshclient.IsConnLevelError(terr) {
				return terr // 连接级失败：交池弃置重建、整树重试一次
			}
			// 业务失败（权限/不存在等）：记录首个错误后继续余下路径（与既有
			// 逐路径部分成功语义一致），不弃置连接
		}
		return nil
	})
	if err != nil {
		connLevel = sshclient.IsConnLevelError(err)
		if firstErr == "" {
			firstErr = err.Error()
		}
	}
	return files, firstErr, connLevel
}
