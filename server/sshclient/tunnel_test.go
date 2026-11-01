package sshclient

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// 隧道管理器测试：进程内起「远端」——
//   1. fakeRemoteSvc：普通回环 HTTP 服务（模拟远端 dev server）
//   2. fakeSSHServer：内存 SSH 服务端（密码认证，处理 direct-tcpip 通道转发）
// 两者皆为 x/crypto/ssh 官方库的标准服务端用法，全程只碰本机回环。
// 覆盖：转发通、同 key 复用、上限 409 语义、显式关闭、空闲回收、断线重连。

// fakeSSHServer 进程内 SSH 服务端：密码认证 + direct-tcpip 转发到本机回环
type fakeSSHServer struct {
	t *testing.T

	ln       net.Listener
	password string
	// cfgMu 保护 cfg / hostSigner：hostkey TOFU 测试会在服务期间原位换主机钥
	//（同端口模拟服务器重装/换钥），serve 循环与 swap 并发
	cfgMu      sync.RWMutex
	cfg        *ssh.ServerConfig
	hostSigner ssh.Signer

	connsMu sync.Mutex
	conns   []*ssh.ServerConn // 存活连接（测试可主动断开模拟网络抖动）

	forwardTotal atomic.Int64 // direct-tcpip 通道累计（转发确实走 SSH 的旁证）
	connTotal    atomic.Int64 // 完成握手的连接累计（连接池「N 次请求仅一次拨号」断言用）
	execTotal    atomic.Int64 // session exec 请求累计
	// rejectForward 模拟 sshd AllowTcpForwarding no：tcpip-forward 全局请求
	// 一律拒绝（反向隧道预检失败谱测试用）
	rejectForward atomic.Bool
}

func newFakeSSHServer(t *testing.T, password string) *fakeSSHServer {
	t.Helper()
	s := &fakeSSHServer{t: t, password: password}
	s.cfg = s.buildCfg(randomHostSigner(t))
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen ssh: %v", err)
	}
	s.ln = ln
	go s.serve()
	t.Cleanup(s.close)
	return s
}

func (s *fakeSSHServer) buildCfg(signer ssh.Signer) *ssh.ServerConfig {
	s.hostSigner = signer // 调用方持 cfgMu（构造期无并发）
	cfg := &ssh.ServerConfig{PasswordCallback: func(conn ssh.ConnMetadata, pass []byte) (*ssh.Permissions, error) {
		if string(pass) == s.password {
			return &ssh.Permissions{}, nil
		}
		return nil, fmt.Errorf("auth rejected for %q", conn.User())
	}}
	cfg.AddHostKey(signer)
	return cfg
}

// swapHostKey 原位更换主机钥（同端口换新钥，模拟服务器重装/密钥轮换，
// hostkey TOFU 测试用）。仅影响之后的新连接——已建连接不受影响
func (s *fakeSSHServer) swapHostKey(signer ssh.Signer) {
	s.cfgMu.Lock()
	defer s.cfgMu.Unlock()
	s.cfg = s.buildCfg(signer)
}

func (s *fakeSSHServer) port() int { return s.ln.Addr().(*net.TCPAddr).Port }

func (s *fakeSSHServer) close() {
	_ = s.ln.Close()
	s.connsMu.Lock()
	for _, c := range s.conns {
		_ = c.Close()
	}
	s.conns = nil
	s.connsMu.Unlock()
}

// killConns 主动断开全部 SSH 连接（模拟远端 sshd 重启/网络抖动；
// 服务端本身仍监听，客户端可重连）
func (s *fakeSSHServer) killConns() {
	s.connsMu.Lock()
	for _, c := range s.conns {
		_ = c.Close()
	}
	s.connsMu.Unlock()
}

// currentHostSigner 当前主机钥公钥（swap 后更新；TOFU 测试断言钉扎指纹用）。
// 方法名不与 hostSigner 字段同名（Go 不允许同名字段与方法），读取走 cfgMu 同一保护面
func (s *fakeSSHServer) currentHostSigner() ssh.Signer {
	s.cfgMu.RLock()
	defer s.cfgMu.RUnlock()
	return s.hostSigner
}

func (s *fakeSSHServer) serve() {
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			return
		}
		s.cfgMu.RLock()
		cfg := s.cfg
		s.cfgMu.RUnlock()
		sconn, chans, reqs, err := ssh.NewServerConn(conn, cfg)
		if err != nil {
			_ = conn.Close()
			continue
		}
		s.connsMu.Lock()
		s.conns = append(s.conns, sconn)
		s.connsMu.Unlock()
		s.connTotal.Add(1)
		go s.handleConn(sconn, chans, reqs)
	}
}

// tcpipForwardMsg RFC 4254 §7.1 远端监听请求载荷（地址 + 端口两字段；
// ssh.Unmarshal 按结构字段数逐段解析，多写字段会把短载荷判为 short read）
type tcpipForwardMsg struct {
	Addr string
	Port uint32
}

// forwardedTCPIPMsg RFC 4254 §7.2 反向转发通道载荷（地址/端口 + 发起方）
type forwardedTCPIPMsg struct {
	Addr       string
	Port       uint32
	OriginAddr string
	OriginPort uint32
}

func (s *fakeSSHServer) handleConn(sconn *ssh.ServerConn, chans <-chan ssh.NewChannel, reqs <-chan *ssh.Request) {
	defer sconn.Close()
	// 反向监听集合（P-20261019-11 测试用）：tcpip-forward 请求在本进程
	// net.Listen，入站连接经 forwarded-tcpip 通道回送客户端；连接断开即全部
	// 释放（模拟 sshd 随连接终止回收远端监听）
	var fmu sync.Mutex
	fwds := map[string]net.Listener{}
	closeForwards := func() {
		fmu.Lock()
		defer fmu.Unlock()
		for k, ln := range fwds {
			_ = ln.Close()
			delete(fwds, k)
		}
	}
	defer closeForwards()
	// 全局请求逐条应答（keepalive 探活 wantReply 的活性判据；未知请求按
	// RFC 4254 §5.4 回 FAILURE，DiscardRequests 的静默丢弃会让 wantReply
	// 客户端悬挂到超时）
	go func() {
		for req := range reqs {
			switch req.Type {
			case "keepalive@openssh.com":
				if req.WantReply {
					_ = req.Reply(true, nil)
				}
			case "tcpip-forward":
				var m tcpipForwardMsg
				if s.rejectForward.Load() || ssh.Unmarshal(req.Payload, &m) != nil || m.Port == 0 {
					if req.WantReply {
						_ = req.Reply(false, nil)
					}
					continue
				}
				addr := net.JoinHostPort(m.Addr, strconv.Itoa(int(m.Port)))
				ln, err := net.Listen("tcp", addr)
				if err != nil {
					if req.WantReply {
						_ = req.Reply(false, nil)
					}
					continue
				}
				fmu.Lock()
				fwds[addr] = ln
				fmu.Unlock()
				if req.WantReply {
					_ = req.Reply(true, nil)
				}
				go s.acceptForwarded(sconn, ln, addr, &fmu, fwds)
			case "cancel-tcpip-forward":
				var m tcpipForwardMsg
				if err := ssh.Unmarshal(req.Payload, &m); err == nil {
					addr := net.JoinHostPort(m.Addr, strconv.Itoa(int(m.Port)))
					fmu.Lock()
					if ln, ok := fwds[addr]; ok {
						_ = ln.Close()
						delete(fwds, addr)
					}
					fmu.Unlock()
				}
				if req.WantReply {
					_ = req.Reply(true, nil)
				}
			default:
				if req.WantReply {
					_ = req.Reply(false, nil)
				}
			}
		}
	}()
	for ch := range chans {
		switch ch.ChannelType() {
		case "direct-tcpip":
			s.handleForward(ch)
		case "session":
			s.handleSession(ch)
		default:
			_ = ch.Reject(ssh.UnknownChannelType, "unsupported")
		}
	}
}

// sshExitStatus exit-status 请求载荷（RFC 4254 §6.10）
type sshExitStatus struct{ Status uint32 }

// handleSession 会话通道：exec 请求回固定成功输出 + exit 0（连接池/exec
// 链路测试的远端替身，真命令语义不在替身职责内）
func (s *fakeSSHServer) handleSession(ch ssh.NewChannel) {
	channel, requests, err := ch.Accept()
	if err != nil {
		return
	}
	go func() {
		defer channel.Close()
		for req := range requests {
			if req.Type != "exec" {
				if req.WantReply {
					_ = req.Reply(false, nil)
				}
				continue
			}
			s.execTotal.Add(1)
			payload := req.Payload
			if len(payload) >= 4 {
				n := binary.BigEndian.Uint32(payload[0:4])
				if int(4+n) <= len(payload) {
					_, _ = io.WriteString(channel, "session-ok:"+string(payload[4:4+n])+"\n")
				}
			}
			_ = req.Reply(true, nil)
			_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(sshExitStatus{Status: 0}))
			return // 单 exec 语义：回完即关（客户端 scan 管道随 EOF 收尾）
		}
	}()
}

// handleForward direct-tcpip 转发（原 handleConn 内联逻辑，session 分支拆出后独立成方法）
func (s *fakeSSHServer) handleForward(ch ssh.NewChannel) {
	s.forwardTotal.Add(1)
	// RFC 4254 §7.2 载荷：目标 host/port + 发起方 host/port（各 4 字节长度前缀）
	payload := ch.ExtraData()
	if len(payload) < 8 {
		_ = ch.Reject(ssh.ConnectionFailed, "bad payload")
		return
	}
	hostLen := binary.BigEndian.Uint32(payload[0:4])
	if int(4+hostLen+4) > len(payload) {
		_ = ch.Reject(ssh.ConnectionFailed, "bad payload")
		return
	}
	host := string(payload[4 : 4+hostLen])
	port := binary.BigEndian.Uint32(payload[4+hostLen : 8+hostLen])

	target, err := net.Dial("tcp", net.JoinHostPort(host, fmt.Sprintf("%d", port)))
	if err != nil {
		_ = ch.Reject(ssh.ConnectionFailed, err.Error())
		return
	}
	channel, requests, err := ch.Accept()
	if err != nil {
		_ = target.Close()
		return
	}
	go ssh.DiscardRequests(requests)
	go func() {
		defer channel.Close()
		defer target.Close()
		_, _ = io.Copy(target, channel)
		if cw, ok := target.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		}
	}()
	go func() {
		defer channel.Close()
		defer target.Close()
		_, _ = io.Copy(channel, target)
	}()
}

// dialFakeSSH 测试用 TunnelDialer：连进程内 SSH 服务端（密码认证）
func dialFakeSSH(server *fakeSSHServer, user, password string) TunnelDialer {
	return func() (*ssh.Client, error) {
		cfg := &ssh.ClientConfig{
			User:            user,
			Auth:            []ssh.AuthMethod{ssh.Password(password)},
			HostKeyCallback: ssh.InsecureIgnoreHostKey(),
			Timeout:         3 * time.Second,
		}
		return ssh.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", server.port()), cfg)
	}
}

// startFakeRemoteSvc 起一个回环 HTTP「远端 dev server」：固定文案响应
func startFakeRemoteSvc(t *testing.T) (port int, url string) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "remote-dev-server-ok")
	})
	srv := &http.Server{Handler: mux}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen remote svc: %v", err)
	}
	go func() { _ = srv.Serve(ln) }() //nolint:errcheck // 测试服务
	t.Cleanup(func() { _ = srv.Close() })
	return ln.Addr().(*net.TCPAddr).Port, "http://" + ln.Addr().String()
}

func httpGetThrough(t *testing.T, localPort int) (string, error) {
	t.Helper()
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/", localPort))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	return string(body), nil
}

func TestTunnelForwardAndClose(t *testing.T) {
	svcPort, _ := startFakeRemoteSvc(t)
	sshSrv := newFakeSSHServer(t, "tpass")
	mgr := NewTunnelManager(3, time.Minute)

	info, err := mgr.Open("host-a", svcPort, dialFakeSSH(sshSrv, "e2e", "tpass"))
	if err != nil {
		t.Fatalf("open tunnel: %v", err)
	}
	if info.LocalPort < 1024 || info.LocalPort > 65535 {
		t.Fatalf("local port out of range: %d", info.LocalPort)
	}

	// 转发通：本地回环口经 SSH 隧道打到远端服务
	body, err := httpGetThrough(t, info.LocalPort)
	if err != nil {
		t.Fatalf("http through tunnel: %v", err)
	}
	if body != "remote-dev-server-ok" {
		t.Fatalf("unexpected body: %q", body)
	}
	if got := sshSrv.forwardTotal.Load(); got < 1 {
		t.Fatalf("expected direct-tcpip channel, got %d forwards", got)
	}

	// 列表可见
	if got := mgr.List("host-a"); len(got) != 1 || got[0].LocalPort != info.LocalPort {
		t.Fatalf("list = %+v", got)
	}

	// 显式关闭 → 端口不再可达
	if !mgr.Close("host-a", info.LocalPort) {
		t.Fatal("close returned false")
	}
	if mgr.Close("host-a", info.LocalPort) {
		t.Fatal("double close should miss")
	}
	if _, err := httpGetThrough(t, info.LocalPort); err == nil {
		t.Fatal("connection should be refused after close")
	}
}

func TestTunnelDedupeSameKey(t *testing.T) {
	svcPort, _ := startFakeRemoteSvc(t)
	sshSrv := newFakeSSHServer(t, "tpass")
	mgr := NewTunnelManager(3, time.Minute)

	first, err := mgr.Open("host-a", svcPort, dialFakeSSH(sshSrv, "e2e", "tpass"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	second, err := mgr.Open("host-a", svcPort, dialFakeSSH(sshSrv, "e2e", "tpass"))
	if err != nil {
		t.Fatalf("re-open: %v", err)
	}
	if first.LocalPort != second.LocalPort {
		t.Fatalf("same key should reuse: %d vs %d", first.LocalPort, second.LocalPort)
	}
	if got := mgr.List("host-a"); len(got) != 1 {
		t.Fatalf("dedupe failed, list = %d entries", len(got))
	}
	t.Cleanup(func() { mgr.CloseAll() })
}

func TestTunnelLimit(t *testing.T) {
	sshSrv := newFakeSSHServer(t, "tpass")
	mgr := NewTunnelManager(2, time.Minute)

	var locals []int
	for i := 0; i < 2; i++ {
		info, err := mgr.Open("host-a", 20000+i, dialFakeSSH(sshSrv, "e2e", "tpass"))
		if err != nil {
			t.Fatalf("open #%d: %v", i, err)
		}
		locals = append(locals, info.LocalPort)
	}
	if _, err := mgr.Open("host-a", 20009, dialFakeSSH(sshSrv, "e2e", "tpass")); !errors.Is(err, ErrTunnelLimit) {
		t.Fatalf("expected ErrTunnelLimit, got %v", err)
	}
	// 关一个腾出名额后可再开
	mgr.Close("host-a", locals[0])
	if _, err := mgr.Open("host-a", 20009, dialFakeSSH(sshSrv, "e2e", "tpass")); err != nil {
		t.Fatalf("open after close: %v", err)
	}
	t.Cleanup(func() { mgr.CloseAll() })
}

func TestTunnelReapIdle(t *testing.T) {
	sshSrv := newFakeSSHServer(t, "tpass")
	mgr := NewTunnelManager(3, 30*time.Millisecond)

	info, err := mgr.Open("host-a", 20001, dialFakeSSH(sshSrv, "e2e", "tpass"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	time.Sleep(20 * time.Millisecond)
	if n := mgr.ReapIdle(); n != 0 {
		t.Fatalf("fresh tunnel should survive, reaped %d", n)
	}
	time.Sleep(50 * time.Millisecond)
	if n := mgr.ReapIdle(); n != 1 {
		t.Fatalf("expected reap 1, got %d", n)
	}
	if got := mgr.List("host-a"); len(got) != 0 {
		t.Fatalf("list after reap = %d", len(got))
	}
	if mgr.Close("host-a", info.LocalPort) {
		t.Fatal("reaped tunnel should not be closable")
	}
}

func TestTunnelReconnectAfterSSHDrop(t *testing.T) {
	svcPort, _ := startFakeRemoteSvc(t)
	sshSrv := newFakeSSHServer(t, "tpass")
	mgr := NewTunnelManager(3, time.Minute)

	info, err := mgr.Open("host-a", svcPort, dialFakeSSH(sshSrv, "e2e", "tpass"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := httpGetThrough(t, info.LocalPort); err != nil {
		t.Fatalf("first request: %v", err)
	}

	// 模拟网络抖动：服务端掐断 SSH 连接（服务端仍监听，可重连）
	sshSrv.killConns()
	time.Sleep(50 * time.Millisecond)

	body, err := httpGetThrough(t, info.LocalPort)
	if err != nil {
		t.Fatalf("request after drop should reconnect: %v", err)
	}
	if body != "remote-dev-server-ok" {
		t.Fatalf("unexpected body after reconnect: %q", body)
	}
	t.Cleanup(func() { mgr.CloseAll() })
}

func TestTunnelCloseHostAndInvalidInput(t *testing.T) {
	svcPort, _ := startFakeRemoteSvc(t)
	sshSrv := newFakeSSHServer(t, "tpass")
	mgr := NewTunnelManager(3, time.Minute)

	if _, err := mgr.Open("", svcPort, dialFakeSSH(sshSrv, "e2e", "tpass")); err == nil {
		t.Fatal("empty hostID should fail")
	}
	if _, err := mgr.Open("host-a", 0, dialFakeSSH(sshSrv, "e2e", "tpass")); err == nil {
		t.Fatal("port 0 should fail")
	}
	if _, err := mgr.Open("host-a", 70000, dialFakeSSH(sshSrv, "e2e", "tpass")); err == nil {
		t.Fatal("port 70000 should fail")
	}
	// 拨号失败不落资源（上限不被占坑）
	if _, err := mgr.Open("host-a", svcPort, func() (*ssh.Client, error) {
		return nil, errors.New("dial boom")
	}); err == nil {
		t.Fatal("dial failure should fail open")
	}
	if got := mgr.List("host-a"); len(got) != 0 {
		t.Fatalf("failed opens should not register, got %d", len(got))
	}

	for _, port := range []int{21001, 21002} {
		if _, err := mgr.Open("host-b", port, dialFakeSSH(sshSrv, "e2e", "tpass")); err != nil {
			t.Fatalf("open host-b %d: %v", port, err)
		}
	}
	if got := mgr.List("host-a"); len(got) != 0 {
		t.Fatalf("host-a should be empty, got %d", len(got))
	}
	if n := mgr.CloseHost("host-b"); n != 2 {
		t.Fatalf("CloseHost = %d", n)
	}
	if n := mgr.CloseHost("host-b"); n != 0 {
		t.Fatalf("double CloseHost = %d", n)
	}
	t.Cleanup(func() { mgr.CloseAll() })
}

// 并发转发压力（-race 主目标）：多请求并行过隧道，内容不串不丢
func TestTunnelConcurrentForward(t *testing.T) {
	svcPort, _ := startFakeRemoteSvc(t)
	sshSrv := newFakeSSHServer(t, "tpass")
	mgr := NewTunnelManager(3, time.Minute)

	info, err := mgr.Open("host-a", svcPort, dialFakeSSH(sshSrv, "e2e", "tpass"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			body, err := httpGetThrough(t, info.LocalPort)
			if err != nil {
				errs <- err
				return
			}
			if body != "remote-dev-server-ok" {
				errs <- fmt.Errorf("bad body %q", body)
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent request failed: %v", err)
	}
	t.Cleanup(func() { mgr.CloseAll() })
}

// acceptForwarded 把远端监听上的入站连接经 forwarded-tcpip 通道回送给
// SSH 客户端（反向隧道测试的服务端替身；真实 sshd 同语义）
func (s *fakeSSHServer) acceptForwarded(sconn *ssh.ServerConn, ln net.Listener, addr string, mu *sync.Mutex, fwds map[string]net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		go func(c net.Conn) {
			defer func() { _ = c.Close() }()
			host, portStr, _ := net.SplitHostPort(addr)
			port, _ := strconv.Atoi(portStr)
			originHost, originPortStr, _ := net.SplitHostPort(c.RemoteAddr().String())
			originPort, _ := strconv.Atoi(originPortStr)
			ch, reqs, err := sconn.OpenChannel("forwarded-tcpip", ssh.Marshal(forwardedTCPIPMsg{
				Addr: host, Port: uint32(port), OriginAddr: originHost, OriginPort: uint32(originPort),
			}))
			if err != nil {
				return
			}
			go ssh.DiscardRequests(reqs)
			go func() {
				_, _ = io.Copy(ch, c)
				if cw, ok := ch.(interface{ CloseWrite() error }); ok {
					_ = cw.CloseWrite()
				}
			}()
			_, _ = io.Copy(c, ch)
			_ = ch.Close()
		}(conn)
	}
}
