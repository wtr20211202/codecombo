package auth

import (
	"context"
	"log/slog"
	"time"

	"codecombo/server/store"
)

// HTTPSResolver 编排 HTTPS 凭据查询
// 被 credential-helper 子命令和测试直接调用
//
// 装配方式：
//   - Store: 通常 store.Get().Credential；helper 子进程自行构造 filestore
//   - Providers: 按 AuthType 注册的默认 Provider map（如 "basic" → BasicAuthProvider）
//   - PlatformLookup: 可选；oauth-device 等需按 platform 选具体 Provider 时调用
//     生产中由 main.go 注入 providers.FindByPlatform（避免 auth 包反向 import providers）
type HTTPSResolver struct {
	Store          store.CredentialStore
	Providers      map[string]CredentialProvider // key = AuthType
	PlatformLookup ProviderLookup                // 可选；oauth-device 按 platform 选 Provider
}

// Resolve 主流程：
//  1. FindEncryptedByHost(host) 拿最佳 cred
//  2. 找 provider（按 AuthType，必要时按 Platform 选择 OAuth Provider）
//  3. 注入 Store 给 provider（若实现 StoreSetter），让 refresh 成功后能持久化
//  4. 应用 TokenUsername（如果 cred.Username 为空）
//  5. 调 provider.Resolve
//  6. 异步更新 LastUsedAt
//  7. 按 AuthError.Kind 处理错误
//
// 永远返回 (nil, nil) 表示「无可用凭据」——让 git 走下一个 helper（如 GCM）兜底
// Provider 报错时通过 handleResolveError 处理后吞掉，helper 仍 exit 0
func (r *HTTPSResolver) Resolve(ctx context.Context, host string) (*ResolvedCredential, error) {
	cred, err := r.Store.FindEncryptedByHost(host)
	if err != nil {
		// store 故障视为瞬时网络/存储层错误（spec §错误分类 KindNetwork）：
		// 仅记 Warn 级，避免与「凭据失效/拒绝」等业务错误混淆淹没告警
		slog.Warn("transient network error", "host", host, "op", "find-credential", "err", err)
		return nil, nil
	}
	if cred == nil {
		return nil, nil
	}

	provider := r.findProvider(cred)
	if provider == nil {
		slog.Error("no provider for cred", "auth_type", cred.AuthType, "platform", cred.Platform)
		return nil, nil
	}

	// 注入 Store：若 provider 实现 StoreSetter（如 OAuth Device Provider），
	// 让 provider 在 refresh 成功后能持久化新 token（spec §数据流 强制要求）
	// 不直接依赖 providers 子包的具体类型，避免循环 import
	//
	// 注：FindByPlatform 每次返回新实例，注入是单线程安全的；
	// 若未来某处缓存共享 provider 实例，需要改为 provider 内部依赖注入或加锁
	if s, ok := provider.(StoreSetter); ok && r.Store != nil {
		s.SetStore(r.Store)
	}

	// 应用 TokenUsername：若 cred.Username 为空且 provider 实现 TokenUsernameProvider
	// OAuth token 类 provider 通常需要固定 username（如 GitHub 的 "x-access-token"）
	if cred.Username == "" {
		if tun, ok := provider.(TokenUsernameProvider); ok {
			cred.Username = tun.TokenUsername(cred)
		}
	}

	resolved, err := provider.Resolve(ctx, cred)
	if err != nil {
		handleResolveError(err, cred, r.Store)
		return nil, nil
	}
	if resolved == nil {
		// provider 返回 nil 表示「跳过当前 helper」
		return nil, nil
	}

	// 异步更新 LastUsedAt（不阻塞 helper 返回）
	// helper 子进程退出前会等 goroutine 吗？不会——但 UpdateLastUsedAt 内部已容忍偶尔失败
	go func() {
		_ = r.Store.UpdateLastUsedAt(cred.ID, time.Now())
	}()

	return resolved, nil
}

// findProvider 按 AuthType + Platform 选 Provider
//
// 策略：
//   - 优先查 Providers[authType]（直接命中，覆盖测试注入的 stub basic 等场景）
//   - 未命中且 PlatformLookup 非空时，调 PlatformLookup(authType, platform)
//     生产中 PlatformLookup = providers.FindByPlatform，能按 platform 选 GitHub/Gitea Device Provider
//
// 这样 helper 子进程可以只注入 PlatformLookup（无需 import providers 子包构造 map），
// 而 HTTPSResolver 直接被业务代码装配时也可通过 Providers map 注入定制 provider
func (r *HTTPSResolver) findProvider(cred *store.Credential) CredentialProvider {
	if p, ok := r.Providers[cred.AuthType]; ok && p != nil {
		return p
	}
	if r.PlatformLookup != nil {
		return r.PlatformLookup(cred.AuthType, cred.Platform)
	}
	return nil
}
