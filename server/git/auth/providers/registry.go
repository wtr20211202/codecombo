package providers

import (
	"net/http"
	"sync"
	"time"

	"codecombo/server/git/auth"
	"codecombo/server/store"
)

// oauthHTTPClient OAuth device flow 请求的兜底 HTTP client（带超时）。
// provider.HTTP 为 nil 时使用——绝不能 fallback 到无超时的 http.DefaultClient：
// credential helper 子进程以 context.Background() 调用 provider，
// 无超时 client 在 token 端点半死时会让 git 操作无界挂起（连接+goroutine 长期占用）
var oauthHTTPClient = &http.Client{Timeout: 30 * time.Second}

// Provider 注册表（扩展点）：新增凭证 provider 或平台特定实现不再需要
// 修改 FindByPlatform 的 switch——实现 auth.CredentialProvider 后调用
// RegisterProvider / RegisterProviderForPlatform 即可。
//
// 结构：authType → 默认 provider（RegisterProvider）；
//       authType → platform → provider（RegisterProviderForPlatform，优先命中）。
// 查找顺序：平台覆盖 > authType 默认 > nil。

var (
	registryMu sync.RWMutex
	defaults   = map[string]auth.CredentialProvider{}
	overrides  = map[string]map[string]auth.CredentialProvider{} // authType → platform → provider
)

func init() {
	RegisterProvider(store.AuthTypeBasic, &BasicAuthProvider{})
	// oauth-device 默认指向 GitHubDeviceProvider；实际生产中 HTTPSResolver 会根据
	// cred.Platform 选择正确的 Device Provider（gitea → GiteaDeviceProvider）
	RegisterProvider(store.AuthTypeOAuthDevice, &GitHubDeviceProvider{})
	RegisterProviderForPlatform(store.AuthTypeOAuthDevice, auth.PlatformGitea, &GiteaDeviceProvider{})

	// 桥接 auth ↔ providers 的 import cycle（roadmap M2.1：原 main.go 显式
	// SetProviderLookup 迁入本包 init 自注册——credential-helper 子进程与
	// serve 主进程共用，任何 import 本包的二进制自动完成装配）
	auth.SetProviderLookup(FindByPlatform)
}

// RegisterProvider 注册某 authType 的默认 provider（同名重复注册覆盖）
func RegisterProvider(authType string, p auth.CredentialProvider) {
	registryMu.Lock()
	defer registryMu.Unlock()
	defaults[authType] = p
}

// RegisterProviderForPlatform 注册某 authType 下特定平台的 provider（同名重复注册覆盖）
func RegisterProviderForPlatform(authType, platform string, p auth.CredentialProvider) {
	registryMu.Lock()
	defer registryMu.Unlock()
	if overrides[authType] == nil {
		overrides[authType] = map[string]auth.CredentialProvider{}
	}
	overrides[authType][platform] = p
}

// DefaultRegistry 返回 authType → 默认 Provider 的映射（副本）
// 当 platform 需要特定 provider 时（如自建 Gitea 用 GiteaDeviceProvider），
// resolver 应通过 FindByPlatform 或 PlatformAdapter 查询而非用默认
func DefaultRegistry() map[string]auth.CredentialProvider {
	registryMu.RLock()
	defer registryMu.RUnlock()
	out := make(map[string]auth.CredentialProvider, len(defaults))
	for k, v := range defaults {
		out[k] = v
	}
	return out
}

// FindByPlatform 按 (authType, platform) 查找正确的 Provider
// 例如 (AuthTypeOAuthDevice, PlatformGitea) → GiteaDeviceProvider
// platform="" 或未知平台时 oauth-device 默认走 GitHub 风格端点
func FindByPlatform(authType, platform string) auth.CredentialProvider {
	registryMu.RLock()
	defer registryMu.RUnlock()
	if m := overrides[authType]; m != nil {
		if p, ok := m[platform]; ok {
			return p
		}
	}
	return defaults[authType]
}
