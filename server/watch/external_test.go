package watch

import (
	"context"
	"strings"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/kernel"
	"codecombo/server/notification"
	"codecombo/server/share"
	"codecombo/server/store"
)

// 敏感外部写入观测单测（P-20261005-15）：模式命中 / 节流 / 自环过滤 / 开关 /
// 相对路径裁剪。判定链出口（audit/notify/enabled/now）全部注入，不依赖真实
// store 装配——观测面无状态泄漏，每个用例独享一个 RepoWatcher

// newExternalHarness 构造带注入出口的观测夹具：p1 → /repo（slash 归一根），
// 时钟拨到固定起点，审计/通知落各自动数组
type externalHarness struct {
	rw      *RepoWatcher
	now     time.Time
	audits  []store.AuditEvent
	notifs  []notification.Notification
	enabled bool
}

func newExternalHarness(t *testing.T) *externalHarness {
	t.Helper()
	h := &externalHarness{rw: &RepoWatcher{}, now: time.Unix(1_000_000, 0), enabled: true}
	h.rw.projIdx = []projIndex{{id: "p1", path: "/repo", len: len("/repo")}}
	h.rw.external.now = func() time.Time { return h.now }
	h.rw.external.enabled = func() bool { return h.enabled }
	h.rw.external.audit = func(e store.AuditEvent) { h.audits = append(h.audits, e) }
	h.rw.external.notify = func(n notification.Notification) { h.notifs = append(h.notifs, n) }
	return h
}

func (h *externalHarness) advance(d time.Duration) { h.now = h.now.Add(d) }

func TestExternalObserve_SensitiveHit(t *testing.T) {
	h := newExternalHarness(t)
	h.rw.observe("p1", "/repo/.env")

	if len(h.audits) != 1 {
		t.Fatalf("sensitive hit should record exactly one audit, got %d", len(h.audits))
	}
	e := h.audits[0]
	if e.Action != store.AuditProjectFileExternal {
		t.Errorf("action = %q, want %q", e.Action, store.AuditProjectFileExternal)
	}
	if e.Result != store.AuditResultSuccess {
		t.Errorf("result = %q, want success", e.Result)
	}
	// Detail 只含项目名 + 相对路径；内容永不如账（这里没有内容可泄，断言形状）
	if e.Detail == "" || !strings.Contains(e.Detail, ".env") {
		t.Errorf("detail should carry rel path, got %q", e.Detail)
	}
	if e.IP != "" {
		t.Errorf("system-observed event should not carry IP, got %q", e.IP)
	}

	if len(h.notifs) != 1 {
		t.Fatalf("sensitive hit should emit exactly one notification, got %d", len(h.notifs))
	}
	n := h.notifs[0]
	if n.Action != "file" || n.ActionPayload != ".env" {
		t.Errorf("notification action = %q/%q, want file/.env", n.Action, n.ActionPayload)
	}
	if n.ProjectID != "p1" {
		t.Errorf("notification projectId = %q, want p1", n.ProjectID)
	}
	if n.TitleKey == "" || n.BodyKey == "" {
		t.Errorf("templated notification should carry title/body keys")
	}
}

func TestExternalObserve_NonSensitiveSkipped(t *testing.T) {
	h := newExternalHarness(t)
	h.rw.observe("p1", "/repo/readme.md")
	if len(h.audits) != 0 || len(h.notifs) != 0 {
		t.Fatalf("non-sensitive path must be silent, got %d audits / %d notifs", len(h.audits), len(h.notifs))
	}
}

func TestExternalObserve_ThrottleSamePathWithinWindow(t *testing.T) {
	h := newExternalHarness(t)
	h.rw.observe("p1", "/repo/.env")
	h.advance(30 * time.Second)
	h.rw.observe("p1", "/repo/.env") // 窗口内同路径：去重
	if len(h.audits) != 1 {
		t.Fatalf("same path within window should dedup, got %d audits", len(h.audits))
	}
	h.advance(31 * time.Second) // 累计 61s > 60s 窗口
	h.rw.observe("p1", "/repo/.env")
	if len(h.audits) != 2 {
		t.Fatalf("same path beyond window should record again, got %d audits", len(h.audits))
	}
}

func TestExternalObserve_ThrottlePerPathAndProject(t *testing.T) {
	h := newExternalHarness(t)
	h.rw.observe("p1", "/repo/.env")
	h.rw.observe("p1", "/repo/config/.env") // 不同路径互不吞记
	h.rw.observe("p1", "/repo/credentials.json")
	if len(h.audits) != 3 {
		t.Fatalf("distinct paths should each record, got %d audits", len(h.audits))
	}
}

func TestExternalObserve_SelfWriteFiltered(t *testing.T) {
	h := newExternalHarness(t)
	// 工作台写入先标记（发布先于落盘的时序由发布侧保证，这里直接驱动标记口）
	h.rw.external.noteSelfWrite("/repo/.env")
	h.rw.observe("p1", "/repo/.env")
	if len(h.audits) != 0 {
		t.Fatalf("self write within TTL must be filtered, got %d audits", len(h.audits))
	}
	// TTL 过后同路径的外部改动照常入账（窗口 5s，拨 6s）
	h.advance(6 * time.Second)
	h.rw.observe("p1", "/repo/.env")
	if len(h.audits) != 1 {
		t.Fatalf("external write after TTL should record, got %d audits", len(h.audits))
	}
}

func TestExternalObserve_SelfWriteTTLExpiry(t *testing.T) {
	h := newExternalHarness(t)
	h.rw.external.noteSelfWrite("/repo/.env")
	h.advance(selfWriteTTL + time.Second)
	if h.rw.external.isSelfWrite("/repo/.env", h.now) {
		t.Fatal("mark should expire after TTL")
	}
}

func TestExternalObserve_SelfWritePathNormalization(t *testing.T) {
	h := newExternalHarness(t)
	// 分隔符显式归一口径：反斜杠事件名与 slash 标记必须互相命中，且判定结果
	// 不随宿主平台漂移（三平台显式一致——显式替换 \，不走 filepath.ToSlash
	// 在 Linux 的恒等路径；share.MatchSensitivePaths 同款先例）
	h.rw.external.noteSelfWrite(`/repo/.env`)
	if !h.rw.external.isSelfWrite(`/repo\.env`, h.now) {
		t.Fatal("backslash event path should hit slash-normalized mark")
	}
}

func TestExternalObserve_Disabled(t *testing.T) {
	h := newExternalHarness(t)
	h.enabled = false
	h.rw.observe("p1", "/repo/.env")
	if len(h.audits) != 0 || len(h.notifs) != 0 {
		t.Fatalf("switch off must silence observation, got %d audits / %d notifs", len(h.audits), len(h.notifs))
	}
}

func TestExternalObserve_UnknownProjectSkipped(t *testing.T) {
	h := newExternalHarness(t)
	h.rw.observe("ghost", "/repo/.env") // 索引无此项目：裁不出相对路径即跳过
	if len(h.audits) != 0 {
		t.Fatalf("unknown project should skip, got %d audits", len(h.audits))
	}
}

func TestExternalRelPath(t *testing.T) {
	cases := []struct {
		root, abs, want string
	}{
		{"/repo", "/repo/.env", ".env"},
		{"/repo", "/repo/config/.env", "config/.env"},
		{"/repo", "/repo-other/.env", ""},   // 前缀相似但非同目录：不裁
		{"/repo", "/repo", ""},              // 事件即项目根本身：跳过
		{"C:/repo", `C:\repo\.env`, ".env"}, // Windows 事件名反斜杠归一
	}
	for _, c := range cases {
		if got := externalRelPath(c.root, c.abs); got != c.want {
			t.Errorf("externalRelPath(%q, %q) = %q, want %q", c.root, c.abs, got, c.want)
		}
	}
}

func TestSensitivePatternReuse(t *testing.T) {
	// 模式表单一事实源对账：share.IsSensitiveName 是分享/补丁导出/本观测共用
	// 的入口，这里钉住代表性模式防表漂移（表本身归属 share 包，勿在 watch 复制）
	for _, name := range []string{".env", ".env.local", "id_rsa", "server.pem", "cred.key", "credentials.json"} {
		if !share.IsSensitiveName(name) {
			t.Errorf("%q should hit shared sensitive patterns", name)
		}
	}
	if share.IsSensitiveName("main.go") || share.IsSensitiveName("environment") {
		t.Error("ordinary source files must not hit")
	}
}

// TestModuleSelfWriteSubscription 总线接线：files 域发布的 file.selfwrite 事件
// 经 Module.Start 的订阅落到观测标记表（生产时序：标记先于落盘，watcher 侧
// 必然可见）
func TestModuleSelfWriteSubscription(t *testing.T) {
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })

	k := kernel.New(nil)
	m := NewModule()
	if err := m.Init(context.Background(), k); err != nil {
		t.Fatalf("init: %v", err)
	}
	if err := m.Start(context.Background(), k); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = m.Stop(context.Background(), k) })

	k.Events().Publish(kernel.Envelope{
		Topic:   "file.selfwrite",
		Payload: map[string]string{"path": "/repo/.env"},
	})
	rw := m.Watcher()
	if rw == nil {
		t.Fatal("watcher should be initialized after Start")
	}
	if !rw.external.isSelfWrite("/repo/.env", time.Now()) {
		t.Fatal("published selfwrite event should mark the path")
	}
}
