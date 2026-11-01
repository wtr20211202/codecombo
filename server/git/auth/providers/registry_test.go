package providers

import (
	"testing"

	"codecombo/server/git/auth"
	"codecombo/server/store"
)

func TestDefaultRegistryBasic(t *testing.T) {
	r := DefaultRegistry()
	if r[store.AuthTypeBasic] == nil {
		t.Error("basic provider not registered")
	}
	if r[store.AuthTypeBasic].Type() != store.AuthTypeBasic {
		t.Errorf("basic type = %q", r[store.AuthTypeBasic].Type())
	}
}

func TestDefaultRegistryOAuthDevice(t *testing.T) {
	r := DefaultRegistry()
	// 注意：oauth-device 类型可能映射到多个 Provider（github / gitea）
	// Registry 按 authType 返回该类型的「默认」Provider（github 优先）
	// 实际选哪个 Provider 由 resolver 根据 PlatformAdapter 决定
	if r[store.AuthTypeOAuthDevice] == nil {
		t.Error("oauth-device provider not registered")
	}
	if r[store.AuthTypeOAuthDevice].Type() != store.AuthTypeOAuthDevice {
		t.Errorf("oauth-device type = %q", r[store.AuthTypeOAuthDevice].Type())
	}
}

func TestRegistryImplementsInterfaces(t *testing.T) {
	r := DefaultRegistry()
	// basic 实现 TokenUsernameProvider
	if _, ok := r[store.AuthTypeBasic].(auth.TokenUsernameProvider); !ok {
		t.Error("basic provider should implement TokenUsernameProvider")
	}
	// oauth-device 实现 OAuthDeviceFlowProvider
	if _, ok := r[store.AuthTypeOAuthDevice].(auth.OAuthDeviceFlowProvider); !ok {
		t.Error("oauth-device provider should implement OAuthDeviceFlowProvider")
	}
}

func TestFindByPlatformBasic(t *testing.T) {
	// basic 任何 platform 都返 BasicAuthProvider
	p := FindByPlatform(store.AuthTypeBasic, "")
	if p == nil {
		t.Fatal("basic provider not found")
	}
	if p.Type() != store.AuthTypeBasic {
		t.Errorf("type = %q, want basic", p.Type())
	}
	// 编译期 + 运行期双重断言：basic 实现 TokenUsernameProvider
	if _, ok := p.(auth.TokenUsernameProvider); !ok {
		t.Error("basic provider should implement TokenUsernameProvider")
	}
}

func TestFindByPlatformOAuthDeviceGitea(t *testing.T) {
	// oauth-device + gitea → GiteaDeviceProvider
	p := FindByPlatform(store.AuthTypeOAuthDevice, "gitea")
	if p == nil {
		t.Fatal("gitea provider not found")
	}
	if p.Type() != store.AuthTypeOAuthDevice {
		t.Errorf("type = %q, want oauth-device", p.Type())
	}
	// TokenUsername 应是 "oauth2"（Gitea 约定）
	tu := p.(auth.TokenUsernameProvider).TokenUsername(nil)
	if tu != "oauth2" {
		t.Errorf("gitea TokenUsername = %q, want oauth2", tu)
	}
}

func TestFindByPlatformOAuthDeviceGitHub(t *testing.T) {
	// oauth-device + github（或其他未知 platform）→ GitHubDeviceProvider
	for _, plat := range []string{"github", "gitlab", "", "unknown"} {
		p := FindByPlatform(store.AuthTypeOAuthDevice, plat)
		if p == nil {
			t.Fatalf("provider nil for platform %q", plat)
		}
		if p.Type() != store.AuthTypeOAuthDevice {
			t.Errorf("platform %q: type = %q", plat, p.Type())
		}
		// TokenUsername 应是 "x-access-token"（GitHub 约定）
		tu := p.(auth.TokenUsernameProvider).TokenUsername(nil)
		if tu != "x-access-token" {
			t.Errorf("platform %q: TokenUsername = %q, want x-access-token", plat, tu)
		}
	}
}

func TestFindByPlatformUnknownType(t *testing.T) {
	// 未知 authType → nil
	if p := FindByPlatform("unknown-type", ""); p != nil {
		t.Errorf("expected nil for unknown authType, got %T", p)
	}
}
