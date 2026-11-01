package ai

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/api/opschannel"
	"codecombo/server/config"
	"codecombo/server/notification"
	"codecombo/server/store"
)

// 审批分类规则接线（P-20261003-35）：CreateAgentApproval 按规则裁决——
// allow 命中同 allow 模式直落库（不广播）、deny 命中直接 denied 落库 + 广播
// 终态（带 ruleHit）、ask 命中/无规则走现卡流

// setRules 写规则表进 settings（测试直接改内存 settings，Save 落盘到临时目录）
func setRules(t *testing.T, rules []config.AgentApprovalRule) {
	t.Helper()
	cfg := store.Get().Settings.Get()
	cfg.Server.AgentApprovalRules = rules
	if err := store.Get().Settings.Save(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cfg.Server.AgentApprovalRules = nil })
}

// subscribeResolved 订阅 approval.resolved 广播（观测 deny 终态载荷）
func subscribeResolved(t *testing.T) *gin.H {
	t.Helper()
	var broadcast gin.H
	opschannel.AddObserver(func(ev opschannel.Event) {
		if ev.Type == "approval.resolved" {
			if m, ok := ev.Payload.(gin.H); ok {
				broadcast = m
			}
		}
	})
	return &broadcast
}

func TestAgentApprovalRules_Deny(t *testing.T) {
	r := setupApprovalTest(t)
	setRules(t, []config.AgentApprovalRule{{OpPattern: "reset", Effect: config.ApprovalEffectDeny}})
	broadcast := subscribeResolved(t)

	// deny 命中：创建即 denied，无 pending 可裁决（重复裁决路径不存在）
	w := doJSON(r, http.MethodPost, "/api/ops-confirm", `{"sessionId":"sc-rules-deny","op":"reset --hard HEAD"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("create status = %d, body=%s", w.Code, w.Body.String())
	}
	var created struct {
		Data struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Data.Status != store.ApprovalDenied {
		t.Fatalf("expect denied, got %s", created.Data.Status)
	}

	// 记录带 ruleHit 留审计
	stored, err := store.Get().AgentApproval.Get(created.Data.ID)
	if err != nil || stored == nil {
		t.Fatal(err)
	}
	if stored.RuleHit != "reset" || stored.Status != store.ApprovalDenied || stored.ResolvedAt == nil {
		t.Fatalf("stored expect denied + ruleHit + resolvedAt, got %+v", stored)
	}

	// 轮询响应携带 ruleHit（agent 据此理解拒绝原因）
	w = doJSON(r, http.MethodGet, "/api/ops-confirm/"+created.Data.ID, "")
	var poll struct {
		Data struct {
			Status  string `json:"status"`
			RuleHit string `json:"ruleHit"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &poll); err != nil {
		t.Fatal(err)
	}
	if poll.Data.Status != store.ApprovalDenied || poll.Data.RuleHit != "reset" {
		t.Fatalf("poll expect denied + ruleHit, got %+v", poll.Data)
	}

	// 广播终态（approval.resolved 带 ruleHit）：落任务事件/多标签页审计同链路
	if broadcast == nil || (*broadcast)["status"] != store.ApprovalDenied || (*broadcast)["ruleHit"] != "reset" {
		t.Fatalf("broadcast expect denied + ruleHit, got %v", *broadcast)
	}
}

func TestAgentApprovalRules_AllowRuleDirectSave(t *testing.T) {
	r := setupApprovalTest(t)
	setRules(t, []config.AgentApprovalRule{{OpPattern: "git push", Effect: config.ApprovalEffectAllow}})

	// allow 命中：直落库语义（同 allow 模式），无 pending 卡流
	var pendingSeen int
	opschannel.AddObserver(func(ev opschannel.Event) {
		if ev.Type == "approval.pending" {
			pendingSeen++
		}
	})
	w := doJSON(r, http.MethodPost, "/api/ops-confirm", `{"sessionId":"sc-rules-allow","op":"git push origin main"}`)
	var created struct {
		Data struct {
			Status string `json:"status"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Data.Status != store.ApprovalAllowed {
		t.Fatalf("expect allowed, got %s", created.Data.Status)
	}
	if pendingSeen != 0 {
		t.Fatalf("allow rule must not broadcast pending, got %d", pendingSeen)
	}
	stored, _ := store.Get().AgentApproval.List("", 0)
	for _, a := range stored {
		if a.Op == "git push origin main" && (a.RuleHit != "git push" || a.Status != store.ApprovalAllowed) {
			t.Fatalf("stored expect allowed + ruleHit, got %+v", a)
		}
	}
}

func TestAgentApprovalRules_AskRuleAndNoRuleKeepCardFlow(t *testing.T) {
	r := setupApprovalTest(t)

	// 显式 ask 规则命中：走现卡流（pending + 广播），记录带 ruleHit
	setRules(t, []config.AgentApprovalRule{{OpPattern: "clean", Effect: config.ApprovalEffectAsk}})
	w := doJSON(r, http.MethodPost, "/api/ops-confirm", `{"sessionId":"sc-rules-ask","op":"clean -fdx"}`)
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
		t.Fatalf("ask rule expect pending, got %s", created.Data.Status)
	}
	if a, _ := store.Get().AgentApproval.Get(created.Data.ID); a.RuleHit != "clean" {
		t.Fatalf("ask rule expect ruleHit audit, got %+v", a)
	}

	// 无规则：默认 ask = 现行为（pending、无 ruleHit）
	setRules(t, nil)
	w = doJSON(r, http.MethodPost, "/api/ops-confirm", `{"sessionId":"sc-rules-none","op":"delete file"}`)
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Data.Status != store.ApprovalPending {
		t.Fatalf("no rule expect pending, got %s", created.Data.Status)
	}
	if a, _ := store.Get().AgentApproval.Get(created.Data.ID); a.RuleHit != "" {
		t.Fatalf("no rule expect empty ruleHit, got %+v", a)
	}
}

func TestAgentApprovalRules_GlobalAllowShortCircuit(t *testing.T) {
	r := setupApprovalTest(t)
	setRules(t, []config.AgentApprovalRule{{OpPattern: "reset", Effect: config.ApprovalEffectDeny}})
	cfg := store.Get().Settings.Get()
	cfg.Server.AgentApprovalMode = "allow"
	t.Cleanup(func() { cfg.Server.AgentApprovalMode = "" })

	// 全局优先：模式 = allow 时 deny 规则不评估，仍直落库放行
	w := doJSON(r, http.MethodPost, "/api/ops-confirm", `{"op":"reset --hard"}`)
	var created struct {
		Data struct {
			Status string `json:"status"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Data.Status != store.ApprovalAllowed {
		t.Fatalf("global allow short-circuit expect allowed, got %s", created.Data.Status)
	}
}

// ---- 规则临时窗口到期恢复（P-20261003-243）：创建点同步物化 + 周期巡检 +
// 通知入账；判定侧惰性正确（到点即回 ask，恢复不依赖巡检节奏）----

func futurePtr(d time.Duration) *time.Time {
	tm := time.Now().Add(d)
	return &tm
}

func TestAgentApprovalRules_TempWindowLazyDecision(t *testing.T) {
	r := setupApprovalTest(t)

	// 窗口内 allow：命中放行（与永久 allow 同裁决，ruleHit 留审计）
	setRules(t, []config.AgentApprovalRule{
		{OpPattern: "git push", Effect: config.ApprovalEffectAllow, TempUntil: futurePtr(time.Hour)},
	})
	w := doJSON(r, http.MethodPost, "/api/ops-confirm", `{"sessionId":"sc-twin-in","op":"git push origin main"}`)
	assertCreateStatus(t, w, store.ApprovalAllowed)

	// 已过期窗口：创建走「入队先清场」物化后按 ask 裁决——结果 pending 卡流。
	// 不经创建点的纯惰性判定（巡检间隙到点即回 ask）在 config 包单测覆盖
	//（TestResolveApprovalRule_TempWindow）
	setRules(t, []config.AgentApprovalRule{
		{OpPattern: "git push", Effect: config.ApprovalEffectAllow, TempUntil: futurePtr(-time.Minute)},
	})
	w = doJSON(r, http.MethodPost, "/api/ops-confirm", `{"sessionId":"sc-twin-out","op":"git push origin main"}`)
	assertCreateStatus(t, w, store.ApprovalPending)
}

func TestAgentApprovalRules_TempWindowSweepOnCreate(t *testing.T) {
	r := setupApprovalTest(t)
	setRules(t, []config.AgentApprovalRule{
		{OpPattern: "git push", Effect: config.ApprovalEffectAllow, TempUntil: futurePtr(-time.Minute)},
		{OpPattern: "reset", Effect: config.ApprovalEffectDeny}, // 未到点规则不动
	})
	store.Get().Notification.Clear()

	// 创建即触发「入队先清场」：到点规则物化回 ask + 清窗口 + 通知入账；
	// 新审批按恢复后的规则表裁决（ask 卡流）
	w := doJSON(r, http.MethodPost, "/api/ops-confirm", `{"sessionId":"sc-twin-sweep","op":"git push origin main"}`)
	assertCreateStatus(t, w, store.ApprovalPending)

	rules := store.Get().Settings.Get().Server.AgentApprovalRules
	if rules[0].Effect != config.ApprovalEffectAsk || rules[0].TempUntil != nil {
		t.Fatalf("expired rule must materialize to ask + cleared window, got %+v", rules[0])
	}
	if rules[1].Effect != config.ApprovalEffectDeny || rules[1].TempUntil != nil {
		t.Fatalf("unexpired rule must stay untouched, got %+v", rules[1])
	}

	// 通知中心入账（titleKey/bodyKey 模板 + pattern 参数）
	notifs := store.Get().Notification.List(0)
	var hit *notification.Notification
	for i := range notifs {
		if notifs[i].TitleKey == ruleWindowExpiredTitleKey {
			hit = &notifs[i]
			break
		}
	}
	if hit == nil {
		t.Fatalf("expect rule window notification, got %+v", notifs)
	}
	if hit.BodyKey != ruleWindowExpiredBodyKey || hit.MsgParams["pattern"] != "git push" {
		t.Fatalf("notification bodyKey/params mismatch, got %+v", hit)
	}

	// 二次创建不重复通知（物化后规则已无窗口，幂等）
	store.Get().Notification.Clear()
	doJSON(r, http.MethodPost, "/api/ops-confirm", `{"sessionId":"sc-twin-sweep2","op":"git push origin main"}`)
	notifs = store.Get().Notification.List(0)
	for _, n := range notifs {
		if n.TitleKey == ruleWindowExpiredTitleKey {
			t.Fatalf("materialization must be idempotent, got duplicate notification %+v", n)
		}
	}
}

func TestAgentApprovalRules_TempWindowSweepPatrol(t *testing.T) {
	setupApprovalTest(t) // store 装配（无路由需求，直接调巡检函数）
	setRules(t, []config.AgentApprovalRule{
		{OpPattern: "deploy", Effect: config.ApprovalEffectAllow, TempUntil: futurePtr(-time.Second)},
	})
	// 周期巡检通道（生产兜底）：与创建点共用同一物化实现
	SweepApprovalTier(time.Now())
	rules := store.Get().Settings.Get().Server.AgentApprovalRules
	if rules[0].Effect != config.ApprovalEffectAsk || rules[0].TempUntil != nil {
		t.Fatalf("patrol must materialize expired window, got %+v", rules[0])
	}
}

// assertCreateStatus 断言创建响应的落库状态
func assertCreateStatus(t *testing.T, w *httptest.ResponseRecorder, want string) {
	t.Helper()
	var created struct {
		Data struct {
			Status string `json:"status"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Data.Status != want {
		t.Fatalf("create expect %s, got %s", want, created.Data.Status)
	}
}
