package terminal

// P-20261005-234 广播写输入的审计入账：BroadcastWrite 成功路径（HTTP 200）逐次
// 留一条 terminal.broadcast——审批管事前（AgentGuard 428+approvalId）、审计管
// 事后（谁在何时对哪些会话批量写了什么），写侧底账与 queue.send（P-144）对称。
// 覆盖：计数形态矩阵（全成功 / missing+failed 部分成功如实计数 / 全 missing）/
// data 摘要单行化+保守截断 / 脱敏双闸（源头 mask + P-203 Append 兜底）/
// store 未装配静默跳过（审计旁路惯例，主流程零阻断）。

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// seedAuditOnlyStore 装配只含 Audit 仓储的全局 Store（广播 handler 只写 Audit
// 面），测试结束还原（system/health_test seedAuditStore 同款）
func seedAuditOnlyStore(t *testing.T) {
	t.Helper()
	store.SetDefault(&store.Store{Audit: store.NewAuditLogRepo(filestore.New(t.TempDir()))})
	t.Cleanup(func() { store.SetDefault(nil) })
}

// auditEvents 读回当前审计事件（按时间倒序，单测写入量个位数一页装下）
func auditEvents(t *testing.T) []store.AuditEvent {
	t.Helper()
	events, _, err := store.Get().Audit.List(100, 0)
	if err != nil {
		t.Fatalf("list audit events: %v", err)
	}
	return events
}

// testAuditContext 构造带请求的测试 context（auditBroadcast 取 ClientIP 用；
// httptest.NewRequest 缺省 RemoteAddr=192.0.2.1:1234）
func testAuditContext() *gin.Context {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/terminals/broadcast-write", nil)
	return c
}

// TestAuditBroadcastCountMatrix 计数形态矩阵：targets = 去重后目标数 =
// written+missing+failed，三形态逐字段如实回账（部分成功不美化、全 missing
// 不虚报成功数——「某会话被批量执行了什么」的追溯凭据就在这三个数上）
func TestAuditBroadcastCountMatrix(t *testing.T) {
	seedAuditOnlyStore(t)
	c := testAuditContext()

	cases := []struct {
		name   string
		data   string
		res    terminal.BroadcastResult
		detail string
	}{
		// 尾部 \r 经摘要折叠+TrimSpace 不入账（单行化纪律，见 broadcastDataBrief）
		{"all written", "uptime\r", terminal.BroadcastResult{Written: 3},
			"targets=3 written=3 missing=0 failed=0 data=uptime"},
		{"partial success", "make test\r", terminal.BroadcastResult{Written: 1, Missing: []string{"ghost"}, Failed: []string{"dead"}},
			"targets=3 written=1 missing=1 failed=1 data=make test"},
		{"all missing", "echo hi\r", terminal.BroadcastResult{Missing: []string{"ghost-a", "ghost-b"}},
			"targets=2 written=0 missing=2 failed=0 data=echo hi"},
	}
	for i, tc := range cases {
		auditBroadcast(c, tc.data, tc.res)
		events := auditEvents(t)
		if len(events) != i+1 {
			t.Fatalf("%s: event count = %d, want %d", tc.name, len(events), i+1)
		}
		ev := events[0]
		if ev.Action != store.AuditTerminalBroadcast {
			t.Errorf("%s: action = %q", tc.name, ev.Action)
		}
		if ev.Result != store.AuditResultSuccess {
			t.Errorf("%s: result = %q", tc.name, ev.Result)
		}
		if ev.IP == "" {
			t.Errorf("%s: IP must be recorded", tc.name)
		}
		if ev.Detail != tc.detail {
			t.Errorf("%s: detail = %q, want %q", tc.name, ev.Detail, tc.detail)
		}
	}
}

// TestAuditBroadcastDataBrief 摘要三纪律：控制字符折叠单行（\r 是命令执行的
// 原生形态，不折叠则审计面板/CSV 出多行脏账）、80 rune 保守截断、脱敏双闸
// （源头 MaskApprovalText 遮已知前缀令牌；P-203 Append 层 MaskAuditDetail 遮
// 赋值形态——broadcastDataBrief 未做赋值形态正是软关联设计的实测点）
func TestAuditBroadcastDataBrief(t *testing.T) {
	seedAuditOnlyStore(t)
	c := testAuditContext()

	// 赋值形态密钥：P-203 Append 层兜底遮蔽（值段 → ***，键名保留）
	auditBroadcast(c, "export DB_PASSWORD=\"sup3rs3cret-value\"\r\n", terminal.BroadcastResult{Written: 1})
	// 已知前缀令牌：源头 MaskApprovalText 遮蔽（前缀+尾 4 可对账不可重放）
	auditBroadcast(c, `curl -s -H "Authorization: Bearer sk-abcdef1234567890abcdef" https://api.example.com`, terminal.BroadcastResult{Written: 1})
	// 100 rune 中文超长截断：80 rune + 省略号
	auditBroadcast(c, strings.Repeat("字", 100), terminal.BroadcastResult{Written: 1})

	events := auditEvents(t)
	if len(events) != 3 {
		t.Fatalf("event count = %d, want 3", len(events))
	}
	detail := events[2].Detail // 最新在前（List 倒序）：首笔 DB_PASSWORD 赋值
	if strings.ContainsAny(detail, "\r\n") || strings.Contains(detail, "sup3rs3cret-value") {
		t.Fatalf("detail must be single-line and secret-free: %q", detail)
	}
	if !strings.Contains(detail, `DB_PASSWORD=***`) {
		t.Fatalf("assignment form must be masked by P-203 append guard: %q", detail)
	}

	detail = events[1].Detail // 次笔 sk- 前缀令牌
	if !strings.Contains(detail, "sk-***cdef") || strings.Contains(detail, "abcdef1234567890abcdef") {
		t.Fatalf("known-prefix token must be masked at source: %q", detail)
	}

	detail = events[0].Detail // 末笔超长截断
	want := "data=" + strings.Repeat("字", 80) + "…"
	if !strings.HasSuffix(detail, want) {
		t.Fatalf("brief must truncate at 80 runes: %q", detail)
	}
}

// TestBroadcastWriteAuditHTTP HTTP 面一次请求恰一条事件：单测进程 DefaultManager
// 无会话，全量 id 走 missing——审计与响应回告同刻同口径（targets 对得上 missing）
func TestBroadcastWriteAuditHTTP(t *testing.T) {
	seedAuditOnlyStore(t)
	w := postBroadcast(setupBroadcastRouter(), `{"ids":["ghost-a","ghost-b"],"data":"echo hi\r"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
	events := auditEvents(t)
	if len(events) != 1 {
		t.Fatalf("event count = %d, want 1", len(events))
	}
	if events[0].Action != store.AuditTerminalBroadcast ||
		events[0].Detail != "targets=2 written=0 missing=2 failed=0 data=echo hi" {
		t.Fatalf("unexpected event: %+v", events[0])
	}
}

// TestBroadcastWriteAuditNoStore store 未装配（单测/测试清理竞态）：静默跳过
// 不 panic、广播主流程零阻断——审计旁路惯例（auditReplace 同款守卫）
func TestBroadcastWriteAuditNoStore(t *testing.T) {
	store.SetDefault(nil)
	t.Cleanup(func() { store.SetDefault(nil) })
	w := postBroadcast(setupBroadcastRouter(), `{"ids":["ghost-a"],"data":"x\r"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}
}
