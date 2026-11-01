package terminal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/remoteterminal"
	"codecombo/server/store"
	"codecombo/server/terminal"
)

// P-20261005-11 广播输入覆盖远程主机终端：混合目标（本地+远程）编排层的
// HTTP 契约与合并语义单测。远程 manager 经 NewModuleWithManager+Init 装配包级
// 单例（生产装配同一条路），会话经 CreateSession+假 Dialer 建立——不经 SSH
// 真拨号；本地半边传无会话的内存态 Manager（Zero 值 sessions nil map 读安全），
// 本地命中链路由 terminal 包单测与 e2e 覆盖。

// fakeRemoteConn 假 PTYConn：Write 记录 / Read 阻塞（防 readLoop 忙转或自终结）
type fakeRemoteConn struct {
	writes []byte
	dead   bool // Write 即失败（模拟 SSH channel 已断，会话未回收窗口）
}

func (f *fakeRemoteConn) Write(p []byte) (int, error) {
	if f.dead {
		return 0, errors.New("conn dead")
	}
	f.writes = append(f.writes, p...)
	return len(p), nil
}
func (f *fakeRemoteConn) Read(_ []byte) (int, error) {
	time.Sleep(time.Second) // 阻塞语义同 remoteterminal mockPTY：readLoop 空转降频
	return 0, nil
}
func (f *fakeRemoteConn) Resize(uint16, uint16) error { return nil }
func (f *fakeRemoteConn) Close() error                { return nil }
func (f *fakeRemoteConn) SetReadDeadline(time.Time) error {
	return nil
}

// routeDialer hostID → 预置连接（一台主机一种写入命运）
type routeDialer map[string]*fakeRemoteConn

func (d routeDialer) DialPTY(spec remoteterminal.SessionSpec) (remoteterminal.PTYConn, error) {
	if conn, ok := d[spec.HostID]; ok {
		return conn, nil
	}
	return nil, errors.New("no route for host")
}

// installRemoteManager 装配含两台主机各一会话的远程 manager 单例（一好一断），
// 返回会话 id 与好连接（断言写入内容用）
func installRemoteManager(t *testing.T) (goodID, deadID string, good *fakeRemoteConn) {
	t.Helper()
	good = &fakeRemoteConn{}
	mgr := remoteterminal.NewManager(routeDialer{
		"sc_rh_a": good,
		"sc_rh_b": {dead: true},
	}, remoteterminal.DefaultSessionLimit)
	sa, err := mgr.CreateSession("sc_rh_a", 24, 80, "")
	if err != nil {
		t.Fatalf("create good remote session: %v", err)
	}
	sd, err := mgr.CreateSession("sc_rh_b", 24, 80, "")
	if err != nil {
		t.Fatalf("create dead remote session: %v", err)
	}
	mod := remoteterminal.NewModuleWithManager(mgr)
	if err := mod.Init(context.Background(), nil); err != nil {
		t.Fatalf("init remote module: %v", err)
	}
	t.Cleanup(func() {
		// Kill 双会话终结 readLoop goroutine，再卸载单例防泄漏进同包其他用例
		mgr.KillSession(sa.ID)
		mgr.KillSession(sd.ID)
		_ = mod.Stop(context.Background(), nil)
	})
	return sa.ID, sd.ID, good
}

// TestBroadcastMixedTargets 本地查无的 id 落到远程半边：远程存活目标写入（SSH
// stdin 服务端中继）、断连目标 failed 并带主机名标注（哪台失败一目了然）、
// 两端都不存在的 id 保持 missing；written/missing/failed 契约与 P-288 逐字节一致
func TestBroadcastMixedTargets(t *testing.T) {
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	for _, h := range []config.RemoteHost{{ID: "sc_rh_a", Name: "舰队-A"}, {ID: "sc_rh_b", Name: "舰队-B"}} {
		if err := store.Get().RemoteHost.Save(h); err != nil {
			t.Fatalf("seed remote host: %v", err)
		}
	}
	goodID, deadID, good := installRemoteManager(t)

	w := postBroadcast(setupBroadcastRouter(),
		`{"ids":["`+goodID+`","`+deadID+`","ghost-x"],"data":"uptime\r"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	var parsed struct {
		Data struct {
			Written     int                   `json:"written"`
			Missing     []string              `json:"missing"`
			Failed      []string              `json:"failed"`
			FailedHosts []BroadcastFailedHost `json:"failedHosts"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("response not json: %v body=%s", err, w.Body.String())
	}
	d := parsed.Data
	if d.Written != 1 {
		t.Fatalf("written = %d, want 1 (remote good leg): %+v", d.Written, d)
	}
	if len(d.Missing) != 1 || d.Missing[0] != "ghost-x" {
		t.Fatalf("missing not merged: %+v", d)
	}
	if len(d.Failed) != 1 || d.Failed[0] != deadID {
		t.Fatalf("failed not annotated: %+v", d)
	}
	if len(d.FailedHosts) != 1 || d.FailedHosts[0].ID != deadID ||
		d.FailedHosts[0].HostID != "sc_rh_b" || d.FailedHosts[0].Host != "舰队-B" {
		t.Fatalf("failedHosts wrong: %+v", d.FailedHosts)
	}
	// 写入真到达远端 stdin（服务端中继的实质断言）
	if string(good.writes) != "uptime\r" {
		t.Fatalf("remote stdin not written: %q", good.writes)
	}
}

// TestBroadcastMixedHostFallback 主机记录不可得（已删/未装配 store）：failed
// 回告保留，主机别名退化回落 hostId（宁缺不虚构）
func TestBroadcastMixedHostFallback(t *testing.T) {
	goodID, deadID, _ := installRemoteManager(t)

	// 空本地 manager（Zero 值）：sessions nil map 读安全，全部 id 落远程二段
	res, failedHosts := broadcastMixed(&terminal.Manager{}, []string{goodID, deadID}, []byte("x"))
	if res.Written != 1 || len(res.Failed) != 1 || res.Failed[0] != deadID {
		t.Fatalf("unexpected result: %+v", res)
	}
	// store 未装配：display 名回落 hostId
	if len(failedHosts) != 1 || failedHosts[0].Host != "sc_rh_b" {
		t.Fatalf("host fallback wrong: %+v", failedHosts)
	}
}
