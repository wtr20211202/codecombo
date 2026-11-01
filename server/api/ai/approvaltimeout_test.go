package ai

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/api/opschannel"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// setupSweepTest 审批超时清扫用例环境：独立 filestore + 观测 approval.resolved
// 广播（载荷为 gin.H，同 TestAgentApproval_DenyReason 惯例）。TTL 配置由各用例
// 经 settings 活指针写入（Get 返回缓存指针，改字段即对后续读生效）
func setupSweepTest(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := gin.New()
	r.POST("/api/ops-confirm", CreateAgentApproval)
	r.GET("/api/ops-confirm/:id", GetAgentApproval)
	r.POST("/api/ops-confirm/:id/resolve", ResolveAgentApproval)
	return r
}

// setSweepTTL 注入超时分钟数（0=不限）
func setSweepTTL(t *testing.T, mins int) {
	t.Helper()
	cfg := store.Get().Settings.Get()
	if cfg == nil {
		t.Fatal("settings not assembled")
	}
	cfg.Server.AgentApprovalTimeoutMin = mins
}

// seedApprovalWithAge 直写一条指定年龄的 pending 审批（绕过 HTTP，控制 CreatedAt）
func seedApprovalWithAge(t *testing.T, sessionID string, age time.Duration) store.AgentApproval {
	t.Helper()
	a := store.AgentApproval{
		ID:        store.NewAgentApprovalID(),
		SessionID: sessionID,
		Agent:     "claude",
		Op:        "reset --hard",
		Target:    "main",
		Status:    store.ApprovalPending,
		CreatedAt: time.Now().Add(-age),
	}
	if err := store.Get().AgentApproval.Save(a); err != nil {
		t.Fatal(err)
	}
	return a
}

func pollSweepStatus(t *testing.T, r *gin.Engine, id string) (string, string) {
	t.Helper()
	w := doJSON(r, http.MethodGet, "/api/ops-confirm/"+id, "")
	if w.Code != http.StatusOK {
		t.Fatalf("poll status = %d, body=%s", w.Code, w.Body.String())
	}
	var got struct {
		Data struct {
			Status string `json:"status"`
			Reason string `json:"reason"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	return got.Data.Status, got.Data.Reason
}

// TestApprovalTimeout_ExpiredDenied 到期 deny：pending 超时 → denied + 超时
// 理由（P-21 通道原文）+ ResolvedAt 落账；恰在 TTL 边界即到期（>=）；未到期
// 与非 pending 不受扫描影响
func TestApprovalTimeout_ExpiredDenied(t *testing.T) {
	r := setupSweepTest(t)
	setSweepTTL(t, 30)
	expired := seedApprovalWithAge(t, "sc-ttl-expired", 30*time.Minute)
	fresh := seedApprovalWithAge(t, "sc-ttl-fresh", 5*time.Minute)

	if n := sweepExpiredApprovals(time.Now()); n != 1 {
		t.Fatalf("sweep denied = %d, want 1", n)
	}
	status, reason := pollSweepStatus(t, r, expired.ID)
	if status != store.ApprovalDenied || reason != approvalTimeoutReason {
		t.Fatalf("expired expect denied+%q, got %s/%q", approvalTimeoutReason, status, reason)
	}
	stored, err := store.Get().AgentApproval.Get(expired.ID)
	if err != nil || stored.ResolvedAt == nil {
		t.Fatalf("resolvedAt not persisted: %v %v", stored, err)
	}

	status, _ = pollSweepStatus(t, r, fresh.ID)
	if status != store.ApprovalPending {
		t.Fatalf("fresh expect still pending, got %s", status)
	}

	// 已 allowed 的过期记录不被改写（终态不动）
	done := seedApprovalWithAge(t, "sc-ttl-done", time.Hour)
	done.Status = store.ApprovalAllowed
	now := time.Now()
	done.ResolvedAt = &now
	if err := store.Get().AgentApproval.Save(done); err != nil {
		t.Fatal(err)
	}
	if n := sweepExpiredApprovals(time.Now()); n != 0 {
		t.Fatalf("resolved records must be untouched, denied = %d", n)
	}
}

// TestApprovalTimeout_BroadcastAndNotification 广播与通知入账：approval.resolved
// 与用户裁决同载荷形状；通知 warning/system 带 titleKey/bodyKey 模板与跳转发起
// 会话的 terminal Action（无 sessionId 时省略 Action）
func TestApprovalTimeout_BroadcastAndNotification(t *testing.T) {
	setupSweepTest(t)
	setSweepTTL(t, 30)

	var broadcast gin.H
	unsub := opschannel.AddObserver(func(ev opschannel.Event) {
		if ev.Type == "approval.resolved" {
			if m, ok := ev.Payload.(gin.H); ok {
				broadcast = m
			}
		}
	})
	defer unsub()

	a := seedApprovalWithAge(t, "sc-ttl-broadcast", 31*time.Minute)
	if n := sweepExpiredApprovals(time.Now()); n != 1 {
		t.Fatalf("sweep denied = %d, want 1", n)
	}
	if broadcast == nil || broadcast["id"] != a.ID || broadcast["status"] != store.ApprovalDenied ||
		broadcast["sessionId"] != "sc-ttl-broadcast" || broadcast["reason"] != approvalTimeoutReason {
		t.Fatalf("broadcast payload mismatch: %v", broadcast)
	}

	list := store.Get().Notification.List(0)
	if len(list) != 1 {
		t.Fatalf("expect 1 notification, got %d", len(list))
	}
	n := list[0]
	if n.TitleKey != approvalTimeoutTitleKey || n.BodyKey != approvalTimeoutBodyKey ||
		n.Action != "terminal" || n.ActionPayload != "sc-ttl-broadcast" {
		t.Fatalf("notification mismatch: %+v", n)
	}
	// 发起方运行时透传（P-20261003-187）：通知记录带 runtime 供前端过滤 chips
	//（seedApprovalWithAge 播种 Agent=claude）
	if n.Runtime != "claude" {
		t.Fatalf("notification runtime = %q, want claude", n.Runtime)
	}

	// 无发起会话：Action 省略（无跳转落点）
	b := seedApprovalWithAge(t, "", 31*time.Minute)
	sweepExpiredApprovals(time.Now())
	list = store.Get().Notification.List(0)
	if len(list) != 2 || list[0].Action != "" || list[0].ActionPayload != "" {
		t.Fatalf("sessionless approval expect no action, got %+v", list)
	}
	_ = b
}

// TestApprovalTimeout_DefaultZeroNoop 默认 0=不限：存量行为不变——TTL 未配置
// 时扫描零改写（含已过期的 pending）
func TestApprovalTimeout_DefaultZeroNoop(t *testing.T) {
	r := setupSweepTest(t)
	setSweepTTL(t, 0)
	a := seedApprovalWithAge(t, "sc-ttl-off", 48*time.Hour)

	if n := sweepExpiredApprovals(time.Now()); n != 0 {
		t.Fatalf("ttl=0 must be noop, denied = %d", n)
	}
	status, _ := pollSweepStatus(t, r, a.ID)
	if status != store.ApprovalPending {
		t.Fatalf("ttl=0 expect still pending, got %s", status)
	}
	if approvalExpired(a, 0, time.Now()) {
		t.Fatal("approvalExpired must be false when ttl disabled")
	}
}

// TestApprovalTimeout_RaceIdempotent 裁决竞态幂等（后到者跳过）：
// a) 用户先裁决 → 清扫幂等跳过（终态保持用户裁决结果）
// b) 清扫先 deny → 用户裁决 409（既有「仅 pending 可裁决」约束）
func TestApprovalTimeout_RaceIdempotent(t *testing.T) {
	r := setupSweepTest(t)
	setSweepTTL(t, 30)

	// a) 用户先 allowed，随后到期的它不再被扫描改写
	a := seedApprovalWithAge(t, "sc-race-user-first", time.Hour)
	w := doJSON(r, http.MethodPost, "/api/ops-confirm/"+a.ID+"/resolve", `{"allow":true}`)
	if w.Code != http.StatusOK {
		t.Fatalf("user resolve status = %d", w.Code)
	}
	if n := sweepExpiredApprovals(time.Now()); n != 0 {
		t.Fatalf("sweep must skip resolved, denied = %d", n)
	}
	if status, _ := pollSweepStatus(t, r, a.ID); status != store.ApprovalAllowed {
		t.Fatalf("user verdict overwritten: %s", status)
	}

	// b) 清扫先 deny（到期），用户后裁决 → 409
	b := seedApprovalWithAge(t, "sc-race-sweep-first", time.Hour)
	if n := sweepExpiredApprovals(time.Now()); n != 1 {
		t.Fatalf("sweep denied = %d, want 1", n)
	}
	w = doJSON(r, http.MethodPost, "/api/ops-confirm/"+b.ID+"/resolve", `{"allow":true}`)
	if w.Code != http.StatusConflict {
		t.Fatalf("late user resolve status = %d, want 409", w.Code)
	}
	if status, reason := pollSweepStatus(t, r, b.ID); status != store.ApprovalDenied || reason != approvalTimeoutReason {
		t.Fatalf("sweep verdict overwritten: %s/%q", status, reason)
	}
}

// TestApprovalTimeout_SweepOnCreate 创建触发同步清扫（入队先清场）：直写过期
// pending 后经 POST /api/ops-confirm 创建新审批，旧记录被顺带置 denied——
// e2e「注入到期」的确定性触发点
func TestApprovalTimeout_SweepOnCreate(t *testing.T) {
	r := setupSweepTest(t)
	setSweepTTL(t, 30)
	expired := seedApprovalWithAge(t, "sc-ttl-oncreate", 32*time.Minute)

	w := doJSON(r, http.MethodPost, "/api/ops-confirm",
		`{"sessionId":"sc-ttl-new","op":"push --force","target":"main"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("create status = %d, body=%s", w.Code, w.Body.String())
	}
	status, reason := pollSweepStatus(t, r, expired.ID)
	if status != store.ApprovalDenied || reason != approvalTimeoutReason {
		t.Fatalf("expired expect denied on create, got %s/%q", status, reason)
	}
	// 新审批本身正常 pending
	var created struct {
		Data struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Data.Status != store.ApprovalPending {
		t.Fatalf("new approval expect pending, got %s", created.Data.Status)
	}
}
