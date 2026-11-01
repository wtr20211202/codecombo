package notification

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// ============== 模板插值 ==============

func TestInterpolate(t *testing.T) {
	got := Interpolate("https://x/hook?title={title}&body={body}", "标题", "正 文&r=1")
	// 值由调用方（SendWebhook GET 分支）转义，这里只验证占位符替换本身
	want := "https://x/hook?title=标题&body=正 文&r=1"
	if got != want {
		t.Fatalf("Interpolate = %q, want %q", got, want)
	}
	if Interpolate("no-placeholder", "a", "b") != "no-placeholder" {
		t.Fatalf("Interpolate should leave text without placeholders intact")
	}
}

// ============== GET/POST 双模式 + httptest 接收断言 ==============

func TestSendWebhookPostJSON(t *testing.T) {
	var mu sync.Mutex
	var gotPath string
	var gotTitle, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		gotPath = r.URL.Path
		b, _ := io.ReadAll(r.Body)
		var payload map[string]string
		_ = json.Unmarshal(b, &payload)
		gotTitle, gotBody = payload["title"], payload["body"]
		if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
			t.Errorf("content-type = %q", ct)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	w := WebhookPrefs{Enabled: true, Mode: WebhookModePost, URL: srv.URL + "/hook?key=secret"}
	if err := SendWebhook(w, "t1", "b1"); err != nil {
		t.Fatalf("SendWebhook: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if gotPath != "/hook" || gotTitle != "t1" || gotBody != "b1" {
		t.Fatalf("received path=%q title=%q body=%q", gotPath, gotTitle, gotBody)
	}
}

func TestSendWebhookGetTemplate(t *testing.T) {
	var mu sync.Mutex
	var gotRawQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		gotRawQuery = r.URL.RawQuery
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	w := WebhookPrefs{Enabled: true, Mode: WebhookModeGet, URL: srv.URL + "/push?title={title}&body={body}"}
	if err := SendWebhook(w, "标题 空格", "a&b=c"); err != nil {
		t.Fatalf("SendWebhook: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	// 值按查询参数转义：空格 → +（QueryEscape），&/= 不破坏 query 结构
	if gotRawQuery != "title=%E6%A0%87%E9%A2%98+%E7%A9%BA%E6%A0%BC&body=a%26b%3Dc" {
		t.Fatalf("raw query = %q", gotRawQuery)
	}
}

func TestSendWebhookNon2xxRejected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	if err := SendWebhook(WebhookPrefs{Enabled: true, Mode: WebhookModePost, URL: srv.URL}, "t", "b"); err == nil {
		t.Fatalf("expected error on 500 response")
	}
}

func TestSendWebhookRejectsNonHTTPScheme(t *testing.T) {
	if err := SendWebhook(WebhookPrefs{Enabled: true, Mode: WebhookModePost, URL: "ftp://x/y"}, "t", "b"); err == nil {
		t.Fatalf("expected error for non-http scheme")
	}
}

// ============== 超时 ==============

func TestSendWebhookTimeout(t *testing.T) {
	// 换短超时 client 验证超时语义（正式 5s 不在用例里干等）
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(300 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	old := webhookClient
	webhookClient = &http.Client{Timeout: 50 * time.Millisecond}
	defer func() { webhookClient = old }()

	if err := SendWebhook(WebhookPrefs{Enabled: true, Mode: WebhookModePost, URL: srv.URL}, "t", "b"); err == nil {
		t.Fatalf("expected timeout error")
	}
}

// ============== 事件过滤三态 ==============

func TestWebhookWantsThreeStates(t *testing.T) {
	failNote := Notification{Type: "error", Category: "task", Title: "部署失败"}
	warnNote := Notification{Type: "warning", Category: "task", Title: "终端异常退出"}
	infoNote := Notification{Type: "info", Category: "git", Title: "完成"}

	// 关闭：未启用/无 URL 一律不转发（Ready 门控在 Forwarder.ready）
	if (WebhookPrefs{}).Ready() {
		t.Fatalf("zero webhook prefs must not be ready")
	}
	// important（默认）：仅 error/warning
	important := WebhookPrefs{Enabled: true, URL: "http://x", Scope: WebhookScopeImportant}.Normalized()
	if !webhookWants(important, failNote) || !webhookWants(important, warnNote) {
		t.Fatalf("important scope must forward error/warning")
	}
	if webhookWants(important, infoNote) {
		t.Fatalf("important scope must not forward info")
	}
	// all：全量
	all := WebhookPrefs{Enabled: true, URL: "http://x", Scope: WebhookScopeAll}.Normalized()
	if !webhookWants(all, infoNote) {
		t.Fatalf("all scope must forward everything")
	}
	// 历史存量零值归一化：Mode/Scope 空值回退 post/important
	nz := WebhookPrefs{Enabled: true, URL: "http://x"}.Normalized()
	if nz.Mode != WebhookModePost || nz.Scope != WebhookScopeImportant {
		t.Fatalf("normalized defaults: %+v", nz)
	}
}

// ============== 转发器端到端（httptest 接收） ==============

func TestForwarderOnNotificationDelivers(t *testing.T) {
	recv := make(chan map[string]string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var payload map[string]string
		_ = json.Unmarshal(b, &payload)
		recv <- payload
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	fw := NewForwarder(func() Prefs {
		return Prefs{Webhook: WebhookPrefs{Enabled: true, Mode: WebhookModePost, URL: srv.URL, Scope: WebhookScopeAll}}
	})
	fw.OnNotification(Notification{Type: "info", Category: "git", Title: "e2e-标题", Body: "e2e-正文"})

	select {
	case p := <-recv:
		if p["title"] != "e2e-标题" || p["body"] != "e2e-正文" {
			t.Fatalf("payload = %+v", p)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("webhook not delivered")
	}
}

func TestForwarderFiltersByScope(t *testing.T) {
	recv := make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		recv <- struct{}{}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	// important 范围：info 通知不外发
	fw := NewForwarder(func() Prefs {
		return Prefs{Webhook: WebhookPrefs{Enabled: true, Mode: WebhookModePost, URL: srv.URL, Scope: WebhookScopeImportant}}
	})
	fw.OnNotification(Notification{Type: "info", Category: "git", Title: "普通完成"})
	select {
	case <-recv:
		t.Fatalf("info must not be forwarded under important scope")
	case <-time.After(300 * time.Millisecond):
	}

	// error 通知外发
	fw.OnNotification(Notification{Type: "error", Category: "task", Title: "失败"})
	select {
	case <-recv:
	case <-time.After(2 * time.Second):
		t.Fatalf("error notification must be forwarded")
	}
}

func TestForwarderApprovalPending(t *testing.T) {
	recv := make(chan map[string]string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var payload map[string]string
		_ = json.Unmarshal(b, &payload)
		recv <- payload
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	// important（默认范围）下审批挂起必须外发
	fw := NewForwarder(func() Prefs {
		return Prefs{Webhook: WebhookPrefs{Enabled: true, Mode: WebhookModePost, URL: srv.URL}}
	})
	// 载荷模拟 store.AgentApproval（JSON 字段对齐，Forwarder 经 JSON 往返提取）
	fw.OnApprovalPending(map[string]any{"agent": "claude", "op": "git push", "target": "/repo", "detail": "d"})

	select {
	case p := <-recv:
		if !strings.Contains(p["title"], "审批挂起") {
			t.Fatalf("title = %q", p["title"])
		}
		if !strings.Contains(p["body"], "git push") || !strings.Contains(p["body"], "/repo") {
			t.Fatalf("body = %q", p["body"])
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("approval webhook not delivered")
	}
}

func TestForwarderIdleWhenDisabled(t *testing.T) {
	// 未装配偏好口 / 未启用：no-op 不 panic、不出网
	var nilFW *Forwarder
	nilFW.OnNotification(Notification{Type: "error", Title: "x"})
	nilFW.OnApprovalPending(map[string]any{})

	fw := NewForwarder(nil)
	fw.OnNotification(Notification{Type: "error", Title: "x"})
}

func TestSendTest(t *testing.T) {
	// 未启用即报配置错误
	if err := SendTest(Prefs{}); err == nil {
		t.Fatalf("SendTest must fail on disabled webhook")
	}

	recv := make(chan map[string]string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var payload map[string]string
		_ = json.Unmarshal(b, &payload)
		recv <- payload
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	err := SendTest(Prefs{Webhook: WebhookPrefs{Enabled: true, Mode: WebhookModePost, URL: srv.URL}})
	if err != nil {
		t.Fatalf("SendTest: %v", err)
	}
	select {
	case p := <-recv:
		if !strings.Contains(p["title"], "Test Push") {
			t.Fatalf("test payload title = %q", p["title"])
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("test push not delivered")
	}
}

// ============== 出域遮蔽闸（P-20261007-9） ==============

// TestForwarderOnNotificationMasksSecrets 通知外发前统一遮蔽：sc?_ 系令牌/
// password 赋值/AWS 密钥三形态替换为 ***（键名与分隔符保留），主机名/地址端口/
// 路径等排障信息零误伤照常外发——「出域才脱敏」分层语义的钉死断言
func TestForwarderOnNotificationMasksSecrets(t *testing.T) {
	recv := make(chan map[string]string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var payload map[string]string
		_ = json.Unmarshal(b, &payload)
		recv <- payload
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	fw := NewForwarder(func() Prefs {
		return Prefs{Webhook: WebhookPrefs{Enabled: true, Mode: WebhookModePost, URL: srv.URL, Scope: WebhookScopeAll}}
	})
	// 部署失败样通知（P-289 实证形态：主机/地址端口 + 路径）叠加密钥三形态
	fw.OnNotification(Notification{
		Type: "error", Category: "task",
		Title: "部署失败 agent=sca_tokeyz9x8",
		Body: "ssh deploy@192.168.1.10:22 failed\n" +
			"CC_LOCK_TOKEN=scl_lock4t5o6k\n" +
			"password=hunter2 key=AKIAIOSFODNN7EXAMPLE\n" +
			"repo=/home/u/simple-coding",
	})

	select {
	case p := <-recv:
		joined := p["title"] + "\n" + p["body"]
		for _, secret := range []string{"sca_tokeyz9x8", "scl_lock4t5o6k", "hunter2", "AKIAIOSFODNN7EXAMPLE"} {
			if strings.Contains(joined, secret) {
				t.Fatalf("outbound payload leaks %q: %q", secret, joined)
			}
		}
		if !strings.Contains(p["title"], "agent=***") {
			t.Fatalf("title mask form = %q", p["title"])
		}
		// 键名/分隔符保留 + 排障文本原样：遮蔽的恰是不该出域的
		for _, keep := range []string{
			"deploy@192.168.1.10:22", "/home/u/simple-coding",
			"CC_LOCK_TOKEN=***", "password=***", "key=***",
		} {
			if !strings.Contains(p["body"], keep) {
				t.Fatalf("body lost %q: %q", keep, p["body"])
			}
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("webhook not delivered")
	}
}

// TestForwarderApprovalPendingMasksSecrets 审批挂起外发遮蔽：Op 字段入库口
// 未遮蔽、总线载荷也可能未经脱敏（老生产方）——外发面单点收敛兜底；审批链
// 入库已 mask 的 Detail（*** 形态）再过闸幂等不变形
func TestForwarderApprovalPendingMasksSecrets(t *testing.T) {
	recv := make(chan map[string]string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var payload map[string]string
		_ = json.Unmarshal(b, &payload)
		recv <- payload
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	fw := NewForwarder(func() Prefs {
		return Prefs{Webhook: WebhookPrefs{Enabled: true, Mode: WebhookModePost, URL: srv.URL}}
	})
	fw.OnApprovalPending(map[string]any{
		"agent": "claude", "op": "git push",
		"target": "/srv/repo token=sca_tok99aa22",
		"detail": "password=***",
	})

	select {
	case p := <-recv:
		if strings.Contains(p["body"], "sca_tok99aa22") {
			t.Fatalf("approval body leaks token: %q", p["body"])
		}
		if !strings.Contains(p["body"], "token=***") {
			t.Fatalf("approval body mask form = %q", p["body"])
		}
		// 幂等：已脱敏值再过闸恰一次替换（无双写/双 *** 叠加）
		if n := strings.Count(p["body"], "password=***"); n != 1 {
			t.Fatalf("idempotent re-mask must keep exactly one ***, got %d: %q", n, p["body"])
		}
		// 零误伤：op 与目标路径照常外发
		if !strings.Contains(p["body"], "git push") || !strings.Contains(p["body"], "/srv/repo") {
			t.Fatalf("approval body lost plain text: %q", p["body"])
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("approval webhook not delivered")
	}
}
