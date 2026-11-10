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
