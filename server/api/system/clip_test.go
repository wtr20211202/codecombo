package system

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"codecombo/server/api/opschannel"

	"github.com/gin-gonic/gin"
)

// clipPost PUT /api/clip 单槽语义的 handler 级单测（P-20261002-32）：
// 三态（写入/超限/空载荷）+ 读取即焚 + 单槽覆写 + TTL 到点自动清 + 广播。

func init() { gin.SetMode(gin.TestMode) }

// performClipRequest 组装 JSON 请求直调 handler（不挂中间件——锁保护/限流
// 由路由组装承担，本表只测 handler 契约）
func performClipRequest(t *testing.T, method, target string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		reader = bytes.NewReader(raw)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, target, reader)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = req
	switch method {
	case http.MethodPost:
		PostClip(c)
	case http.MethodGet:
		GetClip(c)
	default:
		t.Fatalf("unsupported method %s", method)
	}
	return w
}

// drainClip 清槽（用例间隔离：单槽是包级状态）
func drainClip(t *testing.T) {
	t.Helper()
	performClipRequest(t, http.MethodGet, "/api/clip", nil)
}

func TestClipPostThenGetBurns(t *testing.T) {
	drainClip(t)
	w := performClipRequest(t, http.MethodPost, "/api/clip", clipPostRequest{Content: "secret-key-123", Origin: "dev-a"})
	if w.Code != http.StatusOK {
		t.Fatalf("post status = %d, want 200", w.Code)
	}
	var postRes struct {
		OK   bool `json:"ok"`
		Size int  `json:"size"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &postRes); err != nil {
		t.Fatalf("decode post response: %v", err)
	}
	if !postRes.OK || postRes.Size != len("secret-key-123") {
		t.Fatalf("post response = %+v, want ok=true size=%d", postRes, len("secret-key-123"))
	}

	// 首次 GET 拿到内容
	w = performClipRequest(t, http.MethodGet, "/api/clip", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("first get status = %d, want 200", w.Code)
	}
	var got struct {
		Content string `json:"content"`
		Origin  string `json:"origin"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode get response: %v", err)
	}
	if got.Content != "secret-key-123" || got.Origin != "dev-a" {
		t.Fatalf("get response = %+v, want content/origin round-trip", got)
	}

	// 读取即焚：第二次 GET 404（槽空），且响应体不再含内容
	w = performClipRequest(t, http.MethodGet, "/api/clip", nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("second get status = %d, want 404 (burn-on-read)", w.Code)
	}
	if strings.Contains(w.Body.String(), "secret-key-123") {
		t.Fatalf("second get body leaks content: %s", w.Body.String())
	}
}

func TestClipOverwriteSingleSlot(t *testing.T) {
	drainClip(t)
	performClipRequest(t, http.MethodPost, "/api/clip", clipPostRequest{Content: "first"})
	performClipRequest(t, http.MethodPost, "/api/clip", clipPostRequest{Content: "second"})
	w := performClipRequest(t, http.MethodGet, "/api/clip", nil)
	if !strings.Contains(w.Body.String(), "second") || strings.Contains(w.Body.String(), "first") {
		t.Fatalf("single-slot overwrite violated: %s", w.Body.String())
	}
	drainClip(t)
}

func TestClipTooLarge(t *testing.T) {
	drainClip(t)
	// 内容字节超限（边界：恰好 32KB 放行，+1 字节拒绝）
	exact := strings.Repeat("a", clipMaxBytes)
	if w := performClipRequest(t, http.MethodPost, "/api/clip", clipPostRequest{Content: exact}); w.Code != http.StatusOK {
		t.Fatalf("exact %d bytes status = %d, want 200", clipMaxBytes, w.Code)
	}
	drainClip(t)
	over := strings.Repeat("a", clipMaxBytes+1)
	w := performClipRequest(t, http.MethodPost, "/api/clip", clipPostRequest{Content: over})
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize content status = %d, want 413", w.Code)
	}
	// 请求体膨胀形态（JSON 转义后超 clipBodyLimit）同样 413
	huge := strings.Repeat(`"`, clipBodyLimit) // 每字符转义 6 倍膨胀
	w = performClipRequest(t, http.MethodPost, "/api/clip", map[string]string{"content": huge})
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize body status = %d, want 413", w.Code)
	}
	drainClip(t)
}

func TestClipEmptyContentRejected(t *testing.T) {
	drainClip(t)
	w := performClipRequest(t, http.MethodPost, "/api/clip", clipPostRequest{Content: ""})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("empty content status = %d, want 400", w.Code)
	}
	// 拒绝后槽未被污染
	if w := performClipRequest(t, http.MethodGet, "/api/clip", nil); w.Code != http.StatusNotFound {
		t.Fatalf("slot polluted by rejected post: status = %d", w.Code)
	}
}

func TestClipTTLExpiry(t *testing.T) {
	drainClip(t)
	orig := clipTTL
	clipTTL = 30 * time.Millisecond
	defer func() { clipTTL = orig }()
	performClipRequest(t, http.MethodPost, "/api/clip", clipPostRequest{Content: "fleeting"})
	time.Sleep(80 * time.Millisecond)
	if w := performClipRequest(t, http.MethodGet, "/api/clip", nil); w.Code != http.StatusNotFound {
		t.Fatalf("get after TTL status = %d, want 404 (auto-cleared)", w.Code)
	}
}

func TestClipPostBroadcastsArrived(t *testing.T) {
	drainClip(t)
	type captured struct {
		ev opschannel.Event
	}
	got := make(chan captured, 4)
	unsub := opschannel.AddObserver(func(ev opschannel.Event) {
		if ev.Type == opschannel.EventClipboardArrived {
			got <- captured{ev: ev}
		}
	})
	defer unsub()

	performClipRequest(t, http.MethodPost, "/api/clip", clipPostRequest{Content: "hello", Origin: "dev-b"})

	select {
	case c := <-got:
		payload, ok := c.ev.Payload.(gin.H)
		if !ok {
			t.Fatalf("payload type = %T, want gin.H", c.ev.Payload)
		}
		if payload["origin"] != "dev-b" {
			t.Fatalf("payload origin = %v, want dev-b", payload["origin"])
		}
		if payload["size"] != len("hello") {
			t.Fatalf("payload size = %v, want %d", payload["size"], len("hello"))
		}
		// 内容绝不进广播面（内容留在槽内等取）
		if raw, err := json.Marshal(c.ev); err == nil && strings.Contains(string(raw), "hello") {
			t.Fatalf("broadcast leaks content: %s", raw)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("clipboard.arrived not observed within 2s")
	}
	drainClip(t)
}
