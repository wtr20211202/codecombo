package sshclient

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"codecombo/server/store"

	"golang.org/x/crypto/ssh"
)

// 反向隧道测试（P-20261019-11）：进程内 fakeSSHServer 扩展 tcpip-forward /
// forwarded-tcpip 支持（模拟真实 sshd 的远端监听），本机 HTTP 目标替身验证
// 「公网中继 → 实例主端口」全链路。覆盖生命周期/转发/并发上限/断线自动
// 重连/端口冲突/TOFU 主机密钥变更与重置、预检成功与失败谱、指数退避。

func reverseTestDialer(srv *fakeSSHServer, password string) func() (*ssh.Client, error) {
	return func() (*ssh.Client, error) {
		c, err := Dial(ConnectOptions{
			Host: "127.0.0.1", Port: srv.port(), User: "e2e",
			Auth:            AuthMethod{Type: AuthTypePassword, Password: password},
			HostKeyCallback: ssh.InsecureIgnoreHostKey(),
			Timeout:         3 * time.Second,
		})
		if err != nil {
			return nil, err
		}
		return c.UnderlyingClient(), nil
	}
}

// reverseTOFUDialer 不传 HostKeyCallback → TOFU 钉扎（主机密钥变更测试用）
func reverseTOFUDialer(srv *fakeSSHServer, password string) func() (*ssh.Client, error) {
	return func() (*ssh.Client, error) {
		c, err := Dial(ConnectOptions{
			Host: "127.0.0.1", Port: srv.port(), User: "e2e",
			Auth:    AuthMethod{Type: AuthTypePassword, Password: password},
			Timeout: 3 * time.Second,
		})
		if err != nil {
			return nil, err
		}
		return c.UnderlyingClient(), nil
	}
}

func freeLoopbackPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port
}

func startLocalTarget(t *testing.T) (addr string, port int) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "reverse-local-target-ok")
	}))
	t.Cleanup(srv.Close)
	return srv.Listener.Addr().String(), srv.Listener.Addr().(*net.TCPAddr).Port
}

func httpThroughTunnel(t *testing.T, port int) string {
	t.Helper()
	client := &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{Proxy: nil}}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/", port))
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return string(b)
}

func waitReverseStatus(t *testing.T, mgr *ReverseTunnelManager, timeout time.Duration, check func(ReverseStatus) bool) ReverseStatus {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var st ReverseStatus
	for time.Now().Before(deadline) {
		st = mgr.Status()
		if check(st) {
			return st
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("reverse status not reached, last=%+v", st)
	return st
}

func reverseSpec(profileID string, bindHost string, remotePort int, localAddr string, dial func() (*ssh.Client, error)) ReverseSpec {
	return ReverseSpec{
		ProfileID: profileID, RemoteBindHost: bindHost, RemotePort: remotePort,
		LocalAddr: localAddr, PublicURL: fmt.Sprintf("http://relay.example:%d", remotePort), Dial: dial,
	}
}

func TestReverseTunnelLifecycleAndForward(t *testing.T) {
	localAddr, _ := startLocalTarget(t)
	sshSrv := newFakeSSHServer(t, "tpass")
	port := freeLoopbackPort(t)
	var mu sync.Mutex
	var events []string
	mgr := NewReverseTunnelManager(func(ev ReverseEvent) {
		mu.Lock()
		events = append(events, ev.Type)
		mu.Unlock()
	})
	t.Cleanup(mgr.CloseAll)

	st, err := mgr.Start(reverseSpec("relay-a", "0.0.0.0", port, localAddr, reverseTestDialer(sshSrv, "tpass")))
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if st.State != ReverseStateOnline || st.ProfileID != "relay-a" || st.RemotePort != port {
		t.Fatalf("unexpected status: %+v", st)
	}
	if st.PublicURL == "" {
		t.Fatalf("public url should be set")
	}
	if got := httpThroughTunnel(t, port); got != "reverse-local-target-ok" {
		t.Fatalf("through tunnel got %q", got)
	}
	// 幂等：同 profile 再 start 不重建（ServerConn 计数仍为 1）
	if _, err := mgr.Start(reverseSpec("relay-a", "0.0.0.0", port, localAddr, reverseTestDialer(sshSrv, "tpass"))); err != nil {
		t.Fatalf("idempotent start: %v", err)
	}
	var conns int64
	sshSrv.connsMu.Lock()
	conns = int64(len(sshSrv.conns))
	sshSrv.connsMu.Unlock()
	if conns != 1 {
		t.Fatalf("idempotent start should reuse connection, conns=%d", conns)
	}
	if _, after := mgr.Stop(); after.State != ReverseStateStopped {
		t.Fatalf("stop state = %s", after.State)
	}
	if got := httpThroughTunnel(t, port); got != "" {
		t.Fatalf("tunnel should be closed after stop, got %q", got)
	}
	mu.Lock()
	joined := strings.Join(events, ",")
	mu.Unlock()
	if !strings.Contains(joined, ReverseEventStarted) || !strings.Contains(joined, ReverseEventStopped) {
		t.Fatalf("events = %q", joined)
	}
}

func TestReverseTunnelReconnect(t *testing.T) {
	localAddr, _ := startLocalTarget(t)
	sshSrv := newFakeSSHServer(t, "tpass")
	port := freeLoopbackPort(t)
	mgr := NewReverseTunnelManager(nil)
	t.Cleanup(mgr.CloseAll)
	if _, err := mgr.Start(reverseSpec("relay-a", "0.0.0.0", port, localAddr, reverseTestDialer(sshSrv, "tpass"))); err != nil {
		t.Fatalf("start: %v", err)
	}
	if got := httpThroughTunnel(t, port); got == "" {
		t.Fatalf("pre-disconnect forward failed")
	}
	sshSrv.killConns() // 模拟网络抖动/sshd 重启
	st := waitReverseStatus(t, mgr, 15*time.Second, func(s ReverseStatus) bool { return s.State == ReverseStateOnline && s.Attempts == 0 })
	if st.State != ReverseStateOnline {
		t.Fatalf("did not reconnect: %+v", st)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		if got := httpThroughTunnel(t, port); got == "reverse-local-target-ok" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("forward after reconnect failed, status=%+v", mgr.Status())
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func TestReverseTunnelPortConflict(t *testing.T) {
	localAddr, _ := startLocalTarget(t)
	sshSrv := newFakeSSHServer(t, "tpass")
	port := freeLoopbackPort(t)
	occupied, err := net.Listen("tcp", net.JoinHostPort("0.0.0.0", fmt.Sprintf("%d", port)))
	if err != nil {
		t.Fatalf("occupy port: %v", err)
	}
	defer occupied.Close()
	mgr := NewReverseTunnelManager(nil)
	t.Cleanup(mgr.CloseAll)
	_, err = mgr.Start(reverseSpec("relay-a", "0.0.0.0", port, localAddr, reverseTestDialer(sshSrv, "tpass")))
	if err == nil {
		t.Fatalf("start should fail when remote port is occupied")
	}
	if !strings.Contains(err.Error(), "remote bind") {
		t.Fatalf("error should name remote bind: %v", err)
	}
	if st := mgr.Status(); st.State != ReverseStateFailed || st.LastError == "" {
		t.Fatalf("status after failure = %+v", st)
	}
}

func TestReverseTunnelHostKeyChangeThenReset(t *testing.T) {
	initTOFUStore(t)
	localAddr, _ := startLocalTarget(t)
	sshSrv := newFakeSSHServer(t, "tpass")
	port := freeLoopbackPort(t)
	mgr := NewReverseTunnelManager(nil)
	t.Cleanup(mgr.CloseAll)
	if _, err := mgr.Start(reverseSpec("relay-a", "0.0.0.0", port, localAddr, reverseTOFUDialer(sshSrv, "tpass"))); err != nil {
		t.Fatalf("start with TOFU: %v", err)
	}
	// 换主机钥 + 断链：重连必须被 TOFU 拒绝并留下可行动错误
	sshSrv.swapHostKey(randomHostSigner(t))
	sshSrv.killConns()
	st := waitReverseStatus(t, mgr, 12*time.Second, func(s ReverseStatus) bool {
		return strings.Contains(s.LastError, "host key has changed")
	})
	if st.State == ReverseStateOnline {
		t.Fatalf("must not stay online after key change: %+v", st)
	}
	// 合法迁移重置 → 自动重连恢复
	if err := store.Get().SSHHostKey.Delete("127.0.0.1", sshSrv.port()); err != nil {
		t.Fatalf("reset pin: %v", err)
	}
	waitReverseStatus(t, mgr, 20*time.Second, func(s ReverseStatus) bool { return s.State == ReverseStateOnline })
	deadline := time.Now().Add(10 * time.Second)
	for httpThroughTunnel(t, port) != "reverse-local-target-ok" {
		if time.Now().After(deadline) {
			t.Fatalf("forward after key reset failed, status=%+v", mgr.Status())
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func TestReverseBackoff(t *testing.T) {
	cases := []struct {
		attempts int
		want     time.Duration
	}{
		{0, time.Second}, {1, time.Second}, {2, 2 * time.Second}, {3, 4 * time.Second},
		{5, 16 * time.Second}, {6, 30 * time.Second}, {20, 30 * time.Second},
	}
	for _, c := range cases {
		if got := reverseBackoff(c.attempts); got != c.want {
			t.Fatalf("reverseBackoff(%d)=%v want %v", c.attempts, got, c.want)
		}
	}
}

func TestProbeReverseRelaySuccess(t *testing.T) {
	initTOFUStore(t)
	localAddr, _ := startLocalTarget(t)
	sshSrv := newFakeSSHServer(t, "tpass")
	port := freeLoopbackPort(t)
	res := ProbeReverseRelay(ReverseProbeOptions{
		Host: "127.0.0.1", Port: sshSrv.port(), User: "e2e",
		Auth:           AuthMethod{Type: AuthTypePassword, Password: "tpass"},
		RemoteBindHost: "0.0.0.0", RemotePort: port, LocalAddr: localAddr,
		Timeout: 3 * time.Second,
	})
	if !res.OK {
		t.Fatalf("probe should pass: %+v", res)
	}
	for _, step := range res.Steps {
		if !step.OK {
			t.Fatalf("step %s failed: %s %s", step.Step, step.Message, step.Hint)
		}
	}
	if res.HostKeyFingerprint == "" || !strings.HasPrefix(res.HostKeyFingerprint, "SHA256:") {
		t.Fatalf("fingerprint = %q", res.HostKeyFingerprint)
	}
	// 预检临时监听已释放：同一端口可再次绑定
	ln, err := net.Listen("tcp", net.JoinHostPort("0.0.0.0", fmt.Sprintf("%d", port)))
	if err != nil {
		t.Fatalf("probe should release remote listener: %v", err)
	}
	_ = ln.Close()
}

func TestProbeReverseRelayFailureSpectrum(t *testing.T) {
	initTOFUStore(t)
	localAddr, localPort := startLocalTarget(t)
	_ = localPort
	sshSrv := newFakeSSHServer(t, "tpass")

	base := ReverseProbeOptions{
		Host: "127.0.0.1", Port: sshSrv.port(), User: "e2e",
		Auth:           AuthMethod{Type: AuthTypePassword, Password: "tpass"},
		RemoteBindHost: "0.0.0.0", RemotePort: freeLoopbackPort(t), LocalAddr: localAddr,
		Timeout: 2 * time.Second,
	}
	// a) 认证失败
	bad := base
	bad.Auth = AuthMethod{Type: AuthTypePassword, Password: "wrong"}
	if res := ProbeReverseRelay(bad); res.OK || !stepFailed(res, ReverseProbeAuth) {
		t.Fatalf("wrong password should fail auth: %+v", res)
	}
	// b) 本机目标不可达
	noLocal := base
	noLocal.LocalAddr = "127.0.0.1:1"
	if res := ProbeReverseRelay(noLocal); res.OK || !stepFailed(res, ReverseProbeLocalTarget) {
		t.Fatalf("unreachable local target: %+v", res)
	}
	// c) AllowTcpForwarding no
	sshSrv.rejectForward.Store(true)
	if res := ProbeReverseRelay(base); res.OK || !stepFailed(res, ReverseProbeForward) {
		t.Fatalf("forward rejection: %+v", res)
	}
	sshSrv.rejectForward.Store(false)
	// d) 端口占用（先探测命中，早于绑定请求失败）
	occupied, err := net.Listen("tcp", net.JoinHostPort("0.0.0.0", fmt.Sprintf("%d", base.RemotePort)))
	if err != nil {
		t.Fatalf("occupy: %v", err)
	}
	if res := ProbeReverseRelay(base); res.OK || !stepFailed(res, ReverseProbePortFree) {
		t.Fatalf("port occupied: %+v", res)
	}
	_ = occupied.Close()
	// e) 主机密钥变更（先成功一次钉扎，再换钥）
	if res := ProbeReverseRelay(base); !res.OK {
		t.Fatalf("baseline probe should pass: %+v", res)
	}
	sshSrv.swapHostKey(randomHostSigner(t))
	if res := ProbeReverseRelay(base); res.OK || !stepFailed(res, ReverseProbeHostKey) {
		t.Fatalf("host key change should fail host-key step: %+v", res)
	}
}

func stepFailed(res ReverseProbeResult, id string) bool {
	for _, s := range res.Steps {
		if s.Step == id {
			return !s.OK
		}
	}
	return false
}

func TestReverseTunnelConcurrentConnLimit(t *testing.T) {
	localAddr, _ := startLocalTarget(t)
	sshSrv := newFakeSSHServer(t, "tpass")
	port := freeLoopbackPort(t)
	mgr := NewReverseTunnelManager(nil)
	t.Cleanup(mgr.CloseAll)
	spec := reverseSpec("relay-a", "0.0.0.0", port, localAddr, reverseTestDialer(sshSrv, "tpass"))
	spec.MaxConns = 1
	if _, err := mgr.Start(spec); err != nil {
		t.Fatalf("start: %v", err)
	}
	// 打开一条长连接占满配额，第二条应被拒（服务端接受后立即关闭）
	c1, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", fmt.Sprintf("%d", port)))
	if err != nil {
		t.Fatalf("dial 1: %v", err)
	}
	defer c1.Close()
	deadline := time.Now().Add(3 * time.Second)
	for mgr.Status().ActiveConns < 1 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	c2, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", fmt.Sprintf("%d", port)))
	if err != nil {
		t.Fatalf("dial 2: %v", err)
	}
	defer c2.Close()
	_ = c2.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _ = c2.Read(make([]byte, 1)) // 被拒连接应很快 EOF
	deadline = time.Now().Add(3 * time.Second)
	for mgr.Status().DroppedConns < 1 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if got := mgr.Status().DroppedConns; got < 1 {
		t.Fatalf("dropped = %d, want >=1", got)
	}
}
