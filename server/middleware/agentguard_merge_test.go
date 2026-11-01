package middleware

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/store"
)

// 合并审批（P-20261006-26）：AgentGuard 同类高危操作的合并审批——同会话+同 op
// 短窗口内的后续 428 请求入首张主卡挂起队列（不弹新卡），裁决联动与卡片徽标
// 在 api/ai / store 层覆盖；本文件覆盖聚合建卡策略（窗口/上限/会话与规则边界）
// 与并发入队竞态（-race 下验证 approvalMergeMu 串行化）。

// setupMergeGuard 在 setupGuard 基础上装配双通知桥观测（首卡 vs 队列更新重播）
func setupMergeGuard(t *testing.T) (*ginEnv, *mergeObs) {
	t.Helper()
	r, at := setupGuard(t, true)
	// clean 桩路由（不同 op 的聚合边界用例需要）：新组再挂一次 AgentGuard——
	// setupGuard 内的组不可达，直接在 engine 上注册会绕过中间件
	g2 := r.Group("/api")
	g2.Use(AgentGuard())
	g2.POST("/projects/:id/clean", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	obs := &mergeObs{}
	ApprovalNotifier = func(a store.AgentApproval) { obs.pending = append(obs.pending, a) }
	ApprovalUpdatedNotifier = func(a store.AgentApproval) { obs.updated = append(obs.updated, a) }
	t.Cleanup(func() { ApprovalNotifier = nil; ApprovalUpdatedNotifier = nil })
	return &ginEnv{r: r, at: at}, obs
}

type ginEnv struct {
	r  *gin.Engine
	at store.AgentTokenStore
}

type mergeObs struct {
	pending []store.AgentApproval
	updated []store.AgentApproval
}

// pushAs 带会话与令牌发起一次 push 请求，返回 428 body 中的 approvalId
func pushAs(t *testing.T, e *ginEnv, session string) (int, string) {
	t.Helper()
	tok, err := e.at.Rotate()
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/projects/p1/push", nil)
	req.Header.Set("X-Lock-Token", tok)
	if session != "" {
		req.Header.Set("X-Session-ID", session)
	}
	w := httptest.NewRecorder()
	e.r.ServeHTTP(w, req)
	return w.Code, extractApprovalID(w.Body.String())
}

func TestAgentGuardMerge_SecondSameOpJoinsFirstCard(t *testing.T) {
	e, obs := setupMergeGuard(t)

	code1, id1 := pushAs(t, e, "sess-1")
	code2, id2 := pushAs(t, e, "sess-1")
	if code1 != http.StatusPreconditionRequired || code2 != http.StatusPreconditionRequired {
		t.Fatalf("both requests expect 428, got %d/%d", code1, code2)
	}
	if id1 == "" || id2 == "" || id1 == id2 {
		t.Fatalf("expect two distinct approvalIds, got %q/%q", id1, id2)
	}

	// 首卡独立（无 mergedInto），次请求入队（mergedInto 钉主卡，主卡清单含它）
	main, err := store.Get().AgentApproval.Get(id1)
	if err != nil || main == nil {
		t.Fatalf("main missing: %v", err)
	}
	if main.MergedInto != "" || len(main.Merged) != 1 || main.Merged[0].ID != id2 {
		t.Fatalf("main expect one merged item %q, got %+v / into=%q", id2, main.Merged, main.MergedInto)
	}
	entry, err := store.Get().AgentApproval.Get(id2)
	if err != nil || entry == nil {
		t.Fatalf("entry missing: %v", err)
	}
	if entry.MergedInto != id1 || entry.Status != store.ApprovalPending {
		t.Fatalf("entry expect pending merged into main, got %+v", entry)
	}

	// 广播面：首卡走 ApprovalNotifier 一次，入队只重播主卡更新（不新建 pending 卡）
	if len(obs.pending) != 1 || obs.pending[0].ID != id1 {
		t.Fatalf("expect one pending broadcast for main, got %d", len(obs.pending))
	}
	if len(obs.updated) != 1 || obs.updated[0].ID != id1 || len(obs.updated[0].Merged) != 1 {
		t.Fatalf("expect one main update replay with merged list, got %d", len(obs.updated))
	}
}

func TestAgentGuardMerge_NotAcrossSessionsNorOps(t *testing.T) {
	e, _ := setupMergeGuard(t)

	// 不同会话同 op：不聚合
	if _, id1 := pushAs(t, e, "sess-a"); id1 == "" {
		t.Fatal("first card missing")
	}
	code, id2 := pushAs(t, e, "sess-b")
	if code != http.StatusPreconditionRequired || id2 == "" {
		t.Fatalf("second session expect 428, got %d", code)
	}
	a2, _ := store.Get().AgentApproval.Get(id2)
	if a2 == nil || a2.MergedInto != "" {
		t.Fatalf("cross-session request must be standalone, got %+v", a2)
	}

	// 同会话不同 op（clean vs push）：不聚合
	tok, err := e.at.Rotate()
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/projects/p1/clean", nil)
	req.Header.Set("X-Lock-Token", tok)
	req.Header.Set("X-Session-ID", "sess-a")
	w := httptest.NewRecorder()
	e.r.ServeHTTP(w, req)
	if w.Code != http.StatusPreconditionRequired {
		t.Fatalf("clean expect 428, got %d", w.Code)
	}
	a3, _ := store.Get().AgentApproval.Get(extractApprovalID(w.Body.String()))
	if a3 == nil || a3.MergedInto != "" {
		t.Fatalf("cross-op request must be standalone, got %+v", a3)
	}

	// 无会话归属（header 缺省）：不聚合——同会话是合并的信任边界
	if _, id4 := pushAs(t, e, ""); id4 == "" {
		t.Fatal("no-session request expect 428")
	} else if a4, _ := store.Get().AgentApproval.Get(id4); a4 == nil || a4.MergedInto != "" {
		t.Fatalf("no-session request must be standalone, got %+v", a4)
	}
}

func TestAgentGuardMerge_WindowExpiryCreatesStandaloneCard(t *testing.T) {
	e, obs := setupMergeGuard(t)

	_, id1 := pushAs(t, e, "sess-1")
	// 主卡创建时刻回拨出窗口（60s 锚定主卡 CreatedAt）——陈旧主卡不再吸收
	main, _ := store.Get().AgentApproval.Get(id1)
	if main == nil {
		t.Fatal("main missing")
	}
	main.CreatedAt = main.CreatedAt.Add(-(approvalMergeWindow + time.Second))
	if err := store.Get().AgentApproval.Save(*main); err != nil {
		t.Fatal(err)
	}
	before := len(obs.pending)
	code, id2 := pushAs(t, e, "sess-1")
	if code != http.StatusPreconditionRequired || id2 == "" {
		t.Fatalf("expect 428 after window expiry, got %d", code)
	}
	a2, _ := store.Get().AgentApproval.Get(id2)
	if a2 == nil || a2.MergedInto != "" {
		t.Fatalf("expired-window request must be standalone, got %+v", a2)
	}
	if len(obs.pending) != before+1 {
		t.Fatalf("standalone card must broadcast pending, got %d broadcasts", len(obs.pending)-before)
	}
}

func TestAgentGuardMerge_QueueCapFallsBackToStandalone(t *testing.T) {
	e, _ := setupMergeGuard(t)

	_, mainID := pushAs(t, e, "sess-1")
	// 灌满主卡队列（上限 20）：第 2~21 个请求全部入队（主卡本身不计入队列）
	for i := 2; i <= approvalMergeQueueMax+1; i++ {
		if _, id := pushAs(t, e, "sess-1"); id == "" {
			t.Fatalf("request %d expect approvalId", i)
		}
	}
	main, _ := store.Get().AgentApproval.Get(mainID)
	if main == nil || len(main.Merged) != approvalMergeQueueMax {
		t.Fatalf("main queue expect %d entries, got %d", approvalMergeQueueMax, len(main.Merged))
	}
	// 第 22 个请求：队列已满 → 独立建卡（护栏：不饿死、批量裁决放大面有界）
	code, id22 := pushAs(t, e, "sess-1")
	if code != http.StatusPreconditionRequired || id22 == "" {
		t.Fatalf("overflow request expect 428, got %d", code)
	}
	a22, _ := store.Get().AgentApproval.Get(id22)
	if a22 == nil || a22.MergedInto != "" {
		t.Fatalf("overflow request must be standalone, got %+v", a22)
	}
	// 第 23 个请求：并入最新的空位主卡（第 22 张）
	if _, id23 := pushAs(t, e, "sess-1"); id23 == "" {
		t.Fatal("request 23 expect approvalId")
	} else if a23, _ := store.Get().AgentApproval.Get(id23); a23 == nil || a23.MergedInto != id22 {
		t.Fatalf("request 23 must join the overflow card, got %+v", a23)
	}
}

func TestAgentGuardMerge_RuleAskHitDoesNotMerge(t *testing.T) {
	r, at := setupGuard(t, true)
	// 显式 ask 规则 = 用户配置的逐单裁决意图：命中者不进聚合（allow/deny 规则
	// 本就不产生卡，与聚合无交集）
	setGuardRules(t, []config.AgentApprovalRule{{OpPattern: "git push", Effect: config.ApprovalEffectAsk}})

	ids := make([]string, 0, 2)
	for i := 0; i < 2; i++ {
		tok, err := at.Rotate()
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPost, "/api/projects/p1/push", nil)
		req.Header.Set("X-Lock-Token", tok)
		req.Header.Set("X-Session-ID", "sess-1")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusPreconditionRequired {
			t.Fatalf("request %d expect 428, got %d", i, w.Code)
		}
		ids = append(ids, extractApprovalID(w.Body.String()))
	}
	a2, _ := store.Get().AgentApproval.Get(ids[1])
	if a2 == nil || a2.MergedInto != "" {
		t.Fatalf("rule-hit request must be standalone, got %+v", a2)
	}
}

// TestAgentGuardMerge_ConcurrentAttach 并发入队竞态（-race 矩阵）：20 个同会话
// 同 op 请求并发到达，全部入同一主卡（上限内）且清单零丢失——approvalMergeMu
// 串行化「选中主卡 → 追加清单 → 落库」的 check-then-act
func TestAgentGuardMerge_ConcurrentAttach(t *testing.T) {
	e, _ := setupMergeGuard(t)

	const n = approvalMergeQueueMax
	var wg sync.WaitGroup
	ids := make([]string, n)
	var mu sync.Mutex
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			tok, err := e.at.Rotate()
			if err != nil {
				t.Error(err)
				return
			}
			req := httptest.NewRequest(http.MethodPost, "/api/projects/p1/push", nil)
			req.Header.Set("X-Lock-Token", tok)
			req.Header.Set("X-Session-ID", "sess-1")
			w := httptest.NewRecorder()
			e.r.ServeHTTP(w, req)
			if w.Code != http.StatusPreconditionRequired {
				t.Errorf("concurrent request %d expect 428, got %d", i, w.Code)
				return
			}
			mu.Lock()
			ids[i] = extractApprovalID(w.Body.String())
			mu.Unlock()
		}(i)
	}
	wg.Wait()

	// 首个请求建主卡，其余 19 个入队（并发下谁是主卡不确定——按 mergedInto 归组
	// 断言：恰好一张独立卡，n-1 条全部钉到它，主卡清单无丢失）
	mains := map[string]int{}
	queued := 0
	var mainID string
	for _, id := range ids {
		if id == "" {
			t.Fatal("concurrent request missing approvalId")
		}
		a, err := store.Get().AgentApproval.Get(id)
		if err != nil || a == nil {
			t.Fatalf("record %s missing: %v", id, err)
		}
		if a.MergedInto == "" {
			mains[id]++
			mainID = id
		} else {
			queued++
		}
	}
	if len(mains) != 1 || queued != n-1 {
		t.Fatalf("expect exactly 1 standalone card + %d queued, got %d mains + %d queued", n-1, len(mains), queued)
	}
	main, _ := store.Get().AgentApproval.Get(mainID)
	if main == nil || len(main.Merged) != n-1 {
		t.Fatalf("main merged list expect %d entries, got %+v", n-1, main)
	}
	seen := map[string]bool{}
	for _, m := range main.Merged {
		if seen[m.ID] {
			t.Fatalf("duplicate merged item %s——并发清单覆盖竞态", m.ID)
		}
		seen[m.ID] = true
	}
}
