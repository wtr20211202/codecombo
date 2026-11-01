// Package ftpclient 封装 FTP 文件操作（远程主机协议扩展）。
// 与 sshclient 的文件管理面保持同形，由 api/remote 的文件端点按主机 protocol 分派。
// 定位：FTP 是明文协议（凭据与数据均不加密），仅建议内网/可信网络使用；
// 不支持终端/部署等 SSH 能力。跨主机互传暂不支持（仅 SFTP 主机间）。
package ftpclient

import (
	"errors"
	"fmt"
	"io"
	"net/textproto"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/jlaffaye/ftp"

	"codecombo/server/errmarkers"
	"codecombo/server/sshclient"
)

// DirEntry 复用 sshclient 的目录项结构（api 层共用序列化结构）
type DirEntry = sshclient.DirEntry

// ConnectOptions FTP 连接参数
type ConnectOptions struct {
	Host     string
	Port     int
	User     string
	Password string
	Timeout  time.Duration
}

// Client FTP 客户端
type Client struct {
	conn *ftp.ServerConn
}

// Dial 建立 FTP 连接并登录
func Dial(opts ConnectOptions) (*Client, error) {
	if opts.Port == 0 {
		opts.Port = 21
	}
	if opts.Timeout == 0 {
		opts.Timeout = 15 * time.Second
	}
	addr := fmt.Sprintf("%s:%d", opts.Host, opts.Port)
	conn, err := ftp.Dial(addr, ftp.DialWithTimeout(opts.Timeout))
	if err != nil {
		return nil, classifyDialError(addr, err)
	}
	if err := conn.Login(opts.User, opts.Password); err != nil {
		_ = conn.Quit()
		// 稳定前缀收口 errmarkers 注册表（P-20261004-29），与 sshclient 同串
		return nil, fmt.Errorf("ftp login %s: %s: %w", addr, errmarkers.AuthRejectedPrefix, err)
	}
	return &Client{conn: conn}, nil
}

// classifyDialError 给常见 FTP 拨号失败加简短英文标注（与 sshclient 同风格，
// 本地化操作建议由前端按错误特征追加）
func classifyDialError(addr string, err error) error {
	msg := err.Error()
	if strings.Contains(msg, "connection refused") {
		return fmt.Errorf("ftp dial %s: connection refused (remote port not listening): %w", addr, err)
	}
	var protoErr *textproto.Error
	if errors.As(err, &protoErr) {
		// 服务端 5xx 拒绝（如登录策略）：原文已含可读信息
		return fmt.Errorf("ftp dial %s: %s", addr, protoErr.Msg)
	}
	return fmt.Errorf("ftp dial %s: %w", addr, err)
}

// ListDir 列出远程目录（目录在前，其余按名称排序）。
// 库优先 MLSD（机器可读），服务端不支持时自动回退 LIST 行解析
func (c *Client) ListDir(remotePath string) ([]DirEntry, error) {
	entries, err := c.conn.List(remotePath)
	if err != nil {
		return nil, fmt.Errorf("read dir %s: %w", remotePath, err)
	}
	out := make([]DirEntry, 0, len(entries))
	for _, e := range entries {
		name := e.Name
		if name == "." || name == ".." {
			continue
		}
		isDir := e.Type == ftp.EntryTypeFolder
		mode := "-rw-r--r--"
		if isDir {
			mode = "drwxr-xr-x"
		}
		var mtime int64
		if !e.Time.IsZero() {
			mtime = e.Time.UnixMilli()
		}
		out = append(out, DirEntry{
			Name:  name,
			Size:  int64(e.Size),
			Mode:  mode,
			IsDir: isDir,
			Mtime: mtime,
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

// Stat 远程文件/目录元信息
func (c *Client) Stat(remotePath string) (size int64, isDir bool, err error) {
	e, err := c.conn.GetEntry(remotePath)
	if err != nil {
		return 0, false, fmt.Errorf("stat %s: %w", remotePath, err)
	}
	return int64(e.Size), e.Type == ftp.EntryTypeFolder, nil
}

// Open 打开远程文件供流式读取（下载；调用方负责 Close）
func (c *Client) Open(remotePath string) (io.ReadCloser, error) {
	rc, err := c.conn.Retr(remotePath)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", remotePath, err)
	}
	return rc, nil
}

// UploadStream 把 r 的内容写到远程路径（同名覆盖）
func (c *Client) UploadStream(r io.Reader, remotePath string) error {
	if err := c.conn.Stor(remotePath, r); err != nil {
		return fmt.Errorf("store %s: %w", remotePath, err)
	}
	return nil
}

// Mkdir 创建单级目录（已存在视为成功，便于幂等 UI）
func (c *Client) Mkdir(remotePath string) error {
	if err := c.conn.MakeDir(remotePath); err != nil {
		if _, _, serr := c.Stat(remotePath); serr == nil {
			return nil
		}
		return fmt.Errorf("mkdir %s: %w", remotePath, err)
	}
	return nil
}

// MkdirAll 递归创建目录
func (c *Client) MkdirAll(remotePath string) error {
	cleaned := strings.Trim(remotePath, "/")
	if cleaned == "" {
		return nil
	}
	cur := ""
	for _, seg := range strings.Split(cleaned, "/") {
		cur = cur + "/" + seg
		if err := c.Mkdir(cur); err != nil {
			return err
		}
	}
	return nil
}

// Rename 重命名/移动
func (c *Client) Rename(from, to string) error {
	if err := c.conn.Rename(from, to); err != nil {
		return fmt.Errorf("rename %s → %s: %w", from, to, err)
	}
	return nil
}

// RemoveAll 递归删除文件/目录：优先服务端递归删除扩展，
// 失败回退后序遍历逐项删除（FTP 无标准递归删除命令）
func (c *Client) RemoveAll(remotePath string) error {
	_, isDir, err := c.Stat(remotePath)
	if err != nil {
		return err
	}
	if !isDir {
		return c.conn.Delete(remotePath)
	}
	if err := c.conn.RemoveDirRecur(remotePath); err == nil {
		return nil
	}
	entries, err := c.ListDir(remotePath)
	if err != nil {
		return err
	}
	for _, e := range entries {
		child := path.Join(remotePath, e.Name)
		if e.IsDir {
			if err := c.RemoveAll(child); err != nil {
				return err
			}
			if err := c.conn.RemoveDir(child); err != nil {
				return err
			}
			continue
		}
		if err := c.conn.Delete(child); err != nil {
			return err
		}
	}
	return c.conn.RemoveDir(remotePath)
}

// Quit 关闭控制连接
func (c *Client) Quit() error {
	return c.conn.Quit()
}

// CurrentDir 服务端当前工作目录（登录后通常为用户主目录；连接测试用）
func (c *Client) CurrentDir() (string, error) {
	return c.conn.CurrentDir()
}
