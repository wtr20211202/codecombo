package ai

import (
	"net/http"
	"strings"
	"testing"
)

// frontend 动词族三原子（P-20261023-4）发布口校验单测：载荷校验函数住在
// agentops 注册表（capabilities.go，与手册文案同文件），本组测试钉发布口的
// HTTP 面——坏载荷 400 退回且 message 是注册表冻结原文（e2e 逐字断言的
// 服务端同源口径），合法载荷 200 放行进广播流。限流沿 ops-notify 既有
// 60 条/分钟/会话（opsNotifyLimiter），本族零特判，不再另测。

func TestOpsNotify_FrontendDownloadPayload(t *testing.T) {
	r := setupNotifyTest(t)

	valid := []string{
		`{"type":"frontend.download","payload":{"path":"reports/a.md","projectId":"p1"}}`,
		`{"type":"frontend.download","payload":{"path":" reports/a.md ","projectId":" p1 "}}`, // trim 规整
	}
	for _, body := range valid {
		w := doJSON(r, http.MethodPost, "/api/ops-notify", body)
		if w.Code != http.StatusOK {
			t.Fatalf("%s expect 200, got %d body=%s", body, w.Code, w.Body.String())
		}
	}

	invalid := []string{
		`{"type":"frontend.download","payload":{}}`,                                      // 双缺
		`{"type":"frontend.download","payload":{"path":"a.md"}}`,                         // 缺 projectId
		`{"type":"frontend.download","payload":{"projectId":"p"}}`,                       // 缺 path
		`{"type":"frontend.download","payload":{"path":"","projectId":"p"}}`,             // 空 path
		`{"type":"frontend.download","payload":{"path":"../escape.md","projectId":"p"}}`, // .. 段
		`{"type":"frontend.download","payload":{"path":"a\\b.md","projectId":"p"}}`,      // 反斜杠
		`{"type":"frontend.download","payload":{"path":"/abs/a.md","projectId":"p"}}`,    // 绝对路径
		`{"type":"frontend.download","payload":{"path":"C:/tmp/a.md","projectId":"p"}}`,  // 盘符
		`{"type":"frontend.download","payload":{"path":"a.md","projectId":""}}`,          // 空 projectId
	}
	for _, body := range invalid {
		w := doJSON(r, http.MethodPost, "/api/ops-notify", body)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s expect 400, got %d body=%s", body, w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), "invalid frontend.download payload") {
			t.Fatalf("%s message 应为注册表冻结原文, got %s", body, w.Body.String())
		}
	}
}

func TestOpsNotify_FrontendClipboardPayload(t *testing.T) {
	r := setupNotifyTest(t)

	valid := []string{
		`{"type":"frontend.clipboard","payload":{"text":"git rebase -i HEAD~3"}}`,
		`{"type":"frontend.clipboard","payload":{"text":" 保留首尾空白 \n"}}`, // 逐字透传不 trim
		// 纯空白文本同样放行：载荷是「待粘贴的逐字内容」，非空字节即合法（写三
		// 个空格无害且 toast 预览可见），拒了反而破坏逐字语义的一致口径
		`{"type":"frontend.clipboard","payload":{"text":"   "}}`,
		`{"type":"frontend.clipboard","payload":{"text":"` + strings.Repeat("a", 32*1024) + `"}}`, // 恰 32KB
	}
	for _, body := range valid {
		w := doJSON(r, http.MethodPost, "/api/ops-notify", body)
		if w.Code != http.StatusOK {
			t.Fatalf("%s expect 200, got %d body=%s", body, w.Code, w.Body.String())
		}
	}

	invalid := []string{
		`{"type":"frontend.clipboard","payload":{}}`,                                                // 缺 text
		`{"type":"frontend.clipboard","payload":{"text":""}}`,                                       // 空文本
		`{"type":"frontend.clipboard","payload":{"text":"` + strings.Repeat("a", 32*1024+1) + `"}}`, // 超 32KB
		`{"type":"frontend.clipboard","payload":{"text":123}}`,                                      // 非字符串
	}
	for _, body := range invalid {
		w := doJSON(r, http.MethodPost, "/api/ops-notify", body)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s expect 400, got %d body=%s", body, w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), "invalid frontend.clipboard payload") {
			t.Fatalf("%s message 应为注册表冻结原文, got %s", body, w.Body.String())
		}
	}
}

func TestOpsNotify_FrontendOpenPayload(t *testing.T) {
	r := setupNotifyTest(t)

	valid := []string{
		`{"type":"frontend.open","payload":{"url":"https://ci.example.com/run/42"}}`,
		`{"type":"frontend.open","payload":{"url":" http://127.0.0.1:9999/monitor "}}`, // trim 规整
	}
	for _, body := range valid {
		w := doJSON(r, http.MethodPost, "/api/ops-notify", body)
		if w.Code != http.StatusOK {
			t.Fatalf("%s expect 200, got %d body=%s", body, w.Code, w.Body.String())
		}
	}

	invalid := []string{
		`{"type":"frontend.open","payload":{}}`,                            // 缺 url
		`{"type":"frontend.open","payload":{"url":""}}`,                    // 空
		`{"type":"frontend.open","payload":{"url":"javascript:alert(1)"}}`, // 伪协议
		`{"type":"frontend.open","payload":{"url":"data:text/html,bomb"}}`, // data:
		`{"type":"frontend.open","payload":{"url":"/project?file=a.ts"}}`,  // 站内相对路径
		`{"type":"frontend.open","payload":{"url":"//evil.com/x"}}`,        // 协议相对外链
		`{"type":"frontend.open","payload":{"url":"https://a.com/x y"}}`,   // 空白
	}
	for _, body := range invalid {
		w := doJSON(r, http.MethodPost, "/api/ops-notify", body)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s expect 400, got %d body=%s", body, w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), "invalid frontend.open payload") {
			t.Fatalf("%s message 应为注册表冻结原文, got %s", body, w.Body.String())
		}
	}
}
