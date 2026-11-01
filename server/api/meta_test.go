package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"codecombo/server/kernel"

	"github.com/gin-gonic/gin"
)

// /api/meta 能力探测端点（P-20261004-4）：响应形状 + 能力项聚合。
// 能力项与真实路由的对账门禁在 server/app/meta_conformance_test.go
//（两侧装配面不同：本包只测处理器语义，对账需组合根 builtinModules）

func metaServe(t *testing.T) (*httptest.ResponseRecorder, MetaResponse) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/meta", HandleMeta)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/meta", nil))
	var resp MetaResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("response not valid MetaResponse JSON: %v\n%s", err, w.Body.String())
	}
	return w, resp
}

// TestHandleMeta_Shape 形状：公开 200、版本载荷非空、能力项为数组非 null
// （未注入内核时前端 []string 直读不炸）
func TestHandleMeta_Shape(t *testing.T) {
	w, resp := metaServe(t)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if resp.Version.Version == "" || resp.Version.Commit == "" || resp.Version.BuildTime == "" {
		t.Errorf("version payload has empty fields: %+v", resp.Version)
	}
	if resp.Version.APIVersion != kernel.APIVersion {
		t.Errorf("apiVersion = %q, want %q", resp.Version.APIVersion, kernel.APIVersion)
	}
	if resp.Capabilities == nil {
		t.Error("capabilities = null, want []（无内核注入时也必须是数组）")
	}
}

// TestHandleMeta_Capabilities 聚合：跨模块去重 + 稳定排序；未声明模块不出项
func TestHandleMeta_Capabilities(t *testing.T) {
	k := kernel.New(nil)
	for _, mf := range []kernel.Manifest{
		{Name: "a", Capabilities: []string{"notes", "fetch-all"}},
		{Name: "b", Capabilities: []string{"fetch-all", "flat-file-list"}},
		{Name: "c"}, // 无能力声明
	} {
		if err := k.Register(stubMetaModule{}, mf); err != nil {
			t.Fatalf("register %s: %v", mf.Name, err)
		}
	}
	prev := kernelDefault
	SetKernel(k)
	defer func() { kernelDefault = prev }()

	_, resp := metaServe(t)
	want := []string{"fetch-all", "flat-file-list", "notes"}
	if len(resp.Capabilities) != len(want) {
		t.Fatalf("capabilities = %v, want %v", resp.Capabilities, want)
	}
	for i := range want {
		if resp.Capabilities[i] != want[i] {
			t.Fatalf("capabilities = %v, want sorted dedup %v", resp.Capabilities, want)
		}
	}
}

// stubMetaModule 最小模块桩（仅满足注册契约；元数据全在 Manifest，生命周期不参与）
type stubMetaModule struct{}

func (stubMetaModule) Name() string                               { return "stub" }
func (stubMetaModule) DependsOn() []string                        { return nil }
func (stubMetaModule) Init(context.Context, kernel.Kernel) error  { return nil }
func (stubMetaModule) Start(context.Context, kernel.Kernel) error { return nil }
func (stubMetaModule) Stop(context.Context, kernel.Kernel) error  { return nil }
