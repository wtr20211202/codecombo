package system

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
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
