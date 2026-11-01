package remote

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/sshclient"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// ============== 连接池集成测试（P-20261005-159） ==============
//
// 进程内 fake SSH 服务端（session 通道承载 exec 回显 + sftp 子系统真身
// （pkg/sftp Server 根在工作临时目录）+ keepalive 应答），覆盖：
//   - handler 级「连续两次目录浏览仅一次拨号」（服务端连接计数断言）
//   - 池化通道请求中途半开：首个 SFTP 操作失败弃置重建一次自愈
//   - 业务失败（目录不存在）不触发重建
//   - 主机编辑级联出池：更新后下次请求重新拨号且新凭据生效

// fakePoolSSH 进程内 SSH 服务端（凭据/通道语义同 sshclient 包测试替身的
// remote 侧最小版：sftp 子系统挂真实 pkg/sftp Server，根 = 测试临时目录）
type fakePoolSSH struct {
	t         *testing.T
	ln        net.Listener
	conns     []*ssh.ServerConn
	connsM    sync.Mutex
	connTotal atomic.Int64 // 完成握手的连接累计（「N 次操作仅一次拨号」断言用）
	root      string
}

func newFakePoolSSH(t *testing.T) *fakePoolSSH {
	t.Helper()
	gin.SetMode(gin.TestMode)
	t.Setenv("CC_DATA_DIR", t.TempDir()) // master-key/TOFU 钉扎隔离在临时数据面
	store.SetDefault(store.New(filestore.New(filepath.Join(t.TempDir(), "data"))))
	t.Cleanup(func() { store.SetDefault(nil) })

	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate host key: %v", err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatalf("signer: %v", err)
	}
	// 密码只验非空（池语义测试不验真凭据；主机改密后的重拨生效性由
	// UpdateRemoteHostFlushesPool 的「拨号成功」间接覆盖）
	cfg := &ssh.ServerConfig{PasswordCallback: func(_ ssh.ConnMetadata, pass []byte) (*ssh.Permissions, error) {
		if len(pass) > 0 {
			return &ssh.Permissions{}, nil
		}
		return nil, fmt.Errorf("auth rejected")
	}}
	cfg.AddHostKey(signer)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	s := &fakePoolSSH{t: t, ln: ln, root: t.TempDir()}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			sconn, chans, reqs, err := ssh.NewServerConn(conn, cfg)
			if err != nil {
				_ = conn.Close()
				continue
			}
			s.connsM.Lock()
			s.conns = append(s.conns, sconn)
			s.connsM.Unlock()
			s.connTotal.Add(1)
			go s.handleConn(sconn, chans, reqs)
		}
	}()
	t.Cleanup(func() { _ = ln.Close(); s.killConns() })
	return s
}

func (s *fakePoolSSH) port() int { return s.ln.Addr().(*net.TCPAddr).Port }

// killConns 断开全部已建连接（模拟对端重启/断网；监听仍在，可重连）
func (s *fakePoolSSH) killConns() {
	s.connsM.Lock()
	for _, c := range s.conns {
		_ = c.Close()
	}
	s.conns = nil
	s.connsM.Unlock()
}

func (s *fakePoolSSH) handleConn(sconn *ssh.ServerConn, chans <-chan ssh.NewChannel, reqs <-chan *ssh.Request) {
	defer sconn.Close()
	go func() {
		for req := range reqs {
			if req.WantReply {
				_ = req.Reply(false, nil) // keepalive 等全局请求的应答面
			}
		}
	}()
	for ch := range chans {
		if ch.ChannelType() != "session" {
			_ = ch.Reject(ssh.UnknownChannelType, "unsupported")
			continue
		}
		s.handleSession(ch)
	}
}

func (s *fakePoolSSH) handleSession(ch ssh.NewChannel) {
	channel, requests, err := ch.Accept()
	if err != nil {
		return
	}
	go func() {
		defer channel.Close()
		for req := range requests {
			switch req.Type {
			case "exec":
				_, _ = io.WriteString(channel, "session-ok\n")
				_ = req.Reply(true, nil)
				_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
				return
			case "subsystem":
				name := ""
				if len(req.Payload) >= 4 {
					if n := binary.BigEndian.Uint32(req.Payload[0:4]); int(4+n) <= len(req.Payload) {
						name = string(req.Payload[4 : 4+n])
					}
				}
				if name != "sftp" {
					_ = req.Reply(false, nil)
					continue
				}
				_ = req.Reply(true, nil)
				srv, serr := sftp.NewServer(channel, sftp.WithServerWorkingDirectory(s.root))
				if serr == nil {
					_ = srv.Serve() // 随通道关闭退出（io.EOF 属预期）
				}
				return
			default:
				if req.WantReply {
					_ = req.Reply(false, nil)
				}
			}
		}
	}()
}

// poolTestHost 注册一台密码认证主机（指向 fake server），返回主机 ID
func poolTestHost(t *testing.T, s *fakePoolSSH) string {
	t.Helper()
	rh, err := store.Get().RemoteHost.Create(config.RemoteHost{
		Name: "pool-e2e", Host: "127.0.0.1", Port: s.port(),
		User: "e2e", AuthType: config.AuthTypePassword, Password: "pool-pw",
	})
	if err != nil {
		t.Fatalf("create host: %v", err)
	}
	t.Cleanup(func() { _ = store.Get().RemoteHost.Delete(rh.ID) })
	return rh.ID
}

// listFiles 直连 ListRemoteFiles handler 的 GET 请求
func listFiles(t *testing.T, hostID, dir string) (int, []sshclient.DirEntry) {
	t.Helper()
	req := httptest.NewRequest("GET", "/api/remotehosts/"+hostID+"/files/list", nil)
	q := req.URL.Query()
	q.Set("path", dir)
	req.URL.RawQuery = q.Encode()
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Params = gin.Params{{Key: "id", Value: hostID}}
	c.Request = req
	ListRemoteFiles(c)
	if w.Code != 200 {
		return w.Code, nil
	}
	var body struct {
		Data struct {
			Entries []sshclient.DirEntry `json:"entries"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode list response: %v", err)
	}
	return w.Code, body.Data.Entries
}

func TestListRemoteFilesReusesPooledConn(t *testing.T) {
	s := newFakePoolSSH(t)
	hostID := poolTestHost(t, s)
	t.Cleanup(func() { conns.CloseAll() })

	for _, name := range []string{"a.txt", "b.txt"} {
		if err := os.WriteFile(filepath.Join(s.root, name), []byte("x"), 0o644); err != nil {
			t.Fatalf("seed %s: %v", name, err)
		}
	}

	// 连续两次目录浏览：仅一次拨号（服务端连接计数断言）。
	// 路径用相对根（"."）：pkg/sftp 服务端把非 / 开头的路径视作相对
	// workDir 解析，Windows 盘符路径会被错误拼接——生产远端是 POSIX 语义，
	// 测试同样以相对路径保持三平台可跑
	for i := 0; i < 2; i++ {
		code, entries := listFiles(t, hostID, ".")
		if code != 200 {
			t.Fatalf("list #%d: status %d", i, code)
		}
		if len(entries) != 2 {
			t.Fatalf("list #%d entries = %d, want 2", i, len(entries))
		}
	}
	if n := s.connTotal.Load(); n != 1 {
		t.Fatalf("server conns = %d, want 1 (two browses share one pooled dial)", n)
	}
}

func TestPooledFileClientRebuildsOnConnError(t *testing.T) {
	s := newFakePoolSSH(t)
	hostID := poolTestHost(t, s)
	t.Cleanup(func() { conns.CloseAll() })
	rh, err := store.Get().RemoteHost.Get(hostID)
	if err != nil {
		t.Fatalf("get host: %v", err)
	}

	fc, err := leaseHostFile(rh)
	if err != nil {
		t.Fatalf("lease: %v", err)
	}
	if _, err := fc.ListDir("."); err != nil {
		t.Fatalf("first list: %v", err)
	}
	s.killConns() // 请求中途连接死亡（对端重启/断网形态）
	// 首个 SFTP 操作失败 → 装饰器弃置重建一次 → 重试成功
	if _, err := fc.ListDir("."); err != nil {
		t.Fatalf("list after conn death should self-heal via rebuild: %v", err)
	}
	if n := s.connTotal.Load(); n != 2 {
		t.Fatalf("server conns = %d, want 2 (dead conn replaced once)", n)
	}
	// 业务失败不重建：不存在的目录如实报错，连接计数不涨
	if _, err := fc.ListDir("no-such-dir"); err == nil {
		t.Fatal("list missing dir should fail")
	}
	if n := s.connTotal.Load(); n != 2 {
		t.Fatalf("server conns after business error = %d, want 2 (business errors must not rebuild)", n)
	}
	fc.Close()
}

func TestUpdateRemoteHostFlushesPool(t *testing.T) {
	s := newFakePoolSSH(t)
	hostID := poolTestHost(t, s)
	t.Cleanup(func() { conns.CloseAll() })

	if code, _ := listFiles(t, hostID, "."); code != 200 {
		t.Fatalf("warm list: status %d", code)
	}
	if n := s.connTotal.Load(); n != 1 {
		t.Fatalf("warm conns = %d, want 1", n)
	}

	// 主机编辑（换密码）→ 级联出池 → 下次请求重新拨号且新凭据生效
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Params = gin.Params{{Key: "id", Value: hostID}}
	c.Request = httptest.NewRequest("POST", "/api/remotehosts/"+hostID,
		strings.NewReader(`{"password":"pool-pw-rotated"}`))
	c.Request.Header.Set("Content-Type", "application/json")
	UpdateRemoteHost(c)
	if w.Code != 200 {
		t.Fatalf("update host: status %d body %s", w.Code, w.Body.String())
	}
	if code, _ := listFiles(t, hostID, "."); code != 200 {
		t.Fatal("list after credential rotation should succeed with new password")
	}
	if n := s.connTotal.Load(); n != 2 {
		t.Fatalf("server conns = %d, want 2 (update must flush pooled conn)", n)
	}
}
