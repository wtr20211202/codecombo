package system

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"codecombo/server/model"
	"codecombo/server/update"

	"github.com/gin-gonic/gin"
)

// stubUpdateSource 固定返回错误的假源（检查失败分类测试用）
type stubUpdateSource struct{ err error }

func (s *stubUpdateSource) FetchLatest(_ context.Context, _, _ string) (*update.ReleaseInfo, error) {
	return nil, s.err
}

// stubOKSource 返回有效 ReleaseInfo 的假源（成功路径零负担断言用）
type stubOKSource struct{}

func (s *stubOKSource) FetchLatest(_ context.Context, _, _ string) (*update.ReleaseInfo, error) {
	return &update.ReleaseInfo{Version: "0.0.1-beta.3"}, nil
}

// TestCheckUpdateErrorTaxonomy 检查失败分类（P-20261106 beta.2 误报实锚）：
// 此前一切检查错误吞成 hasUpdate:false，前端再依「分发源字段为空」猜成
// 「未配置更新源」——stable 通道只有 prerelease 的 404 也走了这条路
func TestCheckUpdateErrorTaxonomy(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { update.GetManager().SetSource(nil) })

	do := func() model.CheckUpdateResponse {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest(http.MethodGet, "/api/updates/check", nil)
		CheckUpdate(c)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", w.Code)
		}
		var body struct {
			Data model.CheckUpdateResponse `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		return body.Data
	}

	// 通道空（stable 无正式版）：channelEmpty=true，不冒充「没配源」
	update.GetManager().SetSource(&stubUpdateSource{err: update.ErrNoStableRelease})
	resp := do()
	if !resp.ChannelEmpty || resp.SourceMissing || resp.CheckError != "" {
		t.Errorf("ErrNoStableRelease → channelEmpty only, got %+v", resp)
	}

	// 真没配源（Init 拒绝非法源后 nil）：sourceMissing=true
	update.GetManager().SetSource(nil)
	resp = do()
	if !resp.SourceMissing || resp.ChannelEmpty {
		t.Errorf("nil source → sourceMissing, got %+v", resp)
	}

	// 其余失败（网络/DNS）：checkError 带原文，不吞
	update.GetManager().SetSource(&stubUpdateSource{err: errors.New("dial tcp: i/o timeout")})
	resp = do()
	if resp.CheckError == "" || resp.ChannelEmpty || resp.SourceMissing {
		t.Errorf("generic error → checkError, got %+v", resp)
	}

	// 坏源返回 nil,nil：checkError 而非炸
	update.GetManager().SetSource(&stubUpdateSource{err: nil})
	resp = do()
	if resp.CheckError == "" || resp.ChannelEmpty || resp.SourceMissing {
		t.Errorf("nil-info source → checkError, got %+v", resp)
	}

	// 成功路径零负担：分类标志全零值
	update.GetManager().SetSource(&stubOKSource{})
	resp = do()
	if resp.ChannelEmpty || resp.SourceMissing || resp.CheckError != "" {
		t.Errorf("success → no flags, got %+v", resp)
	}
}

// flagStubSource 固定返回 ReleaseInfo 的假源（旗标用例专用，避免动既有 stub 家族）
type flagStubSource struct{ info *update.ReleaseInfo }

func (s *flagStubSource) FetchLatest(_ context.Context, _, _ string) (*update.ReleaseInfo, error) {
	return s.info, nil
}

// TestCheckUpdateCompanionFlag 检查旗标透出（P-20261109-9）：有更新且已注定被
// 校验拒绝 → companionFetchFailed=true + 逐资产原因；校验数据齐全 → 零负担；
// 逃生门开着 → 不置位（提示必须是真话）；无更新 → 不置位
func TestCheckUpdateCompanionFlag(t *testing.T) {
	gin.SetMode(gin.TestMode)
	// buildVersion 是包级变量：整包跑时 TestInitSetsBuildInfo 先把它设成
	// 9.9.9-test（HasUpdate 恒假）——钉住本例的「当前版本」并恢复
	oldVer := buildVersion
	buildVersion = "0.0.1"
	t.Cleanup(func() {
		buildVersion = oldVer
		update.GetManager().SetSource(nil)
	})
	// 逃生门两名都清空（开发机设过即会让「注定被拒」判定失真）
	t.Setenv(update.AllowUnverifiedEnv, "")
	t.Setenv(update.AllowUnverifiedEnvOld, "")
	do := func() model.CheckUpdateResponse {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest(http.MethodGet, "/api/updates/check", nil)
		CheckUpdate(c)
		var body struct {
			Data model.CheckUpdateResponse `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		return body.Data
	}

	// 拉取失败形态：旗标 + 原因透出
	update.GetManager().SetSource(&flagStubSource{info: &update.ReleaseInfo{
		Version: "0.0.2", ChecksumFetchErr: "status 503 (after 3 attempts)",
	}})
	resp := do()
	if !resp.HasUpdate || !resp.CompanionFetchFailed {
		t.Fatalf("failing companion → flag on, got %+v", resp)
	}
	if !strings.Contains(resp.CompanionFetchError, "status 503") {
		t.Errorf("per-asset reason missing: %q", resp.CompanionFetchError)
	}

	// 校验数据齐全：旗标不置位
	update.GetManager().SetSource(&flagStubSource{info: &update.ReleaseInfo{
		Version: "0.0.2", ChecksumSHA256: "ab",
	}})
	if resp = do(); resp.CompanionFetchFailed || resp.CompanionFetchError != "" {
		t.Errorf("healthy companion → no flag, got %+v", resp)
	}

	// 逃生门开着：此刻更新不会被拒，旗标必须不置位（提示是真话）
	t.Setenv(update.AllowUnverifiedEnv, "1")
	update.GetManager().SetSource(&flagStubSource{info: &update.ReleaseInfo{
		Version: "0.0.2", ChecksumFetchErr: "status 503",
	}})
	if resp = do(); resp.CompanionFetchFailed {
		t.Errorf("escape hatch on → no flag, got %+v", resp)
	}
	t.Setenv(update.AllowUnverifiedEnv, "")

	// 无更新（当前已是最新）：旗标不置位
	update.GetManager().SetSource(&flagStubSource{info: &update.ReleaseInfo{
		Version: "0.0.1", ChecksumFetchErr: "status 503",
	}})
	if resp = do(); resp.CompanionFetchFailed {
		t.Errorf("no update → no flag, got %+v", resp)
	}
}

// TestCheckUpdateReleaseURLPassthrough 发布页直链透传（P-20261112-2-S2）：
// ReleaseInfo.ReleaseURL → 响应 releaseUrl 同名透传（面板「查看发布页」外链
// 数据源）；源未提供时字段省略（omitempty），旧前端忽略、新前端不显链接零回退
func TestCheckUpdateReleaseURLPassthrough(t *testing.T) {
	gin.SetMode(gin.TestMode)
	// buildVersion 是包级变量：钉住「当前版本」使 HasUpdate 为真（同上方旗标用例）
	oldVer := buildVersion
	buildVersion = "0.0.1"
	t.Cleanup(func() {
		buildVersion = oldVer
		update.GetManager().SetSource(nil)
	})
	do := func() (model.CheckUpdateResponse, []byte) {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest(http.MethodGet, "/api/updates/check", nil)
		CheckUpdate(c)
		var body struct {
			Data model.CheckUpdateResponse `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		return body.Data, w.Body.Bytes()
	}

	// 源提供直链：同名透传
	update.GetManager().SetSource(&flagStubSource{info: &update.ReleaseInfo{
		Version: "0.0.2", ReleaseURL: "https://github.com/owner/repo/releases/tag/v0.0.2",
	}})
	resp, raw := do()
	if resp.ReleaseURL != "https://github.com/owner/repo/releases/tag/v0.0.2" {
		t.Errorf("ReleaseURL = %q, want passthrough", resp.ReleaseURL)
	}
	if !strings.Contains(string(raw), `"releaseUrl":`) {
		t.Errorf("response JSON missing releaseUrl key: %s", raw)
	}

	// 源未提供：字段省略（增量字段零负担），hasUpdate 等既有字段不受影响
	update.GetManager().SetSource(&flagStubSource{info: &update.ReleaseInfo{
		Version: "0.0.2",
	}})
	resp, raw = do()
	if resp.ReleaseURL != "" {
		t.Errorf("ReleaseURL = %q, want empty", resp.ReleaseURL)
	}
	if strings.Contains(string(raw), "releaseUrl") {
		t.Errorf("empty ReleaseURL should be omitted: %s", raw)
	}
	if !resp.HasUpdate {
		t.Errorf("hasUpdate should be unaffected, got %+v", resp)
	}
}

// TestCheckUpdateNpmManagedFlag npm 安装形态旗标透出（P-20261113-4-S1）：
// check（成功/失败两路径）与 status 响应携带 npmManaged（与 ApplyUpdate 拒绝闸
// 同源判定 update.Manager.NpmManaged）；非 npm 形态 omitempty 省略零负担。
// 判定走 env 通道（CODECOMBO_INSTALLER=npm）——测试二进制不在 node_modules，
// 路径通道恒假，env 注入即唯一可控置位口
func TestCheckUpdateNpmManagedFlag(t *testing.T) {
	gin.SetMode(gin.TestMode)
	// env 钉空：默认态确定性为非 npm（测试机若设过 CODECOMBO_INSTALLER 会让
	// 「非 npm」前提失真）
	t.Setenv("CODECOMBO_INSTALLER", "")
	t.Cleanup(func() { update.GetManager().SetSource(nil) })

	doCheck := func() (model.CheckUpdateResponse, []byte) {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest(http.MethodGet, "/api/updates/check", nil)
		CheckUpdate(c)
		var body struct {
			Data model.CheckUpdateResponse `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		return body.Data, w.Body.Bytes()
	}
	doStatus := func() (model.UpdateStatusResponse, []byte) {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest(http.MethodGet, "/api/updates/status", nil)
		GetUpdateStatus(c)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", w.Code)
		}
		var body struct {
			Data model.UpdateStatusResponse `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		return body.Data, w.Body.Bytes()
	}

	// 非 npm 形态：check 成功路径字段省略（omitempty）
	update.GetManager().SetSource(&flagStubSource{info: &update.ReleaseInfo{Version: "0.0.2"}})
	resp, raw := doCheck()
	if resp.NpmManaged {
		t.Errorf("non-npm install → flag off, got %+v", resp)
	}
	if strings.Contains(string(raw), "npmManaged") {
		t.Errorf("non-npm install → key omitted: %s", raw)
	}

	// env 注入 npm：check 成功路径置位
	t.Setenv("CODECOMBO_INSTALLER", "npm")
	if resp, raw = doCheck(); !resp.NpmManaged || !strings.Contains(string(raw), `"npmManaged":true`) {
		t.Errorf("npm install → check flag on, got %+v raw %s", resp, raw)
	}

	// check 失败路径（nil 源 → sourceMissing）同样携带：安装形态与检查结果无关
	update.GetManager().SetSource(nil)
	if resp, _ = doCheck(); !resp.NpmManaged {
		t.Errorf("npm install → error-path flag on, got %+v", resp)
	}

	// status 响应同挂旗标（agent 经状态端点感知安装形态的留口）
	if st, raw := doStatus(); !st.NpmManaged || !strings.Contains(string(raw), `"npmManaged":true`) {
		t.Errorf("npm install → status flag on, got %+v raw %s", st, raw)
	}

	// env 清空回落非 npm：status 字段省略
	t.Setenv("CODECOMBO_INSTALLER", "")
	if st, raw := doStatus(); st.NpmManaged || strings.Contains(string(raw), "npmManaged") {
		t.Errorf("non-npm install → status flag omitted, got %+v raw %s", st, raw)
	}
}
