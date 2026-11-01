package ai

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"codecombo/server/store"
)

// 合并审批裁决联动（P-20261006-26）：主卡 allow→挂起队列按到达序放行（各请求
// 一次性消费语义不变）、deny→队列全拒（同型信任一致）；超时清扫级联（主卡
// 超时=整批知情，挂起条目不逐卡通知）；列表面对 pending 挂起条目过滤（主卡
// Merged 清单承载展示，终态后照常进历史审计）。

// seedMergedApproval 直造主卡+挂起条目（聚合建卡面在 middleware 层覆盖，这里
// 只关心裁决联动的状态迁移）
func seedMergedApproval(t *testing.T, sessionID string, n int) (mainID string, entryIDs []string) {
	t.Helper()
	now := time.Now()
	main := store.AgentApproval{
		ID:        store.NewAgentApprovalID(),
		SessionID: sessionID,
		Op:        "git push",
		Target:    "/api/projects/p1/push",
		Status:    store.ApprovalPending,
		CreatedAt: now,
	}
	if err := store.Get().AgentApproval.Save(main); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < n; i++ {
		e := store.AgentApproval{
			ID:         store.NewAgentApprovalID(),
			SessionID:  sessionID,
			Op:         main.Op,
			Target:     main.Target,
			Status:     store.ApprovalPending,
			CreatedAt:  now.Add(time.Duration(i+1) * time.Second),
			MergedInto: main.ID,
		}
		if err := store.Get().AgentApproval.Save(e); err != nil {
			t.Fatal(err)
		}
		main.Merged = append(main.Merged, store.ApprovalMergedItem{ID: e.ID, Target: e.Target, CreatedAt: e.CreatedAt})
		entryIDs = append(entryIDs, e.ID)
	}
	if err := store.Get().AgentApproval.Save(main); err != nil {
		t.Fatal(err)
	}
	return main.ID, entryIDs
}

func TestResolveAgentApproval_CascadeAllowReleasesQueue(t *testing.T) {
	r := setupApprovalTest(t)
	mainID, entryIDs := seedMergedApproval(t, "sess-1", 3)

	if w := doJSON(r, http.MethodPost, "/api/ops-confirm/"+mainID+"/resolve", `{"allow":true}`); w.Code != http.StatusOK {
		t.Fatalf("resolve status = %d, body=%s", w.Code, w.Body.String())
	}
	// 主卡 allowed；挂起条目逐条 allowed 且 ResolvedAt 齐备（各自 5min 重试窗口
	// 独立起算，一次性消费语义每请求保持）
	main, _ := store.Get().AgentApproval.Get(mainID)
	if main == nil || main.Status != store.ApprovalAllowed || main.ResolvedAt == nil {
		t.Fatalf("main expect allowed, got %+v", main)
	}
	if len(main.Merged) != 3 {
		t.Fatalf("main merged list must survive the ruling, got %d", len(main.Merged))
	}
	base := *main.ResolvedAt
	for _, id := range entryIDs {
		e, err := store.Get().AgentApproval.Get(id)
		if err != nil || e == nil {
			t.Fatalf("entry %s missing: %v", id, err)
		}
		if e.Status != store.ApprovalAllowed || e.ResolvedAt == nil || e.ResolvedAt.Sub(base) > time.Second {
			t.Fatalf("entry %s expect allowed at ~ruling time, got %+v", id, e)
		}
		if e.Reason != "" {
			t.Fatalf("allow must leave reason empty, got %q", e.Reason)
		}
	}

	// 重复裁决主卡 → 409 幂等（联动不改变既有约束）
	if w := doJSON(r, http.MethodPost, "/api/ops-confirm/"+mainID+"/resolve", `{"allow":false}`); w.Code != http.StatusConflict {
		t.Fatalf("double resolve status = %d, want 409", w.Code)
	}
}

func TestResolveAgentApproval_CascadeDenyDeniesQueueWithReason(t *testing.T) {
	r := setupApprovalTest(t)
	mainID, entryIDs := seedMergedApproval(t, "sess-1", 2)

	if w := doJSON(r, http.MethodPost, "/api/ops-confirm/"+mainID+"/resolve",
		`{"allow":false,"reason":"不要推送"}`); w.Code != http.StatusOK {
		t.Fatalf("resolve status = %d", w.Code)
	}
	for _, id := range entryIDs {
		e, _ := store.Get().AgentApproval.Get(id)
		if e == nil || e.Status != store.ApprovalDenied || e.Reason != "不要推送" || e.ResolvedAt == nil {
			t.Fatalf("entry %s expect denied with reason, got %+v", id, e)
		}
	}
}

func TestSweepApprovalTimeout_CascadesToMergedQueue(t *testing.T) {
	setupApprovalTest(t)
	// TTL 1 分钟（挂设置·还原）
	cfg := store.Get().Settings.Get()
	cfg.Server.AgentApprovalTimeoutMin = 1
	t.Cleanup(func() { cfg.Server.AgentApprovalTimeoutMin = 0 })

	mainID, entryIDs := seedMergedApproval(t, "sess-1", 2)
	// 快进到主卡与条目全部超窗（条目 CreatedAt 晚于主卡，级联时机=主卡先到期）
	denied := sweepExpiredApprovals(time.Now().Add(2 * time.Minute))
	if denied != 3 {
		t.Fatalf("sweep expect 3 denied (main+2 entries), got %d", denied)
	}
	for _, id := range append([]string{mainID}, entryIDs...) {
		a, _ := store.Get().AgentApproval.Get(id)
		if a == nil || a.Status != store.ApprovalDenied || a.Reason != approvalTimeoutReason {
			t.Fatalf("record %s expect timeout denied, got %+v", id, a)
		}
	}
}

func TestListAgentApprovals_FiltersPendingMergedEntries(t *testing.T) {
	r := setupApprovalTest(t)
	mainID, entryIDs := seedMergedApproval(t, "sess-1", 2)

	// pending 挂起条目不出现在列表（主卡 Merged 清单承载展示）——seed 补账不再
	// 把它们弹成碎卡
	w := doJSON(r, http.MethodGet, "/api/ops-confirm", "")
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d", w.Code)
	}
	var got struct {
		Data []struct {
			ID         string `json:"id"`
			Status     string `json:"status"`
			MergedInto string `json:"mergedInto"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Data) != 1 || got.Data[0].ID != mainID {
		t.Fatalf("list expect main card only, got %+v", got.Data)
	}

	// 终态后挂起条目照常进列表（历史/最近裁决/CSV 审计可见）
	if w := doJSON(r, http.MethodPost, "/api/ops-confirm/"+mainID+"/resolve", `{"allow":true}`); w.Code != http.StatusOK {
		t.Fatal(w.Code)
	}
	w = doJSON(r, http.MethodGet, "/api/ops-confirm", "")
	if !strings.Contains(w.Body.String(), entryIDs[0]) || !strings.Contains(w.Body.String(), entryIDs[1]) {
		t.Fatalf("resolved entries must appear in list, body=%s", w.Body.String())
	}
}

// TestAttachVsResolve_ConcurrentRace 并发入队撞裁决（-race 矩阵）：入队与主卡
// 裁决并发跑——approvalMergeMu 串行化下要么入队成功且随裁决联动放行，要么被
// 拒于裁决后的主卡（独立卡），两条出路都必须收敛，不允许丢裁决/丢条目
func TestAttachVsResolve_ConcurrentRace(t *testing.T) {
	setupApprovalTest(t)
	now := time.Now()
	main := store.AgentApproval{
		ID: store.NewAgentApprovalID(), SessionID: "sess-race", Op: "git clean",
		Target: "/api/projects/p1/clean", Status: store.ApprovalPending, CreatedAt: now,
	}
	if err := store.Get().AgentApproval.Save(main); err != nil {
		t.Fatal(err)
	}

	const n = 16
	var wg sync.WaitGroup
	resolved := make(chan struct{})
	go func() {
		// 裁决稍候发起，与入队 goroutines 交错
		time.Sleep(5 * time.Millisecond)
		_, _ = store.Get().AgentApproval.ResolveApprovalCascade(store.AgentApproval{
			ID: main.ID, Status: store.ApprovalAllowed,
		}, "", time.Now())
		close(resolved)
	}()
	attached := make([]string, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			entry := store.AgentApproval{
				ID: store.NewAgentApprovalID(), SessionID: "sess-race", Op: "git clean",
				Target: "/api/projects/p1/clean", Status: store.ApprovalPending,
				CreatedAt: time.Now(),
			}
			m, err := store.Get().AgentApproval.AttachMergedApproval(entry, time.Minute, 20, time.Now())
			if err != nil {
				t.Error(err)
				return
			}
			if m != nil {
				attached[i] = entry.ID
			}
		}(i)
	}
	wg.Wait()
	<-resolved

	// 收敛断言：每条入队成功的条目必有终态（随裁决联动 allowed）；主卡终态唯一
	allowed := 0
	for _, id := range attached {
		if id == "" {
			continue // 裁决已先行（主卡非 pending），回落独立建卡属合法出路
		}
		e, err := store.Get().AgentApproval.Get(id)
		if err != nil || e == nil {
			t.Fatalf("entry %s missing: %v", id, err)
		}
		if e.Status == store.ApprovalAllowed && e.ResolvedAt != nil {
			allowed++
		} else {
			t.Fatalf("attached entry %s must follow the ruling, got %+v", id, e)
		}
	}
	if allowed == 0 {
		t.Fatal("race window must still attach some entries (timing guard)")
	}
	mainAfter, _ := store.Get().AgentApproval.Get(main.ID)
	if mainAfter == nil || mainAfter.Status != store.ApprovalAllowed || mainAfter.ResolvedAt == nil {
		t.Fatalf("main must stay allowed, got %+v", mainAfter)
	}
}
