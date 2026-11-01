package sshclient

import (
	"fmt"
	"io"
	"os"
	"path"
	"sort"
	"strings"

	"github.com/pkg/sftp"
)

// UploadOptions 文件上传参数
type UploadOptions struct {
	RemotePath string
	Mode       os.FileMode
}

// UploadBytes 上传字节到远程路径
func (c *Client) UploadBytes(data []byte, opts UploadOptions) error {
	if opts.Mode == 0 {
		opts.Mode = 0644
	}
	sc, err := c.SFTP()
	if err != nil {
		return fmt.Errorf("sftp client: %w", err)
	}
	dir := path.Dir(opts.RemotePath)
	if dir != "." && dir != "/" {
		_ = sc.MkdirAll(dir)
	}
	f, err := sc.Create(opts.RemotePath)
	if err != nil {
		return fmt.Errorf("create %s: %w", opts.RemotePath, err)
	}
	defer f.Close()
	if _, err := f.Write(data); err != nil {
		return fmt.Errorf("write %s: %w", opts.RemotePath, err)
	}
	return sc.Chmod(opts.RemotePath, opts.Mode)
}

// UploadFile 上传本地文件（流式：32MB/文件也不进内存，直接 Open → io.Copy）
func (c *Client) UploadFile(localPath string, opts UploadOptions) error {
	in, err := os.Open(localPath)
	if err != nil {
		return fmt.Errorf("read local %s: %w", localPath, err)
	}
	defer in.Close()
	if fi, serr := in.Stat(); serr == nil && fi.IsDir() {
		return fmt.Errorf("read local %s: is a directory", localPath)
	}
	if opts.Mode == 0 {
		opts.Mode = 0644
	}
	sc, err := c.SFTP()
	if err != nil {
		return fmt.Errorf("sftp client: %w", err)
	}
	dir := path.Dir(opts.RemotePath)
	if dir != "." && dir != "/" {
		_ = sc.MkdirAll(dir)
	}
	out, err := sc.Create(opts.RemotePath)
	if err != nil {
		return fmt.Errorf("create %s: %w", opts.RemotePath, err)
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return fmt.Errorf("write %s: %w", opts.RemotePath, err)
	}
	return sc.Chmod(opts.RemotePath, opts.Mode)
}

// ReadFile 读取远程文件
func (c *Client) ReadFile(remotePath string) ([]byte, error) {
	sc, err := c.SFTP()
	if err != nil {
		return nil, err
	}
	f, err := sc.Open(remotePath)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}

// ============== 流式文件管理（大文件不进内存） ==============

// DirEntry 远程目录项（api 层直接序列化为 JSON）
type DirEntry struct {
	Name  string `json:"name"`
	Size  int64  `json:"size"`
	Mode  string `json:"mode"`
	IsDir bool   `json:"isDir"`
	Mtime int64  `json:"mtime"` // unix 毫秒
}

// ListDir 列出远程目录（目录在前，其余按名称排序）
func (c *Client) ListDir(remotePath string) ([]DirEntry, error) {
	sc, err := c.SFTP()
	if err != nil {
		return nil, fmt.Errorf("sftp client: %w", err)
	}
	infos, err := sc.ReadDir(remotePath)
	if err != nil {
		return nil, fmt.Errorf("read dir %s: %w", remotePath, err)
	}
	out := make([]DirEntry, 0, len(infos))
	for _, fi := range infos {
		out = append(out, DirEntry{
			Name:  fi.Name(),
			Size:  fi.Size(),
			Mode:  fi.Mode().String(),
			IsDir: fi.IsDir(),
			Mtime: fi.ModTime().UnixMilli(),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].IsDir != out[j].IsDir {
			return out[i].IsDir
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// OpenRemote 打开远程文件供流式读取（下载；调用方负责 Close）
func (c *Client) OpenRemote(remotePath string) (*sftp.File, error) {
	sc, err := c.SFTP()
	if err != nil {
		return nil, fmt.Errorf("sftp client: %w", err)
	}
	return sc.Open(remotePath)
}

// CreateRemote 创建/截断远程文件供流式写入（上传；调用方负责 Close）
func (c *Client) CreateRemote(remotePath string) (*sftp.File, error) {
	sc, err := c.SFTP()
	if err != nil {
		return nil, fmt.Errorf("sftp client: %w", err)
	}
	return sc.Create(remotePath)
}

// StatRemote 远程文件/目录元信息
func (c *Client) StatRemote(remotePath string) (os.FileInfo, error) {
	sc, err := c.SFTP()
	if err != nil {
		return nil, fmt.Errorf("sftp client: %w", err)
	}
	return sc.Stat(remotePath)
}

// ChmodRemote 设置远程文件权限位（编辑器写路径「保权限」用：临时文件按原文件
// 权限 chmod 后再原子换名，权限位全程不丢）
func (c *Client) ChmodRemote(remotePath string, mode os.FileMode) error {
	sc, err := c.SFTP()
	if err != nil {
		return fmt.Errorf("sftp client: %w", err)
	}
	return sc.Chmod(remotePath, mode)
}

// MkdirAllRemote 递归创建远程目录
func (c *Client) MkdirAllRemote(remotePath string) error {
	sc, err := c.SFTP()
	if err != nil {
		return fmt.Errorf("sftp client: %w", err)
	}
	return sc.MkdirAll(remotePath)
}

// MkdirRemote 创建单级远程目录（已存在视为成功，便于幂等 UI）
func (c *Client) MkdirRemote(remotePath string) error {
	sc, err := c.SFTP()
	if err != nil {
		return fmt.Errorf("sftp client: %w", err)
	}
	if err := sc.Mkdir(remotePath); err != nil {
		if fi, serr := sc.Stat(remotePath); serr == nil && fi.IsDir() {
			return nil
		}
		return fmt.Errorf("mkdir %s: %w", remotePath, err)
	}
	return nil
}

// RenameRemote 重命名/移动远程文件或目录
func (c *Client) RenameRemote(oldPath, newPath string) error {
	sc, err := c.SFTP()
	if err != nil {
		return fmt.Errorf("sftp client: %w", err)
	}
	if err := sc.PosixRename(oldPath, newPath); err != nil {
		// PosixRename 扩展不被部分服务端支持时回退基础 rename（目标已存在会失败）
		return sc.Rename(oldPath, newPath)
	}
	return nil
}

// RemoveRemote 删除远程文件或空目录
func (c *Client) RemoveRemote(remotePath string, isDir bool) error {
	sc, err := c.SFTP()
	if err != nil {
		return fmt.Errorf("sftp client: %w", err)
	}
	if isDir {
		return sc.RemoveDirectory(remotePath)
	}
	return sc.Remove(remotePath)
}

// RemoveAllRemote 递归删除远程文件/目录（后序遍历；防御性上限同 copyLimits）
func (c *Client) RemoveAllRemote(remotePath string) error {
	sc, err := c.SFTP()
	if err != nil {
		return fmt.Errorf("sftp client: %w", err)
	}
	fi, err := sc.Stat(remotePath)
	if err != nil {
		return fmt.Errorf("stat %s: %w", remotePath, err)
	}
	if !fi.IsDir() {
		return sc.Remove(remotePath)
	}
	st := &walkState{}
	if err := removeAllDir(sc, remotePath, st); err != nil {
		return err
	}
	return sc.RemoveDirectory(remotePath)
}

// removeAllDir 后序递归删除目录内容
func removeAllDir(sc *sftp.Client, dir string, st *walkState) error {
	if st.files >= copyMaxFiles {
		return fmt.Errorf("too many entries (limit %d)", copyMaxFiles)
	}
	infos, err := sc.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("read dir %s: %w", dir, err)
	}
	for _, fi := range infos {
		p := path.Join(dir, fi.Name())
		if fi.IsDir() {
			if err := removeAllDir(sc, p, st); err != nil {
				return err
			}
			if err := sc.RemoveDirectory(p); err != nil {
				return err
			}
			continue
		}
		st.files++
		if err := sc.Remove(p); err != nil {
			return err
		}
	}
	return nil
}

// copyLimits 递归复制/删除的防御性上限（防失控递归与超大批量）
const (
	copyMaxFiles     = 20000
	copyMaxTotalSize = 8 << 30 // 8 GiB
)

// walkState 递归遍历的累计状态
type walkState struct {
	files int
	size  int64
}

// collectTree 递归收集 remotePath 下的全部文件路径（含子目录），受 copyLimits 约束
func (c *Client) collectTree(sc *sftp.Client, remotePath string, st *walkState) ([]string, error) {
	if st.files >= copyMaxFiles {
		return nil, fmt.Errorf("too many files (limit %d)", copyMaxFiles)
	}
	infos, err := sc.ReadDir(remotePath)
	if err != nil {
		return nil, err
	}
	var files []string
	for _, fi := range infos {
		p := path.Join(remotePath, fi.Name())
		if fi.IsDir() {
			sub, err := c.collectTree(sc, p, st)
			if err != nil {
				return nil, err
			}
			files = append(files, sub...)
			continue
		}
		st.files++
		st.size += fi.Size()
		if st.size > copyMaxTotalSize {
			return nil, fmt.Errorf("total size exceeds %d bytes", copyMaxTotalSize)
		}
		files = append(files, p)
	}
	return files, nil
}

// TransferTree 把源连接上 remotePath 指向的文件/目录流式复制到 dst 连接的 dstDir 下
// （保留末级目录名/文件名）。跨主机传输复用同一条实现：源与目标是两个独立 SSH
// 连接，服务器只做流式中转，不落盘
func (c *Client) TransferTree(remotePath, dstDir string, dst *Client) (int, error) {
	srcSc, err := c.SFTP()
	if err != nil {
		return 0, fmt.Errorf("sftp client: %w", err)
	}
	fi, err := srcSc.Stat(remotePath)
	if err != nil {
		return 0, fmt.Errorf("stat %s: %w", remotePath, err)
	}

	// 单文件：直接落到 dstDir/<name>
	if !fi.IsDir() {
		if err := dst.MkdirAllRemote(dstDir); err != nil {
			return 0, err
		}
		if _, err := copyOne(c, remotePath, dst, path.Join(dstDir, fi.Name())); err != nil {
			return 0, err
		}
		return 1, nil
	}

	// 目录：递归收集源文件，按相对路径在目标侧建目录后逐一拷贝
	st := &walkState{}
	files, err := c.collectTree(srcSc, remotePath, st)
	if err != nil {
		return 0, fmt.Errorf("collect %s: %w", remotePath, err)
	}
	if len(files) == 0 {
		return 0, nil
	}
	base := path.Dir(remotePath)
	copied := 0
	for _, f := range files {
		rel := relPosix(base, f)
		target := path.Join(dstDir, rel)
		if err := dst.MkdirAllRemote(path.Dir(target)); err != nil {
			return copied, err
		}
		if _, err := copyOne(c, f, dst, target); err != nil {
			return copied, err
		}
		copied++
	}
	return copied, nil
}

// relPosix 计算远程 POSIX 路径相对 base 的部分。
// 不用 filepath.Rel：Windows 主机进程的 filepath 语义带盘符/反斜杠，远程路径永远是 POSIX
func relPosix(base, p string) string {
	if base == "/" {
		return strings.TrimPrefix(p, "/")
	}
	return strings.TrimPrefix(p, base+"/")
}

// copyOne 单文件流式拷贝（源 Open → 目标 Create → io.Copy），结束后同步权限
func copyOne(src *Client, srcPath string, dst *Client, dstPath string) (int64, error) {
	in, err := src.OpenRemote(srcPath)
	if err != nil {
		return 0, fmt.Errorf("open %s: %w", srcPath, err)
	}
	defer in.Close()
	out, err := dst.CreateRemote(dstPath)
	if err != nil {
		return 0, fmt.Errorf("create %s: %w", dstPath, err)
	}
	defer out.Close()
	n, err := io.Copy(out, in)
	if err != nil {
		return n, fmt.Errorf("copy %s → %s: %w", srcPath, dstPath, err)
	}
	if sfi, serr := src.StatRemote(srcPath); serr == nil {
		if dsc, derr := dst.SFTP(); derr == nil {
			_ = dsc.Chmod(dstPath, sfi.Mode().Perm())
		}
	}
	return n, nil
}
