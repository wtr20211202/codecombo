package git

import (
	"context"
	"path/filepath"
	"time"

	"codecombo/server/git/auth"
	"codecombo/server/kernel"
	"codecombo/server/model"
	"codecombo/server/store"
)

// Module Git 模块（roadmap M1.5，内核化最大件）：把 execGit 出站事件的
// 广播与 workDir→projectID 反查的装配收进模块生命周期——包级注入点
// （原 SetBroadcastFunc/SetPathResolver setter）随之消除，模块 Init 内
// 直接对包内变量赋值。鉴权 resolver 装配与 clone 任务过期清理同批迁入。
type Module struct {
	k        kernel.Kernel
	sshCache *auth.SSHKeyLRU
}

// NewModule 创建 Git 模块
func NewModule() *Module { return &Module{} }

func (m *Module) Name() string        { return "git" }
func (m *Module) DependsOn() []string { return nil }

// Init 装配三件事（依赖 store 已就绪，组合根保证先建 store 再 StartAll）：
//  1. 鉴权 resolver：HTTPS 路径由 credential-helper 子进程独立装配（传 nil），
//     SSH 路径注入 KeyPathSSHResolver（避免 auth_inject.go 懒加载兜底）；
//  2. 失败广播：git 命令错误先进事件总线（可被任意模块订阅），
//     再经 api 层桥接以原有 WSMessage 格式落到项目 WS 通道；
//  3. 路径反查：workDir → projectID（store 项目表全量比对）。
func (m *Module) Init(_ context.Context, k kernel.Kernel) error {
	m.k = k

	m.sshCache = auth.NewSSHKeyLRU(16)
	SetAuthResolvers(nil, &auth.KeyPathSSHResolver{
		Store: store.Get().SshKey,
		Cache: m.sshCache,
	})

	broadcastFn = func(projectID string, msg model.WSMessage) {
		k.Events().Publish(kernel.Envelope{
			Topic:     msg.Type,
			ProjectID: projectID,
			Payload:   msg.Data,
		})
	}
	pathResolverFn = resolveProjectID
	return nil
}

// Start clone 任务过期清理托管到内核调度器（Stop 统一取消并等待）
func (m *Module) Start(_ context.Context, k kernel.Kernel) error {
	k.Scheduler().AddTicker("clone-cleanup", 30*time.Second, func(context.Context) {
		DefaultTaskManager.CleanupExpired()
	})
	return nil
}

// Stop 清理 SSH key LRU 内的 tmp key 文件（明文 PEM，安全敏感）
func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error {
	if m.sshCache != nil {
		m.sshCache.Cleanup()
		m.sshCache = nil
	}
	return nil
}

// resolveProjectID 由 workDir 反查 projectID（反查不到返回 ""）
func resolveProjectID(workDir string) string {
	projects, err := store.Get().Project.List()
	if err != nil {
		return ""
	}
	absWork, _ := filepath.Abs(workDir)
	for _, p := range projects {
		absProj, _ := filepath.Abs(p.Path)
		if absWork == absProj {
			return p.ID
		}
	}
	return ""
}
