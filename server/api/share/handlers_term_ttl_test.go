package shareapi

// 终端直播永久挡（P-20261119-5）管理面单测：创建面 permanent×ttlMinutes 互斥
// 400（可编程感知，不静默吞标志）+ permanent×unfiltered 组合合法（【用户定向
// 修订】2026-11-19：不再 400 硬禁，撤销兜底即可——组合通过校验链落到会话存在
// 性检查）+ SetExpiry 对 terminal 的双向改期与 24h 钳（改期路径此前无钳，可把
// 直播改成任意长度甚至永久而无对冲）。创建 happy path 需真实 PTY 会话，由定向
// e2e share-terminal-live 覆盖（含 unfiltered+permanent 落库零值断言）；组合的
// store 层落库语义由 store 包 share_terminal_ttl_test 锁定；此处只锁不依赖会话
// 的校验链与改期链。

import (
	"net/http"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// newTermLiveRouter 创建/改期两端点的测试路由（store 换临时目录实例）
func newTermLiveRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := gin.New()
	r.POST("/api/share/terminal", CreateTerminalLive)
	r.POST("/api/share/:token/expiry", SetShareExpiry)
	return r
}

func TestCreateTerminalLivePermanentValidation(t *testing.T) {
	r := newTermLiveRouter(t)

	for _, tc := range []struct {
		name string
		body string
	}{
		// 两来源矛盾：请求值≠生效值会让调用方拿到非预期窗口（文件分享
		// expiresAt/ttl 互斥同口径）
		{"permanent-with-ttl", `{"sessionId":"s","permanent":true,"ttlMinutes":60}`},
	} {
		code, out := doJSON(r, http.MethodPost, "/api/share/terminal", tc.body)
		if code != http.StatusBadRequest {
			t.Fatalf("%s status = %d, want 400 (body=%v)", tc.name, code, out)
		}
	}

	// 校验链先于会话存在性：通过校验的请求落到 404（不是 400）——确保上面的
	// 400 来自互斥校验而非未知会话兜底
	if code, _ := doJSON(r, http.MethodPost, "/api/share/terminal", `{"sessionId":"no-such-session","permanent":true}`); code != http.StatusNotFound {
		t.Fatalf("permanent with unknown session status = %d, want 404", code)
	}
	// 未过滤但非永久：组合合法（落到未知会话 404）
	if code, _ := doJSON(r, http.MethodPost, "/api/share/terminal", `{"sessionId":"no-such-session","unfiltered":true}`); code != http.StatusNotFound {
		t.Fatalf("unfiltered non-permanent status = %d, want 404", code)
	}
	// permanent×unfiltered 组合合法（【用户定向修订】2026-11-19 撤销 400 硬禁）：
	// 通过校验链落到会话存在性 404（store 层落库零值由 share_terminal_ttl_test
	// 锁定、API 全链由 e2e share-terminal-live 覆盖）
	if code, _ := doJSON(r, http.MethodPost, "/api/share/terminal", `{"sessionId":"no-such-session","permanent":true,"unfiltered":true}`); code != http.StatusNotFound {
		t.Fatalf("permanent+unfiltered combo status = %d, want 404 (must pass validation, not 400)", code)
	}
}

func TestSetShareExpiryTerminal(t *testing.T) {
	r := newTermLiveRouter(t)

	live, err := store.Get().Share.Create(store.Share{Kind: store.ShareKindTerminal, TerminalID: "term-setexp", Name: "t"})
	if err != nil {
		t.Fatalf("seed terminal share: %v", err)
	}

	// 限时方向：越过 24h 的显式时点被钳回上限（「非显式永久不越 24h」不变量
	// 与创建面对称），响应即生效值
	code, out := doJSON(r, http.MethodPost, "/api/share/"+live.Token+"/expiry",
		`{"expiresAt":"`+time.Now().Add(48*time.Hour).UTC().Format(time.RFC3339)+`"}`)
	if code != http.StatusOK {
		t.Fatalf("set expiry status = %d, body = %v", code, out)
	}
	data, _ := out["data"].(map[string]any)
	if remain := time.Until(ttlResponseExpiry(t, data)); remain > store.TerminalLiveTTLMax+time.Minute {
		t.Fatalf("terminal expiry must cap to %v, got %v", store.TerminalLiveTTLMax, remain)
	}

	// 永久方向：null 清窗（与创建面 permanent 语义一致），响应不带 expiresAt
	code, out = doJSON(r, http.MethodPost, "/api/share/"+live.Token+"/expiry", `{"expiresAt":null}`)
	if code != http.StatusOK {
		t.Fatalf("set permanent status = %d, body = %v", code, out)
	}
	data, _ = out["data"].(map[string]any)
	if at := ttlResponseExpiry(t, data); !at.IsZero() {
		t.Fatalf("permanent request must clear expiresAt, got %v", at)
	}
	stored, err := store.Get().Share.Get(live.Token)
	if err != nil {
		t.Fatalf("get after clear: %v", err)
	}
	if !stored.ExpiresAt.IsZero() {
		t.Fatalf("stored expiry must be zero after clear, got %v", stored.ExpiresAt)
	}

	// 未知 token → 404（与轮换同口径）
	if code, _ := doJSON(r, http.MethodPost, "/api/share/zzzzzzzzzzzzzzzz/expiry", `{"expiresAt":null}`); code != http.StatusNotFound {
		t.Fatalf("unknown token status = %d, want 404", code)
	}
}

// TestExpiryTTLTextPermanent 审计/日志 TTL 文本（P-20261119-5 必改3）：永久记录
// 的零值 ExpiresAt 经 time.Until 会输出 ≈-2562047h 的不可读值——必须输出
// permanent 字样；限时记录仍按粒度四舍五入成可读时长
func TestExpiryTTLTextPermanent(t *testing.T) {
	if got := expiryTTLText(time.Time{}, time.Minute); got != "permanent" {
		t.Fatalf("zero expiresAt text = %q, want permanent", got)
	}
	if got := expiryTTLText(time.Now().Add(time.Hour), time.Minute); got != "1h0m0s" {
		t.Fatalf("timed expiresAt text = %q, want 1h0m0s", got)
	}
}
