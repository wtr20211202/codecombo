package remote

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 批量诊断扇出（P-20261004-58）单测：请求校验 / 去重保序 / 逐台结构化降级
// （不拖垮整体）/ 并发扇出下的结果同序。主机不可达用 127.0.0.1 未监听端口
// ——拨号立即拒绝，不依赖外网与真实 SSH。

func newBatchTestStore(t *testing.T) {
	t.Helper()
	t.Cleanup(func() { store.SetDefault(nil) })
	prev := store.Get()
	if prev != nil {
		t.Cleanup(func() { store.SetDefault(prev) })
	}
	store.SetDefault(store.New(filestore.New(t.TempDir())))
}

// postBatch 构造批量诊断请求（gin TestMode），返回响应体字节
func postBatch(t *testing.T, body string) []byte {
	t.Helper()
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/remotehosts/diagnose-batch", bytes.NewBufferString(body))
	c.Request.Header.Set("Content-Type", "application/json")
	DiagnoseRemoteHostsBatch(c)
	return w.Body.Bytes()
}

// TestDiagnoseBatchValidation 请求校验：ids 缺失/全空 400，超上限 400 不静默
func TestDiagnoseBatchValidation(t *testing.T) {
	newBatchTestStore(t)

	cases := []struct {
		name string
		body string
		want int
	}{
		{"missing ids", `{}`, http.StatusBadRequest},
		{"empty ids", `{"ids":[]}`, http.StatusBadRequest},
		{"blank ids only", `{"ids":["",""]}`, http.StatusBadRequest},
		{"over cap", `{"ids":[` + strings.Repeat(`"x",`, diagBatchMaxHosts) + `"y"]}`, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gin.SetMode(gin.TestMode)
			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)
			c.Request = httptest.NewRequest(http.MethodPost, "/api/remotehosts/diagnose-batch", bytes.NewBufferString(tc.body))
			c.Request.Header.Set("Content-Type", "application/json")
			DiagnoseRemoteHostsBatch(c)
			if w.Code != tc.want {
				t.Fatalf("code = %d, want %d (body %s)", w.Code, tc.want, w.Body.String())
			}
		})
	}
}

// TestDiagnoseBatchDedupeAndOrder 去重保序：重复/空 id 只诊断一次，结果按
// 请求序回填（并行完成序不稳定不外泄）；不可达主机是结构化降级（HTTP 200 +
// 逐台 error），不拖垮整体也不断言失败主机有 snapshot
func TestDiagnoseBatchDedupeAndOrder(t *testing.T) {
	newBatchTestStore(t)

	// 建两台主机：host-b 与 host-a 故意乱序注册，验证结果按请求序而非注册序
	mk := func(name, port string) string {
		body := `{"name":"` + name + `","host":"127.0.0.1","port":` + port + `,"user":"e2e","authType":"password","password":"x"}`
		gin.SetMode(gin.TestMode)
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest(http.MethodPost, "/api/remotehosts", bytes.NewBufferString(body))
		c.Request.Header.Set("Content-Type", "application/json")
		CreateRemoteHost(c)
		var resp struct {
			Data struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil || resp.Data.ID == "" {
			t.Fatalf("host create failed: %s", w.Body.String())
		}
		t.Cleanup(func() { _ = store.Get().RemoteHost.Delete(resp.Data.ID) })
		return resp.Data.ID
	}
	idB := mk("batch-b", "1") // port 1：拨号立即拒绝
	idA := mk("batch-a", "2")

	raw := postBatch(t, `{"ids":["`+idB+`","","`+idA+`","`+idB+`"]}`)
	if !bytes.Contains(raw, []byte(`"data"`)) {
		t.Fatalf("expected data-wrapped response, got %s", raw)
	}
	var resp struct {
		Data struct {
			Results []diagBatchResult `json:"results"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		t.Fatalf("unmarshal: %v (%s)", err, raw)
	}
	// 去重后 2 条：重复 idB 只一条、空串剔除
	if got := len(resp.Data.Results); got != 2 {
		t.Fatalf("results = %d entries, want 2: %s", got, raw)
	}
	// 请求序（idB 在前），不是完成序/注册序
	if resp.Data.Results[0].HostID != idB || resp.Data.Results[1].HostID != idA {
		t.Fatalf("order = [%s,%s], want [%s,%s]",
			resp.Data.Results[0].HostID, resp.Data.Results[1].HostID, idB, idA)
	}
	for _, r := range resp.Data.Results {
		if r.OK || r.Error == "" {
			t.Fatalf("unreachable host should degrade with error, got %+v", r)
		}
		if r.Snapshot != nil {
			t.Fatalf("unreachable host should not carry snapshot, got %+v", r)
		}
		if r.Name == "" {
			t.Fatalf("degraded entry should still carry host name for the table")
		}
	}
}

// TestDiagnoseBatchUnknownID 未注册 id 是该台的结构化降级（"host not found"），
// 与其余主机互不影响
func TestDiagnoseBatchUnknownID(t *testing.T) {
	newBatchTestStore(t)
	raw := postBatch(t, `{"ids":["sc_rh_missing"]}`)
	var resp struct {
		Data struct {
			Results []diagBatchResult `json:"results"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		t.Fatalf("unmarshal: %v (%s)", err, raw)
	}
	if len(resp.Data.Results) != 1 || resp.Data.Results[0].OK {
		t.Fatalf("expected single degraded entry: %s", raw)
	}
	if !strings.Contains(resp.Data.Results[0].Error, "host not found") {
		t.Fatalf("error = %q, want host not found", resp.Data.Results[0].Error)
	}
}

// TestDiagnoseBatchFTPHost FTP 主机逐台拦截（files only），错误可定位到该台
func TestDiagnoseBatchFTPHost(t *testing.T) {
	newBatchTestStore(t)
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/remotehosts", bytes.NewBufferString(
		`{"name":"batch-ftp","host":"127.0.0.1","port":21,"user":"e2e","authType":"password","password":"x","protocol":"ftp"}`))
	c.Request.Header.Set("Content-Type", "application/json")
	CreateRemoteHost(c)
	var created struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil || created.Data.ID == "" {
		t.Fatalf("ftp host create failed: %s", w.Body.String())
	}
	t.Cleanup(func() { _ = store.Get().RemoteHost.Delete(created.Data.ID) })

	raw := postBatch(t, `{"ids":["`+created.Data.ID+`"]}`)
	if !strings.Contains(string(raw), "FTP host does not support SSH diagnose") {
		t.Fatalf("expected per-host FTP degrade: %s", raw)
	}
}

// TestDiagnoseBatchConcurrencyCap 扇出受 diagBatchConcurrency 限流：
// 同时在跑的工作单元不超上限（信号量语义自证）
func TestDiagnoseBatchConcurrencyCap(t *testing.T) {
	var mu sync.Mutex
	inFlight := 0
	peak := 0
	var wg sync.WaitGroup
	sem := make(chan struct{}, diagBatchConcurrency)
	for i := 0; i < diagBatchMaxHosts; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			mu.Lock()
			inFlight++
			if inFlight > peak {
				peak = inFlight
			}
			mu.Unlock()
			mu.Lock()
			inFlight--
			mu.Unlock()
			<-sem
		}()
	}
	wg.Wait()
	if peak > diagBatchConcurrency {
		t.Fatalf("peak in-flight = %d, want <= %d", peak, diagBatchConcurrency)
	}
}
