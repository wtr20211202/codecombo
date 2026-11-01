package git

import (
	"context"
	"log/slog"
	"strings"

	"codecombo/server/config"
	"codecombo/server/git/auth"
	"codecombo/server/store"
)

// 全局 resolver 实例（main.go 启动期通过 SetAuthResolvers 注入）
//
// 设计意图：
//   - HTTPS 路径由 HTTPSResolver 编排 helper 协议返回 username/password（在 credential-helper 子命令中实际查询）
//     execGitWithAuth 仅注入 GIT_CONFIG_GLOBAL 路径，让 git 子进程自动回调本程序 credential-helper
//   - SSH 路径由 SSHResolver 返回 SSHInjection（GIT_SSH_COMMAND + 可选 PreExec / PostExec）
//
// 未注入（globalXxxResolver == nil）时调 initResolvers 懒加载默认实例
// 测试中调 SetAuthResolvers 注入 stub
var (
	globalHTTPSResolver *auth.HTTPSResolver //nolint:unused // HTTPSResolver 参数保留供未来 main.go 显式装配（见 SetAuthResolvers 注释）
	globalSSHResolver   auth.SSHResolver
)

// SetAuthResolvers 启动期注入 resolver 实例（main.go 调用）
//
// 生产装配（main.go serve() 启动期）：
//
//	git.SetAuthResolvers(
//	    nil, // HTTPS 不需要：credential-helper 子进程独立装配 HTTPSResolver
//	    &auth.KeyPathSSHResolver{Store: store.Get().SshKey, Cache: auth.NewSSHKeyLRU(16)},
//	)
//
// 测试中也可调用以注入 mock；当前 SSHResolver 参数为 nil 时走 lazy init
// HTTPSResolver 参数保留供未来 main.go 显式装配（当前未使用）
func SetAuthResolvers(https *auth.HTTPSResolver, ssh auth.SSHResolver) {
	globalHTTPSResolver = https
	globalSSHResolver = ssh
}

// GetSSHResolver 返回全局 SSH resolver 实例
//
// 仅供 handler 层（admin/sshkey.go DeleteSshKey）调用以失效 LRU 缓存——
// store 层不能 import auth 包（循环依赖），因此失效操作必须在 handler 层完成
//
// 未注入（nil）时返回 nil；调用方需 nil-check
func GetSSHResolver() auth.SSHResolver {
	return globalSSHResolver
}

// initResolvers 懒加载默认 resolver 实例（仅 SSHResolver 当前需要）
//
// HTTPSResolver 不在此懒加载——HTTPS 路径走 credential-helper 子进程，子进程独立装配
// resolver，主进程不需要 HTTPSResolver 实例
//
// 注意：仅 SSH 分支调 initResolvers；测试可通过 SetAuthResolvers(nil, stub) 绕过
func initResolvers() {
	if globalSSHResolver == nil {
		globalSSHResolver = &auth.KeyPathSSHResolver{
			Store: store.Get().SshKey,
			Cache: auth.NewSSHKeyLRU(16),
		}
	}
}

// execGitWithAuth 处理已有仓库的远程操作（fetch / pull / push / lfs / submodule update）
//
// 通过 remoteName 反查 URL，再交给 execGitWithURL 走协议对应的注入路径：
//   - HTTPS / HTTP：注入 GIT_CONFIG_GLOBAL 指向本程序 credential-helper 链
//   - SSH（git@ / ssh://）：注入 GIT_SSH_COMMAND 指向 LRU 缓存的 tmp key
//
// 返回值与 execGit 一致：(stdout 字符串, error)
func execGitWithAuth(repoPath, remoteName string, args ...string) (string, error) {
	rawURL, err := gitRemoteGetURL(repoPath, remoteName)
	if err != nil {
		return "", err
	}
	return execGitWithURL(repoPath, rawURL, args...)
}

// execGitWithURL 处理已知 URL 的 git 操作（clone / 直接传 URL 的 pull 等）
//
// 与 execGitWithAuth 的差异：调用方已知 URL（如 clone 场景），无需反查 remote
//
// 内部：
//  1. buildAuthEnvForURL 按 URL 协议构造 env 和 cleanup
//  2. execGitWithEnv 执行 git（env 自动追加到 cmd.Env）
//  3. defer 调用所有 cleanup（删除 tmp 文件等）
func execGitWithURL(repoPath, rawURL string, args ...string) (string, error) {
	env, cleanups, err := buildAuthEnvForURL(rawURL)
	if err != nil {
		return "", err
	}
	defer func() {
		for _, c := range cleanups {
			c()
		}
	}()
	return execGitWithEnv(repoPath, env, args...)
}

// buildAuthEnv 为测试暴露的内部函数
//
// 第二参数 repoPath 当前未使用，保留供未来 deploy-key / 多账号场景按仓库选凭据
// 返回 (env, cleanup, error)：cleanup 合并了所有子 cleanup，调用方 defer 一次即可
func buildAuthEnv(rawURL, _ string) ([]string, func(), error) {
	env, cleanups, err := buildAuthEnvForURL(rawURL)
	if err != nil {
		return nil, nil, err
	}
	merged := func() {
		for _, c := range cleanups {
			c()
		}
	}
	return env, merged, nil
}

// buildAuthEnvForURL 根据 URL 协议构造 env 和 cleanup 列表（无用户选定密钥，
// SSH 路径按 host 自动匹配）
func buildAuthEnvForURL(rawURL string) ([]string, []func(), error) {
	return buildAuthEnvForURLWithKey(rawURL, "")
}

// buildAuthEnvForURLWithKey 同上，sshKeyID 非空时 SSH 路径按 id 精确取用户选定
// 的密钥（克隆对话框选择），优先于 host 自动匹配
//
// 协议分支：
//   - HTTPS / HTTP：
//     a) 调 auth.GetCachedHelperConfig() 拿进程级单例 GIT_CONFIG_GLOBAL 路径
//     b) env 追加 GIT_CONFIG_GLOBAL=<path>
//     c) cleanup 当前是 no-op（helper config 由 sync.Once 全局管理）
//   - SSH（git@ / ssh://）：
//     a) 调 globalSSHResolver.ResolveForSSH 拿 SSHInjection
//     b) 若 inj.PreExec 非 nil，立即调用（如启动 ssh-agent）
//     c) 若 inj.PostExec 非 nil，注册到 cleanup（如关闭 ssh-agent）
//     d) env 追加 inj.Env 全部条目
//
// 基础 env（无论协议）：
//   - GIT_TERMINAL_PROMPT=0：禁止 git 卡 TTY 输入等待
//   - CC_DATA_DIR=<path>：让 credential-helper 子命令定位本系统数据目录（SC_DATA_DIR 旧名双读）
//
// 注意：initResolvers 仅在 SSH 分支调用——HTTPS 路径只依赖 helper config 文件，
// 无需 resolver（credential-helper 子进程独立装配），避免在 HTTPS 测试中触发 store.Get()
//   - SSH（git@ / ssh://）：按 host（或 sshKeyID）取钥匙，注入 GIT_SSH_COMMAND
func buildAuthEnvForURLWithKey(rawURL, sshKeyID string) ([]string, []func(), error) {
	env := []string{
		"GIT_TERMINAL_PROMPT=0",
		"SC_DATA_DIR=" + config.DataDir(),
	}
	var cleanups []func()

	switch {
	case isHTTPSURL(rawURL):
		cfgPath, cfgCleanup, err := auth.GetCachedHelperConfig()
		if err != nil {
			return nil, nil, err
		}
		env = append(env, "GIT_CONFIG_GLOBAL="+cfgPath)
		cleanups = append(cleanups, cfgCleanup)

	case isSSHURL(rawURL):
		// 懒加载 resolver：仅 SSH 路径需要 SSHResolver 实例
		// 测试通过 SetAuthResolvers 注入 stub 可绕过
		initResolvers()

		// 复用 store.HostFromURL（已正确处理 SSH 端口、SCP path、user@ 等格式）
		// 本包历史版本曾实现 hostFromURL，但对 git@gitlab.corp:2222:owner/repo.git 这类
		// 含端口的 SCP URL 误判（停在第一个 ':'），交由统一实现避免分叉
		host := store.HostFromURL(rawURL)
		if host == "" {
			// URL 格式异常无法解析 host：放弃注入，让 git 走默认行为
			slog.Warn("buildAuthEnv: cannot parse host from ssh url", "url", rawURL)
			break
		}
		if globalSSHResolver != nil {
			inj, err := globalSSHResolver.ResolveForSSH(context.Background(), host, sshKeyID)
			if err != nil {
				return nil, nil, err
			}
			if inj != nil {
				if inj.PreExec != nil {
					if err := inj.PreExec(); err != nil {
						return nil, nil, err
					}
				}
				if inj.PostExec != nil {
					cleanups = append(cleanups, func() { _ = inj.PostExec() })
				}
				env = append(env, inj.Env...)
			}
		}
	}

	return env, cleanups, nil
}

// gitRemoteGetURL 调 `git remote get-url <name>` 拿到 URL
//
// 不带 env 注入：get-url 是本地操作（读 .git/config），无需凭据
func gitRemoteGetURL(repoPath, remoteName string) (string, error) {
	out, err := execGit(repoPath, "remote", "get-url", remoteName)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}
