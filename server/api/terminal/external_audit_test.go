package terminal

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// 外部会话接管/显式终结的审计留痕（P-20261008-16）单测。两动作的 handler 级
// 集成依赖 tmux 后端与存活外部会话（AttachExternalSession 需真实 attach），
// Windows 单测形态不可得——事件形态由本文件的 helper 级断言覆盖，handler 分流
// 集成（接管→takeover 条目、kill=1→kill 条目、close 释放无条目）由 Linux e2e
// terminal-external-tmux.spec.ts 覆盖；此处仅覆盖 handler 的「会话不存在」形态
// （DefaultManager 查无会话即零入账，无需任何后端）。

// fakeExternalSession 构造审计断言用的外部会话值（Session 字段全导出，无需
// 后端接线；外部会话 id=tmux 会话名的落账形态见 AttachExternalSession）
func fakeExternalSession(id, name string) *terminal.Session {
	return &terminal.Session{ID: id, Name: name, Origin: terminal.OriginExternal}
}

// externalAuditContext 带 id 路由参数的测试 context（CloseTerminal 取 Param 用）
func externalAuditContext(id string) *gin.Context {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodDelete, "/api/terminals/"+id, nil)
	c.Params = gin.Params{{Key: "id", Value: id}}
	return c
}

// TestAuditExternalTakeoverEventShape 接管入账形态：动作常量、成功结果、操作者
// IP 走 AuditEvent.IP 惯例字段，Detail = 显示名 + tmux 会话名（跨接管的稳定锚点）
// + origin=external，全语言中立元数据
func TestAuditExternalTakeoverEventShape(t *testing.T) {
	seedAuditOnlyStore(t)
	c := testAuditContext()

	auditTakeover(c, fakeExternalSession("ext-sess", "训练任务"), "tmux-job-1")

	events := auditEvents(t)
	if len(events) != 1 {
		t.Fatalf("expected exactly 1 audit event, got %d", len(events))
	}
	ev := events[0]
	if ev.Action != store.AuditTerminalExternalTakeover {
		t.Errorf("action = %q, want %q", ev.Action, store.AuditTerminalExternalTakeover)
	}
	if ev.Result != store.AuditResultSuccess {
		t.Errorf("result = %q, want %q", ev.Result, store.AuditResultSuccess)
	}
	if ev.IP == "" {
		t.Errorf("IP empty: operator IP must ride the AuditEvent.IP field per convention")
	}
	want := "name=训练任务 tmux=tmux-job-1 origin=external"
	if ev.Detail != want {
		t.Errorf("detail = %q, want %q", ev.Detail, want)
	}
}

// TestAuditExternalKillEventShape 终结入账形态：动作常量、成功结果、IP 惯例，
// Detail = 显示名 + tmux 会话名（外部会话 id 即 tmux 会话名）
func TestAuditExternalKillEventShape(t *testing.T) {
	seedAuditOnlyStore(t)
	c := testAuditContext()

	auditExternalKill(c, fakeExternalSession("tmux-job-2", "遗留构建"))

	events := auditEvents(t)
	if len(events) != 1 {
		t.Fatalf("expected exactly 1 audit event, got %d", len(events))
	}
	ev := events[0]
	if ev.Action != store.AuditTerminalExternalKill {
		t.Errorf("action = %q, want %q", ev.Action, store.AuditTerminalExternalKill)
	}
	if ev.Result != store.AuditResultSuccess {
		t.Errorf("result = %q, want %q", ev.Result, store.AuditResultSuccess)
	}
	if ev.IP == "" {
		t.Errorf("IP empty: operator IP must ride the AuditEvent.IP field per convention")
	}
	if want := "name=遗留构建 tmux=tmux-job-2"; ev.Detail != want {
		t.Errorf("detail = %q, want %q", ev.Detail, want)
	}
}

// TestAuditExternalKillNilSession 零入账形态：s=nil（自建会话关闭/会话已不存在）
// 恒不入账——close 普通分流（解除接管）与自建会话 kill=1（与普通 close 等价的
// 例行操作）不产生 terminal.external.kill 台账噪声
func TestAuditExternalKillNilSession(t *testing.T) {
	seedAuditOnlyStore(t)
	c := testAuditContext()

	auditExternalKill(c, nil)

	if events := auditEvents(t); len(events) != 0 {
		t.Fatalf("nil session must not audit, got %d events", len(events))
	}
}

// TestAuditExternalStoreNotSeededNoPanic store 未装配（裸单测形态）静默跳过——
// 审计旁路惯例（auditBroadcast 同款），绝不阻断接管/关闭主流程
func TestAuditExternalStoreNotSeededNoPanic(t *testing.T) {
	// 不 seed store：store.Get() 为 nil 的形态由两 helper 的旁路分支承接
	auditTakeover(testAuditContext(), fakeExternalSession("ext", "x"), "tmux-x")
	auditExternalKill(testAuditContext(), fakeExternalSession("tmux-x", "x"))
}

// TestCloseTerminalUnknownSessionNoAudit handler 分流的「会话不存在」形态：
// kill=1 与缺省 close 对查无会话的 id 均零入账（DefaultManager 无需任何后端）
func TestCloseTerminalUnknownSessionNoAudit(t *testing.T) {
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })

	force := externalAuditContext("no-such-session")
	force.Request.URL.RawQuery = "kill=1"
	CloseTerminal(force)

	def := externalAuditContext("no-such-session")
	CloseTerminal(def)

	if events := auditEvents(t); len(events) != 0 {
		t.Fatalf("unknown session must not audit, got %d events", len(events))
	}
}
