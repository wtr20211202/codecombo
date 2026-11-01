package sshclient

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// 连接池测试（P-20261005-159）：进程内 fakeSSHServer（见 tunnel_test.go，
// 已扩展 session exec + keepalive 应答 + connTotal 拨号计数）。覆盖：同主机
// 复用（N 次操作仅一次拨号）、TTL 过期重建、FlushHost 即时失效、并发上限
// 与短排队、半开探活、首错弃置重建（WithLease）、ReapIdle 在借保护、
// IsConnLevelError 业务/连接失败甄别。

// poolTestOpts 拨向进程内 fake server 的连接参数（InsecureIgnoreHostKey：
// TOFU 钉扎走 store，池语义测试不掺和）
func poolTestOpts(s *fakeSSHServer) ConnectOptions {
	return ConnectOptions{
		Host: "127.0.0.1", Port: s.port(), User: "e2e",
		Auth:            AuthMethod{Type: AuthTypePassword, Password: s.password},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         3 * time.Second,
	}
}

// execOK 经池借出连接执行一条命令，返回服务端回显
func execOK(t *testing.T, p *ClientPool, hostID string, opts ConnectOptions) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var out *ExecOutput
	err := p.WithLease(hostID, opts, func(c *Client) error {
		var e error
		out, e = c.Exec(ctx, ExecOptions{Cmd: "probe"}, nil)
		return e
	})
	if err != nil {
		t.Fatalf("WithLease exec: %v", err)
	}
	return strings.Join(out.Stdout, "\n")
}

func TestClientPoolReuseSingleDial(t *testing.T) {
	s := newFakeSSHServer(t, "pool-pw")
	p := NewClientPool(2, DefaultPoolTTL)
	for i := 0; i < 3; i++ {
		if got := execOK(t, p, "host-a", poolTestOpts(s)); !strings.Contains(got, "session-ok") {
			t.Fatalf("exec %d output = %q", i, got)
		}
	}
	if n := s.connTotal.Load(); n != 1 {
		t.Fatalf("server conns = %d, want 1 (3 ops should share one dial)", n)
	}
	dials, reuses := p.Stats()
	if dials != 1 || reuses != 2 {
		t.Fatalf("Stats() = (%d, %d), want (1, 2)", dials, reuses)
	}
	// 不同主机各拨各的
	execOK(t, p, "host-b", poolTestOpts(s))
	if n := s.connTotal.Load(); n != 2 {
		t.Fatalf("server conns after host-b = %d, want 2", n)
	}
}

func TestClientPoolTTLExpiry(t *testing.T) {
	s := newFakeSSHServer(t, "pool-pw")
	p := NewClientPool(2, 80*time.Millisecond)
	execOK(t, p, "host-a", poolTestOpts(s))
	time.Sleep(150 * time.Millisecond) // 静默超 TTL
	execOK(t, p, "host-a", poolTestOpts(s))
	if n := s.connTotal.Load(); n != 2 {
		t.Fatalf("server conns = %d, want 2 (idle conn must be re-dialed after TTL)", n)
	}
}

func TestClientPoolFlushHost(t *testing.T) {
	s := newFakeSSHServer(t, "pool-pw")
	p := NewClientPool(2, DefaultPoolTTL)
	execOK(t, p, "host-a", poolTestOpts(s))
	if n := p.FlushHost("host-a"); n != 1 {
		t.Fatalf("FlushHost = %d, want 1", n)
	}
	if n := p.FlushHost("host-a"); n != 0 {
		t.Fatalf("FlushHost (empty) = %d, want 0", n)
	}
	execOK(t, p, "host-a", poolTestOpts(s))
	if n := s.connTotal.Load(); n != 2 {
		t.Fatalf("server conns = %d, want 2 (flush forces re-dial)", n)
	}
	// 凭据变更语义：flush 后按调用方 opts 重新拨号（错误凭据如实失败）。
	// 注：flush → 正确凭据重拨后的再次借出会复用新连接（opts 只在拨号时
	// 生效，凭据轮换靠 FlushHost 触发，这也是 CRUD 侧钩子的依据）
	p.FlushHost("host-a")
	bad := poolTestOpts(s)
	bad.Auth.Password = "wrong"
	if err := p.WithLease("host-a", bad, func(c *Client) error { return nil }); err == nil {
		t.Fatal("dial with wrong password after flush should fail")
	}
}

func TestClientPoolQueueLimitAndTimeout(t *testing.T) {
	s := newFakeSSHServer(t, "pool-pw")
	p := NewClientPool(1, DefaultPoolTTL)
	p.queueWait = 300 * time.Millisecond // 测试收缩排队窗口
	opts := poolTestOpts(s)

	l1, err := p.Get("host-a", opts)
	if err != nil {
		t.Fatalf("first Get: %v", err)
	}
	if _, err := p.Get("host-a", opts); !errors.Is(err, ErrPoolBusy) {
		t.Fatalf("second Get err = %v, want ErrPoolBusy", err)
	}
	l1.End()
	l2, err := p.Get("host-a", opts) // 归还后可再借
	if err != nil {
		t.Fatalf("Get after End: %v", err)
	}
	l2.End()
}

func TestClientPoolConcurrentShareOneConn(t *testing.T) {
	s := newFakeSSHServer(t, "pool-pw")
	p := NewClientPool(4, DefaultPoolTTL)
	opts := poolTestOpts(s)
	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			err := p.WithLease("host-a", opts, func(c *Client) error {
				out, e := c.Exec(ctx, ExecOptions{Cmd: "concurrent"}, nil)
				if e != nil {
					return e
				}
				if !strings.Contains(strings.Join(out.Stdout, "\n"), "session-ok") {
					return fmt.Errorf("unexpected output %v", out.Stdout)
				}
				return nil
			})
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent exec: %v", err)
		}
	}
	if n := s.connTotal.Load(); n != 1 {
		t.Fatalf("server conns = %d, want 1 (4 concurrent ops share one conn via multiplexing)", n)
	}
}

func TestClientPoolHalfOpenRebuildOnFirstError(t *testing.T) {
	s := newFakeSSHServer(t, "pool-pw")
	p := NewClientPool(2, DefaultPoolTTL)
	execOK(t, p, "host-a", poolTestOpts(s)) // 建立并归还（空闲窗口内，下次借出不探活）
	s.killConns()                           // 模拟对端断网/重启（服务端仍在监听）
	// 半开连接的首个操作必败 → WithLease 弃置重建重试一次即自愈
	execOK(t, p, "host-a", poolTestOpts(s))
	if n := s.connTotal.Load(); n != 2 {
		t.Fatalf("server conns = %d, want 2 (half-open conn must be rebuilt once)", n)
	}
}

func TestClientPoolProbeDetectsDeadIdleConn(t *testing.T) {
	s := newFakeSSHServer(t, "pool-pw")
	prev := poolProbeAfter
	poolProbeAfter = 40 * time.Millisecond // 收缩探活阈值
	t.Cleanup(func() { poolProbeAfter = prev })

	p := NewClientPool(2, DefaultPoolTTL)
	execOK(t, p, "host-a", poolTestOpts(s))
	s.killConns()
	time.Sleep(80 * time.Millisecond) // 空闲超探活阈值：借出前先探活
	execOK(t, p, "host-a", poolTestOpts(s))
	if n := s.connTotal.Load(); n != 2 {
		t.Fatalf("server conns = %d, want 2 (probe must replace dead idle conn before use)", n)
	}
}

func TestClientPoolReapIdle(t *testing.T) {
	s := newFakeSSHServer(t, "pool-pw")
	p := NewClientPool(2, 60*time.Millisecond)
	opts := poolTestOpts(s)
	execOK(t, p, "host-a", opts)
	time.Sleep(100 * time.Millisecond)
	if n := p.ReapIdle(); n != 1 {
		t.Fatalf("ReapIdle = %d, want 1", n)
	}
	// 在借连接不回收
	l, err := p.Get("host-b", opts)
	if err != nil {
		t.Fatalf("Get host-b: %v", err)
	}
	time.Sleep(100 * time.Millisecond)
	if n := p.ReapIdle(); n != 0 {
		t.Fatalf("ReapIdle with inflight lease = %d, want 0", n)
	}
	l.End()
}

func TestIsConnLevelError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"eof", io.EOF, true},
		{"unexpected eof", io.ErrUnexpectedEOF, true},
		{"net closed", net.ErrClosed, true},
		{"op error", &net.OpError{Op: "write", Err: errors.New("broken pipe")}, true},
		{"timeout text", errors.New("read tcp: connection reset by peer"), true},
		{"broken pipe", errors.New("write: broken pipe"), true},
		{"sftp send packet", errors.New("failed to send packet header: EOF"), true},
		// 半开连接 OpenChannel：写进内核缓冲成功、confirm 读 EOF，x/crypto/ssh
		// incoming 关闭解出 <nil>（TestClientPoolHalfOpenRebuildOnFirstError 实测）——
		// 首错重建必须认得，否则 FIN 晚于首写时序下半开自愈失效
		{"half-open channel open", errors.New("new session: ssh: unexpected packet in response to channel open: <nil>"), true},
		{"ctx deadline", context.DeadlineExceeded, false},
		{"ctx canceled", context.Canceled, false},
		{"sftp status", errors.New(`sftp: "No such file" (SSH_FX_NO_SUCH_FILE)`), false},
		{"exit status", errors.New("Process exited with status 1"), false},
		{"plain business", os.ErrNotExist, false},
	}
	for _, tc := range cases {
		if got := IsConnLevelError(tc.err); got != tc.want {
			t.Errorf("%s: IsConnLevelError(%v) = %v, want %v", tc.name, tc.err, got, tc.want)
		}
	}
}
