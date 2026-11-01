package platforms

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"codecombo/server/git/auth"
)

func TestPlatformRegistryMatch(t *testing.T) {
	cases := []struct {
		host string
		want string
	}{
		{"github.com", auth.PlatformGitHub},
		{"gitlab.com", auth.PlatformGitLab},
		{"gitea.com", auth.PlatformGitea},
		{"gitee.com", auth.PlatformGitee},
		// unknown 走 Probe（必失败）→ Generic 兜底
		// 用 127.0.0.1:1 这种几乎必连不上的端口，避免依赖外网
		{"127.0.0.1:1", auth.PlatformGeneric},
	}
	for _, c := range cases {
		a := Match(context.Background(), c.host)
		if a.ID() != c.want {
			t.Errorf("Match(%q) = %q, want %q", c.host, a.ID(), c.want)
		}
	}
}

func TestGiteaProbe(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/version" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"version":"1.21.0"}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	a := &GiteaAdapter{}
	ok, err := a.Probe(context.Background(), srv.URL)
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if !ok {
		t.Error("Probe should return true for Gitea-like server")
	}
}

func TestPlatformCapabilityLookup(t *testing.T) {
	// GitHubAdapter 应实现 OAuthCapable / PRURLBuilder / ScopeAdvisor
	var a auth.PlatformAdapter = &GitHubAdapter{}
	if _, ok := a.(auth.OAuthCapable); !ok {
		t.Error("GitHubAdapter should implement OAuthCapable")
	}
	if _, ok := a.(auth.PRURLBuilder); !ok {
		t.Error("GitHubAdapter should implement PRURLBuilder")
	}
	if _, ok := a.(auth.ScopeAdvisor); !ok {
		t.Error("GitHubAdapter should implement ScopeAdvisor")
	}

	// GenericAdapter 只实现 PRURLBuilder
	g := &GenericAdapter{}
	if _, ok := interface{}(g).(auth.OAuthCapable); ok {
		t.Error("GenericAdapter should NOT implement OAuthCapable")
	}
	if _, ok := interface{}(g).(auth.PRURLBuilder); !ok {
		t.Error("GenericAdapter should implement PRURLBuilder")
	}
}

// TestProbeFallbackForSelfHostedGitea 验证 Probe 兜底分支：
// 静态注册表 miss 的自建 host，通过 /api/v1/version 探测命中 GiteaAdapter（而非 Generic）。
// 此用例直接覆盖修复前为死代码的 Probe 分支。
func TestProbeFallbackForSelfHostedGitea(t *testing.T) {
	// 启动 TLS mock Gitea server，返回 200 + 合法 version
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/version" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"version":"1.21.0"}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	// Match 内部硬编码 baseURL = "https://"+host；这里 host 直接用 server 的 host:port
	// Probe 现在用包级 probeClient（带 5s timeout），通过 setProbeClientTransport 注入
	// srv.Client().Transport 让 https://host 请求路由到 mock TLS server
	host := stripScheme(srv.URL)
	restore := setProbeClientTransport(srv.Client().Transport)
	defer restore()

	a := Match(context.Background(), host)
	if a.ID() != auth.PlatformGitea {
		t.Errorf("Match(self-hosted gitea) = %q, want \"gitea\"", a.ID())
	}
}

// TestGenericFallbackForUnknownHost 验证最终兜底分支：
// 静态注册表 miss 且所有 Probe 都未命中时，返回 GenericAdapter。
func TestGenericFallbackForUnknownHost(t *testing.T) {
	// 127.0.0.1:1 几乎必定连不上，所有 Probe 返 (false, nil) → Generic 兜底
	a := Match(context.Background(), "127.0.0.1:1")
	if a.ID() != auth.PlatformGeneric {
		t.Errorf("Match(unknown host) = %q, want \"generic\"", a.ID())
	}
}

// stripScheme 去掉 URL 的 scheme，返回 host[:port]
func stripScheme(url string) string {
	for _, prefix := range []string{"https://", "http://"} {
		if len(url) > len(prefix) && url[:len(prefix)] == prefix {
			return url[len(prefix):]
		}
	}
	return url
}
