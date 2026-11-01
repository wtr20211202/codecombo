package middleware

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/store"
)

// 敏感写入路径窄表闸（P-20261005-235）单测：窄表命中三类（.git/hooks、
// .git/config、.ssh）与未命中零打扰、路径归一化绕过变体（.. 段 / 分隔符
// 变体 / 大小写 / ./ 前缀）、审批流（428 → 裁决 → X-Approval-ID 一次性
// 放行）、op 钉路径（跨路径重放不透传）、规则 allow/deny/pathPattern 三态。

// TestIsSensitiveWritePath_NarrowTableHits 窄表三类命中：根、子模块嵌套、
// 目录自身（mkdir 场景，`**` 吞零段）
func TestIsSensitiveWritePath_NarrowTableHits(t *testing.T) {
	hits := []string{
		".git/hooks/pre-commit",      // 根 hooks 投毒
		"sub/.git/hooks/pre-commit",  // 子模块 .git 一并覆盖（模式带 **/ 前缀）
		".git/config",                // remote URL 劫持向
		"sub/.git/config",            // 嵌套 config
		".ssh/authorized_keys",       // 根 .ssh
		"deploy/.ssh/id_rsa",         // 嵌套 .ssh
		".git/hooks",                 // 目录自身（CreateDir 场景）
		".ssh",                       // 目录自身
		".git/hooks/sub/dir/hook.sh", // hooks 下任意深度
	}
	for _, p := range hits {
		if !IsSensitiveWritePath(p) {
			t.Errorf("IsSensitiveWritePath(%q) = false, want true", p)
		}
	}
}

// TestIsSensitiveWritePath_MissKeepsDailyWork 未命中零打扰：日常开发对象
// 不进窄表（近似名不误伤——段精确匹配，非子串）
func TestIsSensitiveWritePath_MissKeepsDailyWork(t *testing.T) {
	misses := []string{
		".gitignore",               // 根忽略清单（日常编辑对象）
		".github/workflows/ci.yml", // CI 配置——任务书明言的正常编辑对象
		"src/main.go",
		"git-hooks/pre-commit", // 近似目录名（段必须精确等于 .git/hooks）
		"my.git/config",        // my.git ≠ .git 段
		".ssh_config",          // 单段文件名 ≠ .ssh 段
		"docs/githooks/x",      // docs/githooks ≠ .git/hooks
		".git/HEAD",            // 窄表外（窄表纪律：起步三类，不擅自扩）
		"",                     // 空（项目根）
		".",                    // 项目根
		"../outside/evil.sh",   // 越出项目根：写入入口边界校验的职责，闸不背
	}
	for _, p := range misses {
		if IsSensitiveWritePath(p) {
			t.Errorf("IsSensitiveWritePath(%q) = true, want false", p)
		}
	}
}

// TestIsSensitiveWritePath_NormalizationBypassVariants 归一化绕过防护：
// .. 段、分隔符变体、大小写、./ 前缀在匹配前归一，全部照常命中
func TestIsSensitiveWritePath_NormalizationBypassVariants(t *testing.T) {
	variants := []string{
		"./.git/hooks/pre-commit", // ./ 前缀
		".git//hooks//pre-commit", // 重复分隔符
		".git\\hooks\\pre-commit", // Windows 反斜杠（agent 常拼）
		".git/./hooks/pre-commit", // 段间 ./ 噪声
		".GIT/HOOKS/PRE-COMMIT",   // 大小写变体
		".Git/Config",             // 大小写变体（config）
		".git/hooks/../config",    // .. 段归一后命中 config（写入入口
		// SafeJoinProject 已整体拒绝 ..，此处是匹配器层第二道防线）
		"  .git/config  ", // 首尾空白
	}
	for _, p := range variants {
		if !IsSensitiveWritePath(p) {
			t.Errorf("IsSensitiveWritePath(%q) = false, want true (归一后命中)", p)
		}
	}
}

// setupPathGuard 敏感路径面测试桩：复用 setupGuard 的 store 装配，注册一个
// 经 GuardSensitiveWritePath 的写入桩路由（path 走 query）
func setupPathGuard(t *testing.T, guardOn bool) (*gin.Engine, store.AgentTokenStore) {
	t.Helper()
	r, at := setupGuard(t, guardOn)
	r.POST("/api/projects/:id/file", func(c *gin.Context) {
		if !GuardSensitiveWritePath(c, c.Query("path")) {
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	return r, at
}

// writeWith 发起带 path 的写入桩请求
func writeWith(r *gin.Engine, token, relPath string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/projects/p1/file?path="+relPath, nil)
	if token != "" {
		req.Header.Set("X-Lock-Token", token)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// TestGuardSensitiveWritePath_Flow 主链路：agent 令牌命中 → 428 审批卡
// （op 以「写入敏感路径」为前缀）→ 裁决允许 → 携 ID 重试放行（一次性）；
// 未命中照常；用户令牌豁免
func TestGuardSensitiveWritePath_Flow(t *testing.T) {
	r, at := setupPathGuard(t, true)
	tok, err := at.Rotate()
	if err != nil {
		t.Fatal(err)
	}

	// 未命中：agent 令牌写普通文件零打扰
	if w := writeWith(r, tok, "src/main.go"); w.Code != http.StatusOK {
		t.Fatalf("normal path status = %d, want 200, body=%s", w.Code, w.Body.String())
	}

	// 命中：428 + approvalId + 稳定 code
	w := writeWith(r, tok, ".git%2Fhooks%2Fpre-commit")
	if w.Code != http.StatusPreconditionRequired {
		t.Fatalf("sensitive path status = %d, want 428, body=%s", w.Code, w.Body.String())
	}
	if got := guardBodyCode(t, w.Body.String()); got != "ops.approval_required" {
		t.Errorf("code = %q, want ops.approval_required", got)
	}
	approvalID := extractApprovalID(w.Body.String())
	if approvalID == "" {
		t.Fatal("no approvalId in 428 body")
	}
	a, err := store.Get().AgentApproval.Get(approvalID)
	if err != nil || a == nil {
		t.Fatalf("approval not found: %v", err)
	}
	// 卡片契约：op「写入敏感路径 <path>」前缀（规则一条前缀覆盖整个面）+ target 携归一路径
	if len(a.Op) < len("写入敏感路径 ") || a.Op[:len("写入敏感路径 ")] != "写入敏感路径 " {
		t.Errorf("op = %q, want 写入敏感路径 前缀", a.Op)
	}
	if a.Op != "写入敏感路径 .git/hooks/pre-commit" {
		t.Errorf("op = %q, want op 携归一路径", a.Op)
	}
	if a.Target != ".git/hooks/pre-commit" {
		t.Errorf("target = %q, want 归一相对路径", a.Target)
	}

	// 用户裁决允许 → 重试放行（一次性消费）
	allowed := store.ApprovalAllowed
	now := time.Now()
	a.Status = allowed
	a.ResolvedAt = &now
	if err := store.Get().AgentApproval.Save(*a); err != nil {
		t.Fatal(err)
	}
	req2 := httptest.NewRequest(http.MethodPost, "/api/projects/p1/file?path=.git%2Fhooks%2Fpre-commit", nil)
	req2.Header.Set("X-Lock-Token", tok)
	req2.Header.Set("X-Approval-ID", approvalID)
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("retry status = %d, want 200, body=%s", w2.Code, w2.Body.String())
	}
	// 同 ID 二次重试 → 已消费，重新 428
	req3 := httptest.NewRequest(http.MethodPost, "/api/projects/p1/file?path=.git%2Fhooks%2Fpre-commit", nil)
	req3.Header.Set("X-Lock-Token", tok)
	req3.Header.Set("X-Approval-ID", approvalID)
	w3 := httptest.NewRecorder()
	r.ServeHTTP(w3, req3)
	if w3.Code != http.StatusPreconditionRequired {
		t.Fatalf("replay status = %d, want 428", w3.Code)
	}

	// 用户解锁令牌（scl_）豁免：敏感路径照常写
	if w := writeWith(r, "scl_user_token", ".git%2Fhooks%2Fpre-commit"); w.Code != http.StatusOK {
		t.Fatalf("unlock token status = %d, want 200 (exempt)", w.Code)
	}
}

// TestGuardSensitiveWritePath_OpPinnedRetry op 钉路径：A 路径的 approvalId
// 拿去写 B 路径不透传——视为无效头，重建 B 自己的审批（跨路径重放防护）
func TestGuardSensitiveWritePath_OpPinnedRetry(t *testing.T) {
	r, at := setupPathGuard(t, true)
	tok, err := at.Rotate()
	if err != nil {
		t.Fatal(err)
	}

	w := writeWith(r, tok, ".git%2Fconfig")
	if w.Code != http.StatusPreconditionRequired {
		t.Fatalf("first status = %d, want 428", w.Code)
	}
	approvalID := extractApprovalID(w.Body.String())
	a, err := store.Get().AgentApproval.Get(approvalID)
	if err != nil || a == nil {
		t.Fatalf("approval not found: %v", err)
	}
	allowed := store.ApprovalAllowed
	now := time.Now()
	a.Status = allowed
	a.ResolvedAt = &now
	if err := store.Get().AgentApproval.Save(*a); err != nil {
		t.Fatal(err)
	}

	// 携 A 路径（.git/config）的 ID 重试 B 路径（.ssh/authorized_keys）：
	// 不放行 B，而是为 B 建新审批（428，op 携 B 路径）
	req := httptest.NewRequest(http.MethodPost, "/api/projects/p1/file?path=.ssh%2Fauthorized_keys", nil)
	req.Header.Set("X-Lock-Token", tok)
	req.Header.Set("X-Approval-ID", approvalID)
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req)
	if w2.Code != http.StatusPreconditionRequired {
		t.Fatalf("cross-path retry status = %d, want 428 (new approval for B)", w2.Code)
	}
	newID := extractApprovalID(w2.Body.String())
	if newID == "" || newID == approvalID {
		t.Fatalf("expect fresh approval for path B, got %q", newID)
	}
	b, err := store.Get().AgentApproval.Get(newID)
	if err != nil || b == nil {
		t.Fatalf("new approval missing: %v", err)
	}
	if b.Op != "写入敏感路径 .ssh/authorized_keys" {
		t.Errorf("new approval op = %q, want 钉在 B 路径", b.Op)
	}
	// 原审批未被跨路径消费（仍 allowed 在册，本路径重试仍可用）
	if ra, _ := store.Get().AgentApproval.Get(approvalID); ra == nil || ra.Status != store.ApprovalAllowed {
		t.Errorf("original approval must stay allowed (not consumed cross-path)")
	}
}

// TestGuardSensitiveWritePath_Rules 规则三态接线：allow 前缀直放行不建卡、
// deny 403 携 ruleHit、pathPattern 条件在本面真实生效（路径不匹配的规则
// 按未命中回落 428）
func TestGuardSensitiveWritePath_Rules(t *testing.T) {
	t.Run("allow 前缀直放行", func(t *testing.T) {
		r, at := setupPathGuard(t, true)
		setGuardRules(t, []config.AgentApprovalRule{{OpPattern: "写入敏感路径", Effect: config.ApprovalEffectAllow}})
		tok, err := at.Rotate()
		if err != nil {
			t.Fatal(err)
		}
		if w := writeWith(r, tok, ".ssh%2Fauthorized_keys"); w.Code != http.StatusOK {
			t.Fatalf("allow rule status = %d, want 200, body=%s", w.Code, w.Body.String())
		}
		list, _ := store.Get().AgentApproval.List("", 0)
		if len(list) != 0 {
			t.Fatalf("allow rule must not create approval, got %d", len(list))
		}
	})

	t.Run("deny 403 携 ruleHit", func(t *testing.T) {
		r, at := setupPathGuard(t, true)
		setGuardRules(t, []config.AgentApprovalRule{{OpPattern: "写入敏感路径", Effect: config.ApprovalEffectDeny}})
		tok, err := at.Rotate()
		if err != nil {
			t.Fatal(err)
		}
		w := writeWith(r, tok, ".git%2Fconfig")
		if w.Code != http.StatusForbidden {
			t.Fatalf("deny rule status = %d, want 403, body=%s", w.Code, w.Body.String())
		}
		var body struct {
			RuleHit string `json:"ruleHit"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.RuleHit != "写入敏感路径" {
			t.Errorf("ruleHit = %q, want 写入敏感路径", body.RuleHit)
		}
	})

	t.Run("pathPattern 条件真实生效", func(t *testing.T) {
		r, at := setupPathGuard(t, true)
		// 仅对 .ssh 面 deny：写 .git/config 不被该规则命中（路由面 target 是
		// URL 只能按未命中跳过，本面是真相对路径——glob 精确区分）
		setGuardRules(t, []config.AgentApprovalRule{
			{OpPattern: "写入敏感路径", PathPattern: "**/.ssh/**", Effect: config.ApprovalEffectDeny},
		})
		tok, err := at.Rotate()
		if err != nil {
			t.Fatal(err)
		}
		if w := writeWith(r, tok, ".git%2Fconfig"); w.Code != http.StatusPreconditionRequired {
			t.Fatalf("path-mismatched deny rule status = %d, want 428 (rule skipped)", w.Code)
		}
		if w := writeWith(r, tok, ".ssh%2Fauthorized_keys"); w.Code != http.StatusForbidden {
			t.Fatalf("path-matched deny rule status = %d, want 403", w.Code)
		}
	})
}

// TestGuardSensitiveWritePath_SwitchOff 总开关关闭：整个强制面（含窄表闸）不生效
func TestGuardSensitiveWritePath_SwitchOff(t *testing.T) {
	r, at := setupPathGuard(t, false)
	tok, err := at.Rotate()
	if err != nil {
		t.Fatal(err)
	}
	if w := writeWith(r, tok, ".git%2Fhooks%2Fpre-commit"); w.Code != http.StatusOK {
		t.Fatalf("guard off status = %d, want 200", w.Code)
	}
}
