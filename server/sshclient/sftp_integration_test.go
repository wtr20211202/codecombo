package sshclient

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"testing"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// ============== 进程内 SSH+SFTP 测试服务 ==============
// 覆盖文件管理链路（List/Upload/Download/Transfer/RemoveAll/Rename），
// 不依赖任何外部 sshd。

// startTestSFTPServer 起一个仅支持 sftp subsystem 的 SSH 服务，
// 密码认证 user/pass；t.Cleanup 关闭监听。返回监听地址（host:port）
func startTestSFTPServer(t *testing.T, user, pass string) string {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("host key: %v", err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatalf("signer: %v", err)
	}
	wantPass := []byte(pass)
	cfg := &ssh.ServerConfig{
		PasswordCallback: func(conn ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
			if conn.User() == user && subtle.ConstantTimeCompare(password, wantPass) == 1 {
				return &ssh.Permissions{}, nil
			}
			return nil, fmt.Errorf("auth rejected for %q", conn.User())
		},
	}
	cfg.AddHostKey(signer)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go serveSSHConn(conn, cfg)
		}
	}()
	t.Cleanup(func() { _ = ln.Close() })
	return ln.Addr().String()
}

func serveSSHConn(conn net.Conn, cfg *ssh.ServerConfig) {
	sconn, chans, reqs, err := ssh.NewServerConn(conn, cfg)
	if err != nil {
		return
	}
	defer sconn.Close()
	go ssh.DiscardRequests(reqs)
	for newCh := range chans {
		if newCh.ChannelType() != "session" {
			_ = newCh.Reject(ssh.UnknownChannelType, "unsupported")
			continue
		}
		ch, chReqs, err := newCh.Accept()
		if err != nil {
			continue
		}
		go serveSession(ch, chReqs)
	}
}

func serveSession(ch ssh.Channel, reqs <-chan *ssh.Request) {
	defer ch.Close()
	// subsystem 受理后必须立即并发启动 sftp.Serve（等请求循环结束再启动会死锁：
	// 客户端等 sftp 响应，这里等 channel 关闭）
	for req := range reqs {
		switch req.Type {
		case "subsystem":
			// payload: uint32 len + name；只认 sftp
			isSFTP := len(req.Payload) > 4 && string(req.Payload[4:]) == "sftp"
			if !isSFTP {
				_ = req.Reply(false, nil)
				continue
			}
			s, err := sftp.NewServer(ch)
			if err != nil {
				_ = req.Reply(false, nil)
				continue
			}
			_ = req.Reply(true, nil)
			go func() { _ = s.Serve() }()
		default:
			if req.WantReply {
				_ = req.Reply(false, nil)
			}
		}
	}
}

func dialTest(t *testing.T, addr, user, pass string) *Client {
	t.Helper()
	c, err := Dial(ConnectOptions{
		Host: strings.Split(addr, ":")[0],
		Port: func() int { var p int; _, _ = fmt.Sscanf(addr, "127.0.0.1:%d", &p); return p }(),
		User: user,
		Auth: AuthMethod{Type: AuthTypePassword, Password: pass},
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	// 只关底层 SSH 连接：测试桩的 sftp server 不响应 client.Close 的收尾
	// 握手（真实 sshd 会响应），直接 Close 会永久阻塞
	t.Cleanup(func() { _ = c.UnderlyingClient().Close() })
	return c
}

func fwdSlash(p string) string { return strings.ReplaceAll(p, "\\", "/") }

func TestSFTPUploadListDownloadRoundTrip(t *testing.T) {
	addr := startTestSFTPServer(t, "u", "p")
	root := fwdSlash(t.TempDir())
	c := dialTest(t, addr, "u", "p")

	// 上传
	content := []byte("hello sftp round trip")
	if err := c.UploadBytes(content, UploadOptions{RemotePath: root + "/dir/file.txt", Mode: 0644}); err != nil {
		t.Fatalf("upload: %v", err)
	}
	// 列目录（目录在前排序）
	entries, err := c.ListDir(root)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(entries) == 0 || !entries[0].IsDir || entries[0].Name != "dir" {
		t.Fatalf("expected dir first, got %+v", entries)
	}
	// 下载回读一致
	got, err := c.ReadFile(root + "/dir/file.txt")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(got) != string(content) {
		t.Fatalf("content mismatch: %q", got)
	}
	// 流式下载接口
	f, err := c.OpenRemote(root + "/dir/file.txt")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer f.Close()
	head := make([]byte, 5)
	n, _ := io.ReadFull(f, head)
	if string(head[:n]) != "hello" {
		t.Fatalf("stream head mismatch: %q", head[:n])
	}
}

func TestSFTPTransferTreeAndRemoveAll(t *testing.T) {
	addr := startTestSFTPServer(t, "u", "p")
	srcRoot := fwdSlash(t.TempDir())
	dstRoot := fwdSlash(t.TempDir())
	src, dst := dialTest(t, addr, "u", "p"), dialTest(t, addr, "u", "p")

	// 源树：dir/{a.txt, sub/b.txt}
	files := map[string]string{
		"/tree/a.txt":      "A",
		"/tree/sub/b.txt":  "BB",
		"/tree/sub/c.data": "CCC",
	}
	for rel, body := range files {
		if err := src.UploadBytes([]byte(body), UploadOptions{RemotePath: srcRoot + rel}); err != nil {
			t.Fatalf("seed %s: %v", rel, err)
		}
	}

	// 整树传输到目标主机的 /copied 下（保留 tree 目录名）
	n, err := src.TransferTree(srcRoot+"/tree", dstRoot+"/copied", dst)
	if err != nil {
		t.Fatalf("transfer: %v", err)
	}
	if n != len(files) {
		t.Fatalf("expected %d files copied, got %d", len(files), n)
	}
	for rel, body := range files {
		got, err := dst.ReadFile(dstRoot + "/copied/" + strings.TrimPrefix(rel, "/"))
		if err != nil {
			t.Fatalf("read copied %s: %v", rel, err)
		}
		if string(got) != body {
			t.Fatalf("copied content mismatch for %s", rel)
		}
	}

	// 递归删除目标树
	if err := dst.RemoveAllRemote(dstRoot + "/copied"); err != nil {
		t.Fatalf("remove all: %v", err)
	}
	if _, err := dst.StatRemote(dstRoot + "/copied"); err == nil {
		t.Fatal("expected tree removed")
	}

	// 重命名
	if err := src.RenameRemote(srcRoot+"/tree/a.txt", srcRoot+"/tree/renamed.txt"); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if _, err := src.StatRemote(srcRoot + "/tree/renamed.txt"); err != nil {
		t.Fatalf("renamed file missing: %v", err)
	}
}

// TestSFTPLargeFileTransfer 大文件（~3MB，跨多个 SFTP 包）流式一致性
func TestSFTPLargeFileTransfer(t *testing.T) {
	addr := startTestSFTPServer(t, "u", "p")
	srcRoot := fwdSlash(t.TempDir())
	dstRoot := fwdSlash(t.TempDir())
	src, dst := dialTest(t, addr, "u", "p"), dialTest(t, addr, "u", "p")

	big := make([]byte, 3<<20)
	if _, err := rand.Read(big); err != nil {
		t.Fatalf("rand: %v", err)
	}
	if err := src.UploadBytes(big, UploadOptions{RemotePath: srcRoot + "/big.bin"}); err != nil {
		t.Fatalf("upload big: %v", err)
	}
	if _, err := src.TransferTree(srcRoot+"/big.bin", dstRoot, dst); err != nil {
		t.Fatalf("transfer big: %v", err)
	}
	got, err := dst.ReadFile(dstRoot + "/big.bin")
	if err != nil {
		t.Fatalf("read big: %v", err)
	}
	gs, ws := sha256.Sum256(got), sha256.Sum256(big)
	if gs != ws {
		t.Fatal("large transfer content mismatch")
	}
	if _, err := os.Stat(dstRoot + "/big.bin"); err != nil {
		t.Fatalf("stat: %v", err)
	}
}
