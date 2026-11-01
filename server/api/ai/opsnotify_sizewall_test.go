package ai

import (
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// ops-notify 发布口尺寸墙（P-20261004-130）单测：
// 请求体 64KB 封顶（LimitBody → 413）/ 通知文本字段 4096 字节封顶（400 退回）
// / 恰在边界的合法载荷零回归。ops-ask 家族请求体总限同款封顶一并覆盖。

// setupSizeWallTest 尺寸墙测试装配：与 setupNotifyTest 同构 + 限流器复位——
// 限流器跨用例共享（见 resetRateLimitTest 注记），不复位会与既有用例互相污染计数
func setupSizeWallTest(t *testing.T) *gin.Engine {
	t.Helper()
	r := setupNotifyTest(t)
	resetRateLimiters(t)
	return r
}

// TestOpsNotify_BodySizeWall 请求体总限：超 64KB 的载荷 413 退回（与广播面
// JSON marshal 内存放大同防，terminal.body_too_large 同语义）且不进广播流；
// 恰在边界（=64KB）的合法载荷照常发布零回归
func TestOpsNotify_BodySizeWall(t *testing.T) {
	r := setupSizeWallTest(t)
	rec := recordEvents(t)

	// 超限：64KB + 1 字节 → 413 + ops.payload_too_large，不广播
	oversized := `{"type":"navigate","payload":{"path":"/p/` + strings.Repeat("a", opsNotifyMaxBody) + `"}}`
	w := doJSON(r, http.MethodPost, "/api/ops-notify", oversized)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body expect 413, got %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "ops.payload_too_large") {
		t.Fatalf("oversized body expect code ops.payload_too_large, got %s", w.Body.String())
	}
	if got := len(rec.of("navigate")); got != 0 {
		t.Fatalf("oversized body must not broadcast, published = %d", got)
	}

	// 边界：恰 64KB → MaxBytesReader 放行，照常发布
	prefix := `{"type":"navigate","payload":{"path":"/p/`
	suffix := `"}}`
	fill := strings.Repeat("a", opsNotifyMaxBody-len(prefix)-len(suffix))
	boundary := prefix + fill + suffix
	if len(boundary) != opsNotifyMaxBody {
		t.Fatalf("boundary body size mismatch: %d != %d", len(boundary), opsNotifyMaxBody)
	}
	w = doJSON(r, http.MethodPost, "/api/ops-notify", boundary)
	if w.Code != http.StatusOK {
		t.Fatalf("boundary body (=64KB) expect 200, got %d body=%s", w.Code, w.Body.String())
	}
	if got := len(rec.of("navigate")); got != 1 {
		t.Fatalf("boundary body must broadcast once, published = %d", got)
	}
}

// TestOpsNotify_TextFieldSizeWall 通知文本字段封顶：task.progress 步骤名 /
// preview.port label 超 4096 字节 400 退回（内置事件载荷校验同款错误码），
// 恰在边界的合法清单照常发布——单条巨型 step 串不再经校验直达广播流
func TestOpsNotify_TextFieldSizeWall(t *testing.T) {
	r := setupSizeWallTest(t)
	rec := recordEvents(t)

	// 步骤名超限 → 400 不广播
	tooLongStep := `{"type":"task.progress","payload":{"task":"t","status":"running","steps":[{"name":"` + strings.Repeat("a", opsNotifyTextMax+1) + `"}]}}`
	w := doJSON(r, http.MethodPost, "/api/ops-notify", tooLongStep)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("oversized step name expect 400, got %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "invalid task.progress payload") {
		t.Fatalf("expect invalid payload message, got %s", w.Body.String())
	}
	if got := len(rec.of("task.progress")); got != 0 {
		t.Fatalf("oversized step name must not broadcast, published = %d", got)
	}

	// 步骤名恰在边界 → 200 照常发布（合法长通知零误伤）
	boundaryStep := `{"type":"task.progress","payload":{"task":"t","status":"running","steps":[{"name":"` + strings.Repeat("a", opsNotifyTextMax) + `"}]}}`
	w = doJSON(r, http.MethodPost, "/api/ops-notify", boundaryStep)
	if w.Code != http.StatusOK {
		t.Fatalf("boundary step name (=4096 bytes) expect 200, got %d body=%s", w.Code, w.Body.String())
	}
	if got := len(rec.of("task.progress")); got != 1 {
		t.Fatalf("boundary step name must broadcast once, published = %d", got)
	}

	// preview.port label 超限 → 400（展示文本同受封顶）
	tooLongLabel := `{"type":"preview.port","payload":{"port":3000,"label":"` + strings.Repeat("a", opsNotifyTextMax+1) + `"}}`
	w = doJSON(r, http.MethodPost, "/api/ops-notify", tooLongLabel)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("oversized label expect 400, got %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "invalid preview.port payload") {
		t.Fatalf("expect invalid payload message, got %s", w.Body.String())
	}
	if got := len(rec.of("preview.port")); got != 0 {
		t.Fatalf("oversized label must not broadcast, published = %d", got)
	}

	// label 恰在边界 → 200 照常发布
	boundaryLabel := `{"type":"preview.port","payload":{"port":3000,"label":"` + strings.Repeat("a", opsNotifyTextMax) + `"}}`
	w = doJSON(r, http.MethodPost, "/api/ops-notify", boundaryLabel)
	if w.Code != http.StatusOK {
		t.Fatalf("boundary label (=4096 bytes) expect 200, got %d body=%s", w.Code, w.Body.String())
	}
	if got := len(rec.of("preview.port")); got != 1 {
		t.Fatalf("boundary label must broadcast once, published = %d", got)
	}
}

// TestAgentAsk_BodySizeWall ops-ask 家族请求体总限（P-20261004-130 对齐）：
// create / answer 两入口超 64KB 均 413（字段上限之外的畸形巨型请求体挡在
// 解析期），合法载荷照常创建零回归
func TestAgentAsk_BodySizeWall(t *testing.T) {
	r := setupAskTest(t)

	oversized := `{"question":"` + strings.Repeat("a", askBodyMaxBytes) + `"}`
	w := doJSON(r, http.MethodPost, "/api/ops-ask", oversized)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized create body expect 413, got %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "exceeds 65536 bytes") {
		t.Fatalf("expect size detail in message, got %s", w.Body.String())
	}

	w = doJSON(r, http.MethodPost, "/api/ops-ask/ask-x/answer",
		`{"answer":"`+strings.Repeat("a", askBodyMaxBytes)+`"}`)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized answer body expect 413, got %d body=%s", w.Code, w.Body.String())
	}

	// 合法载荷零回归：正常创建照常 200
	w = doJSON(r, http.MethodPost, "/api/ops-ask", `{"terminalId":"sz-term-1","question":"继续吗？"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("legal create expect 200, got %d body=%s", w.Code, w.Body.String())
	}
}
