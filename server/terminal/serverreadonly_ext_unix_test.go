//go:build !windows

package terminal

import (
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
)

// 服务端只读闸（P-20261008-17）接管初值用例：AttachExternalSession 产物闸
// 默认开（与前端接管 pane 默认只读锁同初值）。真实 tmux 域（!windows 构建
// 标签——tmux 命令助手住 tmux_cmd.go 同标签文件）。夹具会话住用户默认
// socket（外部会话语义，P-189 同款——专属 socket 上的会话不是外部面）
func TestServerReadOnly_ExternalAttachTrue(t *testing.T) {
	name := "sc-ro-gate-test"
	if out, err := runTmuxDefaultSocket("new-session", "-d", "-s", name); err != nil {
		t.Skipf("tmux unavailable: %v (out=%s)", err, out)
	}
	t.Cleanup(func() { _, _ = runTmuxDefaultSocket("kill-session", "-t", name) })
	time.Sleep(100 * time.Millisecond) // tmux server 注册窗口

	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })

	m := &Manager{sessions: make(map[string]*Session)}
	s, err := m.AttachExternalSession(name, name)
	if err != nil {
		t.Skipf("external attach unavailable: %v", err)
	}
	t.Cleanup(func() { m.CloseSession(s.ID) })
	if !s.ServerReadOnly() {
		t.Fatal("attached external session must default to serverReadOnly=true")
	}
	s.SetServerReadOnly(false)
	if s.ServerReadOnly() {
		t.Fatal("SetServerReadOnly(false) must release the gate on external session")
	}
}
