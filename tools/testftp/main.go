// testftp e2e 测试夹具：内存盘 FTP 服务（只在本机回环监听，进程退出即消失）。
// 用途：文件管理器 e2e 不依赖外部 WSL/sshd，用一台 FTP 主机即可实测
// 浏览/上传/下载/右键/目录 zip 归档。种子文件见 seed 列表；凭据仅测试夹具用。
package main

import (
	"crypto/tls"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"

	ftpserver "github.com/fclairamb/ftpserverlib"
	"github.com/spf13/afero"
)

type driver struct {
	fs       afero.Fs
	settings *ftpserver.Settings
}

func (d *driver) GetSettings() (*ftpserver.Settings, error) { return d.settings, nil }
func (d *driver) ClientConnected(ftpserver.ClientContext) (string, error) {
	return "test", nil
}
func (d *driver) ClientDisconnected(ftpserver.ClientContext) {}
func (d *driver) GetTLSConfig() (*tls.Config, error)         { return nil, nil }
func (d *driver) AuthUser(_ ftpserver.ClientContext, user, pass string) (ftpserver.ClientDriver, error) {
	if user != "e2e" || pass != "e2e-pass" {
		return nil, fmt.Errorf("auth rejected")
	}
	return d.fs, nil
}

// seed 在内存盘布置确定的目录树（e2e 断言依赖这些名字）
func seed(fs afero.Fs) error {
	files := map[string]string{
		"/hello.txt":         "hello from testftp",
		"/docs/readme.md":    "# readme\nzip me",
		"/docs/sub/note.txt": "nested",
	}
	for p, content := range files {
		if err := fs.MkdirAll(parentOf(p), 0o755); err != nil {
			return err
		}
		if err := afero.WriteFile(fs, p, []byte(content), 0o644); err != nil {
			return err
		}
	}
	return fs.MkdirAll("/empty-dir", 0o755)
}

func parentOf(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' {
			return p[:i]
		}
	}
	return "/"
}

func main() {
	port := flag.Int("port", 2121, "listen port (loopback only)")
	flag.Parse()

	fs := afero.NewMemMapFs()
	if err := seed(fs); err != nil {
		log.Fatalf("seed: %v", err)
	}

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	srv := ftpserver.NewFtpServer(&driver{fs: fs, settings: &ftpserver.Settings{Listener: ln}})
	if err := srv.Listen(); err != nil { // 使用 settings.Listener（不阻塞）
		log.Fatalf("listen setup: %v", err)
	}
	go func() {
		if err := srv.Serve(); err != nil {
			log.Printf("serve exited: %v", err)
		}
	}()
	log.Printf("testftp ready on 127.0.0.1:%d", *port)

	// SIGTERM/SIGINT 即退出（e2e 拉起方负责杀进程）
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
}
