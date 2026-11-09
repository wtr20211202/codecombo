package shareapi

// 终端输出冻结分享（P-20261005-205）的管理面单测：创建校验（happy path 走
// 定向 e2e，单测不拉真 PTY 进程）、净化链纪律（遮蔽先于哈希/落盘）、快照
// 目录派生（rotate 换链目录不动）、孤儿对账 keep 集覆盖（本形态的生命线——
// 不进 keep 集会被当孤儿误删）。

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/share"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// TestCreateTerminalFrozenValidation 创建校验：404 未知会话、400 缺 sessionId
func TestCreateTerminalFrozenValidation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := gin.New()
	r.POST("/api/share/terminal-frozen", CreateTerminalFrozen)

	post := func(body string) int {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/share/terminal-frozen", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)
		return w.Code
	}

	// 未知会话 → 404（无可定格的源，不建空快照记录）
	if code := post(`{"sessionId":"no-such-session"}`); code != http.StatusNotFound {
		t.Fatalf("unknown session status = %d, want 404", code)
	}
	// 缺 sessionId → 400（binding required）
	if code := post(`{}`); code != http.StatusBadRequest {
		t.Fatalf("missing sessionId status = %d, want 400", code)
	}
}

// TestSanitizeTermFrozenOutput 净化链纪律（纯函数锁序）：剥 ANSI → 敏感值
// 遮蔽 → 哈希。遮蔽必须先于哈希——快照身份与内容都是净化后形态
func TestSanitizeTermFrozenOutput(t *testing.T) {
	raw := []byte("\x1b[32m$ export CC_LOCK_TOKEN=scl_deadbeef001\x1b[0m\r\n" +
		"password=\"hunter2\"\r\nAKIAABCDEFGHIJKLMNOP\r\n")
	masked, hash := sanitizeTermFrozenOutput(raw, false)

	// ANSI 序列剥除（净化文本无转义字节）
	if strings.ContainsRune(masked, 0x1b) {
		t.Fatalf("masked output still contains ANSI escapes: %q", masked)
	}
	// 三族敏感形态全部 *** 替换（P-108 同源模式表），本体零残留
	for _, secret := range []string{"scl_deadbeef001", "hunter2", "AKIAABCDEFGHIJKLMNOP"} {
		if strings.Contains(masked, secret) {
			t.Fatalf("masked output leaks %q: %q", secret, masked)
		}
	}
	if !strings.Contains(masked, "***") {
		t.Fatalf("masked output lacks *** placeholders: %q", masked)
	}
	// 哈希 = 净化文本的 sha256 hex（64 位）；同输入恒同哈希（幂等定格同链的根基）
	if len(hash) != 64 {
		t.Fatalf("hash len = %d, want 64 hex chars", len(hash))
	}
	if _, hash2 := sanitizeTermFrozenOutput(raw, false); hash2 != hash {
		t.Fatalf("hash not deterministic: %s vs %s", hash, hash2)
	}
	// 输入不同（净化后内容不同）→ 哈希不同（不同输出不得共用一条链）
	if _, hash3 := sanitizeTermFrozenOutput([]byte("other output"), false); hash3 == hash {
		t.Fatal("different content must derive different hash")
	}
}

// TestSanitizeTermFrozenOutputUnfiltered 未过滤模式（P-20261106-9 显式 opt-out）：
// 只剥 ANSI、敏感值原样保留（内网协作原样输出）；哈希走域分离——即便输出
// 不含任何敏感值（两模式落盘字节全等），遮蔽/未过滤两条快照也恒不同链，
// 幂等定位不会把「请求未过滤」落到既有遮蔽记录上（或反之）；同输入确定性
func TestSanitizeTermFrozenOutputUnfiltered(t *testing.T) {
	raw := []byte("\x1b[32m$ export CC_LOCK_TOKEN=scl_deadbeef001\x1b[0m\r\npassword=\"hunter2\"\r\n")
	text, hash := sanitizeTermFrozenOutput(raw, true)
	if strings.ContainsRune(text, 0x1b) {
		t.Fatalf("unfiltered output must still strip ANSI (render purification is orthogonal): %q", text)
	}
	for _, secret := range []string{"scl_deadbeef001", "hunter2"} {
		if !strings.Contains(text, secret) {
			t.Fatalf("unfiltered output must keep %q verbatim: %q", secret, text)
		}
	}
	if _, again := sanitizeTermFrozenOutput(raw, true); again != hash {
		t.Fatal("unfiltered hash not deterministic")
	}
	if _, maskedHash := sanitizeTermFrozenOutput(raw, false); maskedHash == hash {
		t.Fatal("unfiltered and masked snapshots of sensitive output must not share a link")
	}
	// 无敏感值：两模式净化文本全等，哈希仍须不同（域分离）
	plain := []byte("build ok\r\n")
	pText, pHash := sanitizeTermFrozenOutput(plain, true)
	mText, mHash := sanitizeTermFrozenOutput(plain, false)
	if pText != mText {
		t.Fatalf("plain output differs between modes: %q vs %q", pText, mText)
	}
	if pHash == mHash {
		t.Fatal("hash must be domain-separated by mode even for byte-identical content")
	}
}

// TestShareResponseUnfilteredProjection 管理面投影（P-20261106-9）：未过滤记录
// 恒携 unfiltered:true（列表徽标/结果卡标注数据源）；遮蔽记录不携带（存量
// 零迁移语义——缺省即已遮蔽）
func TestShareResponseUnfilteredProjection(t *testing.T) {
	on := shareResponse(store.Share{Token: "t1", Kind: store.ShareKindTermFrozen, Unfiltered: true})
	if v, ok := on["unfiltered"]; !ok || v != true {
		t.Fatalf("unfiltered record must project unfiltered:true, got %v", on["unfiltered"])
	}
	off := shareResponse(store.Share{Token: "t2", Kind: store.ShareKindTerminal})
	if _, ok := off["unfiltered"]; ok {
		t.Fatal("masked record must omit the unfiltered projection")
	}
}

// TestTermFrozenDirOfAndGc 快照目录派生 + 孤儿对账 keep 集：
// DirOf 从记录字段（TerminalID+ContentHash）重算目录名——rotate 迁键后
// 仍命中同一目录；gcFrozenOrphans 的 keep 集必须覆盖本形态（不进 keep
// 即被当孤儿清掉——记录存活、快照被误删的坏链事故）
func TestTermFrozenDirOfAndGc(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	st := store.New(filestore.New(filepath.Join(t.TempDir(), "docs")))
	resolver := snapshotResolver{}

	native := store.TermFrozenNativeToken(config.MasterKey(), "term-a", "hash-1")
	if err := share.WriteTermFrozenSnapshot(native, []byte("net\n")); err != nil {
		t.Fatalf("seed snapshot: %v", err)
	}

	// 记录在 + 副本在盘 → DirOf 命中快照目录（位于 SnapshotsRoot 隔离区）
	sh, err := st.Share.Create(store.Share{Kind: store.ShareKindTermFrozen, TerminalID: "term-a", ContentHash: "hash-1"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	dir, err := resolver.DirOf(sh)
	if err != nil {
		t.Fatalf("DirOf: %v", err)
	}
	if want := filepath.Join(share.SnapshotsRoot(), native); dir != want {
		t.Fatalf("DirOf = %s, want %s", dir, want)
	}

	// rotate 迁键：记录 token 变化，目录派生锚是零代际值 → 同一目录
	rot, err := st.Share.Rotate(sh.Token)
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	dir2, err := resolver.DirOf(rot)
	if err != nil {
		t.Fatalf("DirOf after rotate: %v", err)
	}
	if dir2 != dir {
		t.Fatalf("DirOf after rotate = %s, want same dir %s", dir2, dir)
	}

	// gc keep 集覆盖：存活记录（含已轮换）的快照在对账后原地存活
	if removed, err := share.GcOrphanSnapshots(keepSetForGc(st)); err != nil {
		t.Fatalf("gc: %v", err)
	} else if removed != 0 {
		t.Fatalf("gc removed = %d, want 0 (alive record's snapshot must survive)", removed)
	}
	if !share.HasTermFrozenSnapshot(native) {
		t.Fatal("gc must keep term-frozen snapshot of alive record")
	}

	// 记录撤销后：keep 集不再包含 → 对账清掉快照（TTL 清理通道的兜底路径）
	if err := st.Share.Delete(rot.Token); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if removed, err := share.GcOrphanSnapshots(keepSetForGc(st)); err != nil {
		t.Fatalf("gc after revoke: %v", err)
	} else if removed != 1 {
		t.Fatalf("gc removed = %d, want 1 (orphan swept)", removed)
	}
	if share.HasTermFrozenSnapshot(native) {
		t.Fatal("gc must sweep term-frozen snapshot of revoked record")
	}
}

// keepSetForGc 复用 module.go 的 keep 集构建逻辑（gcFrozenOrphans 的 List 失败
// 路径无关本测试，直接以存活记录重算）
func keepSetForGc(st *store.Store) map[string]bool {
	shares, err := st.Share.List()
	if err != nil {
		return nil
	}
	keep := make(map[string]bool)
	for _, s := range shares {
		switch {
		case s.Kind == store.ShareKindFile && s.Frozen && s.ProjectID != "":
			keep[store.FrozenNativeToken(config.MasterKey(), s.ProjectID, s.Path)] = true
		case s.Kind == store.ShareKindTermFrozen && s.TerminalID != "" && s.ContentHash != "":
			keep[store.TermFrozenNativeToken(config.MasterKey(), s.TerminalID, s.ContentHash)] = true
		}
	}
	return keep
}

// TestGcFrozenOrphansCoversTermFrozen 直接锁 gcFrozenOrphans 的 keep 集分支
// （上面的 keepSetForGc 是本测试的镜像实现——若 module.go 的 gcFrozenOrphans
// 漏扩 terminal-frozen，本测试经真实目录存亡翻红）
func TestGcFrozenOrphansCoversTermFrozen(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	st := store.New(filestore.New(filepath.Join(t.TempDir(), "docs")))
	native := store.TermFrozenNativeToken(config.MasterKey(), "term-gc", "h")
	if err := share.WriteTermFrozenSnapshot(native, []byte("x")); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := st.Share.Create(store.Share{Kind: store.ShareKindTermFrozen, TerminalID: "term-gc", ContentHash: "h"}); err != nil {
		t.Fatalf("create: %v", err)
	}
	gcFrozenOrphans(st, slog.Default())
	if !share.HasTermFrozenSnapshot(native) {
		t.Fatal("gcFrozenOrphans must keep term-frozen snapshot of alive record (missing keep-set branch)")
	}
	// 消亡记录的快照被同一轮对账扫走（时间不倒流的验证口径：删除记录后重跑）
	shares, _ := st.Share.List()
	for _, s := range shares {
		_ = st.Share.Delete(s.Token)
	}
	gcFrozenOrphans(st, slog.Default())
	if share.HasTermFrozenSnapshot(native) {
		t.Fatal("gcFrozenOrphans must sweep term-frozen snapshot with no alive record")
	}
}
