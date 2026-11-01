package ai

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 放行时限档位接线（P-20261003-316）：resolve horizon 三选一 → 档位/映射落盘；
// 巡检物化（24h 到期回 ask）与死会话裁剪。判定函数本身在 config 包覆盖，
// 此处锁端到端行为与写路径副作用

// withTierMode 档位改写 + 恢复（包级单例配置，防泄漏给同包后续用例）
func withTierMode(t *testing.T, mutate func(s *config.ServerConfig)) {
	t.Helper()
	cfg := store.Get().Settings.Get()
	savedMode := cfg.Server.AgentApprovalMode
	savedExp := cfg.Server.AgentApprovalExpiresAt
	savedMap := cfg.Server.AgentSessionAllows
	mutate(&cfg.Server)
	t.Cleanup(func() {
		cfg.Server.AgentApprovalMode = savedMode
		cfg.Server.AgentApprovalExpiresAt = savedExp
		cfg.Server.AgentSessionAllows = savedMap
	})
}

// createPending 建 pending 审批并回 id（满种对齐 opsconfirm_test 形态）
func createPending(t *testing.T, r *gin.Engine, sessionID, op string) string {
	t.Helper()
	w := doJSON(r, http.MethodPost, "/api/ops-confirm",
		`{"sessionId":"`+sessionID+`","op":"`+op+`","target":"main"}`)
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
	return created.Data.ID
}

func TestResolve_HorizonSessionGrantsAndAutoAllows(t *testing.T) {
	r := setupApprovalTest(t)
	// 档位是 config.Load 包级单例（新 store 缺 config 文档时回落它），授予后必须
	// 恢复，不泄漏给同包后续用例（同 opsconfirm_always_test 纪律）
	withTierMode(t, func(s *config.ServerConfig) { s.AgentSessionAllows = nil })
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{ID: "sc-h-s1", CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	id := createPending(t, r, "sc-h-s1", "git push -f")

	w := doJSON(r, http.MethodPost, "/api/ops-confirm/"+id+"/resolve", `{"allow":true,"horizon":"session"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("resolve status = %d, body=%s", w.Code, w.Body.String())
	}
	cfg := store.Get().Settings.Get().Server
	if cfg.AgentApprovalModeStored() != config.ApprovalModeAllowSession {
		t.Fatalf("mode = %q, want allow-session", cfg.AgentApprovalModeStored())
	}
	if _, ok := cfg.AgentSessionAllows["sc-h-s1"]; !ok {
		t.Fatalf("session grant missing: %v", cfg.AgentSessionAllows)
	}

	// 同会话后续审批：直接 allowed（不弹卡）；异会话仍 pending 走卡流
	w = doJSON(r, http.MethodPost, "/api/ops-confirm",
		`{"sessionId":"sc-h-s1","op":"reset --hard","target":"main"}`)
	if !strings.Contains(w.Body.String(), `"status":"allowed"`) {
		t.Fatalf("granted session expect auto-allowed, got %s", w.Body.String())
	}
	w = doJSON(r, http.MethodPost, "/api/ops-confirm",
		`{"sessionId":"sc-h-s2","op":"reset --hard","target":"main"}`)
	if !strings.Contains(w.Body.String(), `"status":"pending"`) {
		t.Fatalf("other session expect pending card, got %s", w.Body.String())
	}
}

func TestResolve_Horizon24hArmsExpiry(t *testing.T) {
	r := setupApprovalTest(t)
	// 档位/到期恢复（同包级单例纪律）：allow-24h 泄漏会让后续用例的建单被
	// auto-allow，卡流分支全体失真
	withTierMode(t, func(s *config.ServerConfig) {
		s.AgentApprovalMode = ""
		s.AgentApprovalExpiresAt = time.Time{}
	})
	id := createPending(t, r, "sc-h-24", "clean -fdx")

	before := time.Now()
	w := doJSON(r, http.MethodPost, "/api/ops-confirm/"+id+"/resolve", `{"allow":true,"horizon":"24h"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("resolve status = %d, body=%s", w.Code, w.Body.String())
	}
	cfg := store.Get().Settings.Get().Server
	if cfg.AgentApprovalModeStored() != config.ApprovalModeAllow24h {
		t.Fatalf("mode = %q, want allow-24h", cfg.AgentApprovalModeStored())
	}
	// 到期时刻从授予时刻起算 ~24h（时钟能跑动的窗口内 ±1min 容差）
	exp := cfg.AgentApprovalExpiresAt
	if exp.Before(before.Add(config.ApprovalAllow24hTTL).Add(-time.Minute)) ||
		exp.After(time.Now().Add(config.ApprovalAllow24hTTL).Add(time.Minute)) {
		t.Fatalf("expiresAt = %v, want ~%v", exp, before.Add(config.ApprovalAllow24hTTL))
	}
}

func TestResolve_HorizonAlwaysAndInvalid(t *testing.T) {
	r := setupApprovalTest(t)
	// 段前复位档位：前序用例泄漏的放行档位会让建单直接 auto-allow，测不了卡流
	withTierMode(t, func(s *config.ServerConfig) {
		s.AgentApprovalMode = ""
		s.AgentApprovalExpiresAt = time.Time{}
		s.AgentSessionAllows = nil
	})

	// 历史 always 字段 = 永久档（兼容面不回归）
	id := createPending(t, r, "sc-h-always", "rm -rf")
	if w := doJSON(r, http.MethodPost, "/api/ops-confirm/"+id+"/resolve", `{"allow":true,"always":true}`); w.Code != http.StatusOK {
		t.Fatalf("legacy always resolve status = %d", w.Code)
	}
	if got := store.Get().Settings.Get().Server.AgentApprovalModeStored(); got != config.ApprovalModeAllow {
		t.Fatalf("mode = %q, want allow (legacy always)", got)
	}
	// 复位回 ask：永久档在场时后续建单会被 auto-allow，无法测卡流分支
	store.Get().Settings.Get().Server.AgentApprovalMode = ""

	// 非法 horizon：400 + 稳定码，裁决未生效（仍 pending 可重新裁决）
	id2 := createPending(t, r, "sc-h-bad", "git push")
	w := doJSON(r, http.MethodPost, "/api/ops-confirm/"+id2+"/resolve", `{"allow":true,"horizon":"forever"}`)
	if w.Code != http.StatusBadRequest || bodyCode(t, w.Body.String()) != "ops.confirm_horizon_invalid" {
		t.Fatalf("invalid horizon: %d %s", w.Code, w.Body.String())
	}
	w = doJSON(r, http.MethodGet, "/api/ops-confirm/"+id2, "")
	if !strings.Contains(w.Body.String(), `"status":"pending"`) {
		t.Fatalf("invalid horizon must keep approval pending, got %s", w.Body.String())
	}

	// session 档缺会话归属：先于状态迁移拒绝（pending 保留）
	id3 := createPending(t, r, "", "git push")
	w = doJSON(r, http.MethodPost, "/api/ops-confirm/"+id3+"/resolve", `{"allow":true,"horizon":"session"}`)
	if w.Code != http.StatusBadRequest || bodyCode(t, w.Body.String()) != "ops.confirm_horizon_invalid" {
		t.Fatalf("session horizon without sessionId: %d %s", w.Code, w.Body.String())
	}
	w = doJSON(r, http.MethodGet, "/api/ops-confirm/"+id3, "")
	if !strings.Contains(w.Body.String(), `"status":"pending"`) {
		t.Fatalf("session horizon without sessionId must keep pending, got %s", w.Body.String())
	}
}

func TestSweepApprovalTier_MaterializesExpiryAndPrunesDeadSessions(t *testing.T) {
	r := setupApprovalTest(t) // 装配 store（档位落盘/会话台账都要真实文档存储）
	_ = r
	withTierMode(t, func(s *config.ServerConfig) {
		s.AgentApprovalMode = config.ApprovalModeAllow24h
		s.AgentApprovalExpiresAt = time.Now().Add(-time.Hour) // 已到期
		s.AgentSessionAllows = map[string]time.Time{"sc-live": time.Now()}
	})
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{ID: "sc-live", CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}

	SweepApprovalTier(time.Now())

	cfg := store.Get().Settings.Get().Server
	if cfg.AgentApprovalModeStored() != config.ApprovalModeAsk {
		t.Fatalf("expired 24h expect materialized ask, got %q", cfg.AgentApprovalModeStored())
	}
	if !cfg.AgentApprovalExpiresAt.IsZero() {
		t.Fatalf("expiry must be cleared on materialize, got %v", cfg.AgentApprovalExpiresAt)
	}

	// 会话级档位下死会话授予被裁、活会话保留
	withTierMode(t, func(s *config.ServerConfig) {
		s.AgentApprovalMode = config.ApprovalModeAllowSession
		s.AgentSessionAllows = map[string]time.Time{
			"sc-live":   time.Now(),
			"sc-dead":   time.Now(),
			"sc-orphan": time.Now(), // 无台账元数据（孤儿）
		}
	})
	SweepApprovalTier(time.Now())
	cfg = store.Get().Settings.Get().Server
	if _, ok := cfg.AgentSessionAllows["sc-live"]; !ok {
		t.Fatal("live session grant must survive sweep")
	}
	if _, ok := cfg.AgentSessionAllows["sc-orphan"]; ok {
		t.Fatal("dead session grant must be pruned by sweep")
	}
}

// lastApprovalModeAudit 最近一条 approval.mode 审计事件（无则 nil）。档位审计
// 低频，页大小 10 足够覆盖单用例产生的全部条目
func lastApprovalModeAudit(t *testing.T) *store.AuditEvent {
	t.Helper()
	events, _, err := store.Get().Audit.List(10, 0)
	if err != nil {
		t.Fatal(err)
	}
	for i := range events {
		if events[i].Action == store.AuditApprovalMode {
			return &events[i]
		}
	}
	return nil
}

// 审批档位变更审计（P-20261005-162）——resolve 写点：用户在卡面授予档位时
// 入账一条，Detail 含档位与会话标识（多设备/值班交接的追认面）
func TestResolve_HorizonAppendsAudit(t *testing.T) {
	r := setupApprovalTest(t)
	withTierMode(t, func(s *config.ServerConfig) {
		s.AgentApprovalMode = ""
		s.AgentApprovalExpiresAt = time.Time{}
		s.AgentSessionAllows = nil
	})
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{ID: "sc-aud-s1", CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	id := createPending(t, r, "sc-aud-s1", "git push -f")
	if w := doJSON(r, http.MethodPost, "/api/ops-confirm/"+id+"/resolve", `{"allow":true,"horizon":"session"}`); w.Code != http.StatusOK {
		t.Fatalf("resolve status = %d, body=%s", w.Code, w.Body.String())
	}

	ev := lastApprovalModeAudit(t)
	if ev == nil {
		t.Fatal("resolve with horizon must append approval.mode audit")
	}
	if ev.Result != store.AuditResultSuccess {
		t.Fatalf("result = %q, want success", ev.Result)
	}
	if !strings.Contains(ev.Detail, "→ "+config.ApprovalModeAllowSession) {
		t.Fatalf("detail = %q, want old→new with allow-session", ev.Detail)
	}
	if !strings.Contains(ev.Detail, "session=sc-aud-s1") {
		t.Fatalf("detail = %q, want session identifier", ev.Detail)
	}
}

// 审计（P-20261005-162）——Sweep 写点：24h 到期物化入账一条（归因 system 无 IP，
// Detail 携到期时刻）；空转巡检（档位已复位）零入账——10min 高频巡检不能变成
// 审计噪音源
func TestSweepApprovalTier_ExpiryAuditAndIdleThrottle(t *testing.T) {
	r := setupApprovalTest(t)
	_ = r
	expired := time.Now().Add(-time.Hour)
	withTierMode(t, func(s *config.ServerConfig) {
		s.AgentApprovalMode = config.ApprovalModeAllow24h
		s.AgentApprovalExpiresAt = expired // 已到期（时间注入同 P-316 ExpiresAt 测试法）
		s.AgentSessionAllows = nil
	})

	SweepApprovalTier(time.Now())

	ev := lastApprovalModeAudit(t)
	if ev == nil {
		t.Fatal("24h expiry materialize must append approval.mode audit")
	}
	if ev.IP != "" {
		t.Fatalf("system action must have no client IP, got %q", ev.IP)
	}
	if !strings.Contains(ev.Detail, config.ApprovalModeAllow24h+" → "+config.ApprovalModeAsk) {
		t.Fatalf("detail = %q, want allow-24h → ask", ev.Detail)
	}
	if want := " (expired " + expired.UTC().Format(time.RFC3339) + ")"; !strings.Contains(ev.Detail, want) {
		t.Fatalf("detail = %q, want expiry timestamp %q", ev.Detail, want)
	}

	// 空转零入账：档位已回 ask，再次巡检不新增任何档位审计
	_, total, err := store.Get().Audit.List(10, 0)
	if err != nil {
		t.Fatal(err)
	}
	SweepApprovalTier(time.Now())
	_, totalAfter, err := store.Get().Audit.List(10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if totalAfter != total {
		t.Fatalf("idle sweep must not append audit, total %d → %d", total, totalAfter)
	}
}
