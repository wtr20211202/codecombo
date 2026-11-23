package share

// 会话输入闸生命周期收口纪律锁（P-20261122-17）：撤销/轮换/过期三条路径
// 都是「先删/换记录再回收」——释放不得依赖记录 lookup；同 token 重建不得
// 继承旧毒来源；自愈对账只放失去授权物的来源（持权中/开放连接在场不误放）。

import (
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"codecombo/server/store"

	"github.com/gorilla/websocket"
)

// gateEnv 最小装配：fakeShares 以 map 暴露给测试（可直接模拟删除/重建），
// sink 记录闸迁移与持权回收回调
func gateEnv(t *testing.T) (fakeShares, *Service, *fakeWritableSink) {
	t.Helper()
	shares := fakeShares{}
	sink := &fakeWritableSink{}
	svc := NewService(shares, fakeRoots{byID: map[string]string{}}, nil).WithWritableSink(sink)
	return shares, svc, sink
}

func terminalShare(token, sessionID string) *store.Share {
	return &store.Share{Token: token, Kind: store.ShareKindTerminal, TerminalID: sessionID, Name: "live"}
}

func lastGate(sink *fakeWritableSink, sessionID string) (bool, bool) {
	sink.mu.Lock()
	defer sink.mu.Unlock()
	log := sink.gates[sessionID]
	if len(log) == 0 {
		return false, false
	}
	return log[len(log)-1], true
}

// TestGateReleaseAfterRecordGone 三生命周期主线：记录先死后回收，闸仍解除
func TestGateReleaseAfterRecordGone(t *testing.T) {
	t.Run("delete", func(t *testing.T) {
		token := fixedToken("gatedel")
		shares, svc, sink := gateEnv(t)
		shares[token] = terminalShare(token, "sess-1")
		svc.GrantDirect(token, "v1", "")
		if v, _ := lastGate(sink, "sess-1"); !v {
			t.Fatal("grant must set the gate")
		}
		// DeleteShare 语义：先删记录，再 RevokeDirect（handlers.go）
		delete(shares, token)
		if _, ok := svc.RevokeDirect(token, "cascade"); !ok {
			t.Fatal("hold must still be revoked even when the record is gone")
		}
		if v, ok := lastGate(sink, "sess-1"); !ok || v {
			t.Fatalf("gate after delete+revoke = %v/%v, want released", v, ok)
		}
	})

	t.Run("rotate", func(t *testing.T) {
		oldToken, newToken := fixedToken("gaterot1"), fixedToken("gaterot2")
		shares, svc, sink := gateEnv(t)
		shares[oldToken] = terminalShare(oldToken, "sess-1")
		svc.GrantDirect(oldToken, "v1", "")
		// RotateShare 语义：store 换 token 后再回收旧 token
		delete(shares, oldToken)
		shares[newToken] = terminalShare(newToken, "sess-1")
		svc.RevokeDirect(oldToken, "cascade")
		if v, _ := lastGate(sink, "sess-1"); v {
			t.Fatal("old token revoke must release the gate after rotation")
		}
		// 新 token 持权/收回正常（同会话闸可再次翻转）
		svc.GrantDirect(newToken, "v2", "")
		if v, _ := lastGate(sink, "sess-1"); !v {
			t.Fatal("new token grant must re-acquire the gate")
		}
		svc.RevokeDirect(newToken, "owner")
		if v, _ := lastGate(sink, "sess-1"); v {
			t.Fatal("new token revoke must release the gate")
		}
	})

	t.Run("expire", func(t *testing.T) {
		token := fixedToken("gateexp")
		shares, svc, sink := gateEnv(t)
		rec := terminalShare(token, "sess-1")
		shares[token] = rec
		svc.GrantDirect(token, "v1", "")
		// CleanupExpired 语义：记录被清后 CascadeRelease(keep) 回收
		delete(shares, token)
		if n := svc.CascadeRelease(map[string]bool{}); n != 1 {
			t.Fatalf("cascade release = %d, want 1", n)
		}
		if v, _ := lastGate(sink, "sess-1"); v {
			t.Fatal("gate must be released after expire cascade")
		}
		if hold := svc.direct.peek(token); hold != nil {
			t.Fatalf("hold survived cascade: %+v", hold)
		}
	})
}

// TestGateNoPoisonSourceAcrossRecreate 同会话重建分享（终端直播 token 由
// 会话 ID 稳定派生=同一 token）：旧毒 source 不得跨重建存活，重建后
// grant/revoke 照常翻转
func TestGateNoPoisonSourceAcrossRecreate(t *testing.T) {
	token := fixedToken("gatepoison")
	shares, svc, sink := gateEnv(t)
	shares[token] = terminalShare(token, "sess-1")
	svc.GrantDirect(token, "v1", "")

	// 撤销：先删记录再收回（旧实现此时 lookup 失败 → 闸永久滞留）
	delete(shares, token)
	svc.RevokeDirect(token, "cascade")
	if v, _ := lastGate(sink, "sess-1"); v {
		t.Fatal("gate must be released on revoke even with the record gone")
	}
	if srcs := svc.gates.sources(); len(srcs) != 0 {
		t.Fatalf("ledger sources after revoke = %v, want empty (no poison source)", srcs)
	}

	// 重建同会话分享（同 token）→ 授予/收回闭合，无旧状态干扰
	shares[token] = terminalShare(token, "sess-1")
	if h := svc.GrantDirect(token, "v1", ""); h == nil {
		t.Fatal("grant on recreated share must succeed")
	}
	if _, hold := svc.DirectState(token); hold == nil {
		t.Fatal("hold missing after recreated share grant")
	}
	svc.RevokeDirect(token, "owner")
	if v, ok := lastGate(sink, "sess-1"); !ok || v {
		t.Fatalf("gate after recreate revoke = %v/%v, want released", v, ok)
	}
	if srcs := svc.gates.sources(); len(srcs) != 0 {
		t.Fatalf("ledger sources after recreate cycle = %v, want empty", srcs)
	}
}

// TestRevokeDirectReleasesStaleSource 无持权但账本残留 direct 来源
// （ok=false 分支）：也必须幂等释放
func TestRevokeDirectReleasesStaleSource(t *testing.T) {
	token := fixedToken("gatestale")
	shares, svc, sink := gateEnv(t)
	shares[token] = terminalShare(token, "sess-1")
	// 模拟旧实现留下的毒 source（无对应 hold）
	svc.gateAcquire("sess-1", "direct:"+token)
	if v, _ := lastGate(sink, "sess-1"); !v {
		t.Fatal("precondition: stale source must hold the gate")
	}
	if _, ok := svc.RevokeDirect(token, "owner"); ok {
		t.Fatal("no hold should be reported")
	}
	if v, ok := lastGate(sink, "sess-1"); !ok || v {
		t.Fatalf("stale direct source must be released on revoke, got %v/%v", v, ok)
	}
}

// TestGateReleaseKeepsOtherSource 双开关并存：删除/撤销只放 direct，ws 来源
// 仍在场时不得误归还 owner 键盘
func TestGateReleaseKeepsOtherSource(t *testing.T) {
	token := fixedToken("gatedual")
	shares, svc, sink := gateEnv(t)
	shares[token] = terminalShare(token, "sess-1")
	svc.GrantDirect(token, "v1", "")
	svc.gateAcquire("sess-1", "ws:"+token)

	delete(shares, token)
	svc.RevokeDirect(token, "cascade")
	if v, _ := lastGate(sink, "sess-1"); !v {
		t.Fatal("gate must stay while the ws source is present")
	}
	svc.gateReleaseSource("ws:" + token)
	if v, _ := lastGate(sink, "sess-1"); v {
		t.Fatal("gate must release when the last source leaves")
	}
}

// TestFlushReleasedHoldsKeepsOtherTokenSnapshots 记录缺失分支不得整队丢弃
// 其他 token 的惰性回收快照（旧实现 drainReleased 直接丢）
func TestFlushReleasedHoldsKeepsOtherTokenSnapshots(t *testing.T) {
	tokenA, tokenB := fixedToken("gatea"), fixedToken("gateb")
	shares, svc, sink := gateEnv(t)
	shares[tokenA] = terminalShare(tokenA, "sess-a")
	shares[tokenB] = terminalShare(tokenB, "sess-b")
	var released []string
	svc = svc.WithDirectRelease(func(token, sessionID, reason string) {
		released = append(released, token+"|"+sessionID+"|"+reason)
	})
	// 链式 setter 原地改字段返回同一实例——下方 svc 指针即回调接线后的服务
	svc.GrantDirect(tokenA, "va", "")
	svc.GrantDirect(tokenB, "vb", "")
	// tokenB 持权超时（进入 released 快照——一次查询触达即入队）
	svc.direct.mu.Lock()
	h := svc.direct.holds[tokenB]
	h.LastInputAt = time.Now().Add(-11 * time.Minute)
	svc.direct.holds[tokenB] = h
	svc.direct.mu.Unlock()
	if hold := svc.direct.holdOf(tokenB, "sess-b", time.Now()); hold != nil {
		t.Fatalf("tokenB hold should have expired: %+v", hold)
	}
	// tokenA 记录先删（旧实现的记录缺失分支会把 tokenB 的快照丢掉）
	delete(shares, tokenA)
	svc.RevokeDirect(tokenA, "cascade")

	if rel := svc.direct.drainReleased(); len(rel) != 0 {
		t.Fatalf("released snapshots must be drained, got %+v", rel)
	}
	// tokenA 的 cascade 回调之外，tokenB 的 expired 快照必须同样收口
	//（旧实现在记录缺失分支整队丢弃，tokenB 既无回调也无闸释放）
	foundB := false
	for _, r := range released {
		if r == tokenB+"|sess-b|expired" {
			foundB = true
		}
	}
	if !foundB {
		t.Fatalf("released callbacks = %v, want tokenB expired (queue must not be dropped)", released)
	}
	if v, _ := lastGate(sink, "sess-b"); v {
		t.Fatal("tokenB gate must be released by its expired snapshot")
	}
	if v, _ := lastGate(sink, "sess-a"); v {
		t.Fatal("tokenA gate must be released by the revoke")
	}
}

// TestReconcileGates 自愈对账各分支（直接调 reconcileGatesNow 绕节流）
func TestReconcileGates(t *testing.T) {
	t.Run("direct source without hold", func(t *testing.T) {
		token := fixedToken("recon1")
		shares, svc, sink := gateEnv(t)
		shares[token] = terminalShare(token, "sess-1")
		svc.gateAcquire("sess-1", "direct:"+token)
		svc.reconcileGatesNow(time.Now())
		if v, _ := lastGate(sink, "sess-1"); v {
			t.Fatal("direct source without a valid hold must be released")
		}
	})

	t.Run("hold with dead record", func(t *testing.T) {
		token := fixedToken("recon2")
		_, svc, sink := gateEnv(t) // 无记录
		svc.direct.grant(token, "v1", "", "sess-1", time.Now())
		svc.gateAcquire("sess-1", "direct:"+token)
		svc.reconcileGatesNow(time.Now())
		if hold := svc.direct.peek(token); hold != nil {
			t.Fatalf("hold on dead record must be pruned: %+v", hold)
		}
		if v, _ := lastGate(sink, "sess-1"); v {
			t.Fatal("dead-record direct source must be released")
		}
	})

	t.Run("hold with expired record", func(t *testing.T) {
		token := fixedToken("recon3")
		shares, svc, sink := gateEnv(t)
		rec := terminalShare(token, "sess-1")
		rec.ExpiresAt = time.Now().Add(-time.Minute)
		shares[token] = rec
		svc.direct.grant(token, "v1", "", "sess-1", time.Now())
		svc.gateAcquire("sess-1", "direct:"+token)
		svc.reconcileGatesNow(time.Now())
		if hold := svc.direct.peek(token); hold != nil {
			t.Fatalf("hold on expired record must be pruned: %+v", hold)
		}
		if v, _ := lastGate(sink, "sess-1"); v {
			t.Fatal("expired-record direct source must be released")
		}
	})

	t.Run("hold stays while valid", func(t *testing.T) {
		token := fixedToken("recon4")
		shares, svc, sink := gateEnv(t)
		shares[token] = terminalShare(token, "sess-1")
		svc.GrantDirect(token, "v1", "")
		svc.reconcileGatesNow(time.Now())
		if hold := svc.direct.peek(token); hold == nil {
			t.Fatal("valid hold must survive reconcile")
		}
		if v, _ := lastGate(sink, "sess-1"); !v {
			t.Fatal("valid hold's gate must stay set")
		}
	})

	t.Run("stale hold from a previous record generation", func(t *testing.T) {
		token := fixedToken("recon7")
		shares, svc, sink := gateEnv(t)
		// 先有持权（上一代分享），随后记录被删并重建——CreatedAt 晚于授予
		svc.direct.grant(token, "v1", "", "sess-1", time.Now().Add(-time.Minute))
		svc.gateAcquire("sess-1", "direct:"+token)
		rec := terminalShare(token, "sess-1")
		rec.CreatedAt = time.Now()
		shares[token] = rec
		svc.reconcileGatesNow(time.Now())
		if hold := svc.direct.peek(token); hold != nil {
			t.Fatalf("hold predating the record must be pruned: %+v", hold)
		}
		if v, _ := lastGate(sink, "sess-1"); v {
			t.Fatal("stale direct source must be released")
		}
	})

	t.Run("ws source follows open connection count", func(t *testing.T) {
		token := fixedToken("recon5")
		shares, svc, sink := gateEnv(t)
		shares[token] = terminalShare(token, "sess-1")
		c := &writableConn{token: token, sessionID: "sess-1", visitorID: "v1", open: true}
		if _, ok := svc.writable.addConn(c, time.Now()); !ok {
			t.Fatal("add conn failed")
		}
		svc.gateAcquire("sess-1", "ws:"+token)
		svc.reconcileGatesNow(time.Now())
		if v, _ := lastGate(sink, "sess-1"); !v {
			t.Fatal("ws source with an open connection must stay")
		}
		svc.writable.removeConn(c) // 模拟连接断开但 defer 未跑（崩溃窗口）
		svc.reconcileGatesNow(time.Now())
		if v, _ := lastGate(sink, "sess-1"); v {
			t.Fatal("ws source with zero open connections must be released")
		}
	})

	t.Run("transient store error does not release", func(t *testing.T) {
		token := fixedToken("recon6")
		shares := fakeShares{token: terminalShare(token, "sess-1")}
		sink := &fakeWritableSink{}
		svc := NewService(flakyShares{fakeShares: shares, broken: token}, fakeRoots{}, nil).
			WithWritableSink(sink)
		svc.direct.grant(token, "v1", "", "sess-1", time.Now())
		svc.gateAcquire("sess-1", "direct:"+token)
		svc.reconcileGatesNow(time.Now())
		if v, _ := lastGate(sink, "sess-1"); !v {
			t.Fatal("transient store error must not release the gate")
		}
		if hold := svc.direct.peek(token); hold == nil {
			t.Fatal("transient store error must not prune the hold")
		}
	})
}

// TestWritableDownDoesNotReleaseBareWSSource 无连接可断的 WritableDown 不得
// 抢放 ws 来源（Close 前抢放会让访客键入窗口内 owner 键盘提前回位）——
// 残账交 ReconcileGates 兜底
func TestWritableDownDoesNotReleaseBareWSSource(t *testing.T) {
	token := fixedToken("gatedown")
	shares, svc, sink := gateEnv(t)
	shares[token] = terminalShare(token, "sess-1")
	svc.gateAcquire("sess-1", "ws:"+token)
	if down := svc.WritableDown(token, true); down {
		t.Fatal("WritableDown with no connections should be a no-op")
	}
	if v, _ := lastGate(sink, "sess-1"); !v {
		t.Fatal("bare ws source must stay after a no-op WritableDown")
	}
	svc.reconcileGatesNow(time.Now())
	if v, _ := lastGate(sink, "sess-1"); v {
		t.Fatal("reconcile must release the bare ws source")
	}
}

// TestReconcileGatesThrottle ListShares 入口 5s 节流：窗内重复触达不重复
// 对账（ticker 1min 天然不受影响）
func TestReconcileGatesThrottle(t *testing.T) {
	old := gateReconcileMinInterval
	gateReconcileMinInterval = time.Hour
	t.Cleanup(func() { gateReconcileMinInterval = old })

	token := fixedToken("reconthr")
	shares, svc, sink := gateEnv(t)
	shares[token] = terminalShare(token, "sess-1")
	svc.ReconcileGates() // 首次触达：建立节流锚（无残留可放）
	svc.gateAcquire("sess-1", "ws:"+token)
	if v, _ := lastGate(sink, "sess-1"); !v {
		t.Fatal("precondition: bare ws source holds the gate")
	}
	svc.ReconcileGates() // 窗内：不得对账
	if v, _ := lastGate(sink, "sess-1"); !v {
		t.Fatal("throttled call must not release")
	}
	svc.reconcileGatesNow(time.Now()) // 绕节流直调：释放
	if v, _ := lastGate(sink, "sess-1"); v {
		t.Fatal("unthrottled reconcile must release the bare ws source")
	}
}

// TestShareWSHalfOpenTimeout 半开连接 60s（测试注入短窗）读超时收口：
// 读循环退出 → 连接 defer 释放 ws 闸来源
func TestShareWSHalfOpenTimeout(t *testing.T) {
	old := shareWSReadTimeout
	shareWSReadTimeout = 300 * time.Millisecond
	t.Cleanup(func() { shareWSReadTimeout = old })

	token := fixedToken("wshalf")
	srv, svc, _ := writableTestEnv(t, token, true, &fakeWritableSink{})
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/s/" + token + "/termws?visitorId=v1"
	hdr := http.Header{}
	hdr.Set("Origin", url)
	conn, _, err := websocket.DefaultDialer.Dial(url, hdr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	// 不读不 pong（客户端不 ReadMessage 就不会自动回 pong）——半开形态
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if svc.writable.openCountOf(token) == 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("half-open connection not reaped, open conns = %d", svc.writable.openCountOf(token))
}

// TestWritableResizeRevalidated fire 前复核授权物（P-20261122-17）：
// open 需仍有开放连接且记录仍开 Writable；hold 需持权仍绑同一 visitorId
func TestWritableResizeRevalidated(t *testing.T) {
	newResizeEnv := func(t *testing.T) (fakeShares, *Service, *fakeWritableResizer, string) {
		t.Helper()
		token := fixedToken("wrrv")
		shares := fakeShares{token: {
			Token: token, Kind: store.ShareKindTerminal, TerminalID: "sess-1",
			Name: "live", Writable: true,
		}}
		resizer := &fakeWritableResizer{} // deny="" 即准入放行（P-20261122-16 后 fake 以拒绝原因表达）
		svc := NewService(shares, fakeRoots{}, nil).
			WithWritableSink(&fakeWritableSink{}).WithWritableResizer(resizer)
		return shares, svc, resizer, token
	}
	stage := func(svc *Service, token string, st *pendingResize) {
		svc.writable.mu.Lock()
		svc.writable.resizes[token] = st
		svc.writable.mu.Unlock()
	}

	t.Run("open without connection is dropped", func(t *testing.T) {
		_, svc, resizer, token := newResizeEnv(t)
		stage(svc, token, &pendingResize{cols: 100, rows: 30, visitorID: "v1", open: true})
		svc.fireWritableResize(token)
		if got := resizer.got(); len(got) != 0 {
			t.Fatalf("resize applied without open conns: %v", got)
		}
	})

	t.Run("open with Writable off is dropped", func(t *testing.T) {
		shares, svc, resizer, token := newResizeEnv(t)
		shares[token].Writable = false
		c := &writableConn{token: token, sessionID: "sess-1", visitorID: "v1", open: true}
		if _, ok := svc.writable.addConn(c, time.Now()); !ok {
			t.Fatal("add conn failed")
		}
		stage(svc, token, &pendingResize{cols: 100, rows: 30, visitorID: "v1", open: true})
		svc.fireWritableResize(token)
		if got := resizer.got(); len(got) != 0 {
			t.Fatalf("resize applied after Writable off: %v", got)
		}
	})

	t.Run("hold visitor mismatch is dropped", func(t *testing.T) {
		_, svc, resizer, token := newResizeEnv(t)
		svc.direct.grant(token, "v2", "", "sess-1", time.Now())
		stage(svc, token, &pendingResize{cols: 100, rows: 30, visitorID: "v1"})
		svc.fireWritableResize(token)
		if got := resizer.got(); len(got) != 0 {
			t.Fatalf("resize applied for a stale visitor: %v", got)
		}
	})

	t.Run("hold owner revoked is dropped", func(t *testing.T) {
		_, svc, resizer, token := newResizeEnv(t)
		stage(svc, token, &pendingResize{cols: 100, rows: 30, visitorID: "v1"})
		svc.fireWritableResize(token) // 无持权
		if got := resizer.got(); len(got) != 0 {
			t.Fatalf("resize applied without hold: %v", got)
		}
	})

	t.Run("hold still valid applies", func(t *testing.T) {
		_, svc, resizer, token := newResizeEnv(t)
		svc.direct.grant(token, "v1", "", "sess-1", time.Now())
		stage(svc, token, &pendingResize{cols: 100, rows: 30, visitorID: "v1"})
		svc.fireWritableResize(token)
		if got := resizer.got(); len(got) != 1 || got[0] != "100x30" {
			t.Fatalf("valid hold resize = %v, want [100x30]", got)
		}
	})
}

// flakyShares 让单个 token 的记录读取返回瞬时错误（对账不得误放）
type flakyShares struct {
	fakeShares
	broken string
}

func (f flakyShares) Get(token string) (*store.Share, error) {
	if token == f.broken {
		return nil, errors.New("transient store error")
	}
	return f.fakeShares.Get(token)
}
