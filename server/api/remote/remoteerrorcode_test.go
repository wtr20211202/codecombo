package remote

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/api/shared"
	"codecombo/server/errmarkers"
)

// P-20261005-160 门禁：remote 域拨号错误面的 code 稳定断言——SSH 认证失败/
// 主机指纹变更（remoteErrors.ts 第二张正则表的服务端源头）按 code 分支自纠，
// 码值或绑定 status 漂移在此翻红；message 关键字（P-29 marker）共存断言保
// 前端正则过渡层兼容。

// TestRemoteErrCode_Classification 分类器单元断言：两标记 → 两码（合成错误以
// errmarkers 常量构造，与注册表同源——文本改动须两侧同步的场景不失明）；
// 普通网络错误/nil → 无码（保持无 code 旧形态）
func TestRemoteErrCode_Classification(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want shared.ErrCode
	}{
		{"hostkey changed", fmt.Errorf("ssh dial h:2222: %s: knownhosts mismatch", errmarkers.HostKeyChanged), shared.CodeRemoteHostKeyChanged},
		{"auth rejected", fmt.Errorf("ssh dial h:22: %s: unable to authenticate", errmarkers.AuthRejectedPrefix), shared.CodeRemoteAuthFailed},
	}
	for _, tc := range cases {
		code, ok := remoteErrCode(tc.err)
		if !ok || code != tc.want {
			t.Errorf("%s: code=%q ok=%v, want %q", tc.name, code, ok, tc.want)
		}
	}
	if _, ok := remoteErrCode(errors.New("dial tcp 1.2.3.4:22: connection refused")); ok {
		t.Error("plain net error must not carry a code")
	}
	if _, ok := remoteErrCode(nil); ok {
		t.Error("nil error must not carry a code")
	}
	// hostkey 优先于 auth 前缀判别（指纹变更错误文本可能同现认证语义词）
	code, ok := remoteErrCode(errors.New(errmarkers.HostKeyChanged + " " + errmarkers.AuthRejectedPrefix))
	if !ok || code != shared.CodeRemoteHostKeyChanged {
		t.Errorf("hostkey-first: code=%q ok=%v, want remote.host_key_changed", code, ok)
	}
}

// TestRespondRemoteDialError dial 出口两形态：命中标记 → 502 + code + marker
// 文本共存；未命中 → 502 无 code（增量兼容，错误通道对旧 agent 零变化）
func TestRespondRemoteDialError(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/dial", func(c *gin.Context) {
		respondRemoteDialError(c, "remote host dial failed", errors.New("ssh dial h:22: "+errmarkers.AuthRejectedPrefix+": bob"))
	})
	r.GET("/dial-plain", func(c *gin.Context) {
		respondRemoteDialError(c, "remote host dial failed", errors.New("dial tcp: connection refused"))
	})

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/dial", nil))
	if w.Code != http.StatusBadGateway {
		t.Fatalf("auth status = %d, want 502", w.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["code"] != "remote.auth_failed" {
		t.Errorf("code = %q, want remote.auth_failed", body["code"])
	}
	if body["error"] != "ssh dial h:22: "+errmarkers.AuthRejectedPrefix+": bob" {
		t.Errorf("error text must keep marker wording, got %q", body["error"])
	}

	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, httptest.NewRequest(http.MethodGet, "/dial-plain", nil))
	if w2.Code != http.StatusBadGateway {
		t.Fatalf("plain status = %d, want 502", w2.Code)
	}
	var body2 map[string]string
	if err := json.Unmarshal(w2.Body.Bytes(), &body2); err != nil {
		t.Fatal(err)
	}
	if _, has := body2["code"]; has {
		t.Errorf("plain dial error must not emit code field: %v", body2)
	}
}
