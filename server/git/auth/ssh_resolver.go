package auth

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"codecombo/server/config"
	"codecombo/server/store"
)

// SSHResolver 返回 SSH 注入策略
//
// 不同实现：
//   - KeyPathSSHResolver（默认）：解密 PEM 写 tmp 文件，构造 GIT_SSH_COMMAND
//   - 未来 AgentForwardSSHResolver（P1）：启动 ssh-agent，转发本机 agent socket
//   - 未来 DeployKeySSHResolver（P1）：按 repoPath 选 deploy key，临时写 .ssh/config
//
// keyID 参数：用户显式选定的密钥 id（克隆对话框传入）；非空时精确按 id 取钥匙
// （优先于 host 匹配），空时按 host 自动匹配。repoPath 语义已由 keyID 取代
type SSHResolver interface {
	ResolveForSSH(ctx context.Context, host, keyID string) (*SSHInjection, error)
}

// KeyPathSSHResolver 默认实现：解密 PEM 写 tmp 文件（经 LRU 缓存），构造 GIT_SSH_COMMAND
//
// 装配：
//   - Store: 通常 store.Get().SshKey
//   - Cache: 通常 auth.NewSSHKeyLRU(16)，进程级单例
type KeyPathSSHResolver struct {
	Store store.SshKeyStore
	Cache *SSHKeyLRU
}

// ResolveForSSH 解析 SSH 注入：keyID 非空按 id 精确取，否则按 host 匹配；
// 经 LRU 拿 tmp key path，构造 GIT_SSH_COMMAND
//
// 两者都无 key 时返回空 injection（Env 为空），让 git 走系统默认 ssh
//
// GIT_SSH_COMMAND 选项说明：
//   - -i "<path>"：指定私钥
//   - IdentitiesOnly=yes：禁止 ssh 从 ssh-agent / 默认 ~/.ssh/id_* 取密钥
//     （否则同主机多账号场景会 identity 混乱）
//   - StrictHostKeyChecking=accept-new：首次连接自动接受，后续严格校验
//     （避免首次 clone 时交互式 prompt 卡死 git 子进程）
func (r *KeyPathSSHResolver) ResolveForSSH(ctx context.Context, host, keyID string) (*SSHInjection, error) {
	if r.Store == nil || r.Cache == nil {
		return nil, InternalError("ssh-resolve", fmt.Errorf("resolver not initialized: Store=%v Cache=%v", r.Store != nil, r.Cache != nil))
	}

	var (
		key *store.SSHKey
		err error
	)
	if keyID != "" {
		// 用户显式选定：按 id 精确取（找不到视为错误，而非静默回退 host 匹配）
		key, err = r.Store.GetByID(keyID)
		if err != nil {
			return nil, InternalError("ssh-resolve", fmt.Errorf("find ssh key by id %s: %w", keyID, err))
		}
	} else {
		key, err = r.Store.FindByHost(host)
		if err != nil {
			return nil, InternalError("ssh-resolve", fmt.Errorf("find ssh key: %w", err))
		}
		if key == nil {
			// 无 key：返回空 injection，让 git 走系统默认 ssh
			return &SSHInjection{}, nil
		}
	}

	keyPath, err := r.Cache.GetOrWrite(key)
	if err != nil {
		return nil, InternalError("ssh-resolve", err)
	}

	// known_hosts 隔离到应用数据目录：不写服务用户的 ~/.ssh（受限部署域下
	// 家目录不可写会降级为每次连接重复 accept，等于常驻 TOFU 风险），也避免
	// 多实例/多用户时污染用户文件
	khDir := filepath.Join(config.DataDir(), "cache")
	if err := os.MkdirAll(khDir, 0o700); err != nil {
		return nil, InternalError("ssh-resolve", err)
	}
	knownHosts := filepath.Join(khDir, "known_hosts")

	cmd := fmt.Sprintf(
		`ssh -i "%s" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=%q`,
		keyPath, knownHosts,
	)
	return &SSHInjection{
		Env: []string{"GIT_SSH_COMMAND=" + cmd},
	}, nil
}

// InvalidateKey 按 keyID 失效 LRU 中对应的 tmp 文件，供 handler（SSH key 删除）调用
//
// 为何不放在 store 层：store 包不能 import auth（auth 已 import store，
// 反向 import 会形成循环依赖），所以失效操作必须由持有 resolver 引用的
// handler 层触发
//
// 安全 fail-open：Cache 为 nil（懒加载未触发）时不报错，等价于本就无缓存可清
func (r *KeyPathSSHResolver) InvalidateKey(keyID string) {
	if r == nil || r.Cache == nil {
		return
	}
	r.Cache.Invalidate(keyID)
}
