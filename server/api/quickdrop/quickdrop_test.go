package quickdrop

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 快投递端点纪律锁（P-20261006-51）：token 门禁 404 口径、限流外的长度护栏、
// 到达通知（遮蔽摘要 + 行内动作双出口）、审计不含正文、访客页渲染/PRG。

// newQuickdropRouter 测试路由：公开投递原语 + 访客页 + 管理面全量，
// store 换临时目录实例（shareapi handlers_test 同款装配）
func newQuickdropRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := gin.New()
	r.POST("/api/quickdrop", PostDrop)
	r.GET("/drop/:token", GetDropPage)
	r.POST("/drop/:token", PostDropForm)
	r.GET("/api/quickdrop", ListDrops)
	r.DELETE("/api/quickdrop/:id", DeleteDrop)
	r.POST("/api/quickdrop/token", CreateDropToken)
	r.GET("/api/quickdrop/token", GetDropToken)
	r.DELETE("/api/quickdrop/token", RevokeDropToken)
	return r
}

// doJSON 发一次 JSON 请求并解包响应（shareapi handlers_test doJSON 同款）
func doJSON(r *gin.Engine, method, path, body string) (int, map[string]any) {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	r.ServeHTTP(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

// genToken 生成一枚投递凭据并返回明文
func genToken(t *testing.T, r *gin.Engine) string {
	t.Helper()
	code, out := doJSON(r, http.MethodPost, "/api/quickdrop/token", "")
	if code != http.StatusOK {
		t.Fatalf("generate token status = %d: %v", code, out)
	}
	data, _ := out["data"].(map[string]any)
	plain, _ := data["token"].(string)
	if plain == "" {
		t.Fatalf("missing token in response: %v", out)
	}
	return plain
}

func TestPostDropTokenGate(t *testing.T) {
	r := newQuickdropRouter(t)

	// 无凭据/错凭据/已撤销凭据一律 404（端点存在性不可探测）
	for _, tok := range []string{"", "scd_wrongwrongwrongwrongwrongwr", genTokenForRevoke(t, r)} {
		code, out := doJSON(r, http.MethodPost, "/api/quickdrop",
			`{"token":"`+tok+`","content":"hello"}`)
		if code != http.StatusNotFound {
			t.Fatalf("token %q status = %d, want 404: %v", tok, code, out)
		}
		if msg, _ := out["error"].(string); msg != "not found" {
			t.Fatalf("404 body = %v, want bare not-found", out)
		}
		if code, _ := doJSON(r, http.MethodGet, "/drop/"+tok, ""); code != http.StatusNotFound {
			t.Fatalf("drop page token %q status = %d, want 404", tok, code)
		}
	}
	// 收件箱保持空
	list, _ := store.Get().Quickdrop.List()
	if len(list) != 0 {
		t.Fatalf("rejected drops must not be stored, got %d", len(list))
	}
}

// genTokenForRevoke 生成再撤销一枚凭据（供「已撤销 → 404」用例）
func genTokenForRevoke(t *testing.T, r *gin.Engine) string {
	t.Helper()
	plain := genToken(t, r)
	if code, _ := doJSON(r, http.MethodDelete, "/api/quickdrop/token", ""); code != http.StatusOK {
		t.Fatalf("revoke status: %d", code)
	}
	return plain
}

func TestPostDropArrives(t *testing.T) {
	r := newQuickdropRouter(t)
	token := genToken(t, r)

	code, out := doJSON(r, http.MethodPost, "/api/quickdrop",
		`{"token":"`+token+`","content":"panic: nil map in handler.go:42"}`)
	if code != http.StatusOK {
		t.Fatalf("post status = %d: %v", code, out)
	}
	data, _ := out["data"].(map[string]any)
	if data == nil || data["id"] == nil || data["expiresAt"] == nil {
		t.Fatalf("missing arrival payload: %v", out)
	}

	// 收件箱入账（内容/来源/24h TTL）
	list, err := store.Get().Quickdrop.List()
	if err != nil || len(list) != 1 {
		t.Fatalf("inbox: %v %d", err, len(list))
	}
	if list[0].Content != "panic: nil map in handler.go:42" || list[0].From == "" {
		t.Fatalf("stored drop wrong: %+v", list[0])
	}

	// 到达通知：类别 drop + 行内动作双出口（payload 前缀指向本投递）
	notifs := store.Get().Notification.List(10)
	if len(notifs) != 1 {
		t.Fatalf("notification count = %d, want 1", len(notifs))
	}
	n := notifs[0]
	if n.Category != "drop" || n.TitleKey != "notify.quickdrop.arrived" {
		t.Fatalf("notification category/titleKey wrong: %+v", n)
	}
	if !strings.HasPrefix(n.ActionPayload, PayloadPrefix) || !strings.HasPrefix(n.SecondActionPayload, PayloadPrefix) {
		t.Fatalf("action payloads wrong: %q / %q", n.ActionPayload, n.SecondActionPayload)
	}
	if n.Action != "quickdrop-active" || n.SecondAction != "quickdrop-new" {
		t.Fatalf("actions wrong: %q / %q", n.Action, n.SecondAction)
	}
	id := list[0].ID
	if n.ActionPayload != PayloadPrefix+id || n.SecondActionPayload != PayloadPrefix+id {
		t.Fatalf("payload id mismatch: %q vs %s", n.ActionPayload, id)
	}
	// 摘要行进入 Body 且含原文（无敏感词形态不被遮蔽破坏）
	if !strings.Contains(n.Body, "panic: nil map") {
		t.Fatalf("summary body = %q, want content line", n.Body)
	}

	// 审计入账：动作在、正文不在（P-13 纪律）
	events, _, _ := store.Get().Audit.List(10, 0)
	found := false
	for _, e := range events {
		if e.Action == "quickdrop.drop" {
			found = true
			if strings.Contains(e.Detail, "panic") || strings.Contains(e.Detail, "handler.go") {
				t.Fatalf("audit detail leaks content: %q", e.Detail)
			}
			if !strings.Contains(e.Detail, "bytes=") {
				t.Fatalf("audit detail missing size: %q", e.Detail)
			}
		}
	}
	if !found {
		t.Fatal("quickdrop.drop audit event missing")
	}
}

func TestPostDropGuards(t *testing.T) {
	r := newQuickdropRouter(t)
	token := genToken(t, r)

	// 空内容 400
	if code, _ := doJSON(r, http.MethodPost, "/api/quickdrop",
		`{"token":"`+token+`","content":"   \n  "}`); code != http.StatusBadRequest {
		t.Fatalf("empty content status = %d, want 400", code)
	}
	// 超限 413（4KB 字节口径）
	big := strings.Repeat("a", store.MaxDropBytes+1)
	if code, _ := doJSON(r, http.MethodPost, "/api/quickdrop",
		`{"token":"`+token+`","content":"`+big+`"}`); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize status = %d, want 413", code)
	}
	// 请求体封顶（16KB）→ 413
	if code, _ := doJSON(r, http.MethodPost, "/api/quickdrop",
		`{"token":"`+token+`","content":"`+strings.Repeat("a", dropMaxBody+10)+`"}`); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("body over cap status = %d, want 413", code)
	}
	list, _ := store.Get().Quickdrop.List()
	if len(list) != 0 {
		t.Fatalf("rejected drops must not be stored, got %d", len(list))
	}
}

func TestDropBriefMasksSecrets(t *testing.T) {
	// 含密钥形态内容的摘要先遮蔽（遮蔽在前防截断切漏片段）
	got := dropBrief("token = ghp_Abcdefghijklmnopqrstuvwxyz012345\nsecond line")
	if strings.Contains(got, "ghp_") {
		t.Fatalf("brief leaks secret: %q", got)
	}
	// 首条非空行入选
	if got == "" || strings.Contains(got, "second line") {
		t.Fatalf("brief should be first non-empty line only: %q", got)
	}
	// 纯空白返回空串
	if dropBrief("\n  \n") != "" {
		t.Fatal("blank content brief must be empty")
	}
}

func TestGuestPageFlow(t *testing.T) {
	r := newQuickdropRouter(t)
	token := genToken(t, r)

	// 页面渲染：表单 + token 无效 404
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/drop/"+token, nil))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "<textarea") {
		t.Fatalf("page status = %d, want 200 with form", w.Code)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("drop page must be no-store (token in URL)")
	}

	// 表单提交 → 303 PRG 回跳成功态；内容入收件箱
	w = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/drop/"+token, strings.NewReader("content=from+my+phone"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusSeeOther {
		t.Fatalf("form post status = %d, want 303", w.Code)
	}
	if loc := w.Header().Get("Location"); !strings.HasPrefix(loc, "/drop/"+token+"?sent=1") {
		t.Fatalf("redirect = %q", loc)
	}
	list, _ := store.Get().Quickdrop.List()
	if len(list) != 1 || list[0].Content != "from my phone" {
		t.Fatalf("form drop not stored: %+v", list)
	}

	// 成功态页面渲染已送达横幅
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/drop/"+token+"?sent=1", nil))
	if !strings.Contains(w.Body.String(), "已送达") {
		t.Fatal("sent banner missing")
	}

	// 校验失败重渲染：保留输入 + 错误横幅（400，非裸页）
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/drop/"+token, strings.NewReader("content="))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "内容为空") {
		t.Fatalf("empty form post status = %d", w.Code)
	}

	// 无效 token 的表单提交 → 404 页（不走 ingest）
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/drop/scd_invalidinvalidinvalidinvalidinv", strings.NewReader("content=x"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("invalid-token form post status = %d, want 404", w.Code)
	}
}

func TestInboxManagementFace(t *testing.T) {
	r := newQuickdropRouter(t)
	token := genToken(t, r)

	doJSON(r, http.MethodPost, "/api/quickdrop", `{"token":"`+token+`","content":"first"}`)
	doJSON(r, http.MethodPost, "/api/quickdrop", `{"token":"`+token+`","content":"second"}`)

	// 清单（新→旧，带 size 投影）
	code, out := doJSON(r, http.MethodGet, "/api/quickdrop", "")
	if code != http.StatusOK {
		t.Fatalf("list status = %d", code)
	}
	items, _ := out["data"].([]any)
	if len(items) != 2 {
		t.Fatalf("list len = %d, want 2", len(items))
	}
	first, _ := items[0].(map[string]any)
	if first["content"] != "second" {
		t.Fatalf("list must be newest-first: %v", first)
	}
	if n, _ := first["size"].(float64); int(n) != len("second") {
		t.Fatalf("size projection = %v", first["size"])
	}

	// 摘除：未知 id 幂等成功；摘除后清单缩短
	id, _ := first["id"].(string)
	if code, _ = doJSON(r, http.MethodDelete, "/api/quickdrop/"+id, ""); code != http.StatusOK {
		t.Fatalf("delete status = %d", code)
	}
	if code, _ = doJSON(r, http.MethodDelete, "/api/quickdrop/sc_qd_unknown", ""); code != http.StatusOK {
		t.Fatalf("delete unknown id status = %d, want 200 idempotent", code)
	}
	_, out = doJSON(r, http.MethodGet, "/api/quickdrop", "")
	items, _ = out["data"].([]any)
	if len(items) != 1 {
		t.Fatalf("list after delete len = %d, want 1", len(items))
	}

	// 凭据元信息不含明文
	_, out = doJSON(r, http.MethodGet, "/api/quickdrop/token", "")
	meta, _ := out["data"].(map[string]any)
	if meta["exists"] != true || meta["prefix"] == nil || meta["token"] != nil {
		t.Fatalf("token meta = %v, want exists+prefix without plain", meta)
	}
}

// TestTokenRotateInvalidatesOld 轮换：旧凭据即刻 404，新凭据可投递
func TestTokenRotateInvalidatesOld(t *testing.T) {
	r := newQuickdropRouter(t)
	oldToken := genToken(t, r)
	newToken := genToken(t, r) // 生成即轮换
	if oldToken == newToken {
		t.Fatal("rotate must produce a new token")
	}
	if code, _ := doJSON(r, http.MethodPost, "/api/quickdrop",
		`{"token":"`+oldToken+`","content":"x"}`); code != http.StatusNotFound {
		t.Fatalf("old token after rotate = %d, want 404", code)
	}
	if code, _ := doJSON(r, http.MethodPost, "/api/quickdrop",
		`{"token":"`+newToken+`","content":"x"}`); code != http.StatusOK {
		t.Fatalf("new token = %d, want 200", code)
	}
}
