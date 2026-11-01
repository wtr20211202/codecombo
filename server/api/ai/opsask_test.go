package ai

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"codecombo/server/api/opschannel"
	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// setupAskTest ops-ask 路由测试装配（与 setupApprovalTest 同构：独立 store + 本组路由）
func setupAskTest(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := gin.New()
	r.POST("/api/ops-ask", CreateAgentAsk)
	r.GET("/api/ops-ask/:id", GetAgentAsk)
	r.POST("/api/ops-ask/:id/answer", AnswerAgentAsk)
	r.GET("/api/ops-ask", ListAgentAsks)
	return r
}

// TestAgentAsk_FourStates 创建/轮询/回答/超时四态全链路
func TestAgentAsk_FourStates(t *testing.T) {
	r := setupAskTest(t)

	// ── 创建：问题 + 选项 + 归属终端 → pending ──
	w := doJSON(r, http.MethodPost, "/api/ops-ask",
		`{"terminalId":"ask-term-1","question":"选方案 A 还是 B？","options":["方案 A","方案 B"]}`)
	if w.Code != http.StatusOK {
		t.Fatalf("create status = %d, body=%s", w.Code, w.Body.String())
	}
	var created struct {
		Data struct {
			ID        string `json:"id"`
			Status    string `json:"status"`
			ExpiresAt string `json:"expiresAt"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Data.Status != store.AskPending || created.Data.ID == "" || created.Data.ExpiresAt == "" {
		t.Fatalf("expect pending with id+expiresAt, got %+v", created.Data)
	}

	// ── 轮询：pending，且回读完整记录（问题/选项/归属，供卡片与大屏补账） ──
	w = doJSON(r, http.MethodGet, "/api/ops-ask/"+created.Data.ID, "")
	var got struct {
		Data store.AgentAsk `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Data.Status != store.AskPending || got.Data.Question != "选方案 A 还是 B？" ||
		len(got.Data.Options) != 2 || got.Data.TerminalID != "ask-term-1" {
		t.Fatalf("poll expect pending with full record, got %+v", got.Data)
	}

	// ── 用户作答（选项原文）→ answered；轮询取到答案 ──
	w = doJSON(r, http.MethodPost, "/api/ops-ask/"+created.Data.ID+"/answer", `{"answer":"方案 A"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("answer status = %d, body=%s", w.Code, w.Body.String())
	}
	w = doJSON(r, http.MethodGet, "/api/ops-ask/"+created.Data.ID, "")
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Data.Status != store.AskAnswered || got.Data.Answer != "方案 A" || got.Data.AnsweredAt == nil {
		t.Fatalf("expect answered with answer, got %+v", got.Data)
	}

	// ── 幂等约束：已答记录再答 → 409（答案以先到者为准） ──
	w = doJSON(r, http.MethodPost, "/api/ops-ask/"+created.Data.ID+"/answer", `{"answer":"方案 B"}`)
	if w.Code != http.StatusConflict {
		t.Fatalf("double answer status = %d, want 409", w.Code)
	}

	// ── 自由文本作答路径（无选项提问）──
	w = doJSON(r, http.MethodPost, "/api/ops-ask", `{"question":"缺 DATABASE_URL 的值"}`)
	var created2 struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created2); err != nil {
		t.Fatal(err)
	}
	w = doJSON(r, http.MethodPost, "/api/ops-ask/"+created2.Data.ID+"/answer", `{"answer":"postgres://localhost/db"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("free-text answer status = %d", w.Code)
	}

	// ── 列表（大屏补账数据源）包含且状态正确 ──
	w = doJSON(r, http.MethodGet, "/api/ops-ask", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), store.AskAnswered) {
		t.Fatalf("list expect answered entry, status=%d body=%s", w.Code, w.Body.String())
	}
}

// TestAgentAsk_Expiry 超时语义：过 ExpiresAt 的 pending 轮询即翻转 expired，
// 作答同判（409）；列表同步翻转，不向补账方泄露陈旧 pending
func TestAgentAsk_Expiry(t *testing.T) {
	r := setupAskTest(t)

	// 直接落库一条已过期的 pending（绕过 handler 的 TTL 赋值，模拟时间流逝）
	ask := store.AgentAsk{
		ID: store.NewAgentAskID(), TerminalID: "t", Question: "过期问题",
		Status: store.AskPending, CreatedAt: time.Now().Add(-2 * store.AskTTL),
		ExpiresAt: time.Now().Add(-store.AskTTL),
	}
	if err := store.Get().AgentAsk.Save(ask); err != nil {
		t.Fatal(err)
	}

	// 轮询 → expired（惰性翻转落库）
	w := doJSON(r, http.MethodGet, "/api/ops-ask/"+ask.ID, "")
	var got struct {
		Data struct {
			Status string `json:"status"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || got.Data.Status != store.AskExpired {
		t.Fatalf("poll expect expired, got %s err=%v", got.Data.Status, err)
	}
	// 落库状态已翻转（不只响应层面）
	saved, _ := store.Get().AgentAsk.Get(ask.ID)
	if saved == nil || saved.Status != store.AskExpired {
		t.Fatalf("expired flip not persisted: %+v", saved)
	}

	// 过期后作答 → 409
	ask2 := store.AgentAsk{
		ID: store.NewAgentAskID(), Question: "过期问题2",
		Status: store.AskPending, CreatedAt: time.Now().Add(-2 * store.AskTTL),
		ExpiresAt: time.Now().Add(-time.Second),
	}
	if err := store.Get().AgentAsk.Save(ask2); err != nil {
		t.Fatal(err)
	}
	if w := doJSON(r, http.MethodPost, "/api/ops-ask/"+ask2.ID+"/answer", `{"answer":"late"}`); w.Code != http.StatusConflict {
		t.Fatalf("answer on expired status = %d, want 409", w.Code)
	}

	// 列表惰性翻转：不返回陈旧 pending
	ask3 := store.AgentAsk{
		ID: store.NewAgentAskID(), Question: "过期问题3",
		Status: store.AskPending, CreatedAt: time.Now().Add(-2 * store.AskTTL),
		ExpiresAt: time.Now().Add(-time.Second),
	}
	if err := store.Get().AgentAsk.Save(ask3); err != nil {
		t.Fatal(err)
	}
	if w := doJSON(r, http.MethodGet, "/api/ops-ask", ""); strings.Contains(w.Body.String(), `"status":"pending"`) {
		t.Fatalf("list should not expose stale pending, body=%s", w.Body.String())
	}
}

// TestAgentAsk_Validation 入参校验：问题/选项/答案边界与未知 ID
func TestAgentAsk_Validation(t *testing.T) {
	r := setupAskTest(t)
	// 问题缺失 → 400
	if w := doJSON(r, http.MethodPost, "/api/ops-ask", `{"options":["a"]}`); w.Code != http.StatusBadRequest {
		t.Fatalf("missing question status = %d, want 400", w.Code)
	}
	// 问题超长 → 400
	if w := doJSON(r, http.MethodPost, "/api/ops-ask", `{"question":"`+strings.Repeat("a", 3000)+`"}`); w.Code != http.StatusBadRequest {
		t.Fatalf("long question status = %d, want 400", w.Code)
	}
	// 空选项 / 选项超上限 → 400
	if w := doJSON(r, http.MethodPost, "/api/ops-ask", `{"question":"q","options":["  "]}`); w.Code != http.StatusBadRequest {
		t.Fatalf("blank option status = %d, want 400", w.Code)
	}
	opts := make([]string, 11)
	for i := range opts {
		opts[i] = "o"
	}
	body, _ := json.Marshal(map[string]any{"question": "q", "options": opts})
	if w := doJSON(r, http.MethodPost, "/api/ops-ask", string(body)); w.Code != http.StatusBadRequest {
		t.Fatalf("too many options status = %d, want 400", w.Code)
	}
	// 空白答案 → 400
	w := doJSON(r, http.MethodPost, "/api/ops-ask", `{"question":"q"}`)
	var created struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if w := doJSON(r, http.MethodPost, "/api/ops-ask/"+created.Data.ID+"/answer", `{"answer":"   "}`); w.Code != http.StatusBadRequest {
		t.Fatalf("blank answer status = %d, want 400", w.Code)
	}
	// 未知 ID：轮询/作答均 404
	if w := doJSON(r, http.MethodGet, "/api/ops-ask/sc_aq_none", ""); w.Code != http.StatusNotFound {
		t.Fatalf("unknown id status = %d, want 404", w.Code)
	}
	if w := doJSON(r, http.MethodPost, "/api/ops-ask/sc_aq_none/answer", `{"answer":"x"}`); w.Code != http.StatusNotFound {
		t.Fatalf("unknown answer status = %d, want 404", w.Code)
	}
}

// TestAgentAsk_Broadcast 提问经广播出站（input.request 载荷为完整记录）+ 回答回流
func TestAgentAsk_Broadcast(t *testing.T) {
	r := setupAskTest(t)
	var seen []opschannel.Event
	done := make(chan struct{})
	opschannel.SetObserver(func(ev opschannel.Event) {
		seen = append(seen, ev)
		if len(seen) == 2 {
			close(done)
		}
	})
	// 还原为模块 Init 装配的落库观察者（不能置 nil——同包后续用例
	// TestAgentTask_PersistViaObserver 依赖该观察者在位）
	t.Cleanup(func() { opschannel.SetObserver(TaskEventObserver()) })

	w := doJSON(r, http.MethodPost, "/api/ops-ask", `{"terminalId":"b-term","question":"广播校验"}`)
	var created struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	w = doJSON(r, http.MethodPost, "/api/ops-ask/"+created.Data.ID+"/answer", `{"answer":"ok"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("answer status = %d", w.Code)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("expect 2 broadcast events (input.request + input.resolved)")
	}
	if seen[0].Type != "input.request" {
		t.Fatalf("first event = %s, want input.request", seen[0].Type)
	}
	var reqPayload struct {
		Question   string `json:"question"`
		TerminalID string `json:"terminalId"`
		Status     string `json:"status"`
	}
	b, _ := json.Marshal(seen[0].Payload)
	if err := json.Unmarshal(b, &reqPayload); err != nil {
		t.Fatal(err)
	}
	if reqPayload.Question != "广播校验" || reqPayload.TerminalID != "b-term" || reqPayload.Status != store.AskPending {
		t.Fatalf("input.request payload incomplete: %s", string(b))
	}
	if seen[1].Type != "input.resolved" {
		t.Fatalf("second event = %s, want input.resolved", seen[1].Type)
	}
}
