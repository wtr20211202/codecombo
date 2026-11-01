package ftpclient

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	ftpserver "github.com/fclairamb/ftpserverlib"
	"github.com/spf13/afero"
)

// ============== 进程内 FTP 服务集成测试 ==============
// 覆盖文件管理链路：List/Stat/Open(下载)/Upload/MkdirAll/Rename/RemoveAll。
// ftpserverlib + afero 内存盘，无需外部 ftpd。

type testDriver struct {
	fs       afero.Fs
	user     string
	pass     string
	settings *ftpserver.Settings
}

func (d *testDriver) GetSettings() (*ftpserver.Settings, error) { return d.settings, nil }
func (d *testDriver) ClientConnected(ftpserver.ClientContext) (string, error) {
	return "test", nil
}
func (d *testDriver) ClientDisconnected(ftpserver.ClientContext) {}
func (d *testDriver) GetTLSConfig() (*tls.Config, error)         { return nil, nil }
func (d *testDriver) AuthUser(_ ftpserver.ClientContext, user, pass string) (ftpserver.ClientDriver, error) {
	if user == d.user && pass == d.pass {
		return d.fs, nil
	}
	return nil, errAuthFailed
}

var errAuthFailed = &authError{}

type authError struct{}

func (*authError) Error() string { return "auth rejected" }

// startTestFTPServer 起一个内存盘 FTP 服务（用户 u/p），返回监听地址 host:port
func startTestFTPServer(t *testing.T, user, pass string) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })

	drv := &testDriver{
		fs:   afero.NewMemMapFs(),
		user: user, pass: pass,
		settings: &ftpserver.Settings{Listener: ln},
	}
	srv := ftpserver.NewFtpServer(drv)
	if err := srv.Listen(); err != nil { // 采用 settings.Listener（不阻塞）
		t.Fatalf("listen: %v", err)
	}
	go func() { _ = srv.Serve() }() // Serve 在 Stop/监听关闭后返回
	t.Cleanup(func() { _ = srv.Stop() })
	return ln.Addr().String()
}

func dialTestFTP(t *testing.T, addr, user, pass string) *Client {
	t.Helper()
	host, port, _ := strings.Cut(addr, ":")
	var portNum int
	for _, ch := range port {
		portNum = portNum*10 + int(ch-'0')
	}
	c, err := Dial(ConnectOptions{Host: host, Port: portNum, User: user, Password: pass, Timeout: 5 * time.Second})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = c.Quit() })
	return c
}

func TestFTPUploadListDownloadRoundTrip(t *testing.T) {
	addr := startTestFTPServer(t, "u", "p")
	c := dialTestFTP(t, addr, "u", "p")

	content := []byte("hello ftp round trip")
	if err := c.UploadStream(strings.NewReader(string(content)), "/dir/file.txt"); err != nil {
		t.Fatalf("upload: %v", err)
	}

	entries, err := c.ListDir("/")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(entries) == 0 || !entries[0].IsDir || entries[0].Name != "dir" {
		t.Fatalf("expected dir first, got %+v", entries)
	}

	size, isDir, err := c.Stat("/dir/file.txt")
	if err != nil || isDir || int(size) != len(content) {
		t.Fatalf("stat mismatch: size=%d isDir=%v err=%v", size, isDir, err)
	}

	rc, err := c.Open("/dir/file.txt")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer rc.Close()
	got, err := io.ReadAll(rc)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(got) != string(content) {
		t.Fatalf("content mismatch: %q", got)
	}
}

func TestFTPMkdirRenameRemoveAll(t *testing.T) {
	addr := startTestFTPServer(t, "u", "p")
	c := dialTestFTP(t, addr, "u", "p")

	if err := c.MkdirAll("/a/b/c"); err != nil {
		t.Fatalf("mkdirall: %v", err)
	}
	if err := c.UploadStream(strings.NewReader("X"), "/a/b/c/f.txt"); err != nil {
		t.Fatalf("upload: %v", err)
	}
	if err := c.Rename("/a/b/c/f.txt", "/a/b/c/renamed.txt"); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if err := c.RemoveAll("/a"); err != nil {
		t.Fatalf("removeall: %v", err)
	}
	if _, _, err := c.Stat("/a"); err == nil {
		t.Fatal("expected /a removed")
	}
}

func TestFTPLargeFileTransfer(t *testing.T) {
	addr := startTestFTPServer(t, "u", "p")
	c := dialTestFTP(t, addr, "u", "p")

	big := make([]byte, 2<<20)
	if _, err := rand.Read(big); err != nil {
		t.Fatalf("rand: %v", err)
	}
	if err := c.UploadStream(strings.NewReader(string(big)), "/big.bin"); err != nil {
		t.Fatalf("upload big: %v", err)
	}
	rc, err := c.Open("/big.bin")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer rc.Close()
	got, err := io.ReadAll(rc)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	gs, ws := sha256.Sum256(got), sha256.Sum256(big)
	if gs != ws {
		t.Fatal("large content mismatch")
	}
}
